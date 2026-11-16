/**
 * In-process fake of a remote DSH web server for transport/adapter tests.
 *
 * Speaks the real wire contract closely enough to exercise the bridge: the
 * `client-request` / `server-response` JSON envelopes on `POST /api/<method>`,
 * the launch-token flow (`GET /?token=...` -> 303 + cookie), and — behind the
 * `gateway` option — the gateway-style redirect to `/login` that proves the
 * bridge refuses a gateway instead of hanging.
 *
 * Test-only quirks exist so client error paths are deterministic: `mangleRpcId`
 * answers with a mismatched `rpcId`, `nonJsonBody` answers `/api` with a non-JSON
 * body, `GET /__hang` never answers, and `expireAuth()` / `dropAuth()` invalidate
 * cookies. Every response carries `cache-control: no-store`; `close()` destroys
 * open sockets so node:test can exit promptly.
 */
import { createServer } from 'node:http'

const TOKEN_COOKIE = 'dsh-auth-fake=v1.fake.sig'
const CONNECT_COOKIE = 'dsh-auth-fake2=v1.fake2.sig'

/** The live server's catalog shape: provider groups, a default, provider failures. */
const DEFAULT_MODEL_CATALOG = {
  default: { provider: 'fake-provider', model: 'fake-model' },
  routableProviders: ['fake-provider'],
  groups: [
    {
      id: 'fake-provider',
      name: 'Fake Provider',
      models: [
        { id: 'fake-model', name: 'Fake Model' },
        { id: 'fake-model-2', name: 'Fake Model 2', reasoning: { efforts: [{ id: 'high', name: 'High' }] } },
      ],
    },
  ],
  failures: [],
  defaultProvider: 'fake-provider',
  defaultModel: 'fake-model',
}

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

class FakeRpcError {
  constructor(code, message, details) {
    Object.assign(this, { code, message, details })
  }
}

const rejectArg = (message) => {
  throw new FakeRpcError('gateway/arguments-invalid', message)
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })

function send(res, status, headers = {}, body = '') {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body))
  res.writeHead(status, { 'cache-control': 'no-store', 'content-length': buffer.length, ...headers })
  res.end(buffer)
}

const text = (res, status, body, headers = {}) =>
  send(res, status, { 'content-type': 'text/plain; charset=utf-8', ...headers }, body)
const html = (res, status, body) => send(res, status, { 'content-type': 'text/html; charset=utf-8' }, body)
const json = (res, status, value) => send(res, status, { 'content-type': 'application/json' }, JSON.stringify(value))

const cookieMap = (header) =>
  new Map(
    String(header ?? '')
      .split(';')
      .map((part) => part.trim())
      .filter((pair) => pair.indexOf('=') > 0)
      .map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]),
  )

/** Start a fake remote DSH; the promise resolves once listening. */
export async function startFakeDsh(options = {}) {
  const {
    token = 'fake-launch-token',
    requireTrustedHost = null,
    sessions = [],
    modelCatalog = DEFAULT_MODEL_CATALOG,
    pageRecords = {},
    promptEvents = [{ type: 'message', data: { role: 'user', content: [{ type: 'text', text: 'fake prompt' }] } }],
    gateway = false,
    mangleRpcId = false,
    nonJsonBody = false,
    clock = () => Date.now(),
  } = options

  const state = {
    sessions: new Map(),
    tokenAuthRequests: 0,
    connectAuthRequests: 0,
    apiRequests: 0,
    authDisabled: false,
    authenticated: false,
    lastCookieHeader: null,
  }
  const calls = []
  const validCookies = new Set()
  const sockets = new Set()
  let sessionCounter = 0
  let closed = false

  function normalizeRecord(entry, index) {
    const source = entry?.event ?? entry ?? {}
    const { type = 'message', seq = index + 1, time = clock(), data = {} } = source
    return { type: 'event', event: { type, seq, time, data } }
  }

  function makeSession(input) {
    const descriptor = typeof input === 'string' ? { id: input } : (input ?? {})
    const id = descriptor.id ?? descriptor.sessionId ?? `sess-fake-${++sessionCounter}`
    const records = (descriptor.records ?? pageRecords[id] ?? []).map(normalizeRecord)
    const last = records[records.length - 1]?.event
    const row = {
      id,
      // A descriptor may script its own reply to `session/prompt`.
      promptEvents: descriptor.promptEvents ?? promptEvents,
      // Subagent rows are shaped like ordinary ones except for their origin.
      ...(descriptor.origin === undefined ? {} : { origin: descriptor.origin }),
      ...(descriptor.parentSessionId === undefined ? {} : { parentSessionId: descriptor.parentSessionId }),
      title: descriptor.title ?? `Fake session ${id}`,
      workingDirectory: descriptor.workingDirectory ?? descriptor.cwd ?? '/work/fake',
      provider: descriptor.provider ?? modelCatalog.defaultProvider ?? 'fake-provider',
      model: descriptor.model ?? modelCatalog.defaultModel ?? 'fake-model',
      records,
      lastSeq: last?.seq ?? 0,
      lastPromptAt: last?.time ?? null,
      updatedAt: clock(),
    }
    state.sessions.set(id, row)
    return row
  }

  /**
   * One `session/list` row in the real wire shape. The bridge reads titles and
   * models out of `projections.values`, exactly as the live server reports
   * them, so the fixture has to keep that nesting.
   */
  const listRow = (row) => ({
    sessionId: row.id,
    updatedAt: row.updatedAt,
    agentAvailable: false,
    formatStatus: 'current',
    running: row.running === true,
    blank: row.records.length === 0,
    cwd: row.workingDirectory,
    ...(row.origin === undefined ? {} : { origin: row.origin }),
    ...(row.parentSessionId === undefined ? {} : { parentSessionId: row.parentSessionId }),
    projections: {
      kind: 'sequenced',
      asOfSeq: row.lastSeq,
      values: {
        title: row.title,
        workingDirectory: row.workingDirectory,
        modelSelection: { lastUsed: { provider: row.provider, model: row.model } },
        sessionListMetadata: { blank: row.records.length === 0, lastPromptAt: row.lastPromptAt },
        sessionStats: { turns: 0, steps: 0 },
      },
    },
  })

  const payloadOf = (args) => (isPlainObject(args) ? (args.request ?? args._request ?? args) : args)

  function requireSession(request) {
    const sessionId = request?.sessionId ?? request?.address?.sessionId
    if (typeof sessionId !== 'string') rejectArg('request.sessionId is required')
    const row = state.sessions.get(sessionId)
    if (!row) throw new FakeRpcError('session/not-found', `session ${sessionId} was not found`)
    return row
  }

  function appendPrompt(row) {
    // A session descriptor may script its own reply; the fixture default is a
    // single plain user message.
    for (const entry of row.promptEvents ?? promptEvents) {
      const source = entry?.event ?? entry ?? {}
      const seq = typeof source.seq === 'number' ? source.seq : row.lastSeq + 1
      row.records.push(normalizeRecord({ event: { ...source, seq } }, row.records.length))
      row.lastSeq = Math.max(row.lastSeq, seq)
    }
    row.lastPromptAt = row.records[row.records.length - 1]?.event.time ?? row.lastPromptAt
    row.updatedAt = clock()
  }

  const handlers = {
    'session/list'(args) {
      if (!isPlainObject(args) || !isPlainObject(args._request)) rejectArg('missing required object argument "_request"')
      const unknown = Object.keys(args).filter((key) => key !== '_request')
      if (unknown.length > 0) rejectArg(`unknown argument "${unknown[0]}"`)
      return { items: [...state.sessions.values()].map(listRow) }
    },
    'session/projections'(args) {
      const row = requireSession(payloadOf(args))
      return {
        kind: 'sequenced',
        asOfSeq: row.lastSeq,
        values: {
          title: row.title,
          workingDirectory: row.workingDirectory,
          modelSelection: { lastUsed: { provider: row.provider, model: row.model } },
          sessionListMetadata: { blank: row.records.length === 0, lastPromptAt: row.lastPromptAt },
          tokenUsage: { uncachedInputTokens: 12, outputTokens: 34, cacheReadTokens: 56, cacheWriteTokens: 0 },
          sessionStats: { turns: 1, steps: 2 },
          contextPressure: { projectedTokens: 100, contextWindow: 1000 },
        },
      }
    },
    'session/page'(args) {
      const request = payloadOf(args)
      if (!isPlainObject(request)) rejectArg('args must be an object')
      const address = request.address
      const badAddress = !isPlainObject(address) || address.kind !== 'session' || typeof address.sessionId !== 'string'
      if (badAddress || !Number.isInteger(request.throughSeq) || request.throughSeq < 0) {
        rejectArg('request.address must be { kind: "session", sessionId } with a non-negative integer throughSeq')
      }
      const row = state.sessions.get(address.sessionId)
      if (!row) throw new FakeRpcError('session/not-found', `session ${address.sessionId} was not found`)
      if (request.throughSeq > row.lastSeq) {
        throw new FakeRpcError('gateway/bad-request', `throughSeq ${request.throughSeq} is beyond the cursor ${row.lastSeq}`)
      }
      let records = row.records.filter((record) => record.event.seq <= request.throughSeq)
      if (typeof request.beforeSeq === 'number') records = records.filter((record) => record.event.seq < request.beforeSeq)
      const limit = request.maxMessages
      const hasMore = typeof limit === 'number' && limit > 0 && records.length > limit
      if (hasMore) records = records.slice(-limit)
      return { records, hasMore }
    },
    'session/prompt'(args) {
      const request = payloadOf(args)
      if (!isPlainObject(request)) rejectArg('args must be an object')
      for (const key of ['requestId', 'sessionId', 'mode', 'content']) {
        if (request[key] == null) rejectArg(`missing required argument "${key}"`)
      }
      appendPrompt(requireSession(request))
      return { accepted: true }
    },
    'session/cancel'(args) {
      return { accepted: true, sessionId: requireSession(payloadOf(args)).id }
    },
    'session/rename'(args) {
      const request = payloadOf(args)
      const row = requireSession(request)
      if (typeof request.title !== 'string' || !request.title.trim()) rejectArg('request.title is required')
      row.title = request.title
      return { accepted: true, sessionId: row.id, title: row.title }
    },
    'session/selectModel'(args) {
      const request = payloadOf(args)
      const row = requireSession(request)
      const selection = isPlainObject(request.selection) ? request.selection : { provider: request.provider, model: request.model }
      if (typeof selection.provider !== 'string' || typeof selection.model !== 'string') {
        rejectArg('a provider and model are required')
      }
      row.provider = selection.provider
      row.model = selection.model
      return { selected: { provider: row.provider, model: row.model } }
    },
    'session/modelCatalog'(args) {
      void args
      return modelCatalog
    },
    'session/create'(args) {
      const request = payloadOf(args)
      if (request !== undefined && !isPlainObject(request)) rejectArg('args must be an object')
      const row = makeSession({ workingDirectory: request?.workingDirectory ?? request?.cwd, title: request?.title })
      return { sessionId: row.id }
    },
  }

  function isAuthed(req) {
    if (state.authDisabled) return false
    return [...cookieMap(req.headers.cookie)].some(([name, value]) => validCookies.has(`${name}=${value}`))
  }

  function trustedHostOk(req) {
    if (!requireTrustedHost) return true
    const expected = Array.isArray(requireTrustedHost) ? requireTrustedHost : [requireTrustedHost]
    const actual = String(req.headers.host ?? '')
    return expected.some((host) => host === actual || host === actual.split(':')[0])
  }

  const loginPage = () =>
    '<!doctype html><html><body><h1>dsh-gateway</h1><form method="post"><input name="password"></form></body></html>'

  function handleTokenGet(req, res, url) {
    state.tokenAuthRequests += 1
    if (gateway) return send(res, 302, { location: '/login?next=%2F' }, 'redirecting to gateway login')
    if (state.authDisabled) return text(res, 401, 'dsh web authentication required; reopen the URL printed by dsh web.')
    const tokens = url.searchParams.getAll('token')
    if (tokens.length !== 1 || tokens[0] === '') return text(res, 400, 'malformed token query')
    if (tokens[0] !== token) return text(res, 401, 'dsh web authentication required; reopen the URL printed by dsh web.')
    validCookies.add(TOKEN_COOKIE)
    return send(
      res,
      303,
      { location: './', 'set-cookie': `${TOKEN_COOKIE}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict` },
      '',
    )
  }

  function handleConnectGet(req, res, url) {
    state.connectAuthRequests += 1
    if (gateway) return send(res, 302, { location: '/login?next=%2F' }, '')
    if (state.authDisabled) return text(res, 401, 'dsh web authentication required; reopen the URL printed by dsh web.')
    const tokens = url.searchParams.getAll('token')
    const interactions = url.searchParams.getAll('interactions')
    if (tokens.length !== 1 || tokens[0] === '' || tokens[0] !== token) {
      return text(res, 401, 'dsh web authentication required; reopen the URL printed by dsh web.')
    }
    if (interactions.length !== 1 || !/^[A-Za-z0-9_,.:-]+$/.test(interactions[0] ?? '')) {
      return text(res, 400, 'invalid interactions')
    }
    validCookies.add(CONNECT_COOKIE)
    return send(res, 302, { location: './api/remote.mux', 'set-cookie': `${CONNECT_COOKIE}; Path=/; HttpOnly` }, '')
  }

  function handleLoginGet(req, res) {
    return html(res, 200, loginPage())
  }

  /** A gateway rejects a non-browser login; the bridge never gets past this. */
  function handleLoginPost(req, res) {
    return html(res, 401, '<!doctype html><html><body><p>密码错误</p></body></html>')
  }

  function handleState(req, res) {
    if (!isAuthed(req)) return json(res, 401, { error: 'unauthorized' })
    state.authenticated = true
    return json(res, 200, { authenticated: true, sessions: [...state.sessions.values()].map(listRow), apiRequests: state.apiRequests })
  }

  async function handleApi(req, res, pathname) {
    const method = decodeURIComponent(pathname.slice('/api/'.length))
    state.apiRequests += 1
    if (!Object.hasOwn(handlers, method)) return text(res, 404, 'not found')
    if (!isAuthed(req)) return gateway ? send(res, 302, { location: '/login' }, '') : json(res, 401, { error: 'unauthorized' })
    if (!/application\/json/i.test(String(req.headers['content-type'] ?? ''))) return text(res, 415, 'expected application/json')
    let envelope
    try {
      envelope = JSON.parse(await readBody(req))
    } catch {
      return text(res, 400, 'malformed JSON body')
    }
    const validEnvelope =
      isPlainObject(envelope) &&
      envelope.type === 'client-request' &&
      typeof envelope.rpcId === 'string' &&
      envelope.method === method &&
      isPlainObject(envelope.payload)
    if (!validEnvelope) return text(res, 400, 'malformed request envelope')
    const args = envelope.payload.args ?? {}
    calls.push({ method, args })
    let result
    try {
      result = { ok: true, value: await handlers[method](args) }
    } catch (error) {
      result =
        error instanceof FakeRpcError
          ? { ok: false, error: { code: error.code, message: error.message, details: error.details } }
          : { ok: false, error: { code: 'gateway/internal-error', message: 'fake handler failed' } }
    }
    if (nonJsonBody) return text(res, 200, 'this is not a JSON envelope')
    return json(res, 200, { type: 'server-response', rpcId: mangleRpcId ? 'mismatched-rpc-id' : envelope.rpcId, result })
  }

  const server = createServer(async (req, res) => {
    try {
      state.lastCookieHeader = req.headers.cookie ?? null
      if (!trustedHostOk(req)) return text(res, 403, 'forbidden')
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const pathname = url.pathname
      if (req.method === 'GET' && pathname === '/') return handleTokenGet(req, res, url)
      if (req.method === 'GET' && pathname === '/connect') return handleConnectGet(req, res, url)
      if (pathname === '/login') return req.method === 'POST' ? handleLoginPost(req, res) : handleLoginGet(req, res)
      if (req.method === 'GET' && pathname === '/__dsh_gateway/state') return handleState(req, res)
      if (req.method === 'GET' && pathname === '/__hang') return
      if (req.method === 'POST' && pathname.startsWith('/api/')) return await handleApi(req, res, pathname)
      return text(res, 404, 'not found')
    } catch {
      return text(res, 500, 'fake dsh internal error')
    }
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  sessions.forEach(makeSession)

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close() {
      if (closed) return Promise.resolve()
      closed = true
      for (const socket of sockets) socket.destroy()
      return new Promise((resolve) => server.close(() => resolve()))
    },
    state,
    calls,
    setSessions(next = []) {
      state.sessions.clear()
      if (Array.isArray(next)) next.forEach(makeSession)
      else if (isPlainObject(next)) for (const [id, records] of Object.entries(next)) makeSession({ id, records })
      else throw new TypeError('setSessions expects an array of session descriptors')
      return state.sessions
    },
    expireAuth() {
      validCookies.clear()
    },
    dropAuth() {
      validCookies.clear()
      state.authDisabled = true
    },
  }
}
