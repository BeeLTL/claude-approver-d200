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
| **Answer** | Answers one option of a question. Place a few; each takes the next option. |
| **Plan Usage** | How much of your 5-hour or weekly limit is gone, with a countdown to the reset. |
| **Session Board** | The wide key: the session that most wants you, in full — see below. |

Keys sit dim and grey when nothing is pending, so the deck doubles as an at-a-glance
"is Claude waiting on me" light. If the plugin is not running, Claude Code never gets an answer
from the hook and falls back to its normal terminal prompt — nothing breaks.

### Answering somewhere else

The hook does not replace Claude Code's own prompt, it races it: the terminal prompt goes up
while the hook is still running, so the same request is live in two places and whichever answers
first wins. Answer in the terminal and the deck finds out two ways -- Claude Code drops the held
connection, and the tool event that follows carries the same `tool_use_id`. Either one clears the
key immediately, so it never goes on asking for a press that can no longer do anything.

### Always Allow

Pressing Always returns an `updatedPermissions` entry alongside the allow, which asks Claude Code
to add a session-scoped allow rule of its own:

```json
{ "type": "addRules", "behavior": "allow", "destination": "session",
  "rules": [{ "toolName": "Bash", "ruleContent": "git push *" }] }
```

`destination: "session"` means in memory, discarded when the session ends -- your `settings.json`
is never touched. Once Claude Code holds the rule, matching calls stop reaching this plugin at
all, which is better than the plugin answering them quickly.

The plugin also keeps its own copy of the rule, keyed to that `session_id` and dropped at
`SessionEnd`, as a fallback for a host that ignores the field.

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
| Red | The plugin is not listening -- see below |

A key reading **offline** means the plugin could not bind its port, usually because a stale
copy still holds it. That is deliberately distinct from idle: silence has two causes, and
"nothing is happening" and "nothing can happen" call for different reactions. The wide board
spells it out in a sentence.

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

The window size is not recorded anywhere, so it is inferred -- but **per model, not per
session**. The largest prompt ever seen for a model is a lower bound on its window, rounded up
to the next real tier. Inferring it per session made the keys lie about each other: a quiet
194k session read 97% while a busier 227k one read 46%, because the quiet one had never proved
its window was large. One session reaching 822k now settles the window for every session on
that model, and the percentages became comparable -- which is the entire point of putting them
side by side.

### The Session Board (the wide key)

The D200 has one slot that is not square: `3_2`, 464x196, spanning two columns on the bottom
row. That is room for the whole picture rather than a fragment of it:

```
● SESSION  WORKING                        47s
claude-approver-d200
claude-opus-5 · high · main
▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░   52%
```

It follows whichever session most wants a human — needs approval first, then input needed, then
working, then finished — or pins to one project if you name it in the key's settings. When a
request or a question is waiting, the heading becomes that instead of the state, because the
thing waiting on you outranks the status.

The model, effort and branch cost nothing to show: they are already on the same transcript line
the context reading comes from.

**Ulanzi Studio cannot assign that slot.** There is no way to drag onto it, and Studio clears
whatever is there whenever the page is edited in its UI. So the profile JSON is patched directly:

```powershell
powershell -ExecutionPolicy Bypass -File scriptspply-bigkey.ps1
```

Quit Ulanzi Studio first — it rewrites profiles on exit and would undo the patch, and the script
refuses to run while it is open. The page manifest is backed up alongside itself. Pass `-Revert`
to hand the slot back to Ulanzi's own widget.

The patch survives restarts and reboots. It does **not** survive rearranging keys on that page,
because Studio then re-saves the page from a model that knows nothing about `3_2`. Re-run the
script if the board goes blank after you have been moving keys around.

## What it costs

Almost all of the plugin is free. The hooks and the status keys involve no model at all — they
are HTTP calls and local file reads.

| Component | Token cost | When |
|---|---|---|
| Approve / Deny / Always Allow | none | hook only, no model |
| Claude Status, Session Board, Next | none | hooks plus your transcript on disk |
| Answer keys | none | hook only, no model |
| Plan Usage poll | ~11 | per poll, every 5 minutes |

Nothing in the plugin adds a token to a request: permissions and answers both travel on hooks
that were going to fire anyway. Plan Usage costs almost nothing in tokens but does spend an API
request every five minutes, which is worth knowing given what it measures. Pull the key off the
deck to stop it.

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

## Answering questions

`AskUserQuestion` is a tool, so it arrives as a `PermissionRequest` like any other -- and the
questions travel in its `tool_input`. The trick is that an allow decision may carry
`updatedInput`, and that tool reads its answers from exactly there:

```json
{ "behavior": "allow",
  "updatedInput": { "questions": [...], "answers": { "Ship which build?": "Release" } } }
```

So the plugin holds the request open, puts each option on an Answer key, and when you press one
it allows the call with the answer already filled in. The tool never asks: it runs with your
choice as its input and returns it to Claude. No MCP server, no synthetic keystrokes, no window
focus -- and it works in every session on the machine, because it is the same hook that carries
permissions.

There is one Answer action rather than four: place as many keys as the questions you want to
answer and each takes the next option, or pin a key to a fixed option in its settings.

A call may carry up to four questions. The keys show one at a time and repaint with the next the
instant you answer -- the header reads `Database 1/3` -- and every answer is sent together when
the last one is pressed. A question only half answered sends no decision at all, so Claude Code
falls back to its own picker rather than receiving half a mind.

The same fallback covers everything else: nobody presses a key before the hold runs out, the
question is superseded, the session moves on, or the plugin stops. In each case the request is
released with no decision and Claude Code asks in the terminal exactly as it would without the
deck.

### What the other fields cannot do

`PostToolUse.updatedToolOutput` looks like another way in, but the tool "has already run by the
time the hook fires" -- for a question, that means you already answered it. It can overwrite an
answer, not supply one. `PostToolUseFailure` only runs for "a tool that started executing",
which a declined call never does. And denying `AskUserQuestion` does not answer it either: it
arrives as "user dismissed", because a denied tool produced no result.

`updatedInput` is the only field that supplies an answer rather than replacing one, which is why
it is the one the keys use.

## Plan usage

Usage is not written to disk and there is no read-only endpoint for it: it arrives as
`anthropic-ratelimit-unified-*` headers on an ordinary API response. So the key sends the
cheapest request that exists -- one token to Haiku, body discarded -- and reads the headers. It
polls every five minutes, shared across every usage key; press one to refresh immediately.

It reads the login Claude Code already stores (`~/.claude/.credentials.json`, or the login
keychain on macOS) and never writes to it. When that login has expired the key says `expired`
rather than a vague auth error, because the fix is to sign in again. The plugin deliberately does
not refresh the token itself -- doing that means driving someone's login, and getting it wrong
could invalidate a working session.

The mechanism follows [Narlei Moreira's Claude Code Usage plugin](https://github.com/narlei),
MIT licensed; the implementation here is its own.

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
  plugin/lib/rules.js        session-scoped always-allow
  plugin/lib/usage.js        plan usage from the rate-limit headers rules
  plugin/lib/sessions.js     session registry + context-window reader
  plugin/lib/render.js       SVG key icons as base64 data URLs
  plugin/plugin-common-node/ vendored Ulanzi Node SDK
  property-inspector/        settings UI
  libs/                      vendored Ulanzi HTML SDK
scripts/apply-bigkey.ps1     points the D200's wide slot at the Session Board
hooks.example.json           the hook events to merge into settings.json
```

Built against the [official Ulanzi SDK](https://github.com/UlanziTechnology/UlanziDeckPlugin-SDK)
(protocol V2.1.2, Ulanzi Studio 3.0.11+) and the
[Claude Code hooks reference](https://code.claude.com/docs/en/hooks).

## Licence

MIT — see [LICENSE](LICENSE).

The vendored Ulanzi SDK under `plugin/plugin-common-node/` and `libs/` is Ulanzi's, Apache 2.0,
and carries its own notices.
