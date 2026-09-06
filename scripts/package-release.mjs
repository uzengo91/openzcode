#!/usr/bin/env node
// Stage + zip the release bundle:
//   openzcode-v{ver}-bundle.zip
//   └── openzcode/
//       ├── openzcode.cjs          single-file CLI/app-server artifact
//       ├── bin/openzcode          POSIX launcher (node or electron-as-node)
//       ├── bin/openzcode.cmd      Windows launcher
//       ├── app/                   Electron GUI (run: cd app && npm i && npx electron .)
//       ├── README.md / README.en.md / LICENSE
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const versionSrc = fs.readFileSync(path.join(ROOT, "packages/cli/src/version.js"), "utf8");
const VERSION = versionSrc.match(/VERSION\s*=\s*"([^"]+)"/)?.[1];
if (!VERSION) { console.error("✗ 无法解析版本号"); process.exit(1); }

const stageDir = path.join(ROOT, "release", "openzcode");
const outZip = path.join(ROOT, "release", `openzcode-v${VERSION}-bundle.zip`);

fs.rmSync(path.join(ROOT, "release"), { recursive: true, force: true });
fs.mkdirSync(stageDir, { recursive: true });

const cp = (src, dest) => {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
};

cp(path.join(ROOT, "packages/cli/dist/openzcode.cjs"), path.join(stageDir, "openzcode.cjs"));
for (const f of ["README.md", "README.en.md", "LICENSE"]) cp(path.join(ROOT, f), path.join(stageDir, f));

// Electron app source (renderer needs no build step)
const appFiles = ["main.js", "preload.js", "package.json"];
for (const f of appFiles) cp(path.join(ROOT, "packages/app", f), path.join(stageDir, "app", f));
fs.cpSync(path.join(ROOT, "packages/app/host"), path.join(stageDir, "app", "host"), { recursive: true });
fs.cpSync(path.join(ROOT, "packages/app/renderer"), path.join(stageDir, "app", "renderer"), { recursive: true });
// host/ requires a jsonrpc module at ./jsonrpc.js in release layout (monorepo
// layout resolves it from ../../cli/src instead)
cp(path.join(ROOT, "packages/cli/src/rpc/jsonrpc.js"), path.join(stageDir, "app", "host", "jsonrpc.js"));

// Launchers
const launcher = `#!/usr/bin/env sh
# OpenZCode CLI launcher — prefers Electron-as-Node, falls back to plain Node.
dir="$(cd "$(dirname "$0")/.." && pwd)"
if command -v electron >/dev/null 2>&1; then
  ELECTRON_RUN_AS_NODE=1 exec electron "$dir/openzcode.cjs" "$@"
fi
exec node "$dir/openzcode.cjs" "$@"
`;
fs.mkdirSync(path.join(stageDir, "bin"), { recursive: true });
fs.writeFileSync(path.join(stageDir, "bin", "openzcode"), launcher, { mode: 0o755 });
fs.writeFileSync(path.join(stageDir, "bin", "openzcode.cmd"), `@echo off\nnode "%~dp0..\\openzcode.cjs" %*\n`);

execSync(`cd "${path.join(ROOT, "release")}" && zip -qr "${path.basename(outZip)}" openzcode`, { stdio: "inherit" });
const size = fs.statSync(outZip).size;
console.log(`✓ ${path.basename(outZip)} (${(size / 1024).toFixed(1)} KB)`);
