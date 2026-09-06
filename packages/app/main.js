// OpenZCode desktop App — Electron main process.
// The GUI is a frontend: every domain call is proxied over stdio JSON-RPC to
// the CLI engine running in app-server mode (one process per workspace).
"use strict";

process.title = "openzcode-app";

const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("node:path");
const os = require("node:os");
const { AgentProcessManager } = require("./host/agent-process-manager");

const DEFAULT_WORKSPACE = process.env.OPENZCODE_WORKSPACE || path.join(os.homedir(), ".openzcode", "workspace", "default");

let win = null;
let manager = null;
let currentWorkspace = DEFAULT_WORKSPACE;

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 940,
    minHeight: 600,
    backgroundColor: "#0d1117",
    title: "OpenZCode",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.on("closed", () => { win = null; });
}

function broadcast(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

app.whenReady().then(async () => {
  app.setAccessibilitySupportEnabled(true); // expose AX tree for automation/testing

  manager = new AgentProcessManager({
    onEvent: (method, params) => broadcast(method, params),
    onStatus: (status) => broadcast("engine/status", status),
  });

  /* ---------------- IPC: renderer → host → CLI ---------------- */

  ipcMain.handle("rpc", async (_ev, { method, params }) => {
    if (method === "app/state") {
      return {
        workspace: currentWorkspace,
        version: app.getVersion(),
        platform: process.platform,
        engineReady: !!(manager && manager.ready),
      };
    }
    if (method === "workspace/pick") {
      const r = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] });
      if (r.canceled || !r.filePaths[0]) return { picked: currentWorkspace };
      const picked = r.filePaths[0];
      if (picked !== currentWorkspace) {
        currentWorkspace = picked;
        await manager.setWorkspace(picked);
      }
      return { picked };
    }
    // everything else goes to the CLI engine
    return manager.rpcCall(method, params);
  });

  createWindow();

  // boot the engine for the default workspace
  manager.start(currentWorkspace).catch((e) => {
    console.error("engine start failed:", e.message);
    broadcast("engine/status", { state: "error", message: e.message });
  });

  app.on("activate", () => { if (!win) createWindow(); });
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  if (manager) manager.shutdown();
});
