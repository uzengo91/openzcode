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

function renderQuestionCard(item) {
  const card = document.createElement("div");
  card.className = "question-card" + (item.status !== "pending" ? " resolved" : "");
  card.dataset.qid = item.id;
  const optsHtml = (item.options || []).map((o, i) => {
    const label = typeof o === "string" ? o : o.label || "";
    const desc = typeof o === "string" ? "" : o.description || "";
    return item.status === "pending"
      ? `<button class="q-opt" data-i="${i}"><span class="q-label">${esc(label)}</span>${desc ? `<span class="q-desc">${esc(desc)}</span>` : ""}</button>`
      : "";
  }).join("");
  card.innerHTML = `
    <div class="q-head">❓ ${esc(item.header || "请选择")} — ${esc(item.question)}</div>
    ${item.status === "pending" ? `<div class="q-opts">${optsHtml}<button class="q-opt q-other">其他(自由回答)</button></div>` : `<div class="q-result">已选择: ${esc((item.answers || []).join(", "))}</div>`}`;
  if (item.status === "pending") {
    card.querySelectorAll(".q-opt[data-i]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const opt = item.options[Number(btn.dataset.i)];
        const label = typeof opt === "string" ? opt : opt.label;
        await rpc("session/answer", { id: item.id, answers: [label] });
      });
    });
    const other = card.querySelector(".q-other");
    if (other) other.addEventListener("click", async () => {
      const text = prompt("你的回答:");
      if (text != null) await rpc("session/answer", { id: item.id, answers: [text] });
    });
  }
  return card;
}

function renderPlanCard(item) {
  const card = document.createElement("div");
  card.className = "plan-card" + (item.status !== "pending" ? " resolved" : "");
  const body = document.createElement("div");
  body.innerHTML = `<div class="pl-head">📋 实施计划 ${item.status === "pending" ? "(等待批准)" : item.status === "approved" ? "— 已批准 ✓" : "— 已拒绝"}</div>
    <div class="pl-body">${mdToHtml(item.plan)}</div>`;
  card.appendChild(body);
  if (item.status === "pending") {
    const actions = document.createElement("div");
    actions.className = "p-actions";
    actions.innerHTML = `<button class="btn primary">✓ 批准并执行</button><button class="btn danger">✗ 拒绝</button>`;
    actions.children[0].addEventListener("click", async () => {
      if (state.currentSession) await rpc("session/approvePlan", { sessionId: state.currentSession.id, id: item.id, allow: true });
    });
    actions.children[1].addEventListener("click", async () => {
      if (state.currentSession) await rpc("session/approvePlan", { sessionId: state.currentSession.id, id: item.id, allow: false });
    });
    card.appendChild(actions);
  }
  return card;
}

function renderSubagentCard(item) {
  const el = document.createElement("div");
  el.className = "subagent-card";
  const icon = item.status === "running" ? '<span class="s-icon s-spin">◐</span>' : item.status === "done" ? '<span class="s-icon s-ok">✓</span>' : '<span class="s-icon s-err">✗</span>';
  el.innerHTML = `${icon}<span><b>子代理</b> [${esc(item.agentType || "general-purpose")}] ${esc(item.description)}</span>${item.status === "running" && item.lastTool ? `<span class="s-meta">· ${esc(item.lastTool)}…</span>` : ""}`;
  return el;
}

function renderCompactCard(item) {
  const el = document.createElement("div");
  el.className = "compact-card";
  el.textContent = item.status === "running"
    ? `🗜 正在压缩会话… (${item.tokens || "?"} tokens / ${item.messages || "?"} 条消息)`
    : "🗜 会话已压缩, 旧消息已替换为摘要";
  return el;
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
    else if (item.kind === "question") itemsEl.appendChild(renderQuestionCard(item));
    else if (item.kind === "plan") itemsEl.appendChild(renderPlanCard(item));
    else if (item.kind === "subagent") itemsEl.appendChild(renderSubagentCard(item));
    else if (item.kind === "compact") itemsEl.appendChild(renderCompactCard(item));
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
    case "skill_loaded":
      toast(`已加载技能 ${event.name}`, "info");
      return;
    case "question_request":
      state.items.push({ kind: "question", id: event.id, question: event.question, header: event.header, options: event.options || [], multiSelect: !!event.multiSelect, status: "pending" });
      break;
    case "question_resolved": {
      const q = state.items.find((x) => x.kind === "question" && x.id === event.id);
      if (q) { q.status = "resolved"; q.answers = event.answers || []; }
      break;
    }
    case "plan_request":
      state.items.push({ kind: "plan", id: event.id, plan: event.plan || "", status: "pending" });
      break;
    case "plan_resolved": {
      const pl = state.items.find((x) => x.kind === "plan" && x.id === event.id);
      if (pl) { pl.status = event.allow ? "approved" : "rejected"; }
      break;
    }
    case "subagent_started":
      state.items.push({ kind: "subagent", id: event.id, description: event.description, agentType: event.agentType, status: "running" });
      break;
    case "subagent_progress": {
      const sg = state.items.filter((x) => x.kind === "subagent").find((x) => x.id === event.id);
      if (sg) sg.lastTool = event.tool;
      return; // avoid full re-render churn
    }
    case "subagent_finished": {
      const sg2 = state.items.filter((x) => x.kind === "subagent").find((x) => x.id === event.id);
      if (sg2) { sg2.status = event.ok ? "done" : "error"; sg2.lastTool = null; }
      break;
    }
    case "compact_started":
      state.items.push({ kind: "compact", id: "compact_" + Date.now(), tokens: event.tokens, messages: event.messages, status: "running" });
      break;
    case "compact_done": {
      const cc = [...state.items].reverse().find((x) => x.kind === "compact");
      if (cc) cc.status = event.compacted ? "done" : "skipped";
      break;
    }
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
    // custom slash commands (plugins / user / project) expand before sending
    let prompt = text;
    if (text.startsWith("/")) {
      const expanded = await rpc("commands/expand", { text }).catch(() => null);
      if (expanded && expanded.prompt) {
        prompt = expanded.prompt;
        toast(`命令 /${expanded.name} 已展开`, "info");
      }
    }
    state.items = [];           // fresh render of this turn's flow
    state.liveText = "";
    state.running = true;
    setComposerRunning(true);
    scheduleRender();
    await rpc("session/send", { sessionId: session.id, text: prompt });
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

/* ---------------- extensions UI: MCP + Skills ---------------- */

async function loadExtensions() {
  try {
    const list = await rpc("mcp/list");
    renderMcpServers(list || []);
  } catch {}
  try {
    const skills = await rpc("skills/list");
    renderSkills(skills || []);
  } catch {}
}

const MCP_STATUS_LABEL = {
  running: ["running", "运行中"], starting: ["starting", "启动中…"], stopped: ["stopped", "已停止"],
  error: ["error", "错误"], crashed: ["error", "已崩溃"], disabled: ["stopped", "已禁用"],
};

function renderMcpServers(list) {
  const box = $("#mcp-list");
  box.textContent = "";
  for (const s of list) {
    const [cls, label] = MCP_STATUS_LABEL[s.status] || ["stopped", s.status];
    const el = document.createElement("div");
    el.className = "provider-item";
    el.innerHTML = `
      <span class="dot ${cls}" title="${label}"></span>
      <span class="p-name">${esc(s.name)}</span>
      <span class="p-detail">[${esc(s.type)}] ${esc(s.command)} · ${s.toolCount} 工具 · ${esc(s.source)}${s.error ? " · ⚠ " + esc(s.error) : ""}</span>
      <button class="icon-btn a-toggle">${s.enabled ? "禁用" : "启用"}</button>`;
    el.querySelector(".a-toggle").addEventListener("click", async () => {
      await rpc("mcp/toggle", { name: s.name });
      await loadExtensions();
    });
    box.appendChild(el);
  }
  if (!list.length) {
    box.innerHTML = '<div class="about">暂无 MCP 服务器 — 用下方表单添加，或在项目 .mcp.json 配置</div>';
  }
}

function renderSkills(skills) {
  const box = $("#skills-list");
  box.textContent = "";
  for (const s of skills) {
    const el = document.createElement("div");
    el.className = "provider-item";
    el.innerHTML = `
      <span class="dot ready"></span>
      <span class="p-name">${esc(s.name)}</span>
      <span class="p-detail" title="${esc(s.description)}">${esc(s.description || "(无描述)")} · ${esc(s.scope)}</span>`;
    box.appendChild(el);
  }
  if (!skills.length) {
    box.innerHTML = '<div class="about">暂无技能 — 在 ~/.openzcode/skills/<名称>/SKILL.md 创建，或安装插件</div>';
  }
}

async function saveMcpForm() {
  const name = $("#mcp-name").value.trim();
  const type = $("#mcp-type").value;
  const msg = $("#mcp-save-msg");
  if (!name) { msg.textContent = "名称必填"; msg.className = "test-result err"; return; }
  const server = {};
  if (type === "http") {
    server.url = $("#mcp-url").value.trim();
    if (!server.url) { msg.textContent = "URL 必填"; msg.className = "test-result err"; return; }
    try { server.headers = JSON.parse($("#mcp-headers").value.trim() || "{}"); }
    catch { msg.textContent = "Headers JSON 无效"; msg.className = "test-result err"; return; }
  } else {
    const parts = $("#mcp-command").value.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) { msg.textContent = "启动命令必填"; msg.className = "test-result err"; return; }
    server.command = parts[0];
    if (parts.length > 1) server.args = parts.slice(1);
  }
  msg.textContent = "保存中…"; msg.className = "test-result";
  try {
    const { servers = {} } = await rpc("mcp/userConfig");
    servers[name] = server;
    await rpc("mcp/saveUserConfig", { servers });
    msg.textContent = "已保存 ✓"; msg.className = "test-result ok";
    $("#mcp-name").value = ""; $("#mcp-command").value = ""; $("#mcp-url").value = ""; $("#mcp-headers").value = "";
    await loadExtensions();
  } catch (e) {
    msg.textContent = `失败: ${e.message}`; msg.className = "test-result err";
  }
}

/* ---------------- automations modal ---------------- */

function schedText(a) {
  const s = a.schedule || {};
  if (s.kind === "cron") return s.cron;
  if (s.kind === "once") return `${s.delayMinutes}分钟后·一次`;
  return `每${s.interval}${{ minute: "分", hour: "时", day: "天" }[s.unit] || s.unit}`;
}

async function loadAutomations() {
  const box = $("#automation-list");
  let list = [];
  try { list = await rpc("automation/list"); } catch (e) { box.textContent = `加载失败: ${e.message}`; return; }
  box.textContent = "";
  if (!list.length) { box.innerHTML = '<div class="about">暂无自动化 — 用下方表单创建，或在对话里让模型用 CronCreate 创建</div>'; return; }
  for (const a of list) {
    const el = document.createElement("div");
    el.className = "auto-item" + (a.status === "completed" ? " completed" : "");
    el.innerHTML = `
      <div class="a-top">
        <span class="dot ${a.enabled ? "ready" : "stopped"}"></span>
        <span class="a-name">${esc(a.name)}</span>
        <span class="a-sched">${esc(schedText(a))}</span>
      </div>
      <div class="a-meta">
        ${a.mode === "yolo" ? "🤖 yolo" : "🔒 ask"} · 状态 ${esc(a.status)} · 已运行 ${a.runCount}${a.maxRuns ? "/" + a.maxRuns : ""} 次
        ${a.nextRunAt ? ` · 下次 <b>${esc(a.nextRunAt.slice(0, 16).replace("T", " "))}</b>` : ""}
      </div>
      <div class="a-prompt" title="${esc(a.prompt)}">${esc(a.prompt.slice(0, 120))}</div>
      <div class="a-actions">
        <button class="btn a-run">立即运行</button>
        <button class="btn a-toggle">${a.enabled ? "暂停" : "启用"}</button>
        <button class="btn a-history">历史</button>
        <button class="btn danger a-del">删除</button>
      </div>
      <div class="a-runs hidden"></div>`;
    el.querySelector(".a-run").addEventListener("click", async () => {
      try { await rpc("automation/runNow", { id: a.id }); toast(`自动化「${a.name}」已触发`, "info"); await loadAutomations(); }
      catch (e) { toast(`触发失败: ${e.message}`); }
    });
    el.querySelector(".a-toggle").addEventListener("click", async () => {
      await rpc("automation/toggle", { id: a.id }).catch((e) => toast(e.message));
      await loadAutomations();
    });
    el.querySelector(".a-del").addEventListener("click", async () => {
      await rpc("automation/delete", { id: a.id }).catch((e) => toast(e.message));
      await loadAutomations();
    });
    el.querySelector(".a-history").addEventListener("click", async () => {
      const pane = el.querySelector(".a-runs");
      if (!pane.classList.contains("hidden")) { pane.classList.add("hidden"); return; }
      const runs = await rpc("automation/runs", { id: a.id }).catch(() => []);
      pane.innerHTML = runs.length
        ? runs.map((r) => `<div>${r.ok ? "✓" : "✗"} ${esc((r.startedAt || "").slice(0, 19).replace("T", " "))} ${r.error ? "⚠ " + esc(r.error) : ""} <span class="t-status ${r.ok ? "ok" : "error"}">${r.sessionId ? "会话 " + esc(r.sessionId.slice(0, 13)) + "…" : ""}</span></div>`).join("")
        : "<div>(无运行记录)</div>";
      pane.classList.remove("hidden");
    });
    box.appendChild(el);
  }
}

function bindAutomationsModal() {
  $("#btn-automations").addEventListener("click", async () => {
    $("#automations-modal").classList.remove("hidden");
    await loadAutomations();
  });
  $("#btn-close-automations").addEventListener("click", () => $("#automations-modal").classList.add("hidden"));
  $("#automations-modal").addEventListener("click", (e) => {
    if (e.target === $("#automations-modal")) $("#automations-modal").classList.add("hidden");
  });
  $("#auto-refresh").addEventListener("click", loadAutomations);

  $("#auto-kind").addEventListener("change", () => {
    const kind = $("#auto-kind").value;
    $("#auto-cron-wrap").classList.toggle("hidden", kind !== "cron");
    $("#auto-every-wrap").classList.toggle("hidden", kind !== "every");
    $("#auto-delay-wrap").classList.toggle("hidden", kind !== "once");
  });

  $("#auto-create").addEventListener("click", async () => {
    const msg = $("#auto-msg");
    const kind = $("#auto-kind").value;
    const params = {
      title: $("#auto-name").value.trim(),
      prompt: $("#auto-prompt").value.trim(),
      mode: $("#auto-mode").value,
      maxRuns: $("#auto-maxruns").value ? Number($("#auto-maxruns").value) : undefined,
    };
    if (kind === "cron") params.cron = $("#auto-cron").value.trim();
    else if (kind === "every") { params.interval = Number($("#auto-every").value); params.intervalUnit = $("#auto-unit").value; }
    else params.delayMinutes = Number($("#auto-delay").value);
    if (!params.title || !params.prompt) { msg.textContent = "名称与提示词必填"; msg.className = "test-result err"; return; }
    msg.textContent = "创建中…"; msg.className = "test-result";
    try {
      const row = await rpc("automation/create", params);
      msg.textContent = `已创建 ✓ 下次 ${row.nextRunAt?.slice(0, 16).replace("T", " ") || "-"}`;
      msg.className = "test-result ok";
      $("#auto-name").value = ""; $("#auto-prompt").value = ""; $("#auto-maxruns").value = "";
      await loadAutomations();
    } catch (e) {
      msg.textContent = e.message; msg.className = "test-result err";
    }
  });
}

/* ---------------- marketplace modal ---------------- */

async function loadMarketplace() {
  const box = $("#marketplace-list");
  box.innerHTML = '<div class="about">加载市场…</div>';
  const groups = await rpc("marketplace/list").catch((e) => [{ name: "错误", plugins: [], error: e.message }]);
  box.textContent = "";
  let any = false;
  for (const g of groups) {
    for (const p of g.plugins) {
      any = true;
      const card = document.createElement("div");
      card.className = "mkt-card";
      card.innerHTML = `
        <div class="m-name">${esc(p.name)} <span class="m-ver">v${esc(p.version)}</span></div>
        <div class="m-desc">${esc(p.description || "")}</div>
        <div class="m-foot">
          <span class="m-src">${esc(g.name)}${p._installed ? " · 已安装" : ""}</span>
          <button class="btn ${p._installed ? "" : "primary"} m-install">${p._installed ? "重装" : "安装"}</button>
        </div>`;
      card.querySelector(".m-install").addEventListener("click", async () => {
        card.querySelector(".m-install").textContent = "安装中…";
        try {
          await rpc("marketplace/install", { name: p.name, marketplace: g.name });
          toast(`插件 ${p.name} 安装成功`, "info");
          await loadMarketplace();
        } catch (e) {
          toast(`安装失败: ${e.message}`);
          card.querySelector(".m-install").textContent = "安装";
        }
      });
      box.appendChild(card);
    }
  }
  if (!any) box.innerHTML = '<div class="about">市场暂无插件</div>';
}

function bindMarketplaceModal() {
  $("#btn-marketplace").addEventListener("click", async () => {
    $("#marketplace-modal").classList.remove("hidden");
    await loadMarketplace();
  });
  $("#btn-close-marketplace").addEventListener("click", () => $("#marketplace-modal").classList.add("hidden"));
  $("#marketplace-modal").addEventListener("click", (e) => {
    if (e.target === $("#marketplace-modal")) $("#marketplace-modal").classList.add("hidden");
  });
  $("#mkt-refresh").addEventListener("click", loadMarketplace);
  $("#mkt-add").addEventListener("click", async () => {
    const msg = $("#mkt-msg");
    const target = $("#mkt-source").value.trim();
    if (!target) { msg.textContent = "请填写 URL 或目录"; msg.className = "test-result err"; return; }
    try {
      await rpc("marketplace/addSource", { name: $("#mkt-name").value.trim() || undefined, url: /^https?:/i.test(target) ? target : undefined, path: /^https?:/i.test(target) ? undefined : target });
      msg.textContent = "已添加 ✓"; msg.className = "test-result ok";
      $("#mkt-name").value = ""; $("#mkt-source").value = "";
      await loadMarketplace();
    } catch (e) { msg.textContent = e.message; msg.className = "test-result err"; }
  });
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

/* ---------------- memory & hooks modals (v0.5) ---------------- */

async function loadMemoryModal() {
  const list = await rpc("memory/list").catch(() => []);
  const box = $("#memory-list");
  box.textContent = "";
  for (const m of list) {
    const el = document.createElement("div");
    el.className = "provider-item";
    el.innerHTML = `<span class="dot ready"></span><span class="p-name">${esc(m.name)}</span><span class="p-detail">${esc(m.description || "")}</span><button class="icon-btn a-view">查看</button>`;
    el.querySelector(".a-view").addEventListener("click", async () => {
      const r = await rpc("memory/read", { name: m.name }).catch(() => ({ output: "读取失败" }));
      const detail = $("#memory-detail");
      detail.classList.remove("hidden");
      detail.querySelector("pre").textContent = r.output || "";
    });
    box.appendChild(el);
  }
  if (!list.length) box.innerHTML = '<div class="about">暂无记忆 — agent 会用 memory_write 自动记录, 也可在下方手动添加</div>';
}

function bindMemoryModal() {
  $("#btn-memory").addEventListener("click", async () => {
    $("#memory-modal").classList.remove("hidden");
    await loadMemoryModal();
  });
  $("#btn-close-memory").addEventListener("click", () => $("#memory-modal").classList.add("hidden"));
  $("#memory-modal").addEventListener("click", (e) => {
    if (e.target === $("#memory-modal")) $("#memory-modal").classList.add("hidden");
  });
  $("#mem-save").addEventListener("click", async () => {
    const msg = $("#mem-msg");
    const name = $("#mem-name").value.trim();
    const body = $("#mem-body").value.trim();
    if (!name || !body) { msg.textContent = "标识与内容必填"; msg.className = "test-result err"; return; }
    const r = await rpc("memory/write", { name, body, description: $("#mem-desc").value.trim() }).catch((e) => ({ ok: false, output: e.message }));
    msg.textContent = r.ok ? "已保存 ✓" : `失败: ${r.output}`;
    msg.className = "test-result " + (r.ok ? "ok" : "err");
    if (r.ok) { $("#mem-name").value = ""; $("#mem-body").value = ""; $("#mem-desc").value = ""; await loadMemoryModal(); }
  });
}

async function loadHooksModal() {
  const list = await rpc("hooks/list").catch(() => []);
  const box = $("#hooks-list");
  box.textContent = "";
  for (const h of list) {
    const el = document.createElement("div");
    el.className = "provider-item";
    el.innerHTML = `<span class="dot ${h.scope === "project" ? "ready" : "starting"}"></span><span class="p-name">${esc(h.event)}${h.tool ? ":" + esc(h.tool) : ""}</span><span class="p-detail">${esc(h.name)} · ${esc(h.scope)}</span>`;
    box.appendChild(el);
  }
  if (!list.length) box.innerHTML = '<div class="about">暂无 hooks — 在 ~/.openzcode/hooks/ 或项目 .openzcode/hooks/ 放置脚本</div>';
}

function bindHooksModal() {
  $("#btn-hooks").addEventListener("click", async () => {
    $("#hooks-modal").classList.remove("hidden");
    await loadHooksModal();
  });
  $("#btn-close-hooks").addEventListener("click", () => $("#hooks-modal").classList.add("hidden"));
  $("#hooks-modal").addEventListener("click", (e) => {
    if (e.target === $("#hooks-modal")) $("#hooks-modal").classList.add("hidden");
  });
}

/* ---------------- composer toolbar (mode/model/effort) ---------------- */

function bindComposerToolbar() {
  const modeSelect = $("#mode-select");
  modeSelect.addEventListener("change", async () => {
    const v = modeSelect.value;
    if (v === "plan") {
      // plan is a client hint: we just toast; actual plan flow uses EnterPlanMode tool.
      // Persisted mode remains ask/yolo for safety gating.
      toast("计划模式: 对话里说"先规划"或让模型 EnterPlanMode; 写操作将被拦截", "info");
      return;
    }
    await rpc("config/setOptions", { permissionMode: v }).catch(() => {});
    await loadConfig();
  });
  // reflect config on open
  const syncMode = () => {
    const pm = state.config?.permissionMode || "ask";
    modeSelect.value = pm === "yolo" ? "yolo" : "ask";
  };
  const origLoadConfig = loadConfig;
  loadConfig = async function () { await origLoadConfig(); syncMode(); };

  const modelSelect = $("#model-select");
  const fillModels = () => {
    modelSelect.textContent = "";
    for (const p of state.config?.providers || []) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = `${p.name} · ${p.model}`;
      if (p.id === state.config?.defaultProviderId) opt.selected = true;
      modelSelect.appendChild(opt);
    }
  };
  const origLoadConfig2 = loadConfig;
  loadConfig = async function () { await origLoadConfig2(); fillModels(); };
  modelSelect.addEventListener("change", async () => {
    if (modelSelect.value) {
      await rpc("config/setDefaultProvider", { idOrName: modelSelect.value }).catch(() => {});
      await loadConfig();
    }
  });
  $("#effort-select").addEventListener("change", (e) => {
    toast(`推理档位: ${e.target.value === "low" ? "低(更快更省)" : "最高(更深推理)"} — 将随下次请求生效`, "info");
  });
}

/* ---------------- session search (G1) ---------------- */

function bindSessionSearch() {
  $("#session-search").addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    document.querySelectorAll("#session-list .session-item").forEach((el) => {
      el.style.display = !q || el.textContent.toLowerCase().includes(q) ? "" : "none";
    });
  });
}

/* ---------------- boot ---------------- */

function bindEvents() {
  $("#btn-new-session").addEventListener("click", newSession);
  bindAutomationsModal();
  bindMarketplaceModal();
  bindMemoryModal();
  bindHooksModal();
  bindComposerToolbar();
  bindSessionSearch();

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
    await Promise.all([loadConfig(), loadExtensions()]);
  });
  $("#btn-close-settings").addEventListener("click", () => $("#settings-modal").classList.add("hidden"));
  $("#settings-modal").addEventListener("click", (e) => {
    if (e.target === $("#settings-modal")) $("#settings-modal").classList.add("hidden");
  });
  $("#pf-save").addEventListener("click", saveProvider);
  $("#pf-test").addEventListener("click", testProviderForm);
  $("#mcp-save").addEventListener("click", saveMcpForm);
  $("#mcp-reload").addEventListener("click", async () => {
    await rpc("mcp/reload").catch(() => {});
    await loadExtensions();
  });

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
      await Promise.all([loadConfig().catch(() => {}), loadExtensions().catch(() => {})]);
      await refreshSessions();
    }
  });
  if (window.openzcode.onMcpStatus) {
    window.openzcode.onMcpStatus(() => {
      if (!$("#settings-modal").classList.contains("hidden")) loadExtensions();
    });
  }
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
