// The agent loop: user text → LLM (stream) → tool calls → tool results → repeat.
// Every model request/response is double-written: structured storage + rollout jsonl.
"use strict";

const configStore = require("../config");
const { chatStream } = require("../llm/client");
const { buildSystemPrompt } = require("./system");
const { toolDefinitions, getTool } = require("./tools");
const { appendRollout } = require("../rollout");
const { VERSION } = require("../version");

function truncateForEvent(text, n = 4000) {
  if (typeof text !== "string") text = String(text ?? "");
  return text.length > n ? text.slice(0, n) + `…[截断,共${text.length}字符]` : text;
}

const WRITE_CLASS_TOOLS = new Set(["bash", "write_file", "edit_file", "todo_write", "computer_click", "computer_type", "computer_key", "computer_scroll", "browser_click", "browser_type", "browser_evaluate", "Agent", "CronCreate", "CronUpdate", "CronDelete"]);
// per-session plan-mode state persisted across turns (session id → {active, text})
const sessionPlanState = new Map();

/** plan-mode controls passed to tools via extensions */
function createPlanMode(storage) {
  return {
    forSession(sessionId) {
      if (!sessionPlanState.has(sessionId)) sessionPlanState.set(sessionId, { active: false, text: "" });
      const st = sessionPlanState.get(sessionId);
      return {
        isActive: () => st.active,
        async enter() {
          st.active = true;
          st.text = "";
          return { ok: true, output: "已进入计划模式(plan): 只能读取/搜索/产出计划, 写类工具被拒绝。调研充分后用 ExitPlanMode 提交计划。" };
        },
        async exit(planText) {
          st.text = planText;
          // approval via permission channel: approve(id) resolves {allow}
          return new Promise((resolve) => {
            const id = "plan_" + Math.random().toString(36).slice(2, 10);
            st.pendingApproval = { id, planText, resolve };
            // emit is bound later via st.emit (set by the server adapter)
            if (st.emit) st.emit({ type: "plan_request", id, plan: planText });
            else resolve({ ok: false, output: "当前环境不支持计划审批(非交互模式), 请直接执行或切换权限模式。" });
            setTimeout(() => {
              if (st.pendingApproval) { st.pendingApproval = null; resolve({ ok: false, output: "计划审批超时未响应, 仍处于计划模式。" }); }
            }, 600000);
          });
        },
        approve(id, allow) {
          const p = st.pendingApproval;
          if (!p || p.id !== id) return false;
          st.pendingApproval = null;
          st.active = !allow;
          p.resolve({
            ok: true,
            output: allow
              ? "用户已批准计划。已退出计划模式, 现在开始按计划执行。"
              : "用户拒绝了该计划。仍处于计划模式, 请根据反馈调整计划后重新 ExitPlanMode。",
          });
          return true;
        },
        setEmit(fn) { st.emit = fn; },
      };
    },
  };
}

async function runAgentTurn({
  session,
  userText,
  provider,
  config,
  storage,
  emit,
  permissionHandler,
  signal,
  extensions = {}, // { mcpManager, skills, memory, hooks, planMode, askUser, subagents, automations }
}) {
  const sessionId = session.id;
  const workspace = session.workspace;
  const maxIterations = config.maxIterations || 40;

  emit({ type: "turn_started" });

  // auto-compact when context is over budget (before building the request)
  try {
    const { maybeAutoCompact } = require("../compact");
    await maybeAutoCompact({ storage, sessionId, provider, config, emit });
  } catch {}

  // 1. persist user message + auto title
  const userMsg = storage.appendMessage(sessionId, "user", [{ type: "text", text: userText }]);
  emit({ type: "message", message: userMsg });
  if (session.title === "新会话" && userText) {
    const title = userText.replace(/\s+/g, " ").trim().slice(0, 30) || "新会话";
    storage.touchSession(sessionId, { title, model: provider?.model });
    emit({ type: "session_updated", title });
  }

  // 2. tools = builtin (+ skill) + MCP namespaced tools; system prompt reflects both
  const builtinDefs = toolDefinitions();
  const mcpDefs = extensions.mcpManager ? await extensions.mcpManager.toolDefinitions() : [];
  const tools = [...builtinDefs, ...mcpDefs];
  const system = buildSystemPrompt({
    workspace,
    toolNames: tools.map((t) => t.name),
    skillsSection: extensions.skills ? extensions.skills.promptSection() : "",
    memorySection: extensions.memory ? extensions.memory.promptSection(workspace) : "",
    hasMcp: mcpDefs.length > 0,
  });
  const history = storage.getMessages(sessionId).map((m) => ({ role: m.role, parts: m.parts }));

  const alwaysAllowed = new Set();
  // plan-mode state persists across turns of the same session; fresh plan run
  // (permissionMode==="plan" not used by app UI — mode via tools) seeds from config
  if (!sessionPlanState.has(sessionId)) {
    sessionPlanState.set(sessionId, { active: config.permissionMode === "plan", text: "" });
  }
  const planBlock = sessionPlanState.get(sessionId);
  let totalUsage = { promptTokens: 0, completionTokens: 0 };
  let iterations = 0;
  const turnStartedAt = Date.now();

  try {
    for (let iter = 0; iter < maxIterations; iter++) {
      iterations = iter + 1;
      // 3. stream one model response
      const requestAt = Date.now();
      appendRollout(sessionId, {
        type: "model_request",
        iteration: iter,
        model: provider?.model,
        provider: provider ? { baseUrl: provider.baseUrl, protocol: provider.protocol } : null,
        request: { system: system.slice(0, 500) + "…", messageCount: history.length, tools: tools.map((t) => t.name) },
      });

      let partialText = "";
      let response;
      try {
        // one automatic retry for transient stream failures (idle timeout,
        // reset sockets); aborts propagate immediately
        for (let attempt = 0; ; attempt++) {
          try {
            response = await chatStream({
              provider,
              system,
              messages: history,
              tools,
              signal,
              onDelta: (d) => {
                if (d.type === "text") {
                  partialText += d.text;
                  emit({ type: "text_delta", text: d.text });
                }
              },
            });
            break;
          } catch (err) {
            if (signal?.aborted) throw err;
            const retryable = /空闲超时|流中断|fetch failed|ECONNRESET|socket hang up|network/i.test(err.message || "");
            if (attempt === 0 && retryable && !partialText) {
              appendRollout(sessionId, { type: "model_retry", iteration: iter, error: err.message });
              continue;
            }
            throw err;
          }
        }
      } catch (err) {
        if (signal?.aborted) {
          if (partialText) {
            const m = storage.appendMessage(sessionId, "assistant", [{ type: "text", text: partialText + "\n\n[已停止]" }]);
            emit({ type: "message", message: m });
          }
          throw Object.assign(new Error("已停止"), { name: "AbortError" });
        }
        throw err;
      }

      const durationMs = Date.now() - requestAt;
      totalUsage.promptTokens += response.usage.promptTokens;
      totalUsage.completionTokens += response.usage.completionTokens;
      storage.recordModelUsage({
        sessionId, model: provider?.model,
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
        durationMs,
      });
      emit({ type: "usage", promptTokens: response.usage.promptTokens, completionTokens: response.usage.completionTokens, durationMs });
      appendRollout(sessionId, {
        type: "model_response", iteration: iter, durationMs,
        response: { text: response.text, toolCalls: response.toolCalls, usage: response.usage, finishReason: response.finishReason },
      });

      // 4. persist assistant message (text + tool_use parts)
      const parts = [];
      if (response.text) parts.push({ type: "text", text: response.text });
      for (const tc of response.toolCalls) parts.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
      if (!parts.length) parts.push({ type: "text", text: "(空响应)" });
      const assistantMsg = storage.appendMessage(sessionId, "assistant", parts);
      emit({ type: "message", message: assistantMsg });

      if (!response.toolCalls.length) break; // final answer

      history.push({ role: "assistant", parts });

      // 5. execute tool calls sequentially
      const mcpDefs = extensions.mcpManager ? await extensions.mcpManager.toolDefinitions() : [];
      for (const tc of response.toolCalls) {
        let tool = getTool(tc.name);
        if (!tool && tc.name.startsWith("mcp__")) {
          const def = mcpDefs.find((d) => d.name === tc.name);
          if (def && extensions.mcpManager) {
            tool = {
              name: tc.name,
              danger: !!def.danger,
              run: (input) => extensions.mcpManager.call(tc.name, input),
            };
          }
        }
        let result;
        let denied = false;

        /* ---- plan mode: deny write-class tools until plan approved ---- */
        if (planBlock.active && WRITE_CLASS_TOOLS.has(tc.name)) {
          result = { ok: false, output: "当前处于计划模式(plan): 只能读取和产出计划, 不能执行写操作。请用 ExitPlanMode 提交计划等待用户批准, 或提示用户切换权限模式。" };
          denied = true;
        }

        // hooks PreToolUse: allow deny / input rewrite (never fails the turn)
        if (!denied && extensions.hooks) {
          try {
            const hookResult = await extensions.hooks.preToolUse(tc.name, tc.input ?? {});
            if (hookResult.deny) {
              denied = true;
              result = { ok: false, output: `被 hook 拦截: ${hookResult.reason || "(无理由)"}` };
            } else if (hookResult.input !== (tc.input ?? {})) {
              tc.input = hookResult.input;
            }
          } catch {}
        }

        emit({ type: "tool_start", id: tc.id, name: tc.name, input: tc.input });

        if (denied) {
          // denial from plan mode / hooks (set before tool lookup): still emit
          // tool_end so the UI and tests observe what happened
          emit({
            type: "tool_end", id: tc.id, name: tc.name, ok: false, ms: 0,
            output: truncateForEvent(result.output, 2500),
          });
        } else if (!tool) {
          result = { ok: false, output: `未知工具: ${tc.name}` };
        } else {
          const wantsApproval = tool.danger && config.permissionMode === "ask" && !alwaysAllowed.has(tc.name);
          if (wantsApproval && !permissionHandler) {
            // non-interactive run (print mode) without yolo: deny dangerous ops
            result = { ok: false, output: "非交互模式下拒绝执行危险操作 — 使用 --yolo 显式放行，或在交互界面中批准。" };
            denied = true;
          } else if (wantsApproval) {
            const permId = "perm_" + Math.random().toString(36).slice(2, 10);
            emit({ type: "permission_request", id: permId, tool: tc.name, input: tc.input });
            let decision = { allow: false, always: false };
            try {
              decision = await permissionHandler({ id: permId, sessionId, tool: tc.name, input: tc.input, signal });
            } catch {}
            storage.recordPermission({ permId, sessionId, tool: tc.name, input: tc.input, allowed: decision.allow });
            emit({ type: "permission_resolved", id: permId, allow: decision.allow });
            if (decision.always) alwaysAllowed.add(tc.name);
            if (!decision.allow) denied = true;
          }
          if (denied && !result) {
            result = { ok: false, output: "用户拒绝了此操作。请调整方案或向用户解释后重试。" };
          } else if (denied) {
            // keep the more specific denial reason already set
          }
          if (denied) {
            // all denial paths (plan mode / hook / permission / non-interactive)
            // surface a tool_end so UI and tests can observe the denial
            emit({
              type: "tool_end", id: tc.id, name: tc.name, ok: false, ms: 0,
              output: truncateForEvent(result.output, 2500),
            });
          } else {
            const t0 = Date.now();
            try {
              result = await tool.run(tc.input ?? {}, {
                workspace, sessionId, storage, config, emit, signal,
                skills: extensions.skills,
                automations: extensions.automations,
                memory: extensions.memory,
                hooks: extensions.hooks,
                planMode: extensions.planMode ? extensions.planMode.forSession(sessionId) : null,
                askUser: extensions.askUser ? (q) => extensions.askUser(sessionId, q) : null,
                subagents: extensions.subagents,
              });
            } catch (err) {
              result = { ok: false, output: `工具执行异常: ${err.message}` };
            }
            const ms = Date.now() - t0;
            storage.recordToolUse({ sessionId, tool: tc.name, ok: result.ok, durationMs: ms });
            emit({
              type: "tool_end", id: tc.id, name: tc.name, ok: result.ok, ms,
              output: truncateForEvent(result.output, 2500),
              hasImage: !!result.image,
            });
            if (extensions.hooks) {
              try { await extensions.hooks.postToolUse(tc.name, tc.input, result); } catch {}
            }
          }
        }

        const resultParts = [{ type: "tool_result", tool_use_id: tc.id, content: result.output, is_error: !result.ok }];
        if (result.image) resultParts.push({ type: "image", mime: result.image.mime, data: result.image.data });
        const resultMsg = storage.appendMessage(sessionId, "tool", resultParts);
        history.push({ role: "tool", parts: resultMsg.parts });
      }
    }

    emit({ type: "turn_done", ok: true, iterations, usage: totalUsage, ms: Date.now() - turnStartedAt });
    // clean up per-turn state that must not leak into finished sessions
    if (sessionPlanState.get(sessionId) && !sessionPlanState.get(sessionId).active) sessionPlanState.delete(sessionId);
    return { ok: true, iterations, usage: totalUsage };
  } catch (err) {
    const aborted = err?.name === "AbortError" || signal?.aborted;
    emit({ type: "turn_done", ok: false, aborted, error: aborted ? "已停止" : (err.message || String(err)) });
    return { ok: false, aborted, error: err.message || String(err) };
  }
}

module.exports = { runAgentTurn, createPlanMode, sessionPlanState, WRITE_CLASS_TOOLS };
