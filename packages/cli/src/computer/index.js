// Cross-platform computer-use driver (no native dependencies).
// Per-platform backends:
//   darwin : screencapture (screenshots), osascript/System Events (keys, typing,
//            left click at point), cliclick (optional, adds right/double click)
//   win32  : PowerShell + Add-Type (SetCursorPos/mouse_event/SendInput/SendKeys)
//   linux  : xdotool (mouse/keys/typing), scrot|gnome-screenshot|import (shots)
// Screenshots return PNG bytes (base64) so the model can see the screen.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const IS_MAC = process.platform === "darwin";
const IS_WIN = process.platform === "win32";
const IS_LINUX = process.platform === "linux";

function run(file, args, { timeout = 20000, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(file, args, { timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, err, stdout, stderr });
    });
    if (input !== undefined && child.stdin) {
      child.stdin.end(input);
    }
  });
}

/* ---------------- screenshot ---------------- */

function pngSize(buf) {
  // PNG IHDR: width @16..20, height @20..24 (big endian)
  if (buf.length > 24 && buf.readUInt32BE(12) === 0x49484452) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  return {};
}

async function screenshotDarwin(file) {
  const r = await run("screencapture", ["-x", file]);
  if (r.code !== 0 || !fs.existsSync(file)) throw new Error(`screencapture 失败: ${r.stderr || r.err?.message}`);
}

async function screenshotWin32(file) {
  const ps = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$bmp.Save("${file.replace(/\\/g, "\\\\")}", [System.Drawing.Imaging.ImageFormat]::Png)`;
  const r = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 30000 });
  if (r.code !== 0 || !fs.existsSync(file)) throw new Error(`PowerShell 截屏失败: ${r.stderr?.slice(0, 200)}`);
}

async function screenshotLinux(file) {
  for (const cmd of [["gnome-screenshot", ["-f", file]], ["scrot", [file]], ["import", ["-window", "root", file]]]) {
    const r = await run(cmd[0], cmd[1], { timeout: 20000 });
    if (r.code === 0 && fs.existsSync(file)) return;
  }
  throw new Error("Linux 截屏失败 — 请安装 gnome-screenshot / scrot / imagemagick 之一");
}

async function screenshot() {
  const file = path.join(os.tmpdir(), `oz-screen-${Date.now()}.png`);
  try {
    if (IS_MAC) await screenshotDarwin(file);
    else if (IS_WIN) await screenshotWin32(file);
    else await screenshotLinux(file);
    const buf = fs.readFileSync(file);
    return { image: { data: buf.toString("base64"), mime: "image/png" }, ...pngSize(buf) };
  } finally {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
}

/* ---------------- mouse ---------------- */

async function haveCliclick() {
  if (!IS_MAC) return false;
  const r = await run("cliclick", ["-h"]);
  return r.code === 0 || /usage/i.test(r.stdout + r.stderr);
}

async function clickDarwin(x, y, button) {
  if (button !== "left" || (await haveCliclick())) {
    if (!(await haveCliclick())) throw new Error("macOS 右键/双击需要 cliclick (brew install cliclick)");
    const map = { left: "c", right: "rc", double: "dc" };
    const r = await run("cliclick", [`${map[button]}:${x},${y}`]);
    if (r.code !== 0) throw new Error(`cliclick 失败: ${r.stderr}`);
    return;
  }
  const script = `tell application "System Events" to click at {${x}, ${y}}`;
  const r = await run("osascript", ["-e", script]);
  if (r.code !== 0) throw new Error(`点击失败(仅支持前台应用): ${r.stderr?.slice(0, 150)} — 可 brew install cliclick 获得完整支持`);
}

async function clickWin32(x, y, button) {
  const flags = { left: "0x0002", right: "0x0008", double: "0x0002" };
  const up = { left: "0x0004", right: "0x0010", double: "0x0004" };
  const extra = button === "right" ? "0x0000" : "0x0000";
  const ps = `
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class M {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
}
"@
[M]::SetCursorPos(${x}, ${y}) | Out-Null
Start-Sleep -Milliseconds 60
[M]::mouse_event(${flags[button]}, 0, 0, 0, [UIntPtr]::Zero)
[M]::mouse_event(${up[button]}, 0, 0, 0, [UIntPtr]::Zero)
if ("${button}" -eq "double") { Start-Sleep -Milliseconds 60; [M]::mouse_event(${flags.left}, 0, 0, 0, [UIntPtr]::Zero); [M]::mouse_event(${up.left}, 0, 0, 0, [UIntPtr]::Zero) }`;
  const r = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 30000 });
  if (r.code !== 0) throw new Error(`点击失败: ${r.stderr?.slice(0, 200)}`);
}

async function clickLinux(x, y, button) {
  const btn = { left: 1, right: 3, double: 1 }[button] ?? 1;
  const args = button === "double"
    ? ["mousemove", x, y, "click", "--repeat", "2", "--delay", "60", String(btn)]
    : ["mousemove", x, y, "click", String(btn)];
  const r = await run("xdotool", args);
  if (r.code !== 0) throw new Error(`xdotool 失败: ${r.stderr} (X11 需安装 xdotool)`);
}

async function click(x, y, button = "left") {
  x = Math.round(Number(x)); y = Math.round(Number(y));
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("坐标必须是数字");
  if (IS_MAC) await clickDarwin(x, y, button);
  else if (IS_WIN) await clickWin32(x, y, button);
  else await clickLinux(x, y, button);
}

/* ---------------- keyboard ---------------- */

const SPECIAL_KEYS = {
  return: "Return", enter: "Return", tab: "Tab", escape: "Escape", esc: "Escape",
  space: "Space", backspace: "Delete", delete: "ForwardDelete",
  up: "Up", down: "Down", left: "Left", right: "Right",
  home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown",
  f1: "F1", f2: "F2", f3: "F3", f4: "F4", f5: "F5", f6: "F6", f7: "F7", f8: "F8", f9: "F9", f10: "F10", f11: "F11", f12: "F12",
};

async function keyDarwin(key) {
  const parts = key.split("+").map((k) => k.trim().toLowerCase());
  const mods = [];
  const appleMods = { cmd: "command down", ctrl: "control down", alt: "option down", option: "option down", shift: "shift down" };
  let main = null;
  for (const p of parts) {
    if (appleMods[p]) mods.push(appleMods[p]);
    else main = p;
  }
  if (!main) throw new Error(`无效按键: ${key}`);
  const special = SPECIAL_KEYS[main];
  const modStr = mods.length ? ` using {${mods.join(", ")}}` : "";
  const script = special
    ? `tell application "System Events" to key code ${keyCodeDarwin(special)}${modStr}`
    : `tell application "System Events" to keystroke "${main.replace(/"/g, '\\"')}"${modStr}`;
  const r = await run("osascript", ["-e", script]);
  if (r.code !== 0) throw new Error(`按键失败: ${r.stderr?.slice(0, 150)}`);
}

function keyCodeDarwin(k) {
  const codes = { Return: 36, Tab: 48, Escape: 53, Delete: 51, ForwardDelete: 117, Up: 126, Down: 125, Left: 123, Right: 124, Home: 115, End: 119, PageUp: 116, PageDown: 121, Space: 49,
    F1: 122, F2: 120, F3: 99, F4: 118, F5: 96, F6: 97, F7: 98, F8: 100, F9: 101, F10: 109, F11: 103, F12: 111 };
  if (codes[k] != null) return codes[k];
  throw new Error(`未知特殊键: ${k}`);
}

const WIN_VK = { return: 0x0d, enter: 0x0d, tab: 0x09, escape: 0x1b, esc: 0x1b, space: 0x20, backspace: 0x08, delete: 0x2e, up: 0x26, down: 0x28, left: 0x25, right: 0x27, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22 };

async function keyWin32(key) {
  const parts = key.split("+").map((k) => k.trim().toLowerCase());
  const down = [];
  const ups = [];
  let main = null;
  for (const p of parts) {
    if (p === "cmd" || p === "win") { down.push("0x5B"); ups.push("0x5C"); }
    else if (p === "ctrl" || p === "control") { down.push("0x11"); ups.push("0x91"); }
    else if (p === "alt") { down.push("0x12"); ups.push("0x92"); }
    else if (p === "shift") { down.push("0x10"); ups.push("0x90"); }
    else main = p;
  }
  if (!main) throw new Error(`无效按键: ${key}`);
  const vk = WIN_VK[main] ?? (main.length === 1 ? main.toUpperCase().charCodeAt(0) : null);
  if (vk == null) throw new Error(`未知按键: ${main}`);
  const seq = down.map((v) => `keybd ${v}`).join("\n");
  const ps = `
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class K {
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr e);
}
"@
${down.map((v) => `[K]::keybd_event(${v}, 0, 0, [UIntPtr]::Zero)`).join("\n")}
[K]::keybd_event(${vk}, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 30
[K]::keybd_event(${vk}, 0, 2, [UIntPtr]::Zero)
${ups.slice().reverse().map((v) => `[K]::keybd_event(${v}, 0, 2, [UIntPtr]::Zero)`).join("\n")}`;
  const r = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 30000 });
  if (r.code !== 0) throw new Error(`按键失败: ${r.stderr?.slice(0, 200)}`);
}

async function keyLinux(key) {
  const xdot = key.split("+").map((k) => k.trim()).join("+");
  const r = await run("xdotool", ["key", "--clearmodifiers", xdot]);
  if (r.code !== 0) throw new Error(`xdotool key 失败: ${r.stderr}`);
}

async function key(keyStr) {
  if (!keyStr) throw new Error("key 不能为空");
  if (IS_MAC) await keyDarwin(keyStr);
  else if (IS_WIN) await keyWin32(keyStr);
  else await keyLinux(keyStr);
}

/* ---------------- typing ---------------- */

async function typeDarwin(text) {
  const script = `tell application "System Events" to keystroke ${JSON.stringify(text)}`;
  const r = await run("osascript", ["-e", script], { timeout: Math.max(20000, text.length * 30) });
  if (r.code !== 0) throw new Error(`输入失败: ${r.stderr?.slice(0, 150)}`);
}

async function typeWin32(text) {
  const escaped = text.replace(/([{}[\]()^%+~])/g, "{$1}");
  const ps = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait("${escaped.replace(/"/g, '""')}")`;
  const r = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: Math.max(30000, text.length * 30) });
  if (r.code !== 0) throw new Error(`输入失败: ${r.stderr?.slice(0, 200)}`);
}

async function typeLinux(text) {
  const r = await run("xdotool", ["type", "--delay", "12", "--", text], { timeout: Math.max(20000, text.length * 40) });
  if (r.code !== 0) throw new Error(`xdotool type 失败: ${r.stderr}`);
}

async function type(text) {
  if (typeof text !== "string" || !text) throw new Error("text 不能为空");
  if (IS_MAC) await typeDarwin(text);
  else if (IS_WIN) await typeWin32(text);
  else await typeLinux(text);
}

/* ---------------- scroll ---------------- */

async function scroll(amount) {
  const n = Math.max(1, Math.min(Number(amount) || 3, 20));
  if (IS_WIN) {
    const ps = `
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class S { [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e); }
"@
for ($i = 0; $i -lt ${n}; $i++) { [S]::mouse_event(0x0800, 0, 0, ${amount < 0 ? "-120" : "120"}, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40 }`;
    const r = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 30000 });
    if (r.code !== 0) throw new Error(`滚动失败: ${r.stderr?.slice(0, 150)}`);
    return;
  }
  if (IS_LINUX) {
    const btn = amount < 0 ? 5 : 4;
    const args = ["click", "--repeat", String(n), "--delay", "40", String(btn)];
    const r = await run("xdotool", args);
    if (r.code !== 0) throw new Error(`xdotool 滚动失败: ${r.stderr}`);
    return;
  }
  // macOS: key-based fallback (PageUp/PageDown or arrows)
  const code = amount < 0 ? 121 : 116; // PageDown / PageUp
  for (let i = 0; i < Math.min(n, 5); i++) {
    const r = await run("osascript", ["-e", `tell application "System Events" to key code ${code}`]);
    if (r.code !== 0) throw new Error(`滚动失败: ${r.stderr?.slice(0, 150)}`);
    await new Promise((res) => setTimeout(res, 80));
  }
}

async function computerStatus() {
  const status = {
    platform: process.platform,
    screenshotBackend: IS_MAC ? "screencapture" : IS_WIN ? "powershell" : "gnome-screenshot|scrot|import",
    inputBackend: IS_MAC ? "osascript (cliclick 可选)" : IS_WIN ? "powershell SendInput" : "xdotool",
    cliclick: false,
    xdotool: false,
    powershell: IS_WIN,
  };
  if (IS_MAC) status.cliclick = await haveCliclick();
  if (IS_LINUX) status.xdotool = (await run("xdotool", ["version"])).code === 0;
  if (IS_WIN) status.powershell = (await run("powershell", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"])).code === 0;
  return status;
}

// semantic (element-level) layer
const ax = require("./ax");

module.exports = {
  screenshot, click, key, type, scroll, computerStatus,
  platform: process.platform, hasCliclick: haveCliclick,
  appState: ax.appState, clickElement: ax.clickElement, setElementValue: ax.setElementValue,
  listWindows: ax.listWindows, clipboardGet: ax.clipboardGet, clipboardSet: ax.clipboardSet, axStatus: ax.axStatus,
};
