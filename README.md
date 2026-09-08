# Claude Code Approver for Ulanzi D200

Answer Claude Code permission prompts from a deck key instead of the terminal.

Claude Code's `PermissionRequest` hook is an HTTP POST whose **response body carries the
decision**. This plugin runs a local HTTP server, holds that response open, lights up the key
with the tool Claude wants to run, and answers with whatever you press. Nothing is polled and
nothing is scraped from the terminal — the decision path is the hook itself.

```
Claude Code ──POST /hook──▶ plugin (Node, inside Ulanzi Studio)
                               │  request held open, key turns green
                               ▼
                          you press Approve
                               │
Claude Code ◀──{"decision":"allow"}──┘
```

## Actions

| Action | Behaviour |
|---|---|
| **Approve** | Green with the tool name while a request waits; press to allow it once. |
| **Always Allow** | Allows it, and stops asking for that kind of command for the rest of that session. |
| **Deny** | Red while a request waits; press to reject. |
| **Next Request** | Cycles when several sessions are queued (`2/3`). |
| **Claude Status** | One live key per Claude Code session — see below. |

Keys sit dim and grey when nothing is pending, so the deck doubles as an at-a-glance
"is Claude waiting on me" light. If the plugin is not running, Claude Code never gets an answer
from the hook and falls back to its normal terminal prompt — nothing breaks.

### Always Allow is ours, not Claude Code's

A `PermissionRequest` hook may only answer `allow`, `deny` or `ask`; the protocol has no field
for writing a permission rule back into Claude Code. So the rule is kept in the plugin: pressing
Always records it against that `session_id`, and later matching requests are answered before the
key ever lights up. It is dropped at `SessionEnd`, and your `settings.json` is never touched.

Rules are derived from the request: `git push --force origin main` becomes `git push *`, not
`git *` — so allowing a push never quietly allows `git reset --hard`. Commands with nothing
useful in their second word (`ls -la`) become `ls *`, and non-Bash tools become `Write *`.
The Always key shows the rule it is about to create before you press it.

### Claude Status

Each Claude Status key follows one session and shows its project folder, what it is doing, and
how full its context window is:

| Colour | State |
|---|---|
| Blue | Working |
| Yellow | Needs approval *(flashes)* |
| Purple | Input needed *(flashes)* |
| Green | Finished |
| Grey | Idle |

When that session is waiting on a decision, the key switches to the question itself — the tool,
the actual command, and the seconds left — because "what am I about to allow?" matters more than
"which project is this?" at the moment you are deciding. It returns to the normal view once you
answer.

Add as many keys as you want sessions tracked — each claims the next active session in the
order the keys were added, oldest session first, so a key keeps showing the same session as
others come and go. Pin a key to one project by naming its folder in the key's settings.

The context bar comes from the session's transcript: hook payloads carry no token accounting,
but they do carry `transcript_path`, and the newest assistant line records
`input_tokens + cache_creation + cache_read` — exactly what was in the window on that turn.
It is re-read at most every 5 seconds. The bar turns amber past 60%, orange past 85% and red
past 95%. A `∞2` under the bar means that session has two always-allow rules.

## Install

Install the one runtime dependency:

```bash
cd com.ulanzi.claudeapprover.ulanziPlugin && npm install
```

Quit Ulanzi Studio -- it keeps the plugin's node process open -- then copy the whole
`com.ulanzi.claudeapprover.ulanziPlugin/` folder (including `node_modules/`) into the plugins
directory:

```
Windows   %APPDATA%\Ulanzi\UlanziDeck\Plugins\
macOS     ~/Library/Application Support/Ulanzi/UlanziDeck/Plugins/
```

The folder name must stay exactly `com.ulanzi.claudeapprover.ulanziPlugin` -- Ulanzi Studio
identifies plugins by it. Start Ulanzi Studio and the five actions appear under
"Claude Code"; drag them onto keys.

Then point Claude Code at the plugin: merge [hooks.example.json](hooks.example.json) into
`~/.claude/settings.json` and restart Claude Code. If that file already has a `hooks` block,
merge event by event rather than replacing it. Only `PermissionRequest` is required -- the other
nine events feed the Claude Status keys and release held requests when a session ends.
`PreToolUse` is status-only: it is answered immediately and never held, so tool calls are never
blocked waiting on a key.

Check it came up:

```bash
curl http://127.0.0.1:9247/hook
```

`{"ok":true,"pending":0}` means the plugin is listening.

## Settings

Configured from any key's property inspector; the last key you configure wins, since the
server is shared.

| Setting | Default | Notes |
|---|---|---|
| Listen port | `9247` | Must match the URL in `settings.json`. |
| On timeout | Fall through | `ask` returns no decision, so Claude Code prompts in the terminal as usual. `deny` blocks the call. |
| Hold seconds | `110` | Keep it below the hook's `timeout` (120) so the plugin answers first. |
| Only this working directory | empty | Substring match on `cwd`; other projects fall through to the terminal. |
| Shared secret | empty | When set, requests must carry `X-Approver-Token`. |

The server binds `127.0.0.1` only.

## Debugging

Launch Ulanzi Studio with `--log --nodeRemoteDebug`, then open `chrome://inspect` and attach to
the plugin (the manifest exposes `--inspect=127.0.0.1:9248`). `GET http://127.0.0.1:9247/hook`
returns `{"ok":true,"pending":n}` and is the fastest way to tell whether the server is up.

## Layout

```
com.ulanzi.claudeapprover.ulanziPlugin/
  manifest.json              4-segment plugin UUID, 5-segment action UUIDs
  plugin/app.js              key lifecycle, painting, decisions
  plugin/lib/hook-server.js  HTTP server + held-response queue
  plugin/lib/rules.js        session-scoped always-allow rules
  plugin/lib/sessions.js     session registry + context-window reader
  plugin/lib/render.js       SVG key icons as base64 data URLs
  plugin/plugin-common-node/ vendored Ulanzi Node SDK
  property-inspector/        settings UI
  libs/                      vendored Ulanzi HTML SDK
```

Built against the [official Ulanzi SDK](https://github.com/UlanziTechnology/UlanziDeckPlugin-SDK)
(protocol V2.1.2, Ulanzi Studio 3.0.11+) and the
[Claude Code hooks reference](https://code.claude.com/docs/en/hooks).

## Licence

MIT — see [LICENSE](LICENSE).

The vendored Ulanzi SDK under `plugin/plugin-common-node/` and `libs/` is Ulanzi's, Apache 2.0,
and carries its own notices.
