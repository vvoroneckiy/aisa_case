from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field


Role = Literal["system", "user", "assistant"]


class ChatOut(BaseModel):
    id: str
    title: Optional[str] = None
    created_at: datetime


class MessageOut(BaseModel):
    id: int
    chat_id: str
    role: Role
    content: str
    created_at: datetime


class CreateChatIn(BaseModel):
    title: Optional[str] = Field(default=None, max_length=200)


class SendMessageIn(BaseModel):
    content: str = Field(min_length=1)
