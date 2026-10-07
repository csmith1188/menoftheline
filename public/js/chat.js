/**
 * In-match chat panel (bottom-left bubble + full-board overlay).
 */

function escapeText(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function bindChat(options = {}) {
  const socket = options.socket;
  const onOpen = options.onOpen;
  const onPauseClear = options.onPauseClear;
  const btn = document.getElementById("chat-btn");
  const panel = document.getElementById("chat");
  const log = document.getElementById("chat-log");
  const form = document.getElementById("chat-form");
  const input = document.getElementById("chat-input");
  if (!btn || !panel || !log || !form || !input || !socket) {
    return {
      open() {},
      close() {},
      isOpen() { return false; },
      applyLobby() {},
      setPauseAlert() {},
    };
  }

  const seen = new Set();
  let enabled = true;
  let selfName = "";
  let pauseAlert = false;

  function setChromeVisible(on) {
    btn.classList.toggle("hidden", !on);
    if (!on) close();
  }

  function isOpen() {
    return !panel.classList.contains("hidden");
  }

  function clearUnread() {
    btn.classList.remove("has-unread");
  }

  function markUnread() {
    if (!enabled || isOpen()) return;
    btn.classList.add("has-unread");
  }

  function setPauseAlert(on) {
    pauseAlert = Boolean(on);
    btn.classList.toggle("pause-alert", pauseAlert && enabled);
  }

  function clearPauseAlert() {
    if (!pauseAlert) return;
    setPauseAlert(false);
    socket.emit("pauseSeen");
    if (onPauseClear) onPauseClear();
  }

  function scrollToBottom() {
    log.scrollTop = log.scrollHeight;
  }

  function renderMessage(msg) {
    if (!msg || !msg.id || seen.has(msg.id)) return false;
    seen.add(msg.id);
    const row = document.createElement("p");
    row.className = msg.kind === "system" ? "chat-line chat-line-system" : "chat-line";
    row.dataset.id = msg.id;
    if (msg.kind === "system") {
      row.textContent = msg.text || "";
    } else {
      const name = (msg.from && msg.from.name) || "Player";
      row.innerHTML = `<span class="chat-from">${escapeText(name)}</span>: ${escapeText(msg.text || "")}`;
    }
    log.appendChild(row);
    return true;
  }

  function replaceHistory(history) {
    seen.clear();
    log.replaceChildren();
    if (!Array.isArray(history)) return;
    for (let i = 0; i < history.length; i += 1) {
      renderMessage(history[i]);
    }
    if (isOpen()) scrollToBottom();
  }

  function close() {
    panel.classList.add("hidden");
    btn.setAttribute("aria-expanded", "false");
  }

  function open() {
    if (!enabled) return;
    const wasHidden = !isOpen();
    panel.classList.remove("hidden");
    btn.setAttribute("aria-expanded", "true");
    clearUnread();
    clearPauseAlert();
    scrollToBottom();
    if (wasHidden && onOpen) onOpen();
    input.focus();
  }

  function toggle() {
    if (isOpen()) close();
    else open();
  }

  function applyLobby(lobbyState) {
    if (!lobbyState) return;
    if (lobbyState.you && lobbyState.you.name) {
      selfName = String(lobbyState.you.name);
    }
    if (typeof lobbyState.chatEnabled === "boolean") {
      enabled = lobbyState.chatEnabled;
      setChromeVisible(enabled);
    }
    if (enabled && Array.isArray(lobbyState.chatHistory)) {
      replaceHistory(lobbyState.chatHistory);
    }
    if (typeof lobbyState.pauseAlert === "boolean") {
      setPauseAlert(lobbyState.pauseAlert);
      if (lobbyState.pauseAlert && isOpen()) clearPauseAlert();
    }
  }

  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    toggle();
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!enabled) return;
    const text = String(input.value || "").trim();
    if (!text) return;
    socket.emit("chat", { text });
    input.value = "";
  });

  document.addEventListener("pointerdown", (event) => {
    if (!isOpen()) return;
    if (panel.contains(event.target) || event.target === btn) return;
    close();
  });

  socket.on("chat", (msg) => {
    if (!enabled) return;
    const added = renderMessage(msg);
    if (!added) return;
    if (isOpen()) {
      scrollToBottom();
      return;
    }
    const fromName = msg.from && msg.from.name ? String(msg.from.name) : "";
    const fromSelf = msg.kind === "user" && selfName && fromName === selfName;
    if (!fromSelf) markUnread();
  });

  setChromeVisible(true);

  return {
    open,
    close,
    isOpen,
    applyLobby,
    setPauseAlert,
  };
}
