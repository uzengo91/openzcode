// OpenZCode E2E test — drives the CLI in app-server mode over stdio JSON-RPC,
// exactly like the desktop App does, and exercises a real LLM round-trip with
// tool calls (provider config → session → agent loop → file written on disk).
//
// Usage: node scripts/test-e2e.mjs
// Env overrides: OPENZCODE_TEST_BASE_URL / OPENZCODE_TEST_API_KEY / OPENZCODE_TEST_MODEL
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BUNDLE = path.join(ROOT, "packages/cli/dist/openzcode.cjs");

const BASE_URL = process.env.OPENZCODE_TEST_BASE_URL || "https://freeshare.cc.cd/v1";
const API_KEY = process.env.OPENZCODE_TEST_API_KEY || "";
const MODEL = process.env.OPENZCODE_TEST_MODEL || "aio";

if (!API_KEY) {
  console.log("跳过 LLM E2E: 未设置 OPENZCODE_TEST_API_KEY 环境变量 (不视为失败)");
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openzcode-e2e-"));
const ws = path.join(tmp, "ws");
fs.mkdirSync(ws, { recursive: true });

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${detail}`); }
}

const child = spawn(process.execPath, [BUNDLE, "app-server", "--stdio"], {
  env: { ...process.env, OPENZCODE_CONFIG_DIR: path.join(tmp, "data"), OPENZCODE_WORKSPACE: ws },
  stdio: ["pipe", "pipe", "pipe"],
});
child.stderr.on("data", (d) => process.stderr.write(`[cli] ${d}`));

const pending = new Map();
const eventLog = [];
let nextId = 1;

const rl = createInterface({ input: child.stdout });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  } else if (msg.method === "session/event") {
    eventLog.push(msg.params);
  }
});

function request(method, params, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, timeoutMs);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function waitForTurnDone(timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("turn 未在时限内完成")), timeoutMs);
    const iv = setInterval(() => {
      const done = eventLog.find((e) => e.event?.type === "turn_done");
      if (done) { clearInterval(iv); clearTimeout(timer); resolve(done.event); }
    }, 200);
  });
}

try {
  console.log("== OpenZCode E2E (app-server stdio JSON-RPC + 真实 LLM) ==");
  console.log(`   provider: ${MODEL} @ ${BASE_URL}`);

  // 1. initialize
  const info = await request("initialize", {}, 15000);
  check("initialize 返回协议与版本", info.protocolVersion >= 1 && !!info.version, JSON.stringify(info).slice(0, 120));
  console.log(`   engine: OpenZCode ${info.version}, storage=${info.storage}, workspace=${info.workspace}`);

  // 2. provider 配置 + 连接测试
  await request("config/setProvider", { name: "e2e", baseUrl: BASE_URL, apiKey: API_KEY, model: MODEL, protocol: "openai", setDefault: true });
  const test = await request("config/testProvider", { idOrName: "e2e" }, 60000);
  check("config/testProvider 真实连接成功", test.ok === true, test.message);

  // 3. yolo 模式(无人值守)
  await request("config/setOptions", { permissionMode: "yolo" });

  // 4. 会话创建 + 发送真实任务(触发工具调用)
  const session = await request("session/create", { workspace: ws });
  check("session/create", !!session.id, JSON.stringify(session).slice(0, 120));

  request("session/send", {
    sessionId: session.id,
    text: "请完成三步: 1) 用 bash 查看当前目录; 2) 创建文件 hello.txt, 内容恰好为一行: OpenZCode E2E OK; 3) 用 read_file 读回 hello.txt 确认内容。全部完成后用一句话报告结果。",
  }).catch(() => {});

  const turn = await waitForTurnDone(300000);
  const types = eventLog.map((e) => e.event?.type);
  const toolStarts = eventLog.filter((e) => e.event?.type === "tool_start").map((e) => e.event.name);
  const toolEnds = eventLog.filter((e) => e.event?.type === "tool_end");

  check("turn 正常完成", turn.ok === true, turn.error || "");
  check("发生了工具调用(≥2 次)", toolStarts.length >= 2, `实际: ${toolStarts.join(", ")}`);
  check("工具全部执行成功", toolEnds.every((t) => t.event.ok), JSON.stringify(toolEnds.filter((t) => !t.event.ok).map((t) => t.event.output).slice(0, 1)));
  check("有流式文本增量(text_delta)", types.includes("text_delta"));

  // 5. 落盘验证: agent 真的写了文件
  const helloPath = path.join(ws, "hello.txt");
  check("hello.txt 已生成", fs.existsSync(helloPath));
  if (fs.existsSync(helloPath)) {
    const content = fs.readFileSync(helloPath, "utf8").trim();
    check("hello.txt 内容正确", content.includes("OpenZCode E2E OK"), content.slice(0, 80));
  }

  // 6. 会话持久化 + 消息可回放
  const msgs = await request("session/messages", { sessionId: session.id });
  check("消息已持久化(≥6 条: user/assistant/tool...)", msgs.length >= 5, `实际 ${msgs.length}`);
  const list = await request("session/list", { workspace: ws });
  check("session/list 可见该会话", list.some((s) => s.id === session.id));

  // 7. rollout jsonl 双写校验
  const rolloutDir = path.join(tmp, "data", "rollout");
  const rollouts = fs.existsSync(rolloutDir) ? fs.readdirSync(rolloutDir) : [];
  check("rollout/<sessionId>.jsonl 已落盘", rollouts.length > 0, rollouts.join(","));

  // 8. 多轮上下文: 追问刚才写的文件内容
  eventLog.length = 0;
  request("session/send", { sessionId: session.id, text: "刚才 hello.txt 里写的是什么? 只回答那一行内容。" }).catch(() => {});
  const turn2 = await waitForTurnDone(120000);
  const textParts = eventLog.filter((e) => e.event?.type === "message" && e.event.message.role === "assistant")
    .flatMap((e) => e.event.message.parts).filter((p) => p.type === "text").map((p) => p.text).join(" ");
  check("第二轮正常完成(上下文延续)", turn2.ok === true, turn2.error || "");
  check("第二轮回答包含正确内容", textParts.includes("OpenZCode E2E OK"), textParts.slice(0, 150));

  console.log(`\n== 结果: ${passed} 通过, ${failed} 失败 ==`);
  console.log(`   事件总数 ${eventLog.length + " (含首轮)"} | 工具调用: ${[...new Set(toolStarts)].join(", ")}`);
  process.exitCode = failed ? 1 : 0;
} catch (e) {
  console.error(`\n✗ E2E 失败: ${e.message}`);
  process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 300));
  child.kill("SIGKILL");
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
