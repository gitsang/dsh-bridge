# Remote DSH Web protocol (for a `dsh` engine adapter)

Status: research notes, verified 2026-11-13 against a live `dsh web` 0.2.1-rc.4.
Scope: how a **Node.js, no-browser** client authenticates to and drives another
DeepSeek Harness Web instance, directly (`dsh web`) or behind `dsh-gateway`.

The adapter these notes describe is implemented in `src/backends/dsh/`: `http.js`
owns the wire concerns (auth cookies, RPC envelope, timeouts), `session-store.js`
owns the event/message mapping, `attachment.js` owns per-turn observation, and
`index.js` is the engine registration. The doc is kept as the reference for the
protocol itself — including the parts the adapter deliberately does not use yet
(the `remote.mux` WebSocket stream and API Peer cookies).

Legend used throughout:

- **[live]** — verified against the running instance with the exact snippet in
  the Appendix; output quoted (secrets redacted).
- **[source]** — verified by reading the installed package named inline.
- **[inferred]** — follows from code but was not executed (mutation we were not
  allowed to perform, or a path that needs an unlucky state).

Environment used:

| What | Value |
|---|---|
| dsh web | `http://127.0.0.1:3080`, same pid also listens `:3081` |
| launched as | `dsh web --no-open --trusted-host dsh.dev1.yl.c8g.top` |
| gateway front door | `http://127.0.0.1:3081` (`dsh-gateway` plugin, web port + 1) |
| dsh install | `/home/sang/.local/share/fnm/node-versions/v26.5.0/installation/lib/node_modules/@deepseek-ai/dsh` |
| gateway source | `/home/sang/src/github.com/gitsang/dsh-gateway` |
| live sessions | 388 visible rows, 6 running at probe time |

`dsh web` and `dsh-gateway` are one process: the gateway is a plugin that opens
its own listener next to the web server **[live]**. That matters for restarts
(the launch token rotates for both at once).

---

## 1. Auth flow A — direct `dsh web`, launch token / URL

### 1.1 Credential model

- Every process mints a random 32-byte **launch token** (43-char base64url)
  kept in a `WeakMap` keyed by the root Cordis context, so it is stable across
  Connection plugin reloads but **not across restarts**
  (`dsh-client-connection/lib/index.js`, `processLaunchToken`) **[source]**.
  `dsh-web-app` prints it once as `dsh web: <advertised-url>?token=<token>`
  (`dsh-web-app/lib/index.js`, `announceReady`) **[source][live]**.
- The token is only a **bootstrap** for a signed cookie. There is no
  bearer-token API: `Authorization: Bearer <token>` → `401 unauthorized`, and
  `POST /api/session/list?token=…` → `401 unauthorized` **[live]**.
- The cookie is signed with a 32-byte secret in
  `$DSH_HOME/.credentials.yaml` (`client-connection/browser-session` grant
  record). Name = `dsh-auth-` + base64url(sha256(authority)); value =
  `v1.<b64url payload>.<hmac>` for browser sessions, `v2.…` for API sessions
  (payload additionally carries a peer id) **[source]**, both validated live by
  inspecting only the name/attribute/payload shape **[live]**.

`authority` means the WHATWG `host` under the listener scheme: for HTTP,
`host[:port]` with default port dropped; for TLS, the `origin` (so `https:`
cookies cannot authenticate an HTTP listener on the same host:port)
**[source]**. The **`Host` request header is what binds the cookie** — not the
address you dialed.

### 1.2 Exchange 1: browser session via `GET /?token=…`

```
GET /?token=<launch-token> HTTP/1.1
Host: 127.0.0.1:3080
```

Observed **[live]**:

```
HTTP/1.1 303 See Other
location: ./
set-cookie: dsh-auth-<base64url sha256('127.0.0.1:3080')>=v1.<body>.<sig>;
            Max-Age=2592000; Path=/; Expires=Sun, 13 Dec 2026 …; HttpOnly; SameSite=Strict
```

- Cookie payload decodes to `{version:1, authority:"127.0.0.1:3080",
  issuedAt, expiresAt}`; TTL 30 days (`cookieMaxAgeDays`, default 30) **[live]**.
- `Secure` is added **only** when the listener terminated TLS itself; never
  from `X-Forwarded-Proto` or `publicUrl` **[source]**.
- This v1 cookie is a **browser identity** and is usable for `/api` unary calls
  indefinitely: 10/10 sequential calls plus `GET /` and `HEAD /` succeeded with
  one cookie **[live]**. It needs no socket. **This is the best credential for
  a long-lived bridge adapter.**
- Bad/absent token on `/?token=` → `401` text/plain
  `dsh web authentication required; reopen the URL printed by dsh web.`
  (same body for malformed, expired, wrong authority) **[live]**.
- A valid cookie with no token at `GET /` serves index.html; a valid cookie
  **with** a token 303s to `./` to drop the token **[source]**.

### 1.3 Exchange 2: API session via `GET /connect`

```
GET /connect?token=<launch-token>&interactions=answer HTTP/1.1
Host: 127.0.0.1:3080
```

Observed **[live]**:

```
HTTP/1.1 302 Found
location: ./api/remote.mux
set-cookie: dsh-auth-<same name as above>=v2.<body>.<sig>; Max-Age=2592000; Path=/; …; HttpOnly; SameSite=Strict
```

- Payload `{version:2, authority, id:<peer id>, issuedAt, expiresAt}`; the peer
  id is created **before** the cookie is exposed **[source]**.
- `interactions` is declared **once**, `answer` or `none`; omitted ⇒ `none`
  **[source]**. `none` ⇒ passive API caller (no `$events`, no waterfalls, no
  `$on`). `answer` ⇒ the caller participates in forwarded events.
- Repeated declaration (`interactions` twice) or a bad value →
  `400` text/plain `interactions must be declared once as answer or none`
  **[live]**.
- **Lifetime trap**: an API peer's cookie is bound to one WebSocket attachment.
  After the `/api/remote.mux` socket closed, unary calls with that v2 cookie
  returned `401 unauthorized`; a fresh `/connect` minted a working cookie
  **[live]**. So: use `/connect` only when you are about to open the mux;
  otherwise use the v1 browser cookie from `/?token=`.

### 1.4 Request trust fence (`api-request-trust`)

Applies to `/api` **and** `/connect` before authentication
(`dsh-client-connection/README.md`, `api-request-trust`) **[source][live]**:

| Check | Accepted | Rejected |
|---|---|---|
| `Host` | loopback literal (`127.0.0.1:<any port>`, `[::1]:…`, `localhost:…`), the listener's own bind IP literal on any port, or exactly a `--trusted-host` entry (`host` = any port, `host:port` = exact) | `403 forbidden` (plain text) |
| `Origin` (if present) | same authority as `Host`, Host parsed under **Origin's** scheme (so `https://` proxy over HTTP upstream is fine) | `403 forbidden` |
| `sec-fetch-site` | absent, `same-origin`, `same-site`, `none` | `cross-site` → `403 forbidden` |

Verified matrix on the live instance **[live]**:

```
Host=127.0.0.1:3080 → 200   Host=dsh.dev1.yl.c8g.top → 200 (trusted)
Host=localhost:3080 → 200   Host=dsh.dev1.yl.c8g.top:3080 → 200
Host=[::1]:3080     → 200   Host=evil.example → 403
Origin=http://127.0.0.1:3080 → 200   Origin=https://127.0.0.1:3080 → 200
Origin=http://evil.example → 403    Origin=http://dsh.dev1.yl.c8g.top:3080 → 403
sec-fetch-site= cross-site → 403, everything else → 200
```

Consequence: because a **Node client fully controls `Host`**, the adapter must
set `Host` to the authority it wants the cookie bound to, and send no
cross-site-ish `Origin` (or an exact matching one). A remote dsh reached
through a LAN name/IP needs that name in `--trusted-host`. Loopback dialing
with `Host: 127.0.0.1:<port>` always works locally.

Note the asymmetry: cookie authority binding is `Host`, so a cookie minted for
`Host: dsh.dev1.yl.c8g.top` returns `200` under that Host and `401` under
`Host: 127.0.0.1:3080`. Verified both directions **[live]**:
`GET /?token=` under `Host: dsh.dev1.yl.c8g.top` → 303+cookie, then
`/api/session/list` with that cookie and the same Host → 200, with
`Host: 127.0.0.1:3080` → 401.

Interesting hardening detail: a token exchange under an **untrusted** Host is
*not* blocked at `GET /` (the index route has no trust fence of its own, the
cookie is simply minted for that authority) but every `/api` call then returns
`403 forbidden` **[live]**. Do not treat "cookie was issued" as readiness.

---

## 2. Auth flow B — `dsh web` behind `dsh-gateway` (password)

`dsh-gateway` is a plugin that adds a password gate + reverse proxy + PWA in
front of the same web server (`src/index.js`, `src/proxy.js`,
`src/upstream-auth.js`).

### 2.1 Machine contract

| Route | Behaviour |
|---|---|
| `GET /login` | HTML page. **Setup form** (extra `confirm` field) when `auth.json` has no password; password form otherwise. Always 200. |
| `POST /login` | `application/x-www-form-urlencoded`, fields `password`, `next`; **plus `confirm` during setup**. Success → `302` to `next` + `Set-Cookie: dsh_gateway_session=<64-char base64url>`; wrong password → `401` HTML login page with the error text (Chinese `密码错误`); setup mismatch/empty → `400` HTML page. |
| `GET /logout` | `302 /login`, clears the cookie. |
| `GET /__dsh_gateway/state` | authenticated JSON state (listen/upstream/sessions/uptime/pwa/hostMode). Unauthenticated → `401 {"error":"unauthorized"}`. |
| `GET /__dsh_gateway/settings`, `POST /__dsh_gateway/{settings,password,logout-all}` | authenticated; mutations additionally require `x-dsh-gateway: 1` and a same-origin/absent `sec-fetch-site`. |
| anything else, authenticated | proxied upstream. |
| anything else, unauthenticated | `/api*` → `401 {"error":"unauthorized"}` (JSON); everything else → `302 /login?next=<urlencoded>`. |
| WebSocket upgrade, unauthenticated | `401` written on the raw socket then destroyed. |

Gateway session cookie details (`src/stores.js`, `src/index.js`) **[source]**:
random 32-byte token stored server-side in `~/.dsh/profiles/gateway/session.json`
as `token → expiresAt`, TTL `DSH_GATEWAY_TTL_MS` (default 24 h), **rolling**
(touched on every authenticated request). The cookie is emitted with **no
attributes at all** — no `Path`, `HttpOnly`, `SameSite`, `Secure`, no
`Max-Age` — so a Node client must hold it itself; that is also why the README
says not to expose the gateway beyond a trusted network without HTTPS in front.

Live observations **[live]**:

```
GET  /                      → 302 /login?next=%2F
GET  /api/session/list      → 401 {"error":"unauthorized"}
POST /api/session/list      → 401 {"error":"unauthorized"}
GET  /__dsh_gateway/state   → 401 {"error":"unauthorized"}
GET  /login                 → 200 text/html (password field only; setup=false)
POST /login (wrong password) → 401 text/html containing 密码错误, no Set-Cookie
GET  /connect?token=…       → 302 /login?next=%2Fconnect%3Ftoken%3D<redacted>%26interactions%3Danswer
GET  /sw.js, /manifest.webmanifest → 200 (served by gateway, no auth)
```

### 2.2 How the gateway authenticates *to dsh* (why no second login)

`src/upstream-auth.js` **[source]**:

1. asks `connection.authenticatedUrl('http://127.0.0.1:<dsh-port>/')` for a
   tokenized URL,
2. performs `GET /?token=…` upstream itself with `Host: 127.0.0.1:<dsh-port>`,
3. keeps only the `dsh-auth-*` `name=value` pair (attributes discarded),
4. caches it per authority for 1 h and refreshes on demand,
5. on every proxied request/upgrade it **replaces** the browser's cookie with
   that pair, drops any browser `dsh-auth-*` and its own
   `dsh_gateway_session`, and rewrites `Host`/`Origin`/`Referer` (and
   `X-Forwarded-*`) to loopback, leaving `Sec-Fetch-Site` untouched,
6. if dsh answers the fixed plain-text 401, it forgets the cookie, re-runs the
   token exchange once, and retries the request.

Therefore: **a token flow cannot pass through the gateway.** `GET /connect` at
`:3081` is just another unauthenticated page request and gets bounced to
`/login` **[live]**. Behind a gateway the only credential a bridge holds is the
password → `dsh_gateway_session`; the upstream dsh cookie never reaches the
client and never should. `--trusted-host` is also unnecessary behind the
gateway (Host is loopback), which is why it is safe to run the gateway on
`0.0.0.0` while dsh itself stays loopback-only.

### 2.3 Which flow should the adapter use?

| | A: launch token (direct) | A′: v1 browser cookie (direct) | B: gateway password |
|---|---|---|---|
| Stable across restart | no (token rotates) | yes until expiry (30 d) | yes (cookie rolling 24 h, re-login on expiry) |
| Needs user secret | yes, a URL printed at startup | no (needs the dsh home signing secret) | yes, the password |
| Survives being behind a gateway | no | no (authority is loopback upstream) | n/a |
| Get a fresh credential programmatically | no | no | **yes** (`POST /login`) |
| Suitable as stored config | **no** | only if you own the box | **yes** |

Recommendation, as implemented: the adapter keeps flow **A only** —
`{ baseUrl, token, allowInsecureTls }`. The launch token is exchanged
immediately and only the resulting cookie is used; the token is stored because
the remote prints a new one on every restart and the user would otherwise have
to re-enter it, and the error message says plainly that a rotated token is what
happened.

Flow **B is deliberately not implemented.** A gateway authenticates *browsers*:
its cookie comes from a login form, not from the dsh web protocol, and the
bridge has no business driving that form. Pointing a DSH bridge at a gateway
port is therefore a deployment mistake the adapter reports (with a pointer at
dsh web's own port and token) rather than a second credential model to maintain.
Flow A′ needs the dsh home signing secret, so it is test-only and also unused.

---

## 3. RPC envelope

Transport: `POST /api/<endpoint>` with `content-type: application/json`,
`cookie: dsh-auth-…=…` **[source: `client-connection/lib/index.js`,
`rpcFetchHandler`]**.

Request:

```json
{ "type": "client-request", "rpcId": "<any string>", "method": "<endpoint>",
  "payload": { "args": { … } } }
```

Response (HTTP 200 even for remote errors):

```json
{ "type": "server-response", "rpcId": "<same string>",
  "result": { "ok": true,  "value": … } }
{ "type": "server-response", "rpcId": "<same string>",
  "result": { "ok": false, "error": { "code": "gateway/…", "message": "…", "details": {…} } } }
```

Rules and observed edges **[live]**:

- `rpcId` is echoed verbatim; client generates it (`crypto.randomUUID()`
  suggested, any string accepted). Mismatch ⇒ treat as transport corruption.
- `method` **must equal** the path endpoint, else the response is a 200
  envelope with `gateway/bad-request` (`method "X" does not match endpoint "Y"`)
  — it does not 404.
- `content-type` must be `application/json` (else `415` text
  `content type must be application/json`); malformed JSON body → `400` text
  `body is not JSON`; a malformed envelope → 200 with
  `gateway/bad-request` + `details.issues`.
- Unknown endpoint, or any method other than POST → `404 not found` text.
- Every response is gzip-encoded when the request accepts it (`vary:
  accept-encoding`); `fetch`/`node:http` clients handle that transparently.
- No request-scoped timeout is imposed by the host; use 10–30 s for unary
  reads, 60 s for prompt admission. Body cap is `maxRequestBodyBytes`
  (default 300 MiB).
- Results with byte attachments would arrive as `multipart/form-data`; no
  session endpoint the bridge needs does that (the only attachment endpoint,
  `session/attachment`, returns base64 JSON) **[source]**.
- **Args are strict**: the payload is validated against the generated
  descriptor's *strict* codec, so missing or extra keys are hard failures
  (`gateway/arguments-invalid: args fields do not match the descriptor: missing
  "_request"` / `unexpected …`) **[live]**. Note `session/list` is the odd one
  out: its positional arg is named `_request`, so the call is
  `{args:{_request:{}}}`; everything else wraps its DTO as `request`.
- Errors thrown inside a handler become envelopes, not 500s, except for an
  unexpected throw in the transport layer (then `500 handler failure: …`)
  **[source]**.

Error-code vocabulary seen/used **[source]**:
`gateway/bad-request`, `gateway/arguments-invalid`, `gateway/internal`,
`gateway/cancelled`, `gateway/peer-disposed`, `gateway/interactions-forbidden`,
`gateway/method-unavailable`, `gateway/lookup-unavailable`,
`gateway/context-unavailable`, `gateway/binding-invalid`,
`gateway/service-unavailable`, `gateway/result-invalid`, `gateway/protocol`,
`gateway/uplink-overflow`, `remote-access/denied`, `session/not-found`,
`session/writer-held`, `session/conflict`, `session/agent-busy`,
`session/model-unavailable`, `session/title-invalid`,
`session/attachment-invalid`, `session/invalid-time-zone`,
`session/migration-required`, `session/provider-credentials-unavailable`.

---

## 4. Endpoint catalog

All descriptors below come from the generated `typert.host.js` /
`typert.remote-client.js` of `@deepseek-ai/dsh-api-session-controller`
(and siblings) — those files are the authoritative arg/result shapes. All
live observation are read-only calls.

Endpoint list exposed by this dsh version (namespace `session`) **[source]**:

```
session/list  session/page  session/follow  session/projections  session/control
session/create  session/rename  session/prompt  session/cancel  session/selectModel
session/modelCatalog  session/search  session/attachment  session/fork
session/updateQueue  session/openWorkspacePath  session/workspacePathApplications
session/canOpenWorkspacePath  session/initializeDefaultModel
```

plus `workspace/*`, `directoryPicker/*`, `job/*`, `settings/*`,
`credentials/*`, `account/*`, and plugin namespaces (e.g. `pluginManager/*` for
the bridge's own install path).

### 4.1 `session/list` — rows for the sidebar

```json
{ "args": { "_request": {} } }
```

Result `{items:[…]}` — row shape (only the fields the bridge needs are shown;
the real row also carries token/context/goal/team/todo projections):

| field | type | meaning |
|---|---|---|
| `sessionId` | string | durable id, also the `nativeKey` for the bridge |
| `updatedAt` | epoch ms | recency (Host does **not** sort; sort client-side) |
| `running` | bool | a turn is live right now |
| `agentAvailable` | bool | a live Agent is attached (≠ running) |
| `blank` | bool | no turn ever started |
| `formatStatus` | `'current'`\|`'migration-required'` | optional; treat non-current as unreadable |
| `cwd` | string? | session directory (also in projections.workingDirectory) |
| `parentSessionId` / `origin:'subagent'` | | subagent children — **skip** for a top-level list |
| `projections.kind` | `'cached'`\|`'sequenced'` | `cached` = header-only view, `asOfSeq` not comparable to live |
| `projections.asOfSeq` | number | durable watermark — the `throughSeq` you pass to `session/page` |
| `projections.values.title` | string? | latest `session/title` text (last-wins) |
| `projections.values.sessionListMetadata` | `{blank,lastPromptAt}` | cheap summary facts |
| `projections.values.modelSelection` | `{lastUsed,next}` | each `{provider,model,reasoningEffort?}` |
| `projections.values.inbox` | `{'next-turn':[], 'next-step':[]}` | queued input |
| `projections.values.todos` | todo[]? | whole-list snapshot |
| `projections.values.permissions` | `{currentValue}`? | absent when no permission service |
| `projections.values.workingDirectory` | string?/null | session cwd |

Live cost **[live]**: 388 rows = 513 KB / ~0.6–0.8 s. Do **not** poll this for
per-turn liveness. Also: subagent child rows fail `session/projections` without
their parent address (`session/agent-busy: subagent Sessions require their
durable parent address`) — filter `parentSessionId === undefined` before
calling per-session endpoints **[live]**.

Mapping to the bridge's session row (pi/codex/opencode produce
`{nativeKey, key?, id, name, cwd, created, modified, messageCount,
firstMessage, model, messages, tools}`; see `src/backends/pi/session-store.js`):

```js
nativeKey: row.sessionId,
id:        row.sessionId,
name:      row.projections?.values?.title ?? null,
cwd:       row.cwd ?? row.projections?.values?.workingDirectory ?? null,
created:   new Date(row.updatedAt).toISOString(),   // only a recency fact exists
modified:  new Date(row.updatedAt).toISOString(),
messages:  [],                                       // filled by readSession
tools:     [],
messageCount: 0,                                     // unknown without opening
firstMessage: '',                                    // unknown without opening
model:     row.projections?.values?.modelSelection?.next
             ?? row.projections?.values?.modelSelection?.lastUsed ?? null,
running:   row.running,
```

`publicSession()` in `src/index.js` re-wraps whatever the engine returns and
adds `engine`, `bridge`, `key` — so `nativeKey` is the only required key.

### 4.2 `session/projections` — per-session watermark + folded state

```json
{ "args": { "request": { "sessionId": "session-…" } } }
```

Result: `null` for an unknown/unreadable session, else
`{asOfSeq, values:{…}}` with the same projection keys as a list row plus extra
ones rolled up across the whole log (`sessionStats`, `turnOutline`,
`contextPressure`, `contextBreakdown`, `subagentTiming`, `agentTeam`,
`userQuestions`, `goal`, `plan`). Live: 4 KB / ~20 ms **[live]**.

This is the **polling primitive**: `asOfSeq` is the durable cursor, and it
advances as events are appended.

### 4.3 `session/page` — one backwards, message-aligned history page

```json
{ "args": { "request": {
    "address": { "kind": "session", "sessionId": "session-…" },
    "throughSeq": 2777,
    "beforeSeq": 2742,
    "maxMessages": 50,
    "turnWindow": { "minMessages": 2, "minTurns": 2 }
} } }
```

- `address` is a union: `{kind:'session', sessionId}` or
  `{kind:'subagent', parentSessionId, childSessionId, mode:'one-shot'|'continuable'|'unknown'}`.
- `throughSeq` = **inclusive** log cut, `-1` before the first event. It is not a
  `MAX_SAFE_INTEGER` sentinel — `through seq 9007199254740991 is past cursor
  2764` came back as `gateway/bad-request` **[live]**. Always read the cursor
  from `session/projections`/`session/list` first.
- `beforeSeq` = exclusive upper bound for the *previous* page; omit for the
  latest page.
- `maxMessages` counts only append-surface `user/message` + `assistant/message`
  events (default 50) **[source]**.
- `turnWindow {minMessages, minTurns}` stops at a `turn/start` once both minima
  are crossed, giving turn-aligned pages; `minMessages ≤ maxMessages`,
  `minTurns ≥ 1`, both positive.
- Result:

```json
{ "records": [ { "type": "event", "event": {
      "type": "user/message", "seq": 2732, "time": 1794542041787,
      "data": { … owner-defined … }, "ignorable": true?,
      "sourceEventSeqs": [ … ]?, "surfaceOp": "append" | {"op":"replace",…}?
} } ],
  "hasMore": true }
```

- 200 with `{records:[], hasMore:false}` for `throughSeq:-1`; `session/not-found`
  envelope for an unknown id; `gateway/bad-request` for a bad `throughSeq`,
  `maxMessages`, or `turnWindow`.
- Reading a page **never activates an Agent** — it is a persistence read
  (`api-session-controller/README.md`) **[source]**, which makes it safe for a
  bridge that must not disturb the remote session. The `cached` vs `sequenced`
  projection kinds matter only for comparing watermarks.

Live cost **[live]**: 36 records / 10 KB / ~17 ms with `turnWindow`.

### 4.4 `session/prompt` — send a user turn (and implicitly RESUME)

```json
{ "args": { "request": {
    "sessionId": "session-…",
    "requestId": "<client-minted uuid>",
    "mode": "queue",
    "content": [ { "type": "text", "text": "hello" } ],
    "clientTimeZone": "Asia/Shanghai"
} } }
```

`content` parts: `{type:'text', text}` | `{type:'image', mediaType:'image/png'
|'image/jpeg'|'image/webp'|'image/gif', data:<base64>, name?}` |
`{type:'file', receiptId}` (receipt from `dsh-client-file-upload`; not
implemented for an external client). At least one non-whitespace text part or
an attachment is required, else `gateway/bad-request`.

Result: `{accepted:true}`.

Semantics **[source]**:

- `requestId` is persisted as the durable `user/message.data.source.rpcId`. A
  retry with the same `requestId` while the first is still queued/logged
  returns `{accepted:true}` without duplicating (idempotent retries).
- `mode:'steer'` injects into the running step (`agent.steer`);
  `mode:'queue'` (or the Web default) queues for the next turn
  (`agent.followup`). The descriptor also allows `steer` only when the agent is
  live; both modes are accepted by the endpoint, admission is decided by the
  agent.
- **The endpoint cold-resumes the session itself**: `prompt → commands.prompt →
  resolveAgent(sessionId) → agents.resolveAgent → resolve() → this.resume(...)`
  (coalesced per session, result cached). There is **no separate
  "resume" endpoint** to call first. Resume failures surface as
  `session/writer-held` (another writer owns the session log),
  `session/not-found`, `agent-preset/conflict`, `session/conflict`.
- Consequence for the adapter: a prompt against a session open in the remote
  Web UI (or another bridge) can fail with `session/writer-held`; and a
  successful prompt takes the writer lock, so the remote UI may show that
  session as busy/attached. Both must be surfaced honestly.
- Image admission requires a model that supports image input, else
  `session/attachment-invalid`; admission failures become `session/agent-busy`.

### 4.5 `session/cancel` — abort the live turn

```json
{ "args": { "request": { "sessionId": "session-…" } } }
```

Result `{accepted:true}`. Requires an **already-live** Agent:
`ctx.agents.get(sessionId)`; otherwise `session/not-found` ("not found (not
attached)") **[source]**. It calls `agent.cancel({kind:'user'}, {keepInbox:
true})` — queued inbox input is preserved.

Proof the turn ended is **durable**, not in the RPC result: a `turn/end` event
whose `data.reason.kind` is one of
`completed | aborted | blocked | error | max-tokens | interrupted`
(`dsh-session/lib/types/types.d.ts`, `TurnEndReasonMap`); on a cancel it is
`aborted` with `data.reason.reason.kind === 'user'` (the cancel cause union is
`user | parent | hook | disposed | legacy`). A cancelled mid-stream turn also
gets `assistant/message.data.interrupted === true` **[source]**.
Because the cancel RPC returns before the event is observable, the adapter
should keep polling `session/projections` until `turn/end` for that turn shows
up, and only then resolve the abort.

### 4.6 `session/rename`

```json
{ "args": { "request": { "sessionId": "session-…", "title": "New title" } } }
```

Result `{title, seq}`. Errors: `session/title-invalid`, `gateway/internal` when
no session-title service is composed. Cold-resumes the session (resolveAgent)
**[source]**.

### 4.7 `session/modelCatalog` — host-global model list

No args: `{ "args": {} }`. Result:

```json
{ "default": { "provider": "saigw", "model": "deepseek-flash" },
  "routableProviders": ["saigw", "saigw-openai", "saigw-anthropic", "yealink"],
  "groups": [ { "id": "saigw", "name": "SaiGW", "models": [
      { "id": "deepseek-flash", "name": "Deepseek Flash",
        "description"?: "…",
        "reasoning"?: { "efforts": [ {"id":"low","name":"Low"}, … ],
                        "defaultEffort"?: "low" } } ] } ],
  "failures": [ { "id": "…", "name": "…", "message": "…" } ] }
```

Live: 45 ms, 4 groups × 1 model **[live]**. **Not per-session** — it is the
Host's provider catalog, and `failures` reports providers whose catalog could
not be loaded (surface them, don't hide).

Map to the bridge's model shape consumed by `src/client.js`
(`normalizeModelCatalog`: `{id, provider, name, contextWindow, reasoning}`):

```js
models = groups.flatMap((group) => group.models.map((model) => ({
  id: model.id, provider: group.id, name: model.name,
  contextWindow: 0,            // not in this result
  reasoning: model.reasoning?.efforts?.length > 0,
})))
```

### 4.8 `session/selectModel`

```json
{ "args": { "request": { "sessionId": "session-…", "provider": "saigw",
                          "model": "deepseek-flash", "reasoningEffort": "low" } } }
```

Result `{selected:{provider, model, reasoningEffort?}}`. Rejects with
`session/model-unavailable` when the pair is not in the available catalog
(never silently substitutes). Cold-resumes the session and acknowledges before
the default-model setting is persisted **[source]**.
Per-session current selection: read `projections.values.modelSelection.next`
(falls back to `lastUsed`) — no wake-up needed.

### 4.9 `session/create` (optional for the adapter)

```json
{ "args": { "request": { "cwd": "/abs/path", "sessionId"?: "…",
                          "workspaceId"?: "…", "agentPreset"?: "standard" } } }
```

`workspaceId` XOR `cwd` (`gateway/bad-request` if both). Result
`{sessionId, agentPreset?}` — the id may differ from the requested one. Errors:
`session/conflict` (named session in another directory),
`session/agent-busy` (owned by subagent routing), `workspace/not-found`,
`session/workspace-attach-failed`, `agent-preset/conflict`. This is one of the
few endpoints that directly creates an Agent **[source]**.

### 4.10 Workspaces / cwds

There is **no unary `workspace/list`** in this build; `workspace/follow` is a
stream whose opening frame is
`{type:'baseline', value:{items:[{workspaceId, path, title, sessionIds,
createdAt, updatedAt}], archivedSessionIds, pinnedSessionIds}}`
**[source]**. For a bridge sidebar, deriving cwd groups from `session/list`
rows (`cwd` / `projections.values.workingDirectory`) is cheaper and matches what
the pi engine already does; use `workspace/follow` only if real Workspace
identity/titles/pins are required.

### 4.11 Streaming endpoints (kept out of the v1 adapter)

`session/follow` (stream), `session/control` (stream), `workspace/follow`
(stream), `job/follow`, `job/list` are only reachable over the
`/api/remote.mux` WebSocket, not over unary HTTP. See §6.

---

## 5. Mapping dsh session events into the bridge-neutral vocabulary

The bridge's neutral vocabulary (consumed by `src/client.js` `applyBridgeEvent`
and keyed by `src/index.js`) is:
`agent-start`, `agent-end`, `agent-settled {aborted}`, `message-start
{message}`, `message-update {message}`, `message-end {message}`, `tool-start
{toolCallId,name,arguments}`, `tool-update {toolCallId,partialResult}`,
`tool-end {toolCallId,result,isError}`, `session-name {name}`, `backend-event
{event}`. Message objects the client understands are pi/codex/opencode-shaped:
`{role:'user'|'assistant'|'toolResult', content:[{type:'text',text} |
{type:'toolCall',id,name,arguments} | {type:'reasoning',text}], timestamp?,
stopReason?, toolCallId?, isError?}`.

dsh durable events (`data` shapes quoted from real logs) and the translation:

| dsh durable event | `data` (verified shape) | Bridge-neutral emission |
|---|---|---|
| `turn/start` | `{turn}` | `{type:'agent-start'}` |
| `turn/end` | `{turn, reason:{kind:'completed'\|'aborted'\|'blocked'\|'error'\|'max-tokens'\|'interrupted', reason?/error?}}` | `[{type:'agent-end'}, {type:'agent-settled', aborted: reason.kind==='aborted'}]` |
| `step/start` | `{turn, step}` | `{type:'backend-event', event}` (inner step) |
| `step/end` | `{turn, step}` | `{type:'backend-event', event}` |
| `user/message` | `{content:[{type:'text',text}], source:{kind:'user'\|'time-context'\|'schedule'\|…, rpcId?, clientTimeZone?, …}, role:'user', id}` | `{type:'message-end', message:{role:'user', content, timestamp, stopReason?}}` — skip when `source.kind !== 'user'` if you only want human turns (time-context / schedule / injected-context messages are model-visible but not transcript; the source vocabulary is merge-extensible, so fall through unknown kinds). Only emit once per `id`. |
| `assistant/message` | `{turn, step, message:{role:'assistant', content:[{type:'reasoning'}\|{type:'text'}\|{type:'tool-call',id,name,arguments}], source?, id}, usage?:{inputTokens,outputTokens,totalTokens,cacheReadTokens,…}, stream:[…], interrupted?:true}` | `{type:'message-end', message:{role:'assistant', content, timestamp, stopReason: interrupted?'aborted':undefined}}`; and for each `tool-call` block that has no matching `tool/call` event: `{type:'tool-start', toolCallId:id, name, arguments:<JSON string>}` |
| `tool/call` | `{turn, step, callId, name, arguments:"<raw JSON string as the model produced>"}` | `{type:'tool-start', toolCallId:callId, name, arguments}` (parse defensively; the string is not guaranteed valid JSON during truncation) |
| `tool/result` | `{turn, step, message:{role:'tool', toolCallId, content:[{type:'text'}], isError, source:{kind:'tool',callId}, id}, error?:{name,code,reason}, meta?}` | `{type:'tool-end', toolCallId:message.toolCallId, result:{content:message.content}, isError:message.isError}` |
| `session/title` | `{title, messageSeqs:[…], source:{kind:'fallback'\|'llm'}}` | `{type:'session-name', name: title}` |
| `model/selection` | `{provider, model}` | `{type:'backend-event', event}` (or a model chip) |
| `assistant/attempt` / `llm/retry` | `{turn, step, stream}` / `{retryId, turn, step, provider, mode, policyKey, retry, maxRetries, delayMs, failure:{message,code}}` | `{type:'backend-event', event}` |
| `approval/asked` / `approval/decided` | `{id, toolName, callId, reason}` / `{id, outcome:'allowed-once'\|…}` | `{type:'backend-event', event}` (approval UI is out of scope; a bridge could later map to `respondUi`) |
| `todo/write` | `{todos:[{content,status}]}` | `{type:'backend-event', event}` |
| `job/registered` / `job/settled` | `{jobId, owner, kind, label, startedAt, …}` | `{type:'backend-event', event}` |
| `workspace/changes` | `{turn}` | `{type:'backend-event', event}` |
| `permission/preset`, `agent-preset/selected`, `working-directory/change`, `goal/change`, compaction events, `subagent/*`, `team/*` | small payloads | `{type:'backend-event', event}` |
| anything else / unrecognised | — | `{type:'backend-event', event}` |

Important ingestion rule: `session/page` and the `session/follow` snapshot both
deliver **durable events with a `seq`**. The adapter must keep
`lastSeq` per session, drop any `event.seq <= lastSeq`, and accept only
contiguous seqs; dsh itself refuses to emit a gap (`session event stream
skipped seq N`), so a gap on the client side means "re-page from the durable
cursor", never "patch it up". For a per-turn attachment the simplest
implementation is: snapshot the cursor → page the tail → then poll and page
only the delta (§6).

`agent-start`/`agent-settled` are the only two neutral events the Host itself
acts on (`AttachmentSession.watch()` routes them to `onAgentStart`/
`onAgentSettled` to open/close the per-turn agent). So the dsh attachment's
most important mapping is `turn/start → agent-start` and
`turn/end → agent-end + agent-settled{aborted}`.

---

## 6. Liveness without a browser: polling vs `remote.mux`

### 6.1 Polling (recommended for v1)

Everything the bridge needs is in unary reads:

1. **Turn attachment** (`AttachmentSession` semantics): on attach, read
   `session/projections` for the cursor, then `session/page` with
   `throughSeq = asOfSeq`, `maxMessages ≈ 50` and map the records (§5).
2. **Liveness poll**: `session/projections` every **750–1000 ms** while a turn
   is live (4 KB / ~20 ms measured [live]). Stop when you observe
   `turn/end` for the current turn; keep a slower heartbeat (~5–10 s) while
   idle so the bridge can notice remote-side activity.
3. **Incremental page**: when `asOfSeq > lastSeq`, call `session/page` with
   `throughSeq = asOfSeq` (optionally `beforeSeq = lastSeq + 1`) and keep
   records with `seq > lastSeq`. Page cost is bounded by `maxMessages`; 36
   records ≈ 10 KB / 17 ms [live].
4. **Running state** without any stream: `session/list` row `running` (a live
   turn) and `agentAvailable` (a live Agent), refreshed every ~5 s or after
   `agent-end`. `projections.values.inbox` non-empty means queued input.
   `projections.values.subagentTiming.active` means an open turn for a
   subagent child. No WebSocket needed.
5. **Cancel** = `session/cancel` + poll until `turn/end` appears (§4.5).

Polling cost for one attached session ≈ 4 KB/s and <5 % of one CPU-second per
minute — acceptable for a bridge that already holds one SSE stream per browser
tab. Latency floor is one poll interval (≤1 s), which the Web UI's own
assistant streaming makes acceptable.

### 6.2 `remote.mux` WebSocket (for a later streaming upgrade)

Endpoint `ws://<authority>/api/remote.mux`, authenticated by the same cookie
(`Sec-Fetch-Site`/Host fence applies; `401` written on the socket when
unauthenticated). Framing (`dsh-api-gateway/lib/types/stream-protocol.js`)
**[source][live]**:

```
client → {type:'open', streamId, endpoint, payload:{args}}
client → {type:'item', streamId, value?}      // uplink
client → {type:'end'|'cancel', streamId}
server → {type:'item', streamId, value}       // downlink item
server → {type:'end', streamId}
server → {type:'error', streamId, error:{code,message,details}}
```

`session/follow` opening item (live frame captured, truncated) **[live]**:

```json
{ "type":"item", "streamId":"s1", "value":{
  "type":"snapshot",
  "header":{"version":4,"id":"session-…","createdAt":…,"cwd":"…","isSeeded":false,"delegationDepth":0,"agentPreset":"standard"},
  "cursor":398,
  "records":[{"type":"event","event":{"type":"user/message", …}}],
  "hasMore":true,
  "projections":{"asOfSeq":398,"values":{…}},
  "assistantStream"?: { revision, startedAfterSeq, nextIndex, … }   // only with assistantStream:true
} }
```

then one `{type:'event', event}` item per durable event, plus
`{type:'assistant-stream', frame}` items when `assistantStream:true`
(token-level deltas: chunk types `block-start`, … see
`AssistantStreamRecord`), and `{type:'error', …}` on failure.

Cost/benefit: the mux gives sub-100 ms deltas and gap-free ordering, but you
must implement framing, `streamId` lifecycle, reconnect/backoff, a
`$events`/`/connect` peer identity, and accept that the `interactions=answer`
cookie dies with the socket (and that a duplicate attachment to the same peer
is refused). For a **per-turn attachment** the polling design above is strictly
simpler and needs no long-lived socket on the remote; recommend polling in v1
and revisit the mux when the adapter needs token streaming into the browser.

---

## 7. Failure modes and readiness probe

| Symptom | Cause | HTTP | Body / code |
|---|---|---|---|
| Bad/expired/absent launch token on `/connect` or `/?token=` | wrong token (rotated by a restart), or a token from another host | `401` | text/plain `dsh web authentication required; reopen the URL printed by dsh web.` |
| Repeated / invalid `interactions` on `/connect` | caller bug | `400` | text/plain `interactions must be declared once as answer or none` |
| `/api` and `/connect` under an untrusted Host/Origin, or `sec-fetch-site: cross-site` | missing `--trusted-host`, wrong `Host` header, a browser sending a cross-site `Origin` | `403` | text/plain `forbidden` |
| Cookie minted for another authority | port/host mismatch between mint and call | `401` | text/plain `unauthorized` |
| `/connect` cookie used after its mux socket closed | API peer lifetime | `401` | text/plain `unauthorized` |
| Unknown endpoint / non-POST | wrong path or verb | `404` | text/plain `not found` |
| Wrong content type | missing `application/json` | `415` | text/plain `content type must be application/json` |
| Body not JSON | truncated/keyboard bug | `400` | text/plain `body is not JSON` |
| Strict args mismatch | missing `_request`/`request`, extra keys | **200** | envelope `gateway/arguments-invalid` |
| Method/path mismatch | caller bug | **200** | envelope `gateway/bad-request` |
| `throughSeq` past cursor / `maxMessages:0` | wrong cursor source | **200** | envelope `gateway/bad-request` (`session page through seq N is past cursor M`) |
| Unknown session id | stale sidebar | **200** | envelope `session/not-found` + `details.sessionId` |
| Session owned by another writer | remote Web UI / another bridge has it | **200** | envelope `session/writer-held` |
| Prompt with no live/resumable agent | corrupt/archived session | **200** | envelope `session/not-found` |
| Model not in catalog | stale selection | **200** | envelope `session/model-unavailable` |
| Gateway, not logged in, `/api*` | no/invalid `dsh_gateway_session` | `401` | JSON `{"error":"unauthorized"}` |
| Gateway, not logged in, HTML path | same | `302` | `location: /login?next=…` |
| Gateway, wrong password | user typo | `401` | HTML login page (Chinese error text), **no** Set-Cookie |
| Gateway, no password set yet | first use | `200` | HTML **setup** form (`confirm` field present) |
| Gateway up, dsh web down | plugin listener alive, upstream gone | `502` | text `dsh-gateway: upstream unavailable: …` |
| Self-signed TLS | private CA | TLS error | `DEPTH_ZERO_SELF_SIGNED_CERT` / `SELF_SIGNED_CERT_IN_CHAIN` |
| Unreachable | host/port wrong | — | `ECONNREFUSED` / `ENOTFOUND` / `ETIMEDOUT` |

Readiness probe should report **which** of these it hit, in the bridge's own
connection state (`state:'failed'`, `error`) — see `src/index.js` `probe()`
usage around line 454. Suggested probe for the `dsh` engine:

1. parse `baseUrl`;
2. **gateway URL detected** (a `302` to `/login` on the token exchange or on
   `/api`): fail with "this is a dsh-gateway; point the bridge at dsh web's own
   port and use its launch token". The gateway path above is documented for
   completeness only — the adapter does not implement it.
3. **direct**: `GET /connect?token=…&interactions=none` — 302
   `./api/remote.mux` + a `dsh-auth-*` cookie ⇒ ok; 401 ⇒ "launch token is
   invalid or the remote dsh restarted"; 403 ⇒ "Host not trusted; start dsh
   web with --trusted-host <authority> or dial a loopback address"; 400 ⇒
   caller bug. Then one unary `session/list` (`{_request:{}}`) to prove the
   cookie actually authenticates (a cookie can be minted under an untrusted
   Host and still 403 on `/api`), and report the row count + version-ish facts.
4. **both**: check that a cheap endpoint exists (`session/projections` against
   any listed session) so an incompatible/old dsh is reported as
   "remote dsh does not expose the session RPC surface" instead of a timeout.
   Also detect a `migration-required` `formatStatus` and say so.

Never surface the token or cookie; report only the class of failure.

---

## 8. Fake remote dsh HTTP server for unit tests

A single `node:http` server (the bridge's existing test fixtures use the same
pattern, e.g. `test/fixtures/fake-opencode.mjs`) with an in-memory session log.
Routes to emulate, with the contract each must enforce:

| # | Route | Must assert | Must return |
|---|---|---|---|
| 1 | `GET /` (with/without `?token=`) | `Host` equals the fake's authority; `token` equals the configured launch token | no token+cookie: 401 text; valid token: 303 `location: ./` + `set-cookie: dsh-auth-<hash>=v1.<…>`; cookie only: 200 HTML |
| 2 | `GET /connect` | exactly one `interactions` (default `none`), valid value, valid token, trusted Host | 302 `location: ./api/remote.mux` + v2 cookie; 401 / 400 / 403 branches |
| 3 | `POST /api/session/list` | content-type json, envelope, method==endpoint, args exactly `{_request:{}}` | `{items:[…rows…]}`; `gateway/arguments-invalid` when `_request` missing |
| 4 | `POST /api/session/projections` | args `{request:{sessionId}}` | `null` for unknown; `{asOfSeq, values:{title, modelSelection, inbox, workingDirectory}}` |
| 5 | `POST /api/session/page` | `throughSeq ≤ cursor`, `-1` allowed only before the first event, `maxMessages>0`, `turnWindow.minMessages ≤ maxMessages` | `{records:[…], hasMore}`; `gateway/bad-request` past-cursor; `session/not-found` |
| 6 | `POST /api/session/prompt` | `content` has text/attachment, `mode ∈ {queue,steer}`, `requestId` string | `{accepted:true}`; duplicate `requestId` still `{accepted:true}` (no second append); `session/agent-busy` when a scripted failure is armed |
| 7 | `POST /api/session/cancel` | session is "attached" in the fake | `{accepted:true}` and append `turn/end {reason:{kind:'aborted',reason:{kind:'user'}}}`; `session/not-found` when not attached |
| 8 | `POST /api/session/rename` | non-empty title | `{title, seq}`; `session/title-invalid` for empty |
| 9 | `POST /api/session/selectModel` | provider/model present in the fake catalog | `{selected:{…}}`; `session/model-unavailable` otherwise |
| 10 | `POST /api/session/modelCatalog` | no args | global catalog fixture, with a non-empty `failures` variant |
| 11 | `POST /api/session/create` | `cwd` XOR `workspaceId` | `{sessionId}`; `gateway/bad-request` when both |
| 12 | `POST /api/session/follow` | (mux/ws) `assistantStream` bool, address shape | snapshot frame then events; `error` frame for an unknown session |
| 13 | `GET /login` (gateway mode) | — | setup form when no password stored, else password form |
| 14 | `POST /login` (gateway mode) | `application/x-www-form-urlencoded`, `password`(+`confirm` in setup), `next` same-origin | 302 + `dsh_gateway_session`; 401 HTML on wrong password; 400 on mismatch |
| 15 | `GET /__dsh_gateway/state` | gateway cookie | `{upstream, hasPassword, sessions, version, pwa, hostMode}`; 401 JSON otherwise |
| 16 | any `POST /api/*` without gateway cookie (gateway mode) | — | 401 JSON `{"error":"unauthorized"}` |
| 17 | `GET /api/…` or unknown path | — | 404 text (unary transport) |
| 18 | unreachable / TLS / timeout variants | — | driven by pointing the adapter at a closed port / a self-signed server |

Fixture expectations:

- Envelope echo: every `/api` response must echo `rpcId` exactly; a test can
  assert the client rejects a mismatched one.
- One "rich" scripted session log containing, in order:
  `turn/start`, `step/start`, `user/message{source:{kind:'user'}}`,
  `assistant/message` (text + reasoning + a `tool-call` block),
  `tool/call`, `tool/result`, `step/end`, `turn/end{completed}`,
  plus `session/title`, `model/selection`, an `llm/retry`, an
  `approval/asked`, and a `time-context` `user/message` — enough to exercise
  every mapping row (§5) and the "skip non-user source" rule.
- A second "cancelled" log with `assistant/message{interrupted:true}` +
  `turn/end{aborted, reason:{kind:'user'}}`.
- Cursor discipline: serve `session/page` from a real array so
  `throughSeq`-past-cursor and `beforeSeq` paging are exercised for real.
- Auth matrices: token good/bad/absent, `interactions` good/repeated/bad,
  Host loopback/trusted/untrusted, cookie good/tampered/wrong-authority,
  gateway cookie good/expired.

---

## 9. Proof of concept

A complete, working CLI lives at **`/tmp/remote-dsh-poc.mjs`** (read-only: it
only calls `GET /`, `GET /connect`, and read RPCs). Verified runs:

```
$ node /tmp/remote-dsh-poc.mjs --base-url http://127.0.0.1:3080 --token <launch-token>
endpoint      http://127.0.0.1:3080
auth          launch token → GET /connect (interactions=none)
sessions      388 (6 running)

newest sessions:
  ○ 1794551665808 session-5a1702a1-…  MiniMax 分红问题咨询
  ● 1794539765097 e1ffef26-…          You are protocol-scout on the
… 
session       session-5a1702a1-…
cursor        495
page          123 records (hasMore=true)
seq range     373 → 495
event types   assistant/message tool/call job/registered job/settled tool/result step/end step/start turn/end agent/inbox/spliced turn/start user/message workspace/changes
messages      20 (16 assistant)
turns         1
tools         17
```

```
$ node /tmp/remote-dsh-poc.mjs --base-url http://127.0.0.1:3080 --cookie '<injected>' --max-messages 5   # 30 records, exit 0
$ … --dial-port 3999                 → ECONNREFUSED (connection refused …)            exit 4
$ … --cookie 'dsh-auth-x=v1.AAAA.BBBB' → API rejected the cookie (401)                 exit 3
$ … --token 'not-a-real-token'        → launch token rejected (401)                    exit 3
$ … --base-url http://evil.example --dial-host 127.0.0.1 --dial-port 3080 …
                                      → API request not trusted (403): forbidden       exit 3
$ … --session session-nope            → session session-nope has no projections …      exit 5
$ … --base-url http://dsh.dev1.yl.c8g.top:3080 --cookie '<minted for that host>'
                                      → 200, same 388 sessions (authority binding works)
```

Portable core (no dependencies beyond `node:http`/`node:https`; secrets only in
memory):

```js
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { randomUUID } from 'node:crypto'

/** One HTTP call with an explicit Host header (the Host is what binds the cookie). */
function call({ baseUrl, path, method = 'GET', headers = {}, body, dial, insecure = false }) {
  const target = new URL(baseUrl)
  const secure = target.protocol === 'https:'
  const options = {
    method,
    host: dial?.host ?? target.hostname,
    port: dial?.port ?? (target.port !== '' ? Number(target.port) : secure ? 443 : 80),
    path,
    headers: { host: target.host, ...headers },   // <-- authority the cookie is bound to
    ...(secure && insecure ? { rejectUnauthorized: false } : {}),
  }
  return new Promise((resolve, reject) => {
    const req = (secure ? httpsRequest : httpRequest)(options, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({
        status: res.statusCode,
        location: res.headers.location,
        setCookie: (res.headers['set-cookie'] ?? []).map((c) => c.split(';', 1)[0].trim()),
        text: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.setTimeout(30_000, () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

/** Launch token → authority-bound browser cookie. Prefer this over /connect for a bridge. */
async function cookieFromToken(baseUrl, token, dial) {
  const res = await call({ baseUrl, path: `/?token=${encodeURIComponent(token)}`, dial })
  if (res.status === 401) throw new Error('launch token rejected (the remote dsh restarted?)')
  if (res.status === 403) throw new Error('Host not trusted (--trusted-host / wrong Host header)')
  if (res.status !== 303) throw new Error(`GET /?token= → HTTP ${res.status}`)
  return res.setCookie.find((pair) => pair.startsWith('dsh-auth-'))
}

/** One unary Remote call. */
async function remote(baseUrl, cookie, method, args = {}, dial) {
  const rpcId = randomUUID()
  const payload = JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } })
  const res = await call({
    baseUrl, dial, path: `/api/${method}`, method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: payload,
  })
  if (res.status !== 200) throw new Error(`/api/${method} → HTTP ${res.status}: ${res.text.slice(0, 200)}`)
  const envelope = JSON.parse(res.text)
  if (envelope.type !== 'server-response' || envelope.rpcId !== rpcId) throw new Error('bad RPC envelope')
  if (envelope.result.ok !== true) {
    const { code, message } = envelope.result.error
    throw Object.assign(new Error(`${method}: ${code}: ${message}`), { code })
  }
  return envelope.result.value
}

// list + latest page for the newest non-blank session
const baseUrl = 'http://127.0.0.1:3080'
const cookie = process.env.DSH_COOKIE ?? await cookieFromToken(baseUrl, process.env.DSH_TOKEN)
const { items } = await remote(baseUrl, cookie, 'session/list', { _request: {} })
const row = items.filter((item) => !item.blank).sort((a, b) => b.updatedAt - a.updatedAt)[0]
const { asOfSeq } = await remote(baseUrl, cookie, 'session/projections', { request: { sessionId: row.sessionId } })
const page = await remote(baseUrl, cookie, 'session/page', {
  request: { address: { kind: 'session', sessionId: row.sessionId }, throughSeq: asOfSeq, maxMessages: 20 },
})
console.log(row.sessionId, asOfSeq, page.records.length, page.hasMore)
```

---

## 10. Open decisions for the adapter owner

1. **Credential shape.** `password` (gateway, durable, re-login on expiry) is
   the only secret a Node client can renew without a human. A launch token is
   per-process and rotates on every restart, so it can only be a bootstrap
   value pasted from the console. The add-bridge form currently exposes
   `{baseUrl, token}` (`src/backends/registry.js`) — recommend
   `{baseUrl, token|password, insecureTls?}` with a clear "token must be
   re-pasted after the remote restarts" hint, and refuse token+gateway
   combinations with an explicit message (a token cannot traverse a gateway).
2. **`Host` vs dial address.** The adapter needs separate `dial` (TCP) and
   `authority` (Host) so it can reach a remote through a tunnel/NAT while the
   cookie stays bound to the public name. Expose it or derive it strictly from
   `baseUrl`; do not guess.
3. **`session/prompt` resumes and takes the writer lock.** This is a real
   behavioural difference from the pi/codex adapters (which spawn their own
   child): prompting a session that the remote Web UI has open can fail with
   `session/writer-held`, and prompting a cold session wakes it. Confirm the
   product wants that, and decide whether the bridge should treat
   `session/writer-held` as "busy, retryable" or surface it.
4. **No `created` timestamp.** `session/list` exposes `updatedAt` only; the
   session header `createdAt` is on the `session/follow` snapshot /
   `SessionHeader` but not on a unary read. Sidebar rows will need to use
   `updatedAt` for `created` (or the adapter accepts one extra cold read).
5. **Streaming.** v1 polling (§6.1) is enough for a per-turn attachment;
   token-level streaming would need `session/follow` over `remote.mux` and an
   `interactions=answer` peer whose cookie dies with the socket. Decide whether
   v1 needs deltas before paying that complexity.
6. **Model switching granularity.** `session/selectModel` is per session and
   validates against the host-global `session/modelCatalog`; there is no
   global default switch for one session's next turns beyond the Session's own
   selection. The bridge's `pendingModels` (applied on next attach) maps cleanly
   onto it.
7. **`migration-required` sessions** must be rejected with a clear message
   rather than paged; decide where that check lives (list filter vs per-session
   probe).
