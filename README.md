# dsh-bridge

Put multiple **complete DeepSeek Harness hosts** behind one authenticated
path-prefix gateway. Each bridge opens the native dsh Web application, not a
reimplementation of its conversation UI.

```text
Browser
  /                          bridge shell
  /b/native/                 local dsh Host
  /b/pi/                     Pi-backed dsh Host
  /b/codex/                  Codex-backed dsh Host
```

Every mount contains dsh's own Conversation, composer, Lexical keymap, Session
API, plugins and settings. A bridge is selected by URL path, so HTTP RPC and the
`/api/remote.mux` WebSocket always follow the same Host without any custom
header or query selector. Plugin behaviour such as `dsh-qol`'s Enter swap is
therefore native; the bridge has no plugin-specific code.

## Why a gateway

dsh Web is not just a set of REST endpoints. Its client keeps one Session input
machine, one connection generation and one remote mux per Host. Reusing that
frontend correctly means routing a whole Host, not individual sessions.

- `GET /b/<id>/` -> upstream `/`
- `GET /b/<id>/api/...` -> upstream `/api/...`
- `WS /b/<id>/api/remote.mux` -> upstream `/api/remote.mux`
- `GET /b/<id>/plugins/...` -> upstream `/plugins/...`
- `GET /b/<id>/assets/...` -> upstream `/assets/...`

dsh's own `<base href="./">` makes the frontend resolve all relative URLs under
the mount. The gateway strips the prefix before forwarding and rewrites absolute
redirects back into the mount.

## Backend contract

A backend must be a real dsh Host implementing the native Remote API:

- `session/list`, `session/follow`, `session/control`, `session/page`
- `session/prompt`, `session/cancel`, `session/updateQueue`
- `session/selectModel`, `session/projections`
- `session/create`, `session/rename`, `session/fork`
- `workspace/*`, `skills/*`, `fileReferences/*`
- `/api/remote.mux`

The gateway does not translate Pi, Codex or OpenCode events. Those engines need
a dsh Host adapter that maps their sessions and activity into native dsh Session
events and projections. Until such an adapter exists, the engine is unavailable;
the gateway never invents a compatible API.

Backends should share the gateway's dsh version and client plugin build. An
optional `health.version` makes the gateway reject a mismatched Host instead of
mounting an incompatible frontend.

## Install

The package is a dsh bundle with one Host row. Add it to the web profile:

```bash
dsh plugin --profile web add github:gitsang/dsh-bridge
dsh web
```

The gateway listens on the next local port by default and prints its URL. Its
default bridge is `native`, which proxies the same dsh web server that loaded
the plugin.

## Configuration

`$DSH_HOME/bridge-v2.json`, written with mode `0600`:

```json
{
  "version": 1,
  "bridges": [
    {
      "id": "native",
      "name": "Local",
      "engine": "native",
      "autostart": true,
      "upstream": { "self": true }
    },
    {
      "id": "pi",
      "name": "Work Pi",
      "engine": "pi",
      "autostart": true,
      "upstream": {
        "command": "dsh",
        "args": ["web", "--profile", "pi"],
        "cwd": "/work"
      },
      "health": { "version": "2.0.0" }
    },
    {
      "id": "remote",
      "name": "Build Box",
      "engine": "dsh",
      "upstream": {
        "url": "http://127.0.0.1:3090/?token=..."
      }
    }
  ]
}
```

`upstream` selects exactly one mode:

- `{ "self": true }` — the dsh web server hosting this plugin.
- `{ "url": "..." }` — an already running, loopback-reachable dsh Host.
- `{ "command": "...", "args": [] }` — a child dsh Host supervised by the
  gateway. Its announced URL is discovered from stdout/stderr.

Bridge ids are immutable lowercase slugs matching `[a-z0-9][a-z0-9-]*`.
`native` cannot be deleted.

Environment overrides:

| Variable | Default | Meaning |
| --- | --- | --- |
| `DSH_BRIDGE_HOST` | `127.0.0.1` | Gateway bind host |
| `DSH_BRIDGE_PORT` | dsh web port + 1 | Gateway port |
| `DSH_BRIDGE_DATA_DIR` | `$DSH_HOME/profiles/bridge-v2` | Password and session store |
| `DSH_BRIDGE_CONFIG` | `$DSH_HOME/bridge-v2.json` | Bridge config file |
| `DSH_BRIDGE_AUTH` | `1` | Set `0` only for tests |

## Authentication

- The gateway has its own scrypt-hashed password and rolling 24-hour session.
- dsh's authority-bound `dsh-auth-*` cookies never reach the browser. The
  gateway redeems each backend's launch token server-side and injects that
  Host's cookie into proxied HTTP and WebSocket upgrades.
- Backends stay on loopback and are never exposed directly.
- Bridge selection is purely the URL path; no request header or query names a
  backend.

## Shell

`/` is a small management shell. Bridges are listed with live readiness.
Selecting one shows a persistent iframe at `/b/<id>/`; previously opened bridges
stay mounted, so switching does not reload or discard their Session state.
Multiple tabs can open different mounts independently.

Use **Manage bridges** to add, edit, restart or delete backends. The JSON file
can also be edited directly and the gateway picked up on restart.

## Tests

```bash
npm test
```

The suite covers config validation, password/session storage, path-prefix and
WebSocket proxy behaviour, upstream cookie custody, backend health/version
checks, process supervision and the management API.
