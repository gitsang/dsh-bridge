# dsh-bridge

Bridge **Pi Coding Agent** sessions into the **DeepSeek Harness (dsh)** web UI.

This repository currently implements the **Pi bridge only**: the host plugin
lists Pi sessions, attaches to a Pi process over the documented RPC protocol,
streams agent events into dsh, and sends prompts, steering messages, and aborts
back to Pi.

The browser panel lists Pi sessions, shows the current branch, attaches a Pi
child on demand, renders streaming assistant text and tool calls, sends
prompts, aborts a turn, and forwards blocking extension dialogs.

## Status

- [x] Read Pi session files (`~/.pi/agent/sessions/**/*.jsonl`)
- [x] Current-branch reconstruction, tool-call extraction, list previews
- [x] Pi RPC process attachment
- [x] Event fan-out and prompt/steer/abort routes
- [x] dsh browser panel (Pi Sessions main panel + sidebar entry)
- [ ] Install into a dsh profile

## How it works

```text
Browser
  └─ dsh web
       └─ @gitsang/dsh-bridge (host plugin)
            ├─ session-store.js   read-only Pi JSONL listing/history
            └─ pi-attachment.js   spawn `pi --mode rpc --session <file>`
                 │ JSONL over stdin/stdout
                 ▼
            Pi Coding Agent
```

Pi's RPC mode is the stable integration point: commands are JSON lines on
stdin, responses and events are JSON lines on stdout. The bridge never writes
the session file itself, so it cannot corrupt Pi's branch structure.

## Host routes

All routes sit below dsh's authenticated `/api` channel and inherit its
Host/Origin fence and signed browser cookie.

| Route | Purpose |
| --- | --- |
| `GET /api/pi-bridge/sessions` | List Pi sessions (read-only JSONL scan) |
| `GET /api/pi-bridge/session?key=…` | One session with current-branch history |
| `GET /api/pi-bridge/capabilities` | Bridge protocol and live attachment table |
| `POST /api/pi-bridge/attach` | Spawn `pi --mode rpc --session <file>` |
| `POST /api/pi-bridge/detach` | Close the owned Pi child |
| `GET /api/pi-bridge/state?key=…` | `get_state` snapshot |
| `GET /api/pi-bridge/events?key=…` | SSE stream of Pi events and extension UI |
| `POST /api/pi-bridge/prompt` | Prompt, steer, or follow up |
| `POST /api/pi-bridge/abort` | Abort the running turn |
| `POST /api/pi-bridge/ui-response` | Answer a blocking extension dialog |
| `GET /api/pi-bridge/models?key=…` | Provider/model catalog |
| `GET /api/pi-bridge/history-message?key=…` | Concatenated plain-text history |

A session is keyed by a base64url encoding of its absolute JSONL path. The Host
rejects any key that resolves outside the configured Pi sessions root.

## Configuration

Environment variables read by the host plugin:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_BIN` | `pi` | Pi executable, resolved via `PATH`; when absent the globally installed `@earendil-works/pi-coding-agent` package is used |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi config directory |
| `PI_CODING_AGENT_SESSION_DIR` | `$PI_CODING_AGENT_DIR/sessions` | Session storage root |

## Browser panel

The client half registers:

- a **Pi Sessions** entry in the sidebar panel list;
- a `main` panel that renders the session list, transcript, composer, and
  extension dialogs.

It talks only to the host routes above, with `credentials: 'same-origin'`.
Live updates arrive over `EventSource`; the host keeps a bounded event ring so
a reconnecting browser can catch up.

## Development

```bash
npm test
```

## License

MIT
