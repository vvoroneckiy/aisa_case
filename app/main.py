from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.db import create_engine, create_session_factory, session_scope
from app.gigachat import GigaChatClient
from app.models import Base, Chat, Message
from app.schemas import ChatOut, CreateChatIn, MessageOut, SendMessageIn
from app.settings import Settings, get_settings


def _ensure_parent_dir(db_path: str) -> None:
    path = Path(db_path)
    if path.parent and str(path.parent) not in ("", "."):
        path.parent.mkdir(parents=True, exist_ok=True)


def _chat_to_out(chat: Chat) -> ChatOut:
    return ChatOut(id=chat.id, title=chat.title, created_at=chat.created_at)


def _message_to_out(msg: Message) -> MessageOut:
    return MessageOut(
        id=msg.id,
        chat_id=msg.chat_id,
        role=msg.role,  # type: ignore[arg-type]
        content=msg.content,
        created_at=msg.created_at,
    )


class AppState:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.engine: AsyncEngine = create_engine(settings.db_path)
        self.session_factory: async_sessionmaker[AsyncSession] = create_session_factory(self.engine)
        self.gigachat = GigaChatClient(
            api_base=settings.gigachat_api_base,
            auth_url=settings.gigachat_auth_url,
            client_id=settings.gigachat_client_id,
            client_secret=settings.gigachat_client_secret,
            scope=settings.gigachat_scope,
            model=settings.gigachat_model,
            verify_ssl=settings.gigachat_verify_ssl,
        )


def _require_gigachat_config(settings: Settings) -> None:
    if not settings.gigachat_client_id or not settings.gigachat_client_secret:
        raise HTTPException(
            status_code=500,
            detail="Не заданы переменные окружения GIGACHAT_CLIENT_ID/GIGACHAT_CLIENT_SECRET",
        )


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    _ensure_parent_dir(settings.db_path)
    state = AppState(settings)
    async with state.engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    app.state.state = state
    yield
    await state.engine.dispose()


app = FastAPI(lifespan=lifespan)

templates = Jinja2Templates(directory="templates")
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={"request": request, "now": datetime.utcnow()},
    )


@app.get("/api/chats", response_model=list[ChatOut])
async def list_chats(request: Request):
    state: AppState = request.app.state.state
    async with session_scope(state.session_factory) as session:
        rows = await session.execute(select(Chat).order_by(Chat.created_at.desc()))
        chats = rows.scalars().all()
        return [_chat_to_out(c) for c in chats]


@app.post("/api/chats", response_model=ChatOut)
async def create_chat(payload: CreateChatIn, request: Request):
    state: AppState = request.app.state.state
    chat = Chat(id=str(uuid4()), title=payload.title)
    async with session_scope(state.session_factory) as session:
        session.add(chat)
        await session.commit()
        await session.refresh(chat)
    return _chat_to_out(chat)


@app.get("/api/chats/{chat_id}/messages", response_model=list[MessageOut])
async def list_messages(chat_id: str, request: Request):
    state: AppState = request.app.state.state
    async with session_scope(state.session_factory) as session:
        chat = await session.get(Chat, chat_id)
        if not chat:
            raise HTTPException(status_code=404, detail="Чат не найден")
        await session.refresh(chat, attribute_names=["messages"])
        return [_message_to_out(m) for m in chat.messages]


@app.post("/api/chats/{chat_id}/send", response_model=MessageOut)
async def send_message(chat_id: str, payload: SendMessageIn, request: Request):
    state: AppState = request.app.state.state
    _require_gigachat_config(state.settings)

    async with session_scope(state.session_factory) as session:
        chat = await session.get(Chat, chat_id)
        if not chat:
            raise HTTPException(status_code=404, detail="Чат не найден")

        user_msg = Message(chat_id=chat_id, role="user", content=payload.content)
        session.add(user_msg)
        await session.flush()

        rows = await session.execute(
            select(Message)
            .where(Message.chat_id == chat_id)
            .order_by(Message.id.desc())
            .limit(state.settings.history_messages_limit)
        )
        history = list(reversed(rows.scalars().all()))

        gc_messages = [{"role": m.role, "content": m.content} for m in history]
        assistant_text = await state.gigachat.chat(gc_messages)

        assistant_msg = Message(chat_id=chat_id, role="assistant", content=assistant_text)
        session.add(assistant_msg)

        if not chat.title:
            chat.title = payload.content.strip().splitlines()[0][:200]

        await session.commit()
        await session.refresh(assistant_msg)
        return _message_to_out(assistant_msg)
