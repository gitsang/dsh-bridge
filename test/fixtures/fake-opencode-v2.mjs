#!/usr/bin/env node
/**
 * Minimal OpenCode 2.x `serve` stand-in for tests.
 *
 * Replays the wire contract captured from a real 2.2.6 server: the unprefixed
 * `server listening on …` banner, mandatory HTTP Basic auth, the `/api` route
 * tree, and the 2.x event family (`session.execution.*`, `session.step.*`,
 * `session.text.*`, `session.tool.*`). One SSE client at a time, so the scripted
 * turn cannot interleave.
 *
 * Behaviour is steered by environment variables:
 * - `OPENCODE_PASSWORD` is the Basic-auth secret the server demands; without it
 *   the fixture refuses to start (a real 2.x server always has one);
 * - `FAKE_OPENCODE_V2_NO_LISTEN=1` exits before printing the banner;
 * - `FAKE_OPENCODE_V2_EXIT_ON_PROMPT=1` kills the process mid-turn;
 * - `FAKE_OPENCODE_V2_TOOL_FAILURE=1` makes the tool end with `session.tool.failed`;
 * - `FAKE_OPENCODE_V2_PERMISSION=ask` emits `permission.asked` before the tool
 *   and blocks until the session-scoped reply route answers;
 * - `FAKE_OPENCODE_V2_INTERRUPT=1` stops the turn at the tool and waits for
 *   `POST /api/session/{id}/interrupt`, then emits `execution.interrupted`.
 *
 * `GET /api/hang` never answers; it exists so tests can prove that pending
 * requests reject on child exit and that dispose aborts them.
 */
import { createServer } from 'node:http'

const SESSION_ID = 'ses_v2fake00000000000000000001'
const SESSION_ID_2 = 'ses_v2fake00000000000000000002'
const PROVIDER_ID = 'fake-v2-provider'
const MODEL_ID = 'fake-v2-model'
const MODEL_ID_2 = 'fake-v2-model-2'
const WORKSPACE = process.cwd()
const PASSWORD = process.env.OPENCODE_PASSWORD ?? ''

const noListen = process.env.FAKE_OPENCODE_V2_NO_LISTEN === '1'
const exitOnPrompt = process.env.FAKE_OPENCODE_V2_EXIT_ON_PROMPT === '1'
const toolFailure = process.env.FAKE_OPENCODE_V2_TOOL_FAILURE === '1'
const permissionMode = process.env.FAKE_OPENCODE_V2_PERMISSION ?? ''
const interruptMode = process.env.FAKE_OPENCODE_V2_INTERRUPT === '1'

let baseUrl = 'http://127.0.0.1'

const write = (line) => process.stdout.write(line)
const log = (message) => write(`${message}\n`)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let nextId = 0
const mintId = (prefix) => `${prefix}_v2fake${(nextId += 1).toString().padStart(8, '0')}`

/**
 * One in-memory session. 2.x keeps the workspace under `location.directory` and
 * tracks a running token total on the row, which the adapter reads for stats.
 */
const sessions = new Map([
  [SESSION_ID, {
    id: SESSION_ID,
    projectID: 'global',
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: Date.now(), updated: Date.now() },
    title: 'New session - 2026-01-01T00:00:00.000Z',
    location: { directory: WORKSPACE },
  }],
  [SESSION_ID_2, {
    id: SESSION_ID_2,
    projectID: 'global',
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: Date.now() - 1000, updated: Date.now() - 1000 },
    title: 'Older fake session',
    location: { directory: WORKSPACE },
  }],
])

/** Per-session transcripts in the 2.x `[{type,…}]` shape. */
const transcripts = new Map([[SESSION_ID, []], [SESSION_ID_2, []]])
const activeSessions = new Set()
const eventClients = new Set()
const pendingPermissions = new Map()
let interruptWaiter

/** Broadcast one 2.x record: `{id,created,type,data}`, no `properties` wrapper. */
function emitEvent(type, data) {
  const record = { id: mintId('evt'), created: Date.now(), type, data }
  const frame = `data: ${JSON.stringify(record)}\n\n`
  for (const response of eventClients) {
    try {
      response.write(frame)
    } catch {
      eventClients.delete(response)
    }
  }
}

function requireAuth(request, response) {
  const header = request.headers.authorization ?? ''
  const expected = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`
  if (PASSWORD !== '' && header === expected) return true
  // The real server answers the /api tree with 401 and no body.
  response.writeHead(401, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ type: 'UnauthorizedError', message: 'Unauthorized' }))
  return false
}

function sendJson(response, status, value) {
  const body = value === undefined ? '' : JSON.stringify(value)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  response.end(body)
}

/** 204-style empty response, like the model switch and permission reply routes. */
function sendEmpty(response, status = 204) {
  response.writeHead(status)
  response.end()
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let text = ''
    request.on('data', (chunk) => {
      text += chunk
      if (text.length > 4 * 1024 * 1024) {
        request.destroy()
        reject(new Error('body too large'))
      }
    })
    request.on('end', () => {
      if (text.trim() === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch (error) {
        reject(error)
      }
    })
    request.on('error', reject)
  })
}

function catalog() {
  return {
    location: { directory: WORKSPACE },
    data: [
      {
        id: MODEL_ID,
        modelID: MODEL_ID,
        providerID: PROVIDER_ID,
        type: 'chat',
        name: 'Fake V2 Model',
        capabilities: { tools: true, input: ['text'], output: ['text'] },
        variants: [{ id: 'none' }, { id: 'high' }],
        status: 'active',
        enabled: true,
        limit: { context: 200000, output: 8192 },
      },
      {
        id: MODEL_ID_2,
        modelID: MODEL_ID_2,
        providerID: PROVIDER_ID,
        type: 'chat',
        name: 'Fake V2 Model Two',
        capabilities: { tools: true, input: ['text'], output: ['text'] },
        variants: [],
        status: 'active',
        enabled: true,
        limit: { context: 64000, output: 4096 },
      },
      {
        id: 'disabled-model',
        modelID: 'disabled-model',
        providerID: PROVIDER_ID,
        type: 'chat',
        name: 'Disabled Model',
        capabilities: { tools: true, input: ['text'], output: ['text'] },
        variants: [],
        status: 'deprecated',
        enabled: false,
        limit: { context: 1000, output: 100 },
      },
    ],
  }
}

function updateSessionUsage(sessionId, tokens, cost) {
  const session = sessions.get(sessionId)
  if (session === undefined) return
  session.tokens = tokens
  session.cost = cost
  session.time = { ...session.time, updated: Date.now() }
}

/**
 * The scripted turn, using the real 2.2.6 event sequence and field names:
 * execution.started → step.started → reasoning → tool.input.* → tool.called →
 * tool.success → text → step.ended → usage.updated → execution.succeeded.
 */
async function runTurn(sessionId, text) {
  const transcript = transcripts.get(sessionId) ?? []
  transcripts.set(sessionId, transcript)
  activeSessions.add(sessionId)
  emitEvent('session.execution.started', { sessionID: sessionId })

  const assistantMessageId = mintId('msg')
  const started = Date.now()
  emitEvent('session.step.started', {
    sessionID: sessionId,
    assistantMessageID: assistantMessageId,
    agent: 'build',
    model: { id: MODEL_ID, providerID: PROVIDER_ID },
    started,
  })

  const reasoningText = `thinking about ${text}`
  emitEvent('session.reasoning.started', { sessionID: sessionId, assistantMessageID: assistantMessageId, ordinal: 0 })
  for (const chunk of splitChunks(reasoningText)) {
    emitEvent('session.reasoning.delta', {
      sessionID: sessionId,
      assistantMessageID: assistantMessageId,
      ordinal: 0,
      delta: chunk,
    })
  }
  emitEvent('session.reasoning.ended', {
    sessionID: sessionId,
    assistantMessageID: assistantMessageId,
    ordinal: 0,
    text: reasoningText,
  })

  const callId = `call_v2fake${nextId}`
  const toolName = 'shell'
  emitEvent('session.tool.input.started', {
    sessionID: sessionId,
    assistantMessageID: assistantMessageId,
    id: callId,
    name: toolName,
  })
  const argsText = JSON.stringify({ command: 'echo hi' })
  emitEvent('session.tool.input.ended', {
    sessionID: sessionId,
    assistantMessageID: assistantMessageId,
    id: callId,
    text: argsText,
  })
  emitEvent('session.tool.called', {
    sessionID: sessionId,
    assistantMessageID: assistantMessageId,
    id: callId,
    input: { command: 'echo hi' },
    executed: true,
  })

  if (permissionMode === 'ask') {
    await requestPermission(sessionId, callId, assistantMessageId)
  }

  if (interruptMode) {
    // A real interrupted turn stops wherever the abort lands; parking here keeps
    // the fixture deterministic and lets the test abort from the outside.
    await new Promise((resolve) => {
      interruptWaiter = resolve
    })
    return
  }

  emitEvent('session.tool.progress', {
    sessionID: sessionId,
    assistantMessageID: assistantMessageId,
    id: callId,
    metadata: { output: 'hi\n' },
  })
  if (toolFailure) {
    emitEvent('session.tool.failed', {
      sessionID: sessionId,
      assistantMessageID: assistantMessageId,
      id: callId,
      error: { type: 'ToolError', message: 'tool blew up' },
      content: [{ type: 'text', text: 'boom' }],
      executed: true,
    })
  } else {
    emitEvent('session.tool.success', {
      sessionID: sessionId,
      assistantMessageID: assistantMessageId,
      id: callId,
      content: [{ type: 'text', text: 'hi\n' }],
      metadata: { exit: 0 },
      executed: true,
    })
  }

  const textValue = `echo: ${text}`
  emitEvent('session.text.started', { sessionID: sessionId, assistantMessageID: assistantMessageId, ordinal: 0 })
  for (const chunk of splitChunks(textValue)) {
    emitEvent('session.text.delta', {
      sessionID: sessionId,
      assistantMessageID: assistantMessageId,
      ordinal: 0,
      delta: chunk,
    })
  }
  emitEvent('session.text.ended', {
    sessionID: sessionId,
    assistantMessageID: assistantMessageId,
    ordinal: 0,
    text: textValue,
  })

  const tokens = { input: 12, output: 5, reasoning: 2, cache: { read: 30, write: 0 } }
  emitEvent('session.step.streamed', { sessionID: sessionId, assistantMessageID: assistantMessageId })
  emitEvent('session.step.ended', {
    sessionID: sessionId,
    assistantMessageID: assistantMessageId,
    finish: 'stop',
    rawFinish: 'stop',
    tokens,
    cost: 0,
  })

  transcript.push({
    id: assistantMessageId,
    time: { created: started, streamed: Date.now(), completed: Date.now() },
    type: 'assistant',
    agent: 'build',
    model: { id: MODEL_ID, providerID: PROVIDER_ID },
    content: [
      { type: 'text', text: textValue },
      { type: 'reasoning', text: reasoningText },
      {
        type: 'tool',
        id: callId,
        name: toolName,
        executed: true,
        state: toolFailure
          ? { status: 'error', input: { command: 'echo hi' }, error: { type: 'ToolError', message: 'tool blew up' } }
          : { status: 'completed', input: { command: 'echo hi' }, content: [{ type: 'text', text: 'hi\n' }] },
        time: { created: started, completed: Date.now() },
      },
    ],
    finish: 'stop',
    cost: 0,
    tokens,
  })

  updateSessionUsage(sessionId, tokens, 0)
  emitEvent('session.usage.updated', { sessionID: sessionId, cost: 0, tokens })
  emitEvent('session.execution.succeeded', { sessionID: sessionId })
  activeSessions.delete(sessionId)
  transcript.push({ id: mintId('msg'), time: { created: Date.now() }, type: 'idle', outcome: 'succeeded' })
}

function splitChunks(text) {
  const chunks = []
  for (let index = 0; index < text.length; index += 4) chunks.push(text.slice(index, index + 4))
  return chunks
}

/** Ask for approval and block until the session-scoped reply route answers. */
function requestPermission(sessionId, callId, assistantMessageId) {
  const id = mintId('per')
  return new Promise((resolve) => {
    pendingPermissions.set(id, { resolve })
    emitEvent('permission.asked', {
      id,
      sessionID: sessionId,
      action: 'shell',
      resources: ['echo hi'],
      save: ['echo *'],
      metadata: { command: 'echo hi' },
      source: { type: 'tool', messageID: assistantMessageId, callID: callId },
    })
  })
}

/** The interrupt path: answer the pending execution with an interrupted event. */
function finishInterrupted(sessionId) {
  const transcript = transcripts.get(sessionId) ?? []
  transcripts.set(sessionId, transcript)
  activeSessions.delete(sessionId)
  emitEvent('session.execution.interrupted', { sessionID: sessionId, reason: 'user' })
  transcript.push({ id: mintId('msg'), time: { created: Date.now() }, type: 'idle', outcome: 'interrupted' })
  if (interruptWaiter !== undefined) {
    const resolve = interruptWaiter
    interruptWaiter = undefined
    resolve()
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const path = url.pathname
  const method = request.method ?? 'GET'

  // `/` is the web UI on a real 2.x server and needs no auth; it also proves the
  // route tree is unprefixed while the API lives under /api.
  if (path === '/' && method === 'GET') {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<!doctype html><title>fake opencode 2</title>')
    return
  }

  if (!path.startsWith('/api')) {
    sendJson(response, 404, { type: 'NotFoundError', message: `no route for ${method} ${path}` })
    return
  }

  if (!requireAuth(request, response)) return

  // Test hook: a route that never answers, so a caller can prove that a child
  // exit or a dispose aborts an in-flight request instead of hanging.
  if (path === '/api/hang' && method === 'GET') return

  if (path === '/api/info' && method === 'GET') {
    sendJson(response, 200, { version: '2.2.6', pid: process.pid, urls: [baseUrl], paths: { tmp: '/tmp' } })
    return
  }

  if (path === '/api/event' && method === 'GET') {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    })
    eventClients.add(response)
    response.write(`data: ${JSON.stringify({ id: mintId('evt'), created: Date.now(), type: 'server.connected', data: {} })}\n\n`)
    request.on('close', () => eventClients.delete(response))
    return
  }

  if (path === '/api/location' && method === 'GET') {
    sendJson(response, 200, { directory: WORKSPACE, project: { id: 'global', directory: WORKSPACE } })
    return
  }

  if (path === '/api/model' && method === 'GET') {
    sendJson(response, 200, catalog())
    return
  }

  if (path === '/api/provider' && method === 'GET') {
    sendJson(response, 200, {
      location: { directory: WORKSPACE },
      data: [{ id: PROVIDER_ID, name: 'Fake V2 Provider', activation: 'enabled', package: '@opencode/ai/providers/openai-compatible' }],
    })
    return
  }

  if (path === '/api/session' && method === 'GET') {
    const limit = Number(url.searchParams.get('limit') ?? 50)
    const cursor = url.searchParams.get('cursor')
    // Pages of `limit` sessions, so pagination is exercised the way the real
    // endpoint does it: an opaque `cursor.next` string, null on the last page.
    const all = [...sessions.values()]
    const start = cursor === null ? 0 : Number(cursor.replace('cursor-page-', ''))
    const page = all.slice(start, start + Math.max(1, limit))
    const next = start + page.length < all.length ? `cursor-page-${start + page.length}` : null
    sendJson(response, 200, { data: page, cursor: { previous: null, next } })
    return
  }

  if (path === '/api/session' && method === 'POST') {
    const body = await readBody(request)
    const info = {
      id: mintId('ses'),
      projectID: 'global',
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: Date.now(), updated: Date.now() },
      title: typeof body.title === 'string' ? body.title : `New session - ${new Date().toISOString()}`,
      location: { directory: WORKSPACE },
    }
    sessions.set(info.id, info)
    transcripts.set(info.id, [])
    sendJson(response, 200, { data: info })
    return
  }

  if (path === '/api/session/active' && method === 'GET') {
    const data = {}
    for (const sessionId of activeSessions) data[sessionId] = { sessionID: sessionId }
    sendJson(response, 200, { data })
    return
  }

  const sessionMatch = /^\/api\/session\/([^/]+)$/.exec(path)
  if (sessionMatch !== null) {
    const session = sessions.get(sessionMatch[1])
    if (method === 'GET') {
      if (session === undefined) {
        sendJson(response, 404, { type: 'SessionNotFoundError', message: 'session not found' })
        return
      }
      sendJson(response, 200, { data: session })
      return
    }
    if (method === 'PATCH') {
      const body = await readBody(request)
      if (session === undefined) {
        sendJson(response, 404, { type: 'SessionNotFoundError', message: 'session not found' })
        return
      }
      if (typeof body.title === 'string') {
        session.title = body.title
        emitEvent('session.renamed', { sessionID: session.id, title: body.title })
      }
      sendEmpty(response, 204)
      return
    }
  }

  const messagesMatch = /^\/api\/session\/([^/]+)\/message$/.exec(path)
  if (messagesMatch !== null && method === 'GET') {
    const sessionId = messagesMatch[1]
    if (!sessions.has(sessionId)) {
      sendJson(response, 404, { type: 'SessionNotFoundError', message: 'session not found' })
      return
    }
    // Newest first, like the real endpoint; the adapter only reads what it needs
    // and both entry shapes are covered by the turn above.
    sendJson(response, 200, { data: [...(transcripts.get(sessionId) ?? [])].reverse(), cursor: { previous: null, next: null } })
    return
  }

  const promptMatch = /^\/api\/session\/([^/]+)\/prompt$/.exec(path)
  if (promptMatch !== null && method === 'POST') {
    const sessionId = promptMatch[1]
    const body = await readBody(request)
    if (!sessions.has(sessionId)) {
      sendJson(response, 404, { type: 'SessionNotFoundError', message: 'session not found' })
      return
    }
    // The 1.x `{parts}` body is rejected by the real server with this exact
    // shape, which is what proves the adapter posts `{text}`.
    if (typeof body.text !== 'string') {
      sendJson(response, 400, { type: 'InvalidRequestError', message: 'Missing key at ["text"]' })
      return
    }
    if (exitOnPrompt) {
      sendJson(response, 200, { data: { id: mintId('msg'), sessionID: sessionId, type: 'user', payload: { text: body.text }, delivery: 'steer' } })
      setTimeout(() => process.exit(3), 30)
      return
    }
    const transcript = transcripts.get(sessionId) ?? []
    transcripts.set(sessionId, transcript)
    transcript.push({ id: mintId('msg'), time: { created: Date.now() }, text: body.text, type: 'user' })
    sendJson(response, 200, {
      data: {
        id: mintId('msg'),
        sessionID: sessionId,
        time: { created: Date.now() },
        type: 'user',
        payload: { text: body.text },
        delivery: typeof body.delivery === 'string' ? body.delivery : 'steer',
      },
    })
    void runTurn(sessionId, body.text).catch(() => {})
    return
  }

  const interruptMatch = /^\/api\/session\/([^/]+)\/interrupt$/.exec(path)
  if (interruptMatch !== null && method === 'POST') {
    const sessionId = interruptMatch[1]
    if (!sessions.has(sessionId)) {
      sendJson(response, 404, { type: 'SessionNotFoundError', message: 'session not found' })
      return
    }
    finishInterrupted(sessionId)
    sendJson(response, 200, { interrupted: true })
    return
  }

  const modelMatch = /^\/api\/session\/([^/]+)\/model$/.exec(path)
  if (modelMatch !== null && method === 'POST') {
    const body = await readBody(request)
    const session = sessions.get(modelMatch[1])
    if (session === undefined) {
      sendJson(response, 404, { type: 'SessionNotFoundError', message: 'session not found' })
      return
    }
    // The field is `model.id`; `model.modelID` is rejected, exactly like 2.2.6.
    if (typeof body.model?.id !== 'string' || typeof body.model?.providerID !== 'string') {
      sendJson(response, 400, { type: 'InvalidRequestError', message: 'Missing key at ["model"]["id"]' })
      return
    }
    session.model = { id: body.model.id, providerID: body.model.providerID }
    sendEmpty(response, 204)
    return
  }

  const permissionListMatch = /^\/api\/session\/([^/]+)\/permission$/.exec(path)
  if (permissionListMatch !== null && method === 'GET') {
    sendJson(response, 200, { data: [...pendingPermissions.keys()].map((id) => ({ id, sessionID: permissionListMatch[1], action: 'shell', resources: [] })) })
    return
  }

  const permissionReplyMatch = /^\/api\/session\/([^/]+)\/permission\/([^/]+)\/reply$/.exec(path)
  if (permissionReplyMatch !== null && method === 'POST') {
    const body = await readBody(request)
    const pending = pendingPermissions.get(permissionReplyMatch[2])
    if (pending === undefined) {
      sendJson(response, 404, { type: 'PermissionNotFoundError', message: 'permission not found' })
      return
    }
    // 2.x takes `{decision}`; `{reply}` is the 1.x body and must not look valid.
    if (body.decision !== 'once' && body.decision !== 'always' && body.decision !== 'reject') {
      sendJson(response, 400, { type: 'InvalidRequestError', message: 'Missing key at ["decision"]' })
      return
    }
    pendingPermissions.delete(permissionReplyMatch[2])
    pending.resolve(body.decision)
    emitEvent('permission.replied', { sessionID: permissionReplyMatch[1], requestID: permissionReplyMatch[2], reply: body.decision })
    sendEmpty(response, 204)
    return
  }

  sendJson(response, 404, { type: 'NotFoundError', message: `no route for ${method} ${path}` })
})

if (PASSWORD === '') {
  log('fake opencode 2: OPENCODE_PASSWORD is required')
  process.exit(2)
}

if (noListen) {
  log('fake opencode 2: refusing to listen')
  process.exit(2)
}

server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  baseUrl = `http://127.0.0.1:${address.port}`
  // The 2.x banner has no `opencode ` prefix, which is why the adapter's regex
  // has to accept both forms.
  log(`server listening on ${baseUrl}`)
})

// The real 2.x server ignores plain stdin EOF and SIGTERM on some paths; the
// fixture does too, so dispose has to escalate to SIGKILL in tests.
process.on('SIGTERM', () => {})
process.stdin.resume()
process.stdin.on('data', () => {})
process.stdin.on('end', () => {})
