# dsh-bridge

Bridge external coding-agent sessions into the **DeepSeek Harness (dsh)** web UI.

The Bridge is **instance-based**: users create one or more saved bridges, each
with its own transport mode, engine, name, and configuration. The same engine can
appear in several bridges (for example two Pi bridges with different session
roots). The top-left dsh mark shows **Local** (the native dsh conversation) plus
every saved bridge, and selecting one switches both the sidebar and the main
conversation area to that bridge.

Three CLI engines are fully supported — **Pi**, **Codex**, and **OpenCode** — each
with its own session store, live attachment protocol, model catalog, and event
normalizer. Remote **DSH** (a second DeepSeek Harness instance) appears in the
add-bridge form but is marked as pending until its adapter is connected.

## Status

- [x] Bridge-instance host model (`bridges[]`, no global “active backend”)
- [x] Multiple bridges per engine with independent config
- [x] Create/edit/delete bridges in a standalone settings page styled like native dsh Settings
- [x] CLI / Web mode selection and mode-specific engine list
- [x] Confirmed Pi engine: JSONL sessions, RPC attach, normalized events, prompts
- [x] Confirmed Codex engine: rollout JSONL sessions, `app-server` JSON-RPC attach, approval dialogs
- [x] Confirmed OpenCode engine: SQLite sessions, local `serve` HTTP/SSE attach, permission dialogs
- [x] Top-left “Local + configured bridges” dropdown with live connection dots
- [x] Startup readiness probe per bridge (no agent spawned)
- [x] Per-turn lazy attach: send starts Pi, settle closes it
- [x] Sidebar session status: spinner while running, green dot when done
- [x] Bridge-owned sidebar while a bridge is selected
- [x] Import-first sessions: external sessions stay out of the sidebar until explicitly imported
- [x] Import dialog with workspace tree / flat-list views, search, and multi-select
- [x] dsh-identical workspace browser: workspace / workspace-tree / flat grouping, manual / last-updated ordering, session filter
- [x] dsh-style search button and result list
- [x] dsh-style Select Workspace Directory dialog with New folder
- [x] Per-workspace New Session action plus workspace rename / soft delete
- [x] Durable workspace mapping in `bridge-workspaces.json`; delete marks only, never touches engine data
- [x] Durable per-bridge import membership in `bridge-imports.json`
- [x] Host-owned, per-bridge session archive in `bridge-archives.json` with attach/prompt admission checks
- [x] dsh-styled transcript: native process rows, tool cards, and composer
- [x] Draggable left/right content-width handles, sharing dsh Web's width preference
- [x] Composer model picker and a dsh-style statusline (turns/steps, tokens, cache hit)
- [ ] Remote DSH Web engine adapter

## UX

### Top-left switcher

The dsh brand mark opens a menu:

```text
Local                     Return to DeepSeek Harness
────────────────────────────────────────────────────
Work Pi                   CLI · Pi
Scratch Pi                CLI · Pi
Company Codex             CLI · Codex
Bridge settings
```

- **Local** returns to the native dsh conversation and restores the stock
  sidebar.
- Each configured bridge is a separate row. Bridges are not engines, so two Pi
  rows are normal and expected.
- A status dot sits beside each bridge: green = connected, orange = connecting,
  red = failed. Hovering it shows the reason.
- Unavailable engines are shown but disabled.
- **Bridge settings** opens the standalone Bridge settings page; it stays out of
  the native dsh Settings dialog and does not navigate away from the current page.

### Import sessions

Bridge is **import-first**. Sessions that merely exist below an engine's session
root are candidates, not sidebar rows. Until the user imports one, the sidebar
stays unchanged; this prevents terminal-created sessions from silently
appearing in every browser profile.

The import button (database icon) in the Bridge sidebar header opens a dialog
that reads the complete engine session list:

- **Tree** groups sessions by workspace folder and supports workspace-level
  select-all across descendant folders.
- **List** shows a flat, newest-first view for quick scanning.
- Search filters by session title, first message, id, or workspace path.
- Imported rows are marked and disabled; the dialog can be reopened at any time.
- **Import** calls `POST /api/bridge/imports`; only then are the selected
  sessions admitted to the left sidebar and their workspaces reconciled.

A new session created from Bridge is an explicit user action and is imported
immediately. Import membership is persisted per bridge in
`$DSH_HOME/bridge-imports.json`, separate from agent JSONL and the archive set.

### Connection lifecycle

When the dsh host starts, every configured bridge is probed by
`bridge: auto-connect`. Each engine's probe only checks its launcher and its
session store — Pi's sessions root, Codex's rollout root, OpenCode's
`opencode.db`; **no agent process is spawned**. The status endpoint
`GET /api/bridge/status` reports that readiness, and the switcher polls it while
open.

Agent processes are **per turn**:

1. opening a session reads durable history only (composer is already available);
2. the first send calls `POST /api/bridge/attach` and then `prompt`;
3. the sidebar row shows a spinner while the turn runs;
4. `agent_settled` marks the row green and closes the engine process ~1.2s later
   (long enough to flush the final events).

So one bridge needs at most one agent process while a turn is active, rather than
one process per opened session. Sending again in the same session re-attaches.

Session activity is host-owned (`sessionActivity`) and exposed via
`GET /api/bridge/activity?bridge=<id>`; the sidebar polls it every 2s.

### Current model without an agent

Pi records its effective model durably in the session JSONL: a `model_change`
tree entry on every switch, plus `provider` / `model` / `thinkingLevel` on each
assistant message. The bridge parses the current branch and reports
`session.model`, so an unconnected session still shows its model instead of a
placeholder. Live attachment state stays authoritative and overrides it.

### Engines

Each engine owns its own session storage, attach protocol, and event mapping.
Nothing engine-specific leaks into the host: `src/backends/registry.js` imports
the three descriptors and the routes only ever call the adapter contract.

| Engine | Session store | Live attachment | Model catalog | Approvals |
| --- | --- | --- | --- | --- |
| **Pi** | `$PI_CODING_AGENT_SESSION_DIR` JSONL tree | `pi --mode rpc` over JSONL on stdio | `get_available_models` on a short-lived RPC child | Extension UI dialogs forwarded to the browser |
| **Codex** | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` | `codex app-server --stdio` over JSON-RPC 2.0 | `model/list` on a short-lived app-server | `item/*/requestApproval` answered by the Bridge, or forwarded when approvals are kept |
| **OpenCode** | `opencode.db` (SQLite; v2 `session_message` with a legacy `message`/`part` fallback) | `opencode serve` on a loopback port, HTTP + SSE | `GET /provider` from the same server | Permission and question events answered or forwarded |
| **DSH** | remote instance | planned | planned | — |

Two engine-specific quirks are worth knowing because they shape the UI:

- **Codex has no persisted session title.** The sidebar name is derived from the
  session's first real user message, and harness-injected user turns
  (`<environment_context>`, `AGENTS.md`, aborted-turn notices) are filtered out
  so they never become a title.
- **OpenCode's database holds two schema generations.** A session can be
  announced by one CLI version and continued by another, so reading prefers the
  newer `session_message` transcript and falls back to the legacy
  `message`/`part` pair. The reader opens the database read-only and closes it
  after every query.

Every adapter translates its native tool names onto the same narrow vocabulary
the browser styles (`bash`, `read`, `search`, `write`, `edit`, `others`), from
both the durable transcript and the live stream, so a call looks identical
before and after a reload.

### Model catalog without an agent

No engine's catalog can be read from its session store: Pi computes it from
`models.json`, the bundled catalog, credentials, and extension providers; Codex
answers `model/list`; OpenCode collects it from its configured providers. Instead
of a resident control process, each engine spawns a short-lived instance on
demand — `pi --mode rpc --no-session`, `codex app-server`, or a temporary
`opencode serve` — asks for the catalog, and exits. The host caches the result
per bridge for 10 minutes.

`GET /api/bridge/models?key=…` therefore works while detached: it reads the live
attachment when there is one, and otherwise returns the cached/short-lived
catalog (`source: "catalog"`, `cached: true|false`). Model selection with no
agent stores a pending choice that is applied right after the next attach.

### Settings page

Bridge settings is a **standalone page**, not a section inside dsh's own
Settings dialog. Its overlay shell, nav rail, title hierarchy, cards, buttons,
inputs, and spacing are copied from the native dsh Settings surfaces (especially
Models), so it still reads as the same product:

- **Manage bridges**: list every saved bridge, add a bridge, edit its name/mode/
  engine/config, or delete it.
- Add-bridge form:
  - **Bridge mode**: CLI or Web
  - **Engine**:
    - CLI → Pi, Codex, OpenCode
    - Web → DSH
  - engine-specific fields:
    - **Pi**: Sessions root, Bin path, Offline startup
    - **Codex**: Sessions root, Bin path, Skip approvals
    - **OpenCode**: Data directory, Bin path, Auto-approve
    - **DSH**: Base URL and Access token. Tokens are redacted from API responses
      and preserved when an edit leaves the secret field blank.

The two approval switches exist because a Bridge turn has no native terminal to
answer. `Skip approvals` (Codex) starts the app-server with `approvalPolicy:
never`; `Auto-approve` (OpenCode) answers the server's permission events itself.
Turn either off and those prompts are forwarded to a Bridge dialog instead — but
a prompt the Bridge cannot answer would leave the turn waiting, so both default
to on.

### Selected bridge

Selecting a saved bridge:

1. opens the Bridge main panel;
2. replaces the stock `sidebar.workspaces` browser with the bridge's workspace/
   session tree. The browser reuses dsh's `dsh-client-ui-primitives`, visual tokens,
   row metrics, icons, and menus, and supports workspace / workspace-tree / flat
   grouping, manual / last-updated ordering, archived-session filtering, a search
   button, and the directory-picker dialog;
3. loads session history into the main transcript;
4. keeps the composer and live streaming attached to that bridge.

Submitting is local-first: the user bubble appears on the click, the card clears
immediately, and a `深度求索中，用时 …` line with a whale tail waits below the
transcript. That line covers the whole turn — while the agent is being connected
and while the model is working — and its clock starts when the host accepts the
prompt, so connecting a cold agent never inflates the reported time. A failed
submit takes the bubble back and returns the text to the card.

With no session open the panel is dsh's New Session hero: the fish, the
`探索未至之境 / Into the Unknown` headline with its preview badge, and the composer
card with a **workspace chip** above its top-left corner. The chip lists the
bridge's workspaces and opens the same directory picker the sidebar uses; sending
creates the session in the selected workspace and submits the text there.

The transcript mirrors dsh's own chat surface rather than a bespoke log view:
each tool call and reasoning block is a 24px disclosure row with a per-variant
icon, a localized verb (`Read`, `Search`, `Run command`, `Write`, `Edit`, …), a
dot separator, and a one-line argument summary; consecutive steps fold into one
process group at dsh's 6px rhythm, above a right-aligned user bubble and a
headerless assistant answer. Expanding a row shows the shipped result cards —
`TerminalBlock` for shell calls, `DiffBlock` for edits and writes, and an IN/OUT
card for everything else.

The composer follows dsh's docked card geometry (`--dsh-composer-*` sizing,
panel radius, input surface, and elevation). Its trailing control row is
right-aligned and contains:

- a **model picker** backed by the attached engine's model catalog, grouped by
  provider and switched through the engine's native `set_model` RPC;
- the same circular **send** button dsh's own composer paints: a 34px
  info-blue circle on a static white up-arrow glyph. While the agent runs it
  keeps the circle and swaps only the glyph for the rounded-square stop, so
  the control never changes shape or colour mid-turn.

Below the card, the statusline mirrors dsh's shipped composer dock: a gauge
pill for turns/steps, a database pill for total tokens plus cache-hit rate, and
the context-occupancy ring when the engine reports context usage. Each opens
the same kind of compact detail panel. Bridge statistics come from the engine's
`get_session_stats` RPC, with a transcript-fold fallback for engines that do not
expose statistics. This is a visual and interaction match, not a reuse of dsh's
session projections: external agents have their own session model.

Returning to **Local** disposes the Bridge sidebar occupant and restores dsh's
native workspace browser.

## Architecture

```text
Browser (dsh web)
  ├─ Brand switcher ────────> GET /api/bridge/settings
  ├─ Bridge settings page ──> POST/PUT/DELETE /api/bridge/bridges
  ├─ Import dialog ─────────> GET/POST /api/bridge/imports
  └─ Bridge main panel ─────> GET /api/bridge/sessions?bridge=<id>
                              /api/bridge/{session,attach,prompt,events,…}

Host bridge core
  ├─ bridge instance store (bridge.json)
  ├─ engine registry (Pi / Codex / OpenCode / DSH)
  ├─ opaque keys (`bridgeId.base64url(nativeKey)`)
  └─ generic attachment + SSE lifecycle

Engine adapters
  ├─ Pi (implemented)
  ├─ Codex (implemented)
  ├─ OpenCode (implemented)
  └─ DSH (planned)
```

The host imports concrete adapters only in `src/backends/registry.js`. The browser
never imports an engine/CLI implementation.

### Engine adapter contract

An engine provides:

| Member | Purpose |
| --- | --- |
| `id`, `label`, `mode` | Identity and `cli`/`web` transport classification |
| `available`, `unavailableReason` | Honest state for unfinished adapters |
| `capabilities` | Features the UI may expose |
| `configFields`, `defaultConfig()` | Fields rendered in the add/edit form |
| `listSessions(config, env)` | Workspace/session summaries |
| `readSession(nativeKey, config, env)` | Normalized history |
| `createAttachment({session, config, env})` | Live agent handle |
| `normalizeEvent(nativeEvent)` | Native events → bridge event vocabulary |

Normalized events are `agent-start`, `agent-end`, `message-start`,
`message-update`, `message-end`, `tool-start`, `tool-update`, `tool-end`,
`session-name`, and `backend-event`.

## Host routes

All routes sit below dsh's authenticated `/api` channel.

| Route | Purpose |
| --- | --- |
| `GET /api/bridge/settings` | Modes, engines, and redacted bridge list |
| `GET/POST/PUT/DELETE /api/bridge/bridges` | Manage saved bridges |
| `GET/POST /api/bridge/status` | Read or refresh per-bridge readiness state |
| `GET /api/bridge/activity?bridge=<id>` | Per-session running/idle/failed activity |
| `GET /api/bridge/sessions?bridge=<id>` | List one bridge's **imported** sessions/workspaces |
| `GET/POST /api/bridge/imports` | Discover all engine sessions; persist selected session/workspace imports |
| `GET/POST /api/bridge/directories` | Browse / create local workspace directories |
| `GET /api/bridge/session?key=…` | One normalized session history |
| `GET /api/bridge/capabilities` | Protocol and live attachment table |
| `POST /api/bridge/attach` | Start a live attachment |
| `POST /api/bridge/detach` | Close it |
| `GET /api/bridge/state?key=…` | Engine state snapshot |
| `GET /api/bridge/events?key=…` | SSE stream of normalized events/UI |
| `POST /api/bridge/prompt` | Prompt, steer, or follow up |
| `POST /api/bridge/abort` | Abort the running turn |
| `POST /api/bridge/ui-response` | Answer an extension dialog |
| `GET /api/bridge/models?key=…` | Provider/model catalog (works while detached) |
| `POST /api/bridge/models` | Select a provider/model on the live attachment |
| `GET /api/bridge/stats?key=…` | Engine session statistics |
| `GET /api/bridge/history-message?key=…` | Concatenated plain-text history |

A session key is `<bridgeId>.<base64url(nativeKey)>`. It resolves only against
that bridge; changing a bridge's session root invalidates old paths exactly as
before.

## Session imports

Import state is owned by the bridge host, not browser storage. The host keeps
`$DSH_HOME/bridge-imports.json` (versioned, 0600, atomic writes) as a per-bridge
ordered set of native session keys.

- `GET /api/bridge/imports?bridge=<id>` returns every discovered candidate plus
  `imported: true|false` and the workspace candidates.
- `POST /api/bridge/imports` accepts `{ bridge, sessionKeys, workspacePaths }`,
  validates that keys/paths were discovered for that bridge, and is idempotent.
- `GET /api/bridge/sessions` filters its result through this import set. The
  workspace store is no longer auto-populated from every discovered `cwd`.
- Deleting a bridge also deletes its import set.

## Session archiving

Archive state is owned by the bridge host, not by browser storage. The host
keeps `$DSH_HOME/bridge-archives.json` (versioned, 0600, atomic writes) as a
per-bridge ordered set of native session keys. Pi JSONL files, workspace
accounting, and message history are never modified.

- `GET /api/bridge/sessions` returns both `archivedKeys` (browser-facing,
  bridge-prefixed keys) and an `archived` flag on every session summary.
- `POST /api/bridge/archive` takes `{ key, archived }` and returns the complete
  authoritative key set, so open tabs converge on the same state.
- Archived sessions cannot be attached or prompted through the bridge. An idle
  attachment is closed when its session is archived; a running session is
  rejected with `409` and must be aborted first.
- Startup auto-connect warms the newest **unarchived** session.
- Deleting a bridge also deletes its archive set.
- Legacy browser-local `archivedKeys` are ignored rather than migrated, since
  they were scoped to one browser profile and cannot be trusted as host state.

This mirrors dsh Web's model of a durable registry-global archive set while
keeping bridge instances isolated from one another. An external Pi CLI process
is outside the bridge host and therefore cannot be stopped by this gate.

## Configuration

Bridges live in `$DSH_HOME/bridge.json` (mode 0600), written atomically. The old
`$DSH_HOME/pi-bridge.json` and older per-engine `backends` schema are migrated
automatically.

```json
{
  "version": 3,
  "bridges": [
    {
      "id": "pi-local",
      "name": "Pi",
      "mode": "cli",
      "engine": "pi",
      "config": {
        "sessionsRoot": null,
        "binPath": null,
        "offline": true
      }
    }
  ]
}
```

Engine-specific environment variables still work as adapter defaults, so a
bridge can stay empty when the shell already points at the right install:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_BIN` | auto | Pi executable when the bridge's `binPath` is unset |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi config directory |
| `PI_CODING_AGENT_SESSION_DIR` | `$PI_CODING_AGENT_DIR/sessions` | Pi session root |
| `CODEX_BIN` | auto | Codex executable when `binPath` is unset |
| `CODEX_HOME` | `~/.codex` | Codex config directory; its sessions live in `sessions/` |
| `OPENCODE_BIN` | auto | OpenCode executable when `binPath` is unset |
| `XDG_DATA_HOME` | `~/.local/share` | OpenCode's data directory is `$XDG_DATA_HOME/opencode` |

`binPath` always wins over the environment, and the environment wins over `PATH`. A
bridge whose launcher cannot be resolved reports that on its status dot instead of
failing at send time.

## Development

```bash
npm test              # unit tests
npm run test:secrets  # credential leak guard
node tests/live-smoke.mjs                    # read-only live checks
DSH_SMOKE_ATTACH=1 node tests/live-smoke.mjs # attach, prompt, stream, detach
```

See [docs/architecture.md](docs/architecture.md) for the detailed design and
adapter roadmap.

## License

MIT
