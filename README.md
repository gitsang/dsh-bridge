# dsh-bridge

Bridge external coding-agent sessions into the **DeepSeek Harness (dsh)** web UI.

The Bridge is **instance-based**: users create one or more saved bridges, each
with its own transport mode, engine, name, and configuration. The same engine can
appear in several bridges (for example two Pi bridges with different session
roots). The top-left dsh mark shows **Local** (the native dsh conversation) plus
every saved bridge, and selecting one switches both the sidebar and the main
conversation area to that bridge.

Pi is the first fully supported engine. Codex, OpenCode, and remote DSH appear in
the add-bridge form but are marked as pending until their adapters are connected.

## Status

- [x] Bridge-instance host model (`bridges[]`, no global “active backend”)
- [x] Multiple bridges per engine with independent config
- [x] Create/edit/delete bridges from the settings overlay
- [x] CLI / Web mode selection and mode-specific engine list
- [x] Confirmed Pi engine: JSONL sessions, RPC attach, normalized events, prompts
- [x] Top-left “Local + configured bridges” dropdown with live connection dots
- [x] Startup readiness probe per bridge (no agent spawned)
- [x] Per-turn lazy attach: send starts Pi, settle closes it
- [x] Sidebar session status: spinner while running, green dot when done
- [x] Bridge-owned sidebar while a bridge is selected
- [x] dsh-identical workspace browser: workspace / workspace-tree / flat grouping, manual / last-updated ordering, session filter
- [x] dsh-style search button and result list
- [x] dsh-style Select Workspace Directory dialog with New folder
- [x] Per-workspace New Session action plus workspace rename / soft delete
- [x] Durable workspace mapping in `bridge-workspaces.json`; delete marks only, never touches Pi JSONL
- [x] Host-owned, per-bridge session archive in `bridge-archives.json` with attach/prompt admission checks
- [x] dsh-styled transcript and composer
- [x] Draggable left/right content-width handles, sharing dsh Web's width preference
- [x] Composer model picker and a dsh-style statusline (turns/steps, tokens, cache hit)
- [ ] Codex engine adapter
- [ ] OpenCode engine adapter
- [ ] Remote DSH Web engine adapter

## UX

### Top-left switcher

The dsh brand mark opens a menu:

```text
Local                     Return to DeepSeek Harness
────────────────────────────────────────────────────
Work Pi                   CLI · Pi
Scratch Pi                CLI · Pi
Company Codex             CLI · Codex          (adapter pending)
Bridge settings
```

- **Local** returns to the native dsh conversation and restores the stock
  sidebar.
- Each configured bridge is a separate row. Bridges are not engines, so two Pi
  rows are normal and expected.
- A status dot sits beside each bridge: green = connected, orange = connecting,
  red = failed. Hovering it shows the reason.
- Unavailable engines are shown but disabled.
- **Bridge settings** opens the settings overlay in place; it does not navigate
  away from the current page.

### Connection lifecycle

When the dsh host starts, every configured bridge is probed by
`bridge: auto-connect`. For Pi the probe only checks the launcher and sessions
root; **no agent process is spawned**. The status endpoint
`GET /api/bridge/status` reports that readiness, and the switcher polls it while
open.

Agent processes are **per turn**:

1. opening a session reads JSONL history only (composer is already available);
2. the first send calls `POST /api/bridge/attach` and then `prompt`;
3. the sidebar row shows a spinner while the turn runs;
4. `agent_settled` marks the row green and closes the Pi process ~1.2s later
   (long enough to flush the final events).

So one bridge needs at most one Pi process while a turn is active, rather than
one process per opened session. Sending again in the same session re-attaches.

Session activity is host-owned (`sessionActivity`) and exposed via
`GET /api/bridge/activity?bridge=<id>`; the sidebar polls it every 2s.

### Settings overlay

The settings dialog floats above the current page with a left navigation column
and a right content area:

- **Manage bridges**: list every saved bridge, add a bridge, edit its name/mode/
  engine/config, or delete it.
- Add-bridge form:
  - **Bridge mode**: CLI or Web
  - **Engine**:
    - CLI → Pi, Codex, OpenCode
    - Web → DSH
  - engine-specific fields. Pi currently uses:
    - Sessions root
    - Bin path
    - Offline startup
  - DSH uses Base URL and Access token. Tokens are redacted from API responses
    and preserved when an edit leaves the secret field blank.

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

The composer follows dsh's docked card geometry (`--dsh-composer-*` sizing,
panel radius, input surface, and elevation). Its trailing control row is
right-aligned and contains:

- a **model picker** backed by the attached engine's model catalog, grouped by
  provider and switched through the engine's native `set_model` RPC;
- a circular **send** button, which becomes **stop** while the agent runs.

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
  ├─ Bridge settings overlay > POST/PUT/DELETE /api/bridge/bridges
  └─ Bridge main panel ─────> GET /api/bridge/sessions?bridge=<id>
                              /api/bridge/{session,attach,prompt,events,…}

Host bridge core
  ├─ bridge instance store (bridge.json)
  ├─ engine registry (Pi / Codex / OpenCode / DSH)
  ├─ opaque keys (`bridgeId.base64url(nativeKey)`)
  └─ generic attachment + SSE lifecycle

Engine adapters
  ├─ Pi (implemented)
  ├─ Codex (planned)
  ├─ OpenCode (planned)
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
| `GET /api/bridge/sessions?bridge=<id>` | List one bridge's sessions/workspaces |
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
| `GET /api/bridge/models?key=…` | Provider/model catalog |
| `POST /api/bridge/models` | Select a provider/model on the live attachment |
| `GET /api/bridge/stats?key=…` | Engine session statistics |
| `GET /api/bridge/history-message?key=…` | Concatenated plain-text history |

A session key is `<bridgeId>.<base64url(nativeKey)>`. It resolves only against
that bridge; changing a bridge's session root invalidates old paths exactly as
before.

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

Pi-specific environment variables still work as adapter defaults:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_BIN` | auto | Pi executable when the bridge's `binPath` is unset |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi config directory |
| `PI_CODING_AGENT_SESSION_DIR` | `$PI_CODING_AGENT_DIR/sessions` | Session storage root |

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
