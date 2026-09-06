/* OpenZCode renderer — vanilla JS over window.openzcode bridge.
 * Everything domain-level goes through JSON-RPC to the CLI engine. */
"use strict";

const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* ---------------- state ---------------- */

const state = {
  workspace: "",
  sessions: [],
  currentSession: null,
  items: [],           // transcript items: user | assistant | tool | perm
  liveText: "",        // streaming assistant text
  running: false,
  runningSessions: new Set(),
  provider: null,
  config: null,
  settingsEditId: null,
  engineState: "starting",
};

/* ---------------- markdown-lite ---------------- */

function mdToHtml(text) {
  if (!text) return "";
  const blocks = String(text).split(/```/);
  return blocks
    .map((block, i) => {
      if (i % 2 === 1) {
        // code fence block (first line may carry a language tag)
        const nl = block.indexOf("\n");
        const code = nl >= 0 ? block.slice(nl + 1) : block;
        return `<pre><code>${esc(code.replace(/\n$/, ""))}</code></pre>`;
      }
      let html = esc(block);
      html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");
      html = html.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
      html = html.replace(/^### (.*)$/gm, "<h3>$1</h3>");
      html = html.replace(/^## (.*)$/gm, "<h2>$1</h2>");
      html = html.replace(/^# (.*)$/gm, "<h2>$1</h2>");
      html = html.replace(/^\s*[-*] (.*)$/gm, "<li>$1</li>");
      html = html.replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, "<ul>$1</ul>");
      html = html.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
      html = html.replace(/\n{2,}/g, "</p><p>");
      return `<p>${html}</p>`;
    })
    .join("");
}

/* ---------------- rendering ---------------- */

function nearBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
}
function scrollBottom() {
  const t = $("#transcript");
  if (nearBottom(t)) t.scrollTop = t.scrollHeight;
}

function toolSummary(name, input) {
  const i = input || {};
  if (name === "bash") return String(i.command || "").slice(0, 110);
  if (i.path) return String(i.path);
  if (i.pattern) return String(i.pattern);
  if (i.url) return String(i.url);
  return JSON.stringify(i).slice(0, 110);
}

function renderToolCard(item) {
  const card = document.createElement("div");
  card.className = "tool-card";
  card.dataset.toolId = item.id;
  card.innerHTML = `
    <div class="tool-head">
      <span class="t-icon">⚙</span>
      <span class="t-name">${esc(item.name)}</span>
      <span class="t-summary">${esc(toolSummary(item.name, item.input))}</span>
      <span class="t-status ${item.status}">${statusLabel(item.status, item.ms)}</span>
    </div>
    <div class="tool-body">
      <div class="t-label">输入</div>
      <pre>${esc(JSON.stringify(item.input, null, 2))}</pre>
      <div class="t-label">输出</div>
      <pre class="t-output">${esc(item.output || "")}</pre>
    </div>`;
  card.querySelector(".tool-head").addEventListener("click", () => card.classList.toggle("open"));
  return card;
}

function statusLabel(status, ms) {
  if (status === "running") return "运行中…";
  if (status === "ok") return `完成 ${ms != null ? ms + "ms" : ""}`;
  if (status === "error") return "失败";
  if (status === "denied") return "已拒绝";
  return "待执行";
}

function renderPermCard(item) {
  const card = document.createElement("div");
  card.className = "perm-card" + (item.status !== "pending" ? " resolved" : "");
  card.dataset.permId = item.id;
  const actions = item.status === "pending"
    ? `<div class="p-actions">
         <button class="btn primary p-allow">允许</button>
         <button class="btn p-always">本会话总是允许</button>
         <button class="btn danger p-deny">拒绝</button>
       </div>`
    : `<div class="p-result">结果: ${item.status === "allowed" ? "已允许" : "已拒绝"}</div>`;
  card.innerHTML = `
    <div class="p-head">⚠ 请求执行 <code>${esc(item.tool)}</code></div>
    <div class="p-detail">${esc(JSON.stringify(item.input, null, 2))}</div>
    ${actions}`;
  if (item.status === "pending") {
    card.querySelector(".p-allow").addEventListener("click", () => approve(item.id, true, false));
    card.querySelector(".p-always").addEventListener("click", () => approve(item.id, true, true));
    card.querySelector(".p-deny").addEventListener("click", () => approve(item.id, false, false));
  }
  return card;
}

function renderUserItem(item) {
  const el = document.createElement("div");
  el.className = "msg user";
  el.innerHTML = `<div class="role">你</div><div class="body">${mdToHtml(item.text)}</div>`;
  return el;
}

function renderAssistantItem(item) {
  const el = document.createElement("div");
  el.className = "msg assistant";
  el.innerHTML = `<div class="role">OpenZCode</div>`;
  for (const p of item.parts || []) {
    if (p.type === "text" && p.text) {
      const body = document.createElement("div");
      body.innerHTML = mdToHtml(p.text);
      el.appendChild(body);
    } else if (p.type === "tool_use") {
      const toolItem = state.items.find((x) => x.kind === "tool" && x.id === p.id);
      if (toolItem) el.appendChild(renderToolCard(toolItem));
    }
  }
  return el;
}

function renderTranscript() {
  const itemsEl = $("#items");
  itemsEl.textContent = "";
  for (const item of state.items) {
    if (item.kind === "user") itemsEl.appendChild(renderUserItem(item));
    else if (item.kind === "assistant") itemsEl.appendChild(renderAssistantItem(item));
    else if (item.kind === "tool") {
      // tool cards render inside their owning assistant bubble; a standalone
      // fallback would duplicate them, so skip here.
    } else if (item.kind === "perm") itemsEl.appendChild(renderPermCard(item));
  }
  if (state.liveText) {
    const el = document.createElement("div");
    el.className = "msg assistant live";
    el.innerHTML = `<div class="role">OpenZCode</div><div class="body">${mdToHtml(state.liveText)}<span class="streaming-cursor"></span></div>`;
    itemsEl.appendChild(el);
  }
  $("#empty-state").classList.toggle("hidden", state.items.length > 0 || !!state.liveText);
  scrollBottom();
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderTranscript(); });
}

/* update just the live bubble text (fast path during streaming) */
function updateLiveText() {
  const itemsEl = $("#items");
  const liveEl = itemsEl.querySelector(".msg.assistant.live");
  if (!liveEl) { scheduleRender(); return; }
  liveEl.innerHTML = `<div class="role">OpenZCode</div><div class="body">${mdToHtml(state.liveText)}<span class="streaming-cursor"></span></div>`;
  scrollBottom();
}

/* ---------------- event handling ---------------- */

function findToolItem(id) { return state.items.find((x) => x.kind === "tool" && x.id === id); }
function findPermItem(id) { return state.items.find((x) => x.kind === "perm" && x.id === id); }

function handleSessionEvent({ sessionId, event }) {
  // sidebar running-state tracking for background sessions
  if (event.type === "turn_started") state.runningSessions.add(sessionId);
  if (event.type === "turn_done") state.runningSessions.delete(sessionId);

  if (sessionId !== state.currentSession?.id) { renderSessions(); return; }

  switch (event.type) {
    case "turn_started":
      state.running = true;
      state.liveText = "";
      break;
    case "text_delta":
      state.liveText += event.text;
      updateLiveText();
      return; // no full re-render
    case "message": {
      const m = event.message;
      if (m.role === "user") {
        state.items.push({ kind: "user", id: m.id, text: (m.parts || []).map((p) => p.text || "").join("") });
      } else if (m.role === "assistant") {
        state.items.push({ kind: "assistant", id: m.id, parts: m.parts });
        // pre-create tool cards from tool_use parts
        for (const p of m.parts || []) {
          if (p.type === "tool_use" && !findToolItem(p.id)) {
            state.items.push({ kind: "tool", id: p.id, name: p.name, input: p.input, status: "pending", output: "" });
          }
        }
        state.liveText = "";
      } else if (m.role === "tool") {
        // bookkeeping; outputs arrive via tool_end
        return;
      }
      break;
    }
    case "tool_start": {
      const t = findToolItem(event.id);
      if (t) { t.status = "running"; t.input = event.input ?? t.input; }
      break;
    }
    case "tool_end": {
      const t = findToolItem(event.id);
      if (t) { t.status = event.ok ? "ok" : "error"; t.output = event.output || ""; t.ms = event.ms; }
      break;
    }
    case "permission_request":
      state.items.push({ kind: "perm", id: event.id, tool: event.tool, input: event.input, status: "pending" });
      break;
    case "permission_resolved": {
      const p = findPermItem(event.id);
      if (p) p.status = event.allow ? "allowed" : "denied";
      break;
    }
    case "todo_updated":
      renderTodos(event.items);
      break;
    case "usage": {
      const b = $("#usage-badge");
      b.classList.remove("hidden");
      b.textContent = `${event.promptTokens} in / ${event.completionTokens} out`;
      break;
    }
    case "session_updated":
      if (state.currentSession) state.currentSession.title = event.title;
      renderSessions();
      return;
    case "turn_done": {
      state.running = false;
      state.liveText = "";
      setComposerRunning(false);
      if (!event.ok && !event.aborted) toast(`任务出错: ${event.error}`);
      if (event.aborted) toast("已停止当前任务", "info");
      state.runningSessions.delete(sessionId);
      refreshSessions();
      break;
    }
    default: return;
  }
  scheduleRender();
}

/* ---------------- actions ---------------- */

async function rpc(method, params) {
  return window.openzcode.invoke(method, params);
}

async function approve(permId, allow, always) {
  if (!state.currentSession) return;
  try {
    await rpc("session/approve", { sessionId: state.currentSession.id, id: permId, allow, always });
  } catch (e) { toast(`审批失败: ${e.message}`); }
}

async function ensureSession() {
  if (state.currentSession) return state.currentSession;
  const s = await rpc("session/create", { workspace: state.workspace });
  state.currentSession = s;
  renderSessions();
  return s;
}

async function sendMessage(text) {
  if (state.running) return;
  try {
    const session = await ensureSession();
    state.items = [];           // fresh render of this turn's flow
    state.liveText = "";
    state.running = true;
    setComposerRunning(true);
    scheduleRender();
    await rpc("session/send", { sessionId: session.id, text });
  } catch (e) {
    state.running = false;
    setComposerRunning(false);
    toast(`发送失败: ${e.message}`);
  }
}

async function stopSession() {
  if (!state.currentSession) return;
  try { await rpc("session/stop", { sessionId: state.currentSession.id }); } catch {}
}

async function refreshSessions() {
  try {
    state.sessions = await rpc("session/list", { workspace: state.workspace });
    renderSessions();
  } catch {}
}

async function openSession(id) {
  try {
    const msgs = await rpc("session/messages", { sessionId: id });
    const session = state.sessions.find((s) => s.id === id) || { id, title: "会话" };
    state.currentSession = session;
    state.running = state.runningSessions.has(id);
    setComposerRunning(state.running);
    state.items = [];
    state.liveText = "";
    for (const m of msgs) {
      if (m.role === "user") {
        state.items.push({ kind: "user", id: m.id, text: (m.parts || []).map((p) => p.text || "").join("") });
      } else if (m.role === "assistant") {
        state.items.push({ kind: "assistant", id: m.id, parts: m.parts });
        for (const p of m.parts || []) {
          if (p.type === "tool_use") {
            state.items.push({ kind: "tool", id: p.id, name: p.name, input: p.input, status: "pending", output: "" });
          }
        }
      } else if (m.role === "tool") {
        for (const p of m.parts || []) {
          if (p.type === "tool_result") {
            const t = findToolItem(p.tool_use_id);
            if (t) { t.status = p.is_error ? "error" : "ok"; t.output = typeof p.content === "string" ? p.content : JSON.stringify(p.content); }
          }
        }
      }
    }
    // tool cards without results from history: derive final status
    for (const item of state.items) {
      if (item.kind === "tool" && item.status === "pending") item.status = "ok";
    }
    $("#session-title").textContent = session.title || "会话";
    renderTodos(await rpc("session/todos", { sessionId: id }).catch(() => []));
    renderSessions();
    scheduleRender();
  } catch (e) { toast(`打开会话失败: ${e.message}`); }
}

async function newSession() {
  const s = await rpc("session/create", { workspace: state.workspace }).catch((e) => { toast(e.message); return null; });
  if (!s) return;
  state.currentSession = s;
  state.items = [];
  state.liveText = "";
  state.running = false;
  setComposerRunning(false);
  $("#session-title").textContent = s.title;
  $("#usage-badge").classList.add("hidden");
  renderTodos([]);
  refreshSessions();
  scheduleRender();
  $("#input").focus();
}

/* ---------------- sidebar / chrome ---------------- */

function renderSessions() {
  const list = $("#session-list");
  list.textContent = "";
  for (const s of state.sessions.slice(0, 40)) {
    const el = document.createElement("div");
    el.className = "session-item" + (state.currentSession?.id === s.id ? " active" : "");
    el.innerHTML = `
      <span class="s-title">${esc(s.title || "会话")}</span>
      <span class="s-meta">
        <span>${esc((s.updatedAt || s.updated_at || "").slice(0, 16).replace("T", " "))}</span>
        ${state.runningSessions.has(s.id) ? '<span class="s-running">● 运行中</span>' : ""}
      </span>`;
    el.addEventListener("click", () => openSession(s.id));
    list.appendChild(el);
  }
}

function renderTodos(items) {
  const panel = $("#todo-panel");
  if (!items || !items.length) { panel.classList.add("hidden"); return; }
  panel.classList.remove("hidden");
  const box = $("#todo-items");
  box.textContent = "";
  for (const t of items) {
    const el = document.createElement("div");
    el.className = "todo-item" + (t.status === "completed" ? " done" : "");
    const mark = t.status === "completed" ? "☑" : t.status === "in_progress" ? "◐" : "○";
    el.innerHTML = `<span class="t-mark">${mark}</span><span>${esc(t.content)}</span>`;
    box.appendChild(el);
  }
}

function setComposerRunning(running) {
  $("#btn-send").classList.toggle("hidden", running);
  $("#btn-stop").classList.toggle("hidden", !running);
}

function toast(msg, cls = "") {
  const zone = $("#toast-zone");
  const el = document.createElement("div");
  el.className = "toast " + cls;
  el.innerHTML = `<span>${esc(msg)}</span><button class="icon-btn">✕</button>`;
  el.querySelector("button").addEventListener("click", () => el.remove());
  zone.appendChild(el);
  setTimeout(() => el.remove(), 12000);
}

function setEngineStatus(s) {
  state.engineState = s.state;
  const dot = $("#engine-dot"), text = $("#engine-text");
  dot.className = "dot " + s.state;
  const map = {
    starting: "引擎启动中…", ready: "引擎就绪", crashed: "引擎崩溃", restarting: "重启中…",
    stopped: "已停止", error: s.message || "错误",
  };
  text.textContent = map[s.state] || s.state;
}

/* ---------------- settings ---------------- */

async function loadConfig() {
  state.config = await rpc("config/get");
  const def = state.config.providers.find((p) => p.id === state.config.defaultProviderId) || state.config.providers[0];
  state.provider = def || null;
  $("#provider-name").textContent = def ? `${def.name} · ${def.model}` : "未配置模型 — 点击 ⚙";
  $("#model-badge").textContent = def ? `${def.model}` : "未配置模型";
  const chip = $("#permission-mode-chip");
  chip.textContent = state.config.permissionMode;
  chip.className = "chip " + state.config.permissionMode;
  renderSettings();
}

function renderSettings() {
  const cfg = state.config;
  const list = $("#provider-list");
  list.textContent = "";
  for (const p of cfg.providers) {
    const el = document.createElement("div");
    el.className = "provider-item";
    el.innerHTML = `
      <span class="p-name">${esc(p.name)}</span>
      <span class="p-detail">${esc(p.model)} @ ${esc(p.baseUrl)} [${esc(p.protocol)}]</span>
      ${p.id === cfg.defaultProviderId ? '<span class="default-tag">默认</span>' : ""}
      <button class="icon-btn a-use" title="设为默认">↩</button>
      <button class="icon-btn a-edit" title="编辑">✎</button>
      <button class="icon-btn a-del" title="删除">🗑</button>`;
    el.querySelector(".a-use").addEventListener("click", async () => {
      state.config = await rpc("config/setDefaultProvider", { idOrName: p.id });
      await loadConfig();
    });
    el.querySelector(".a-edit").addEventListener("click", () => fillProviderForm(p));
    el.querySelector(".a-del").addEventListener("click", async () => {
      state.config = await rpc("config/removeProvider", { idOrName: p.id });
      await loadConfig();
    });
    list.appendChild(el);
  }

  document.querySelectorAll('input[name="perm"]').forEach((r) => { r.checked = r.value === cfg.permissionMode; });

  const about = $("#about-line");
  if (about) about.textContent = `OpenZCode MVP — CLI + Electron App · app-server over stdio JSON-RPC · workspace: ${state.workspace}`;
}

function fillProviderForm(p) {
  state.settingsEditId = p?.id || null;
  $("#pf-title").textContent = p ? `编辑 Provider: ${p.name}` : "添加 Provider";
  $("#pf-name").value = p?.name || "";
  $("#pf-model").value = p?.model || "";
  $("#pf-baseurl").value = p?.baseUrl || "";
  $("#pf-apikey").value = ""; // never echo keys; empty = keep existing on edit
  $("#pf-apikey").placeholder = p?.hasKey ? "已保存(留空保持不变)" : "sk-…";
  $("#pf-protocol").value = p?.protocol || "openai";
  $("#pf-default").checked = p ? state.config.defaultProviderId === p.id : false;
}

async function saveProvider() {
  const payload = {
    id: state.settingsEditId || undefined,
    name: $("#pf-name").value.trim() || $("#pf-model").value.trim(),
    model: $("#pf-model").value.trim(),
    baseUrl: $("#pf-baseurl").value.trim(),
    apiKey: $("#pf-apikey").value.trim(),
    protocol: $("#pf-protocol").value,
    setDefault: $("#pf-default").checked,
  };
  if (!payload.baseUrl || !payload.model) { toast("Base URL 与模型必填"); return; }
  if (!payload.id && !payload.apiKey) { toast("请填写 API Key"); return; }
  if (payload.id && !payload.apiKey) delete payload.apiKey; // keep stored key
  try {
    state.config = await rpc("config/setProvider", payload);
    await loadConfig();
    fillProviderForm(null);
    $("#pf-test-result").textContent = "已保存 ✓";
    $("#pf-test-result").className = "test-result ok";
  } catch (e) { toast(`保存失败: ${e.message}`); }
}

async function testProviderForm() {
  const el = $("#pf-test-result");
  el.textContent = "测试中…"; el.className = "test-result";
  const provider = {
    name: $("#pf-name").value.trim() || "test",
    model: $("#pf-model").value.trim(),
    baseUrl: $("#pf-baseurl").value.trim(),
    apiKey: $("#pf-apikey").value.trim() || (state.settingsEditId ? "__STORED__" : ""),
    protocol: $("#pf-protocol").value,
  };
  try {
    if (provider.apiKey === "__STORED__") {
      const stored = state.config.providers.find((p) => p.id === state.settingsEditId);
      const r = await rpc("config/testProvider", { idOrName: stored?.id || stored?.name });
      el.textContent = r.message; el.className = "test-result " + (r.ok ? "ok" : "err");
      return;
    }
    const r = await rpc("config/testProvider", { provider });
    el.textContent = r.message; el.className = "test-result " + (r.ok ? "ok" : "err");
  } catch (e) {
    el.textContent = e.message; el.className = "test-result err";
  }
}

/* ---------------- boot ---------------- */

function bindEvents() {
  $("#btn-new-session").addEventListener("click", newSession);

  const input = $("#input");
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      const text = input.value.trim();
      if (text && !state.running) { input.value = ""; autoGrow(); sendMessage(text); }
    }
  });
  input.addEventListener("input", autoGrow);
  function autoGrow() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 180) + "px"; }

  $("#btn-send").addEventListener("click", () => {
    const text = input.value.trim();
    if (text && !state.running) { input.value = ""; autoGrow(); sendMessage(text); }
  });
  $("#btn-stop").addEventListener("click", stopSession);

  $("#btn-settings").addEventListener("click", async () => {
    $("#settings-modal").classList.remove("hidden");
    await loadConfig();
  });
  $("#btn-close-settings").addEventListener("click", () => $("#settings-modal").classList.add("hidden"));
  $("#settings-modal").addEventListener("click", (e) => {
    if (e.target === $("#settings-modal")) $("#settings-modal").classList.add("hidden");
  });
  $("#pf-save").addEventListener("click", saveProvider);
  $("#pf-test").addEventListener("click", testProviderForm);

  document.querySelectorAll('input[name="perm"]').forEach((r) =>
    r.addEventListener("change", async () => {
      state.config = await rpc("config/setOptions", { permissionMode: r.value });
      await loadConfig();
    })
  );

  $("#btn-pick-workspace").addEventListener("click", async () => {
    const r = await rpc("workspace/pick");
    if (r?.picked && r.picked !== state.workspace) {
      state.workspace = r.picked;
      $("#workspace-path").textContent = r.picked;
      $("#workspace-path").title = r.picked;
      state.currentSession = null;
      state.items = [];
      $("#session-title").textContent = "新会话";
      renderTodos([]);
      scheduleRender();
      await refreshSessions();
      toast("已切换工作目录，引擎已重启", "info");
    }
  });

  window.openzcode.onEvent(handleSessionEvent);
  window.openzcode.onStatus(async (s) => {
    setEngineStatus(s);
    if (s.state === "ready") {
      await loadConfig().catch(() => {});
      await refreshSessions();
    }
  });
}

async function boot() {
  bindEvents();
  const st = await rpc("app/state");
  state.workspace = st.workspace;
  $("#workspace-path").textContent = st.workspace;
  $("#workspace-path").title = st.workspace;
  setEngineStatus({ state: st.engineReady ? "ready" : "starting" });
  await loadConfig().catch(() => {});
  await refreshSessions();
  // resume most recent session, else start clean
  if (state.sessions.length) await openSession(state.sessions[0].id);
}

boot().catch((e) => toast(`初始化失败: ${e.message}`));
