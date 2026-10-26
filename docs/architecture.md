# Bridge architecture

## Concepts

The system separates four things that were previously conflated:

1. **Engine** — an adapter for one agent runtime and protocol (Pi, Codex,
   OpenCode, DSH Web).
2. **Bridge** — a saved, user-created instance of an engine. A bridge has an id,
   a user-visible name, a transport mode, an engine id, and an engine-specific
   config record.
3. **Host core** — authenticated routes, bridge persistence, opaque session
   keys, attachment lifecycle, and SSE fan-out.
4. **Browser shell** — brand dropdown, floating settings overlay, sidebar/
   session navigation, transcript, and composer.

The key invariant is: **the user selects a bridge, never an engine**. Any number
of bridge rows may share one engine.

```json
{
  "version": 3,
  "bridges": [
    { "id": "pi-work",  "name": "Work Pi",  "mode": "cli", "engine": "pi",
      "config": { "sessionsRoot": "/work/.pi/sessions", "binPath": null, "offline": true } },
    { "id": "pi-scratch", "name": "Scratch Pi", "mode": "cli", "engine": "pi",
      "config": { "sessionsRoot": "/tmp/pi-sessions", "binPath": null, "offline": true } },
    { "id": "remote-dsh", "name": "Remote DSH", "mode": "web", "engine": "dsh",
      "config": { "baseUrl": "https://dsh.example.com", "token": "***" } }
  ]
}
```

## Engine contract

`src/backends/registry.js` registers engines. Concrete adapters live in
`src/backends/<engine>/`.

An engine declares:

- `id`, `label`, `mode` (`cli` or `web`)
- `available` and `unavailableReason`
- `capabilities`
- `configFields` and `defaultConfig()`
- `listSessions(config, env)`
- `readSession(nativeKey, config, env)`
- `createAttachment({ session, config, env, logger })`
- `normalizeEvent(nativeEvent)`

The host never imports an adapter directly except through the registry. The
browser receives serializable engine descriptors from
`GET /api/bridge/settings`.

### Current engines

| Engine | Mode | State | Config fields |
| --- | --- | --- | --- |
| Pi | CLI | implemented | sessionsRoot, binPath, offline |
| Codex | CLI | planned | sessionsRoot, binPath |
| OpenCode | CLI | planned | sessionsRoot, binPath |
| DSH | Web | planned | baseUrl, token |

Planned engines can be saved as bridge records and appear in the menu disabled;
listing/attach returns a clear unavailable state instead of crashing.

## Session identity

A browser-facing session key is:

```text
<bridgeId>.<base64url(nativeKey)>
```

- Bridge ids are generated slugs such as `pi-<uuid>` and cannot contain dots.
- The native key is opaque to the host core. For Pi it is the absolute JSONL
  path; the Pi adapter validates it against the bridge's configured root.
- Requests resolve the bridge first, then delegate to its engine.

## Host routes

| Route | Purpose |
| --- | --- |
| `GET /api/bridge/settings` | Modes, engines, and redacted bridges |
| `GET/POST/PUT/DELETE /api/bridge/bridges` | Manage bridge instances |
| `GET/POST /api/bridge/sessions` | List one bridge's sessions/workspaces; create a session |
| `GET/POST/PUT/DELETE /api/bridge/workspaces` | List, add, rename, soft-delete workspaces |
| `POST /api/bridge/archive` | Archive / unarchive a session on the host |
| `GET /api/bridge/session?key=…` | Full normalized history |
| `GET /api/bridge/capabilities` | Protocol and live attachment table |
| `POST /api/bridge/attach` | Start an engine attachment |
| `POST /api/bridge/detach` | Stop it |
| `GET /api/bridge/state?key=…` | Engine snapshot |
| `GET /api/bridge/events?key=…` | SSE stream of normalized events |
| `POST /api/bridge/prompt` | Prompt/steer/follow-up |
| `POST /api/bridge/abort` | Abort a turn |
| `POST /api/bridge/ui-response` | Answer an extension dialog |

Bridge edits/deletes are rejected while that bridge has a live attachment.

## Workspace metadata

Pi session headers supply a `cwd` but no user-editable workspace title and no
delete state. The host therefore keeps `$DSH_HOME/bridge-workspaces.json`
(versioned, 0600, atomic writes) as a per-bridge mapping from workspace path to
an id, display name, timestamps, and an optional `deletedAt` tombstone.

- Listing sessions merges every engine-discovered `cwd` into this store, but
  never overwrites an existing name or revives a tombstone.
- Rename changes only the stored display name.
- Delete is a soft delete. The folder, Pi JSONL, and every message remain; the
  path is reported as `removedWorkspacePaths` so the browser files those sessions
  under Ungrouped instead of deriving the group again from `cwd`.
- The browser refreshes the Pi session list on panel load, explicit Refresh,
  window focus/visibility, an agent settling, a session-name event, and every
  workspace mutation. A filesystem watcher is deliberately unnecessary: Pi's
  JSONL remains the source of truth for sessions and titles.

## Session archive state

Pi has no native archive flag and browser `localStorage` does not travel with a
bridge. The host therefore owns archive state in
`$DSH_HOME/bridge-archives.json`:

```json
{
  "version": 1,
  "bridges": {
    "pi-work": { "sessionKeys": ["<nativeKey>", "…"] }
  }
}
```

The store is versioned, mode 0600, and written atomically. A native key is
scoped by its bridge id; the same Pi path archived in one bridge has no effect
in another. Backend-neutral archive operations are:

- `GET /api/bridge/sessions` → `archivedKeys` plus per-session `archived`;
- `POST /api/bridge/archive` `{ key, archived }` → complete `archivedKeys`.

The browser keeps `archivedKeys` only as the current projection for its
existing `default | show | only` filter. It does not write archive state to
storage. The host gate is applied in three places:

1. `attach()` rejects an archived session;
2. `prompt` rejects an archived session before dispatching;
3. startup auto-connect ignores archived sessions when choosing a warm target.

Archiving closes an idle attachment and refuses a running one with HTTP 409;
unarchiving only removes the durable marker, so the session returns to its
existing workspace/order position. Workspace accounting and Pi JSONL are never
touched. Deleting a bridge prunes its archive entry. An external Pi process is
outside this admission gate.

## Connection lifecycle and status

The host keeps a per-bridge connection state, not a per-session one:

```text
connections: bridgeId -> { state: idle|connecting|connected|failed,
                           error, checkedAt, latencyMs, detail }
```

On host start every bridge is probed: the engine probe validates the launcher
and session root only. **No agent is spawned at startup**, so the switcher dot
means "this bridge is ready", not "a child process is running".

Agent processes are per turn:

1. Opening a session is a read-only JSONL parse; the composer is available.
2. The first send calls `attach` (lazy) and then `prompt`.
3. `agent-start` flips the session activity to `running` (sidebar spinner).
4. `agent-settled` flips it to `idle` (green dot) and schedules a 1.2s
   `closeSession`, which disposes the Pi child.

`attachments` therefore holds at most one live process per actively running
session, and `pendingAttachments` deduplicates concurrent spawns. Per-session
activity lives in the host `sessionActivity` map and is exposed through
`GET /api/bridge/activity?bridge=<id>`; the sidebar polls it every 2s.

`GET /api/bridge/status` exposes the states and `POST` re-runs a probe.
`attach()` deduplicates concurrent spawns with a pending-attachment map, so
startup auto-connect and a user attach cannot spawn two Pi children for one
session.

## Model state without an agent

Two different problems, two different answers:

**Current model** is durable. Pi writes a `model_change` entry on every switch
and stamps each assistant message with `provider` / `model` /
`thinkingLevel`. `readPiSession` walks the current branch and returns
`session.model`, so the composer shows the right model before any agent exists.
The newest assistant message wins over an older `model_change`, which handles
fallback-model turns.

**Model catalog** is not durable in the session. It is
`modelRuntime.getAvailableSnapshot()` — user `models.json` + bundled catalog +
credentials + extension providers. The Pi engine answers it with a short-lived
`pi --mode rpc --no-session` child (`queryPiModels`), and the host caches the
result per bridge for 10 minutes. `/api/bridge/models` prefers a live
attachment's catalog and otherwise falls back to that cached query, so the
picker works while detached.

Selecting a model with no live agent records a pending selection; `attach`
applies it with `set_model` right after `get_state`.

## Browser integration

### Brand switcher

The `sidebar.brand.mark` occupant renders the dsh mark with a small chevron. Its
menu is built from `GET /api/bridge/settings`:

- `Local` (always first)
- separator
- every saved bridge
- footer: `Bridge settings`

Local calls `ctx.layout.selectPanel(null)` and clears the Bridge navigation
state. Selecting a bridge stores the bridge descriptor in the shared browser
store and calls `ctx.layout.selectPanel('bridge')`.

The old `sidebar.panellist` Bridge button is intentionally **not registered**.
The dropdown is the entry point.

### Floating settings overlay

Settings are registered into `shell.overlay`, not a main panel. Opening them
never changes `activePanelId`; closing returns to the exact previous page.

The dialog has:

- a left navigation column (`Manage bridges`)
- a right list of saved bridge cards
- an add/edit form with mode, engine, name, and engine-specific fields
- secret fields rendered empty on edit; leaving them blank preserves the saved
  value

### Bridge-owned sidebar

`sidebar.workspaces` is a single-owner slot. While the Bridge panel is active,
the plugin registers its own occupant at priority `-1`; dsh's slot shadowing
rules render the lowest live priority, so the stock workspace browser is hidden.
Returning to Local or Conversation disposes that occupant and restores the stock
browser.

The sidebar and main panel are separate registrations, so they share a small
external store containing only serializable view state:

```text
bridge descriptor, sessions, workspaces, selectedKey, search, loading, error
```

It never contains child processes or secrets.

### Transcript

The main panel consumes normalized events only:

```text
agent-start, agent-end,
message-start, message-update, message-end,
tool-start, tool-update, tool-end,
session-name, backend-event
```

Messages use the normalized shape `{ role, content, timestamp, … }`, with
`text`, `thinking`, `image`, and `toolCall` blocks.

## Security and persistence

- `bridge.json` is written atomically with mode `0600` under `$DSH_HOME`.
- Secret fields are removed from all settings/capability responses; only a
  boolean `configured` flag is exposed.
- The host never invents success for a planned engine.
- File-backed adapters validate every native key against their configured root.
- Bridge mutations are detach-gated while an attachment is alive.

## Roadmap

### Codex CLI

- list rollout JSONL sessions under `~/.codex/sessions`
- use `codex exec --json` / resume for turns, or the app-server protocol
- map JSONL events to the normalized vocabulary
- map approval/elicitation to extension UI

### OpenCode CLI

- prefer OpenCode's local HTTP server API over reading its SQLite store
- list workspaces/sessions, subscribe to events, send prompts, abort
- map permission prompts to extension UI

### Remote DSH Web

- reuse dsh's authenticated client protocol
- store the remote base URL and a credential reference
- list workspaces/sessions, attach, stream events, prompt, detach
