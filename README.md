# dsh-bridge

Bridge **Pi Coding Agent** sessions into the **DeepSeek Harness (dsh)** web UI.

This repository currently implements the **Pi bridge only**: the host plugin
lists Pi sessions, attaches to a Pi process over the documented RPC protocol,
streams agent events into dsh, and sends prompts, steering messages, and aborts
back to Pi.

The browser panel is intentionally minimal at this stage. The transport and
session layer are the product; the UI will grow in later commits.

## Status

- [x] Read Pi session files (`~/.pi/agent/sessions/**/*.jsonl`)
- [x] Current-branch reconstruction, tool-call extraction, list previews
- [ ] Pi RPC process attachment
- [ ] Event fan-out and prompt/steer/abort routes
- [ ] dsh browser panel
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

## Configuration

Environment variables read by the host plugin:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_BIN` | `pi` | Pi executable, resolved via `PATH` |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi config directory |
| `PI_CODING_AGENT_SESSION_DIR` | `$PI_CODING_AGENT_DIR/sessions` | Session storage root |

## Development

```bash
npm test
```

## License

MIT
