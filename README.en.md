# OpenZCode

**A single-binary, dual-form coding agent MVP** — one Electron executable: launched as a GUI it is the desktop App; loaded with `ELECTRON_RUN_AS_NODE=1`, the same `openzcode.cjs` becomes the terminal CLI. The desktop App is essentially a GUI frontend for the CLI, driving the engine over stdio JSON-RPC (`app-server --stdio`).

English | [简体中文](README.md)

[![CI](https://github.com/uzengo91/openzcode/actions/workflows/ci.yml/badge.svg)](https://github.com/uzengo91/openzcode/actions/workflows/ci.yml)
[![Release](https://github.com/uzengo91/openzcode/actions/workflows/release.yml/badge.svg)](https://github.com/uzengo91/openzcode/actions/workflows/release.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

> The architecture mirrors a reverse-engineering write-up of ZCode (desktop + CLI), focusing on its three most instructive designs:
> ① App↔CLI decoupling via stdio JSON-RPC (GUI and engine are independently usable);
> ② session-continuity double-write (structured SQLite + raw rollout JSONL, replayable and auditable);
> ③ dual-track permissions (engine-side permission management + approval events surfaced to the App).

## Quick Start

```bash
git clone https://github.com/uzengo91/openzcode.git
cd openzcode
npm install                 # deps (electron + esbuild)
npm run build:cli           # bundle the single-file CLI: packages/cli/dist/openzcode.cjs
npm start                   # launch the desktop App

# Configure a model provider (via CLI, or in the App's ⚙ settings)
node packages/cli/dist/openzcode.cjs provider add \
  --name my-llm --base-url https://your.host/v1 \
  --api-key <KEY> --model <MODEL> --protocol openai --set-default
node packages/cli/dist/openzcode.cjs provider test
```

Or grab `openzcode-v*-bundle.zip` from [Releases](https://github.com/uzengo91/openzcode/releases):

```bash
unzip openzcode-v*-bundle.zip && cd openzcode
./bin/openzcode --version          # CLI (node, or electron-as-node)
cd app && npm install && npx electron .   # desktop App
```

## Three Forms, One Bundle

| Form | Command | Notes |
|---|---|---|
| Interactive TUI | `openzcode` | readline terminal session, `/help` for commands |
| One-shot | `openzcode -p "task" --yolo [-C dir]` | non-interactive, prints the result |
| App-Server | `openzcode app-server --stdio` | JSON-RPC 2.0 over stdio, driven by the App |
| Desktop App | `npm start` | GUI frontend, one engine process per workspace |

## Process Topology (isomorphic to ZCode)

```
user ── GUI ── Electron main (openzcode-app)
                └── spawn: Electron binary + ELECTRON_RUN_AS_NODE=1
                      └── openzcode.cjs app-server --stdio  (process title: openzcode-app-server)
                            ├── agent loop (system prompt + tools + streaming)
                            ├── model API (OpenAI / Anthropic compatible, HTTPS SSE)
                            └── storage: SQLite (node:sqlite, WAL) + rollout/*.jsonl
```

## Features (MVP+)

- **Agent loop**: system-prompt injection (auto-loads AGENTS.md/CLAUDE.md) → streaming request → tool calls → results fed back → multi-turn iteration (configurable cap)
- **10 built-in tools**: `bash`, `read_file`, `write_file`, `edit_file` (str_replace semantics), `list_dir`, `glob`, `grep` (ripgrep preferred), `todo_write`, `web_fetch`, `skill`
- **Permission model**: in `ask` mode, dangerous ops (bash/write/edit) emit a `permission_request` event → GUI approval card (allow / always-for-this-session / deny) or TUI y/n/a; `yolo` allows everything; non-interactive runs without `--yolo` deny dangerous ops
- **Storage double-write**: `~/.openzcode/db.sqlite` (session/message/todo/model_usage/tool_usage/permission, WAL) + `rollout/<sessId>.jsonl`; automatic JSON fallback where `node:sqlite` is unavailable
- **Model access**: provider registry (openai/anthropic protocols, multiple providers, default switching, connection test, keys stored 0600 and masked in echo)
- **Desktop App**: session sidebar (persisted & restored), streaming rendering, tool cards, approval cards, token usage, todo panel, settings panel (providers/MCP/skills), workspace switching (engine restarts along), engine crash auto-restart
- **CLI TUI**: streaming output, tool lines, permission prompts, slash commands (/new /sessions /resume /provider /skills /mcp /plugins /commands /reload /quit)

## MCP Servers (stdio + Streamable HTTP)

Tools are exposed to the model under the `mcp__<server>__<tool>` namespace and appear in the tool table automatically; crashed servers are restarted and the call retried once.

Three config scopes (project > user > plugin on name conflict):

```jsonc
// ~/.openzcode/mcp.json (user) or <workspace>/.mcp.json (project)
{
  "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
    "deepwiki":   { "url": "https://mcp.deepwiki.com/mcp", "headers": { "authorization": "Bearer xxx" } },
    "careful":    { "command": "./run.sh", "danger": true }   // danger: true → approval required in ask mode
  }
}
```

- GUI: ⚙ Settings → MCP Servers → add / disable / reload; CLI: `openzcode mcp list|tools|call <server> <tool> [json]`
- Transports: stdio (subprocess, JSON-RPC over newline-delimited frames) and Streamable HTTP (POST + `Mcp-Session-Id`, SSE or JSON responses)

## Skills

A `SKILL.md` (YAML frontmatter: `name` + `description`) lives in any of: `~/.openzcode/skills/<name>/`, `<workspace>/.openzcode/skills/<name>/`, or a plugin's `skills/`. Names + descriptions are injected into the system prompt; when a task matches, the model calls the `skill` tool to load the full instructions. Example: [`examples/skills/repo-conventions`](examples/skills/repo-conventions/SKILL.md).

## Plugins & Custom Commands

A plugin = a directory under `~/.openzcode/plugins/<name>/` (or project `.openzcode/plugins/`) that can contribute `skills/` + `commands/` + `mcp.json` at once. Full example: [`examples/plugins/demo-plugin`](examples/plugins/demo-plugin).

```bash
openzcode plugin install ./my-plugin    # installs (copies to user scope)
openzcode plugin list | remove <name>
```

Custom slash commands: `~/.openzcode/commands/<name>.md` (or project/plugin `commands/`), frontmatter `description`, body is a prompt template where `$ARGUMENTS`/`$1` are substituted with what you type. Example: [`examples/commands/translate.md`](examples/commands/translate.md). Works in both TUI and GUI via `/name args`.

## Data Layout (`~/.openzcode/`)

```
config.json             providers + permissionMode (0600)
db.sqlite (| db.json)   structured sessions/messages/usage/permissions
rollout/<sessId>.jsonl  raw model-IO records
workspace/default       default working directory
```

## Testing

```bash
npm run test:ci          # LLM-free smoke: RPC/config/session/storage/robustness (what CI runs)
npm run test:e2e         # real-LLM E2E: requires env OPENZCODE_TEST_API_KEY
npm run test:artifact    # artifact integration test: built artifact does REAL read/write on THIS repo, then asserts
npm run package          # build the release zip
```

- `test:e2e` and `test:artifact` need a real model service: set `OPENZCODE_TEST_API_KEY` (optionally `OPENZCODE_TEST_BASE_URL`, `OPENZCODE_TEST_MODEL`), or configure a default provider in `~/.openzcode/config.json`. Keys never enter the repository.
- `test:artifact` is the final acceptance gate: it drives the agent with the **built artifact** (`OPENZCODE_BUNDLE` may point at the openzcode.cjs extracted from a release zip) using **this repository** as the workspace — the model must read real source files (`packages/cli/src/version.js`, `README.md`, `packages/app/package.json`) and write extracted facts into `.oz-itest/` (gitignored); assertions compare the bytes on disk against ground truth parsed from the repo itself.

## RPC Surface (app-server)

`initialize`, `server/info`, `config/get|setProvider|removeProvider|setDefaultProvider|setOptions|testProvider`,
`session/create|list|get|messages|todos|send|stop|approve|delete`,
`mcp/list|reload|toggle|call|userConfig|saveUserConfig`, `skills/list`, `commands/list|expand`, `plugin/list|install|remove`;
event notification `session/event` (`turn_started` / `text_delta` / `message` / `tool_start` / `tool_end` / `permission_request` / `permission_resolved` / `todo_updated` / `skill_loaded` / `usage` / `session_updated` / `turn_done`), `mcp/status`.

## CI / Release

- **CI** (`.github/workflows/ci.yml`): push/PR → install (skips the Electron binary) → build bundle → LLM-free smoke test → (optional, when the `OPENZCODE_TEST_API_KEY` secret is configured) real-LLM E2E → upload artifact.
- **Release** (`.github/workflows/release.yml`): pushing a `v*` tag → build + smoke → package `openzcode-v*-bundle.zip` → automatically create a GitHub Release with the artifact.

## Gap vs. full ZCode (intentional cuts)

Beyond the backbone, this repo implements an MCP client, skills, plugins and custom commands. Still not included (extension points reserved): subagents, computer-use / browser-use brokers (UDS+token), scheduler (cron automations), telemetry (OpenTelemetry), local CA MITM proxy, session compact/fork, checkpoints, remote plugin marketplace.

## License

[Apache-2.0](LICENSE)
