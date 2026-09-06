// OpenZCode artifact integration test — the final acceptance gate.
//
// Runs the BUILT artifact (openzcode.cjs from the release zip or repo dist) as
// a real agent against THIS repository: the model reads actual source files,
// extracts facts, writes files under .oz-itest/, and assertions verify the
// bytes on disk against ground truth parsed from the repo itself.
//
// Requires a working LLM provider:
//   env OPENZCODE_TEST_API_KEY / OPENZCODE_TEST_BASE_URL / OPENZCODE_TEST_MODEL
//   or a configured default provider in ~/.openzcode/config.json
// Bundle under test: env OPENZCODE_BUNDLE, default packages/cli/dist/openzcode.cjs
// Workspace: this repository (real read/write on real code).
//
// Usage: node scripts/test-artifact.mjs
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BUNDLE = process.env.OPENZCODE_BUNDLE || path.join(ROOT, "packages/cli/dist/openzcode.cjs");
const REPO = ROOT; // workspace under test = the local repository itself
const SCRATCH = path.join(REPO, ".oz-itest");

if (!fs.existsSync(BUNDLE)) {
  console.error(`✗ bundle 不存在: ${BUNDLE} (先构建或解压 release 产物)`);
  process.exit(1);
}

/* ---- provider resolution: env first, then local config ---- */
function resolveProvider() {
  if (process.env.OPENZCODE_TEST_API_KEY) {
    return {
      baseUrl: process.env.OPENZCODE_TEST_BASE_URL || "https://freeshare.cc.cd/v1",
      apiKey: process.env.OPENZCODE_TEST_API_KEY,
      model: process.env.OPENZCODE_TEST_MODEL || "aio",
    };
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".openzcode", "config.json"), "utf8"));
    const prov = cfg.providers.find((p) => p.id === cfg.defaultProviderId) || cfg.providers[0];
    if (prov?.apiKey) return { baseUrl: prov.baseUrl, apiKey: prov.apiKey, model: prov.model };
  } catch {}
  return null;
}

const provider = resolveProvider();
if (!provider) {
  console.log("跳过产物集成测试: 无可用 LLM provider (设置 OPENZCODE_TEST_API_KEY 或先 openzcode provider add)");
  process.exit(0);
}

/* ---- ground truth parsed from the repo itself (not hardcoded) ---- */
const versionSrc = fs.readFileSync(path.join(REPO, "packages/cli/src/version.js"), "utf8");
const EXPECT_VERSION = versionSrc.match(/VERSION\s*=\s*"([^"]+)"/)?.[1];
const readmeSrc = fs.readFileSync(path.join(REPO, "README.md"), "utf8");
const EXPECT_TITLE = readmeSrc.match(/^#\s+(.+)$/m)?.[1]?.trim();
const appPkg = JSON.parse(fs.readFileSync(path.join(REPO, "packages/app/package.json"), "utf8"));
const EXPECT_APP_NAME = appPkg.name;

console.log("== OpenZCode 产物集成测试 (真实 LLM × 本地仓库读写) ==");
console.log(`   产物: ${BUNDLE}`);
console.log(`   工作区(被读写仓库): ${REPO}`);
console.log(`   期望: version=${EXPECT_VERSION} title="${EXPECT_TITLE}" app.name=${EXPECT_APP_NAME}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openzcode-artifact-"));
fs.mkdirSync(SCRATCH, { recursive: true });

// MCP fixture visible to the engine (stdio server shipped in this repo)
fs.mkdirSync(path.join(tmp, "data"), { recursive: true });
fs.writeFileSync(path.join(tmp, "data", "mcp.json"), JSON.stringify({
  mcpServers: { calc: { command: process.execPath, args: [path.join(REPO, "scripts/fixtures/test-mcp-server.cjs")] } },
}));

let passed = 0, failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${detail}`); }
};

const child = spawn(process.execPath, [BUNDLE, "app-server", "--stdio"], {
  env: { ...process.env, OPENZCODE_CONFIG_DIR: path.join(tmp, "data"), OPENZCODE_WORKSPACE: REPO },
  stdio: ["pipe", "pipe", "pipe"],
});

const pending = new Map();
const eventLog = [];
let nextId = 1;
const rl = createInterface({ input: child.stdout });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  } else if (msg.method === "session/event") {
    eventLog.push(msg.params);
  }
});

const request = (method, params, timeoutMs = 60000) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, timeoutMs);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

const waitForTurnDone = (timeoutMs = 300000) =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const done = eventLog.find((e) => e.event?.type === "turn_done");
      if (done) { clearInterval(iv); resolve(done.event); }
      else if (Date.now() - t0 > timeoutMs) { clearInterval(iv); reject(new Error("turn 超时")); }
    }, 200);
  });

async function runTask(sessionId, text) {
  eventLog.length = 0;
  request("session/send", { sessionId, text }).catch(() => {});
  const ev = await waitForTurnDone();
  const tools = eventLog.filter((e) => e.event?.type === "tool_start").map((e) => e.event.name);
  const ends = eventLog.filter((e) => e.event?.type === "tool_end");
  const failures = ends.filter((e) => !e.event.ok).map((e) => `${e.event.name}: ${String(e.event.output).slice(0, 120)}`);
  // turn success is the gate; individual tool retries are allowed (models self-correct)
  return { ev, tools, ok: ev.ok === true, failures };
}

try {
  await request("initialize", {});
  await request("config/setProvider", { name: "artifact-test", baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: provider.model, protocol: "openai", setDefault: true });
  await request("config/setOptions", { permissionMode: "yolo" });
  const session = await request("session/create", { workspace: REPO });

  // ---- Task 1: read real source → write derived fact ----
  let r = await runTask(session.id, `读取 packages/cli/src/version.js，找到 VERSION 常量的字符串值，把这个值(仅版本号本身，一行，不要其他内容)写入 .oz-itest/check-version.txt。`);
  check("任务1: agent 读取了真实源码 (read_file)", r.tools.includes("read_file"), r.tools.join(","));
  check("任务1: agent 执行全部成功", r.ok, r.failures.join(" | ") || r.ev.error || "");
  const gotVersion = fs.existsSync(path.join(SCRATCH, "check-version.txt"))
    ? fs.readFileSync(path.join(SCRATCH, "check-version.txt"), "utf8").trim()
    : null;
  check(`任务1: 磁盘产物内容与仓库真值一致 (${EXPECT_VERSION})`, gotVersion === EXPECT_VERSION, `实际: ${gotVersion}`);

  // ---- Task 2: read repo README heading → write ----
  r = await runTask(session.id, `读取仓库根目录 README.md，找到第一个一级标题(# 开头)的标题文字，把它写入 .oz-itest/check-title.txt（一行，只要标题文字本身）。`);
  check("任务2: README 读取+写入完成", r.ok, r.failures.join(" | ") || r.ev.error || "");
  const gotTitle = fs.existsSync(path.join(SCRATCH, "check-title.txt"))
    ? fs.readFileSync(path.join(SCRATCH, "check-title.txt"), "utf8").trim()
    : null;
  check(`任务2: 标题与仓库真值一致 ("${EXPECT_TITLE}")`, gotTitle === EXPECT_TITLE, `实际: ${gotTitle}`);

  // ---- Task 3: read package.json field → append-write ----
  r = await runTask(session.id, `读取 packages/app/package.json，把其中 name 字段的值写入 .oz-itest/check-name.txt（一行，只要 name 的值）。`);
  check("任务3: package.json 读取+写入完成", r.ok, r.failures.join(" | ") || r.ev.error || "");
  const gotName = fs.existsSync(path.join(SCRATCH, "check-name.txt"))
    ? fs.readFileSync(path.join(SCRATCH, "check-name.txt"), "utf8").trim().replace(/^"|"$/g, "")
    : null;
  check(`任务3: name 字段与仓库真值一致 (${EXPECT_APP_NAME})`, gotName === EXPECT_APP_NAME, `实际: ${gotName}`);

  // ---- Task 4: multi-hop — count real source files via bash and write ----
  r = await runTask(session.id, `用 bash 统计 packages/cli/src 目录及其子目录下 .js 文件的数量，把数字写入 .oz-itest/check-count.txt（一行，只要数字）。`);
  check("任务4: bash 统计真实源码文件数", r.ok, r.failures.join(" | ") || r.ev.error || "");
  const gotCount = fs.existsSync(path.join(SCRATCH, "check-count.txt"))
    ? fs.readFileSync(path.join(SCRATCH, "check-count.txt"), "utf8").trim()
    : null;
  let expectedCount = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".js")) expectedCount++;
    }
  };
  walk(path.join(REPO, "packages/cli/src"));
  check(`任务4: 文件计数与真值一致 (${expectedCount})`, gotCount === String(expectedCount), `实际: ${gotCount}`);

  // ---- Task 5: MCP tool — agent must call the configured mcp server ----
  r = await runTask(session.id, `请使用 MCP 工具 mcp__calc__add 计算 11+22，把结果数字写入 .oz-itest/check-mcp.txt（一行，只要数字）。`);
  check("任务5: agent 调用了 MCP 工具 mcp__calc__add", r.ev.ok === true, r.failures.join(" | ") || r.ev.error || "");
  const gotMcp = fs.existsSync(path.join(SCRATCH, "check-mcp.txt"))
    ? fs.readFileSync(path.join(SCRATCH, "check-mcp.txt"), "utf8").trim()
    : null;
  check("任务5: MCP 计算结果正确 (33)", gotMcp === "33", `实际: ${gotMcp}`);

  // ---- persistence sanity ----
  const msgs = await request("session/messages", { sessionId: session.id });
  check("四轮会话消息已全部持久化", msgs.length >= 4 * 3, `实际 ${msgs.length} 条`);

  console.log(`\n== 产物集成测试: ${passed} 通过, ${failed} 失败 ==`);
  process.exitCode = failed ? 1 : 0;
} catch (e) {
  console.error(`\n✗ 产物集成测试失败: ${e.message}`);
  process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 300));
  child.kill("SIGKILL");
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch {}
}
