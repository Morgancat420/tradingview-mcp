# Evolve Dashboard

A local-only web UI that wraps the evolve strategy loop.

```bash
npm install                 # first time only
npm run dashboard           # then open http://127.0.0.1:7420
```

Port is configurable with `PORT=8080 npm run dashboard`.

## What it does

| Tab | Purpose |
|---|---|
| **Status** | Probes for TradingView CDP (port 9222), the `claude` CLI, `node_modules`, and existing results. Includes a "Launch TradingView" button that runs `scripts/launch_tv_debug_*.sh`. |
| **Run** | Form to configure an evolution run (strategy + data source + seed + symbols/tf/bars). Streams stdout live. |
| **Leaderboard** | Renders `leaderboard.md` as HTML after each run. |
| **Report** | Renders `FINAL_REPORT.md`. |
| **Editor** | In-browser editor for `evolve/evolve.js`. **Save & Run** kicks off a fresh evolution in one click. Saves are syntax-checked with `node --check` before atomic rename; invalid saves surface a banner with the line number and the file on disk is untouched. |
| **Chat** | Brainstorm strategies with Claude Code. Shells out to `claude -p --session-id <uuid> --output-format stream-json` — **uses your existing Claude Code subscription. No API key needed.** The agent has full Read/Grep/Edit access to the repo so it can inspect `evolve/` files directly. |

## Architecture

One Node HTTP server at `evolve/dashboard/server.js` + a single-page
`index.html`. No build step, no frameworks, no new npm dependencies
(uses only `http`, `fs`, `child_process`, `crypto` from the Node
standard library). CJS under `evolve/` (which has its own
`package.json` override).

Endpoints:

```
GET  /                          → index.html
GET  /api/status                → health probe JSON
POST /api/launch-tv             → spawn launch_tv_debug_*.sh; returns runId
POST /api/evolve                → spawn node evolve/evolve.js; returns runId
GET  /api/evolve/:id/stream     → SSE of stdout for that run
GET  /api/leaderboard           → raw leaderboard.md
GET  /api/report                → raw FINAL_REPORT.md
GET  /api/config                → current evolve/evolve.js source + mtime
PUT  /api/config                → save evolve/evolve.js (node --check first)
POST /api/chat                  → start or continue a claude -p session
GET  /api/chat/:sid/stream      → SSE of stream-json output
GET  /api/chat/sessions         → list persisted sessions
```

## Security

- Binds to `127.0.0.1` only — not reachable from other machines.
- No shell interpolation: all subprocess spawns use `spawn(cmd, [args])`, never `exec`.
- The editor can only write to `evolve/evolve.js` (resolved once at startup, hard-coded).
- `claude -p` runs under **your** Claude Code settings — its permission
  prompts surface in the event stream; you can't bypass your own
  permissions through the dashboard.
- No auth on the dashboard — it's single-user and local-only.

## Chat — how the subscription works

When you send a chat message, the server spawns:

```
claude -p "<your message>" \
  --session-id <uuid> \
  --append-system-prompt "<evolve context>" \
  --output-format stream-json \
  --verbose \
  --resume <uuid>        # on turn 2+ of the same session
```

The `claude` CLI is already logged in on your machine (Max/Pro
subscription via `claude login` / OS keychain / `~/.claude/...`). The
spawned subprocess inherits that authentication — the dashboard server
never touches an API key and never talks to `api.anthropic.com`.

Sessions are persisted at `evolve/dashboard/sessions/<uuid>.json`
(just `{id, title, createdAt, turnCount}`). The actual transcripts
live wherever your `claude` CLI stores them (normally
`~/.claude/projects/...`). The dashboard's "New session" button just
forgets the current UUID and starts a fresh one on the next message.

## Known limitations

- Single concurrent evolution run (`POST /api/evolve` returns 409 if
  one is already in flight).
- No auth — do not bind this to `0.0.0.0` and expose it.
- Markdown renderer is a minimal shim (headers + tables + code blocks);
  GitHub-flavored extras like task lists aren't supported.
- `node_modules` check only looks at the directory's existence, not
  whether it matches the current `package.json`.
