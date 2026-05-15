const state = {
  chats: [],
  activeChatId: null,
  loading: false,
};

function $(id) {
  return document.getElementById(id);
}

function formatDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return "";
  }
}

function setStatus(text) {
  $("status").textContent = text || "";
}

function renderChats() {
  const list = $("chatList");
  list.innerHTML = "";

  for (const chat of state.chats) {
    const el = document.createElement("div");
    el.className = "chat-item" + (chat.id === state.activeChatId ? " active" : "");
    
    // Контейнер для содержимого чата
    const content = document.createElement("div");
    content.className = "chat-content";
    
    // Верхняя строка: название и кнопка удаления
    const headerRow = document.createElement("div");
    headerRow.className = "chat-header-row";
    
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = chat.title || "Новый чат";
    
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "delete-chat-btn";
    deleteBtn.innerHTML = "✕";
    deleteBtn.title = "Удалить чат";
    deleteBtn.onclick = (e) => {
      e.stopPropagation();
      deleteChat(chat.id);
    };
    
    headerRow.appendChild(title);
    headerRow.appendChild(deleteBtn);
    
    // Дата создания
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = formatDate(chat.created_at);
    
    content.appendChild(headerRow);
    content.appendChild(meta);
    el.appendChild(content);
    
    el.addEventListener("click", () => openChat(chat.id));
    list.appendChild(el);
  }
}

async function deleteChat(chatId) {
  // Находим название чата для подтверждения
  const chat = state.chats.find(c => c.id === chatId);
  const chatTitle = chat?.title || "Новый чат";
  
  // Подтверждение удаления
  if (!confirm(`Вы уверены, что хотите удалить чат "${chatTitle}"? Все сообщения будут потеряны.`)) {
    return;
  }
  
  setStatus("Удаление...");
  
  try {
    // Отправляем запрос на удаление
    const response = await fetch(`/api/chats/${chatId}`, { method: "DELETE" });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || "Ошибка удаления");
    }
    
    // Удаляем чат из списка
    const index = state.chats.findIndex(c => c.id === chatId);
    if (index !== -1) {
      state.chats.splice(index, 1);
    }
    
    // Если удалили активный чат, переключаемся на другой
    if (state.activeChatId === chatId) {
      if (state.chats.length > 0) {
        await openChat(state.chats[0].id);
      } else {
        state.activeChatId = null;
        await createChat();
      }
    }
    
    renderChats();
    setStatus("Чат удалён");
    setTimeout(() => setStatus(""), 2000);
  } catch (e) {
    setStatus(String(e.message || e));
    setTimeout(() => setStatus(""), 3000);
  }
}

// Функция для рендеринга Markdown и формул
function renderMarkdownWithMath(content) {
  // Сначала рендерим Markdown в HTML
  const html = marked.parse(content);
  
  // Создаём временный контейнер
  const temp = document.createElement('div');
  temp.innerHTML = html;
  
  // Рендерим формулы KaTeX
  if (typeof renderMathInElement === 'function') {
    renderMathInElement(temp, {
      delimiters: [
        {left: '$$', right: '$$', display: true},
        {left: '$', right: '$', display: false},
        {left: '\\(', right: '\\)', display: false},
        {left: '\\[', right: '\\]', display: true}
      ],
      throwOnError: false,
      errorColor: '#cc0000'
    });
  }
  
  return temp.innerHTML;
}

async function renderMessages(messages) {
  const box = $("messages");
  box.innerHTML = "";

  for (const m of messages) {
    const row = document.createElement("div");
    row.className = "msg";

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = m.role === "user" ? "Я" : "AI";

    const bubble = document.createElement("div");
    bubble.className = "bubble " + (m.role === "user" ? "user" : "assistant");

    if (m.role === "user") {
      bubble.textContent = m.content;
    } else {
      try {
        bubble.innerHTML = renderMarkdownWithMath(m.content);
      } catch (e) {
        console.error("Render error:", e);
        bubble.textContent = m.content;
      }
    }

    row.appendChild(avatar);
    row.appendChild(bubble);
    box.appendChild(row);
  }

  box.scrollTop = box.scrollHeight;
}

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      detail = j.detail || detail;
    } catch {}
    throw new Error(detail);
  }
  return await res.json();
}

async function loadChats() {
  state.chats = await api("GET", "/api/chats");
  renderChats();
}

async function createChat() {
  const chat = await api("POST", "/api/chats", {});
  state.chats.unshift(chat);
  state.activeChatId = chat.id;
  renderChats();
  $("chatTitle").textContent = chat.title || "Новый чат";
  await renderMessages([]);
}

async function openChat(chatId) {
  state.activeChatId = chatId;
  renderChats();

  const chat = state.chats.find((c) => c.id === chatId);
  $("chatTitle").textContent = (chat && chat.title) || "Чат";

  setStatus("Загрузка…");
  try {
    const messages = await api("GET", `/api/chats/${encodeURIComponent(chatId)}/messages`);
    await renderMessages(messages);
  } finally {
    setStatus("");
  }
}

function setLoading(v) {
  state.loading = v;
  $("sendBtn").disabled = v;
  $("messageInput").disabled = v;
}

async function sendCurrent() {
  const input = $("messageInput");
  const text = input.value.trim();
  if (!text) return;

  if (!state.activeChatId) {
    await createChat();
  }

  const chatId = state.activeChatId;
  setLoading(true);
  setStatus("Думаю…");

  try {
    const messages = await api("GET", `/api/chats/${encodeURIComponent(chatId)}/messages`);
    messages.push({ role: "user", content: text });
    await renderMessages(messages);
    input.value = "";
    input.style.height = "";

    await api("POST", `/api/chats/${encodeURIComponent(chatId)}/send`, { content: text });

    await loadChats();
    state.activeChatId = chatId;
    renderChats();

    const updated = await api("GET", `/api/chats/${encodeURIComponent(chatId)}/messages`);
    await renderMessages(updated);
  } catch (e) {
    setStatus(String(e.message || e));
  } finally {
    setLoading(false);
    setTimeout(() => setStatus(""), 2500);
  }
}

function autoresizeTextarea(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 180) + "px";
}

window.addEventListener("DOMContentLoaded", async () => {
  $("newChatBtn").addEventListener("click", async () => {
    await createChat();
  });

  const input = $("messageInput");
  input.addEventListener("input", () => autoresizeTextarea(input));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendCurrent();
    }
  });

  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    sendCurrent();
  });

  setStatus("Загрузка…");
  try {
    await loadChats();
    if (state.chats.length === 0) {
      await createChat();
    } else {
      await openChat(state.chats[0].id);
    }
  } catch (e) {
    setStatus(String(e.message || e));
  } finally {
    setTimeout(() => setStatus(""), 2500);
  }
});