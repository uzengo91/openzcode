// Subagent runner — spawn an isolated agent session (own context/todo, shared
// provider/config) and return only the final conclusion to the parent session.
// Types:
//   general-purpose : all non-subagent tools
//   Explore         : read-only tools (no bash? bash is read-capable in
//                     practice but can write; Explore denies bash too — strict
//                     read-only subset)
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { runAgentTurn } = require("./agent/loop");
const { toolDefinitions, getTool } = require("./agent/tools");

const EXPLORE_DENY = new Set(["bash", "write_file", "edit_file", "todo_write", "computer_click", "computer_type", "computer_key", "computer_scroll", "browser_click", "browser_type", "browser_evaluate", "Agent", "CronCreate", "CronUpdate", "CronDelete"]);

function newId(prefix) { return `${prefix}_${crypto.randomUUID()}`; }

function createSubagents({ storage, workspace, getProvider, getConfig, mcpManager, skills, automations, emit, maxDepth = 2 }) {
  // guard against recursive spawning beyond depth via config on the fly
  let depth = 0;

  async function spawn({ description, prompt, type = "general-purpose", emitParent }) {
    if (depth >= maxDepth) return { ok: false, output: `子代理嵌套过深(>${maxDepth}), 请在主会话直接执行。` };
    depth++;
    try {
      const provider = getProvider ? getProvider() : null;
      const config = getConfig ? getConfig() : {};
      // isolated session (own title/rollout/todo); artifacts live in storage like normal
      const session = storage.createSession({ workspace, title: `[agent:${type}] ${description}`.slice(0, 40) });
      const agentId = newId("agent");
      const meta = { id: agentId, sessionId: session.id, type, description, startedAt: new Date().toISOString() };
      const artifactsDir = path.join(workspace, ".openzcode", "agents", session.id);
      try {
        fs.mkdirSync(artifactsDir, { recursive: true });
        fs.writeFileSync(path.join(artifactsDir, "metadata.json"), JSON.stringify({ ...meta, prompt }, null, 2));
      } catch {}

      emitParent && emitParent({ type: "subagent_started", id: agentId, agentType: type, description, sessionId: session.id });

      const wrappedEmit = (event) => {
        if (event.type === "tool_start") {
          emitParent && emitParent({ type: "subagent_progress", id: agentId, description, event: "tool", tool: event.name });
        }
      };

      // Explore type: filter tool table + deny write tools at run time
      const subConfig = {
        ...config,
        permissionMode: "yolo", // unattended; safety via type whitelist
        maxIterations: Math.min(config.maxIterations || 40, 25),
      };

      const savedTools = toolDefinitions;
      let result;
      if (type === "Explore") {
        // monkey-patch tool access for this run via getTool wrapper is intrusive;
        // instead pass a restricted extension through and rely on loop's plan
        // blocker? Simplest robust approach: temporarily override toolDefinitions.
        const readOnlyDefs = savedTools().filter((t) => !EXPLORE_DENY.has(t.name));
        require("./agent/tools").__setToolTableForSubagent && require("./agent/tools").__setToolTableForSubagent(readOnlyDefs);
        try {
          result = await runAgentTurn({
            session, userText: prompt, provider, config: subConfig, storage,
            emit: wrappedEmit, permissionHandler: null, signal: undefined,
            extensions: { mcpManager, skills, automations, subagentDepth: depth },
          });
        } finally {
          require("./agent/tools").__setToolTableForSubagent(null);
        }
      } else {
        result = await runAgentTurn({
          session, userText: prompt, provider, config: subConfig, storage,
          emit: wrappedEmit, permissionHandler: null, signal: undefined,
          extensions: { mcpManager, skills, automations, subagentDepth: depth },
        });
      }

      // collect final assistant text as the conclusion
      const msgs = storage.getMessages(session.id);
      const conclusion = msgs
        .filter((m) => m.role === "assistant")
        .flatMap((m) => m.parts)
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n")
        .trim();

      try {
        fs.writeFileSync(path.join(artifactsDir, "output.txt"), conclusion || "(无文本结论)");
        fs.writeFileSync(path.join(artifactsDir, "task.output"), JSON.stringify(result, null, 2));
      } catch {}

      emitParent && emitParent({ type: "subagent_finished", id: agentId, description, ok: result.ok, sessionId: session.id });
      emit && emit({ sessionId: session.id, event: { type: "subagent_finished", id: agentId, description, ok: result.ok } });

      const header = `[子代理 ${type}·${description}] ${result.ok ? "完成" : `失败: ${result.error || "未知错误"}`} (会话 ${session.id})\n\n`;
      return { ok: result.ok, output: header + (conclusion || "(子代理未产出文本结论)") };
    } finally {
      depth--;
    }
  }

  return { spawn };
}

module.exports = { createSubagents };
