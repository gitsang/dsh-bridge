#!/usr/bin/env node
/**
 * Minimal `opencode serve` stand-in for tests.
 *
 * Speaks the HTTP + SSE subset the adapter uses (health, sessions, messages,
 * prompt_async, abort, provider catalog, permission/question replies) and emits
 * a deterministic scripted turn over `/event`, so the attachment can be tested
 * end to end without the real 200 MB CLI or any network.
 *
 * Ports are random and bound to 127.0.0.1 to keep parallel test runs hermetic.
 * Behaviour is steered by environment variables:
 * - `FAKE_OPENCODE_PERMISSION=ask` emits a `permission.asked` before the tool
 * - `FAKE_OPENCODE_PERMISSION=v2-ask` emits `permission.v2.asked` and answers
 *   through the session-scoped reply route
 * - `FAKE_OPENCODE_PERMISSION=question` emits a `question.asked` instead
 * - `FAKE_OPENCODE_NO_LISTEN=1` exits before printing the listening URL
 * - `FAKE_OPENCODE_EXIT_ON_PROMPT=1` crashes during a turn
 */
import { createServer } from 'node:http'

const SESSION_ID = 'ses_fake000000000000000000000'
const PROVIDER_ID = 'fake-provider'
const MODEL_ID = 'fake-model'
const WORKSPACE = process.cwd()

const permissionMode = process.env.FAKE_OPENCODE_PERMISSION ?? ''
const exitOnPrompt = process.env.FAKE_OPENCODE_EXIT_ON_PROMPT === '1'

/** One turn at a time per session: the real server queues a prompt sent while busy. */
const turnQueues = new Map()
function enqueueTurn(sessionId, task) {
  const previous = turnQueues.get(sessionId) ?? Promise.resolve()
  const next = previous.then(task, task)
  turnQueues.set(sessionId, next.catch(() => {}))
  return next
}

const write = (line) => process.stdout.write(line)
const log = (message) => write(`${message}\n`)

/** One in-memory session; a real server persists these in SQLite. */
const sessions = new Map([
  [SESSION_ID, {
    id: SESSION_ID,
    slug: 'fake-comet',
    projectID: 'global',
    directory: WORKSPACE,
    path: WORKSPACE.replace(/^\//, ''),
    title: 'New session - 2026-01-01T00:00:00.000Z',
    version: '1.19.5',
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: Date.now(), updated: Date.now() },
  }],
])

let nextId = 0
const mintId = (prefix) => `${prefix}_fake${(nextId += 1).toString().padStart(8, '0')}`

/** Per-session transcript, API shape `[{info, parts}]`. */
const transcripts = new Map([[SESSION_ID, []]])
const sessionStatus = new Map()
const pendingPermissions = new Map()
const pendingQuestions = new Map()
const eventClients = new Set()

/** Broadcast one native `{id,type,properties}` record to every SSE client. */
function emitEvent(type, properties) {
  const record = { id: mintId('evt'), type, properties }
  const frame = `data: ${JSON.stringify(record)}\n\n`
  for (const response of eventClients) {
    try {
      response.write(frame)
    } catch {
      eventClients.delete(response)
    }
  }
}

function setStatus(sessionId, status) {
  if (status === undefined) sessionStatus.delete(sessionId)
  else sessionStatus.set(sessionId, status)
  emitEvent('session.status', { sessionID: sessionId, status: status ?? { type: 'idle' } })
  if (status === undefined) emitEvent('session.idle', { sessionID: sessionId })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The deterministic turn: busy → user message → text chunk → tool → idle. */
async function runTurn(sessionId, text, model) {
  const transcript = transcripts.get(sessionId) ?? []
  transcripts.set(sessionId, transcript)
  let currentAssistantId = ''
  let currentUserId = ''

  const userInfo = {
    id: mintId('msg'),
    sessionID: sessionId,
    role: 'user',
    time: { created: Date.now() },
    agent: 'fake',
    model: { providerID: model?.providerID ?? PROVIDER_ID, modelID: model?.modelID ?? MODEL_ID },
  }
  currentUserId = userInfo.id
  const userPart = { id: mintId('prt'), sessionID: sessionId, messageID: userInfo.id, type: 'text', text }
  transcript.push({ info: userInfo, parts: [userPart] })
  emitEvent('message.updated', { sessionID: sessionId, info: userInfo })
  emitEvent('message.part.updated', { sessionID: sessionId, part: userPart, time: Date.now() })

  await sleep(10)
  setStatus(sessionId, { type: 'busy' })

  currentAssistantId = mintId('msg')
  const assistantInfo = {
    id: currentAssistantId,
    sessionID: sessionId,
    role: 'assistant',
    parentID: userInfo.id,
    modelID: model?.modelID ?? MODEL_ID,
    providerID: model?.providerID ?? PROVIDER_ID,
    mode: 'fake',
    agent: 'fake',
    path: { cwd: WORKSPACE, root: WORKSPACE },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: Date.now() },
  }
  transcript.push({ info: assistantInfo, parts: [] })
  emitEvent('message.updated', { sessionID: sessionId, info: assistantInfo })

  const reasoningPart = { id: mintId('prt'), sessionID: sessionId, messageID: currentAssistantId, type: 'reasoning', text: '', time: { start: Date.now() } }
  transcript.at(-1).parts.push(reasoningPart)
  // The real server announces a part with empty text, streams `part.delta`
  // frames, then re-sends the cumulative part. Mirrored so the adapter's
  // delta-then-snapshot accumulation is what the tests exercise.
  emitEvent('message.part.updated', { sessionID: sessionId, part: reasoningPart, time: Date.now() })
  const reasoning = `thinking about ${text}`
  for (const chunk of splitChunks(reasoning)) {
    reasoningPart.text += chunk
    emitEvent('message.part.delta', {
      sessionID: sessionId,
      messageID: currentAssistantId,
      partID: reasoningPart.id,
      field: 'reasoning',
      delta: chunk,
    })
    await sleep(2)
  }
  emitEvent('message.part.updated', { sessionID: sessionId, part: { ...reasoningPart, time: { start: reasoningPart.time.start, end: Date.now() } }, time: Date.now() })

  const textPart = { id: mintId('prt'), sessionID: sessionId, messageID: currentAssistantId, type: 'text', text: '', time: { start: Date.now() } }
  transcript.at(-1).parts.push(textPart)
  emitEvent('message.part.updated', { sessionID: sessionId, part: textPart, time: Date.now() })
  const say = `echo: ${text}`
  for (const chunk of splitChunks(say)) {
    textPart.text += chunk
    emitEvent('message.part.delta', {
      sessionID: sessionId,
      messageID: currentAssistantId,
      partID: textPart.id,
      field: 'text',
      delta: chunk,
    })
    await sleep(2)
  }
  emitEvent('message.part.updated', { sessionID: sessionId, part: { ...textPart, time: { start: textPart.time.start, end: Date.now() } }, time: Date.now() })

  // One tool call per turn, so the attachment's tool-start/update/end path and
  // the message blocks carrying the same call are both exercised.
  const callId = `call_fake${nextId}`
  const toolPart = {
    id: mintId('prt'),
    sessionID: sessionId,
    messageID: currentAssistantId,
    type: 'tool',
    tool: 'bash',
    callID: callId,
    state: { status: 'pending', input: {}, raw: '' },
  }
  transcript.at(-1).parts.push(toolPart)
  emitEvent('message.part.updated', { sessionID: sessionId, part: toolPart, time: Date.now() })

  if (permissionMode === 'ask' || permissionMode === 'v2-ask' || permissionMode === 'question') {
    await requestApproval(sessionId, callId, permissionMode)
  }

  toolPart.state = { status: 'running', input: { command: 'echo hi' }, time: { start: Date.now() } }
  emitEvent('message.part.updated', { sessionID: sessionId, part: toolPart, time: Date.now() })
  toolPart.state = {
    status: 'running',
    input: { command: 'echo hi' },
    metadata: { output: 'hi\n' },
    time: { start: toolPart.state.time.start },
  }
  emitEvent('message.part.updated', { sessionID: sessionId, part: toolPart, time: Date.now() })
  toolPart.state = {
    status: 'completed',
    input: { command: 'echo hi' },
    output: 'hi\n',
    title: 'echo hi',
    metadata: { output: 'hi\n', exit: 0 },
    time: { start: toolPart.state.time.start, end: Date.now() },
  }
  emitEvent('message.part.updated', { sessionID: sessionId, part: toolPart, time: Date.now() })

  const stepFinish = {
    id: mintId('prt'),
    sessionID: sessionId,
    messageID: currentAssistantId,
    type: 'step-finish',
    reason: 'stop',
    cost: 0,
    tokens: { total: 47, input: 12, output: 5, reasoning: 2, cache: { read: 30, write: 0 } },
  }
  transcript.at(-1).parts.push(stepFinish)
  emitEvent('message.part.updated', { sessionID: sessionId, part: stepFinish, time: Date.now() })

  const completed = {
    ...transcript.at(-1).info,
    time: { ...transcript.at(-1).info.time, completed: Date.now() },
    finish: 'stop',
    tokens: { total: 47, input: 12, output: 5, reasoning: 2, cache: { read: 30, write: 0 } },
  }
  transcript.at(-1).info = completed
  emitEvent('message.updated', { sessionID: sessionId, info: completed })
  setStatus(sessionId, undefined)
}

function splitChunks(text) {
  const chunks = []
  for (let index = 0; index < text.length; index += 4) chunks.push(text.slice(index, index + 4))
  return chunks
}

/** Ask for approval and wait for the reply, mirroring the real server's block. */
function requestApproval(sessionId, callId, mode) {
  const id = mode === 'question' ? mintId('que') : mintId('per')
  return new Promise((resolve) => {
    if (mode === 'v2-ask') {
      // The v2 event family names its fields action/resources and is answered
      // through the session-scoped reply route.
      const request = {
        id,
        sessionID: sessionId,
        action: 'bash',
        resources: ['echo hi'],
        save: ['echo *'],
        metadata: { command: 'echo hi' },
        source: { type: 'tool', messageID: currentAssistantFor(sessionId), callID: callId },
      }
      pendingPermissions.set(id, { request, resolve })
      emitEvent('permission.v2.asked', request)
      return
    }
    if (mode === 'ask') {
      const request = {
        id,
        sessionID: sessionId,
        permission: 'bash',
        patterns: ['echo hi'],
        metadata: { command: 'echo hi' },
        always: ['echo *'],
        tool: { messageID: currentAssistantFor(sessionId), callID: callId },
      }
      pendingPermissions.set(id, { request, resolve })
      emitEvent('permission.asked', request)
      return
    }
    const request = {
      id,
      sessionID: sessionId,
      questions: [{ question: 'Pick one', header: 'Choose', options: [{ label: 'alpha', description: 'A' }, { label: 'beta', description: 'B' }] }],
      tool: { messageID: currentAssistantFor(sessionId), callID: callId },
    }
    pendingQuestions.set(id, { request, resolve })
    emitEvent('question.asked', request)
  })
}

function currentAssistantFor(sessionId) {
  const transcript = transcripts.get(sessionId) ?? []
  return transcript.at(-1)?.info?.id ?? ''
}

/** Read a buffered JSON body; a missing body is an empty object. */
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

function sendJson(response, status, value) {
  const body = value === undefined ? '' : JSON.stringify(value)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  response.end(body)
}

function providerCatalog() {
  return {
    all: [{
      id: PROVIDER_ID,
      name: 'Fake Provider',
      source: 'config',
      env: [],
      options: {},
      models: {
        [MODEL_ID]: {
          id: MODEL_ID,
          providerID: PROVIDER_ID,
          name: 'Fake Model',
          capabilities: { reasoning: true },
          limit: { context: 128000, output: 8192 },
        },
        'fake-model-2': {
          id: 'fake-model-2',
          providerID: PROVIDER_ID,
          name: 'Fake Model Two',
          capabilities: { reasoning: false },
          limit: { context: 64000, output: 4096 },
        },
      },
    }],
    connected: [PROVIDER_ID],
    default: { [PROVIDER_ID]: MODEL_ID },
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const path = url.pathname
  const method = request.method ?? 'GET'

  if (path === '/global/health') {
    sendJson(response, 200, { healthy: true, version: '1.19.5' })
    return
  }

  if (path === '/event') {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    eventClients.add(response)
    response.write(`data: ${JSON.stringify({ id: mintId('evt'), type: 'server.connected', properties: {} })}\n\n`)
    request.on('close', () => eventClients.delete(response))
    return
  }

  if (path === '/provider') {
    sendJson(response, 200, providerCatalog())
    return
  }

  if (path === '/permission') {
    sendJson(response, 200, [...pendingPermissions.values()].map((entry) => entry.request))
    return
  }

  if (path === '/session/status') {
    const payload = {}
    for (const [sessionId, status] of sessionStatus.entries()) payload[sessionId] = status
    sendJson(response, 200, payload)
    return
  }

  if (path === '/session' && method === 'GET') {
    sendJson(response, 200, [...sessions.values()])
    return
  }

  if (path === '/session' && method === 'POST') {
    const info = {
      id: mintId('ses'),
      slug: 'fake-new',
      projectID: 'global',
      directory: WORKSPACE,
      path: WORKSPACE.replace(/^\//, ''),
      title: `New session - ${new Date().toISOString()}`,
      version: '1.19.5',
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: Date.now(), updated: Date.now() },
    }
    sessions.set(info.id, info)
    transcripts.set(info.id, [])
    sendJson(response, 200, info)
    return
  }

  const sessionMatch = /^\/session\/([^/]+)$/.exec(path)
  if (sessionMatch !== null && method === 'GET') {
    const session = sessions.get(sessionMatch[1])
    if (session === undefined) {
      sendJson(response, 404, { name: 'NotFound', message: 'session not found' })
      return
    }
    sendJson(response, 200, session)
    return
  }

  const messagesMatch = /^\/session\/([^/]+)\/message$/.exec(path)
  if (messagesMatch !== null && method === 'GET') {
    sendJson(response, 200, transcripts.get(messagesMatch[1]) ?? [])
    return
  }

  const promptMatch = /^\/session\/([^/]+)\/prompt_async$/.exec(path)
  if (promptMatch !== null && method === 'POST') {
    const sessionId = promptMatch[1]
    const body = await readBody(request)
    const text = Array.isArray(body.parts)
      ? body.parts.filter((part) => part?.type === 'text').map((part) => part.text).join('\n')
      : ''
    if (exitOnPrompt) {
      sendJson(response, 204)
      setTimeout(() => process.exit(3), 30)
      return
    }
    // 204 with no body is the real contract: the turn streams over /event.
    response.writeHead(204)
    response.end()
    void enqueueTurn(sessionId, () => runTurn(sessionId, text, body.model))
    return
  }

  const abortMatch = /^\/session\/([^/]+)\/abort$/.exec(path)
  if (abortMatch !== null && method === 'POST') {
    const sessionId = abortMatch[1]
    emitEvent('session.error', { sessionID: sessionId, error: { name: 'MessageAbortedError', data: { message: 'Aborted' } } })
    setStatus(sessionId, undefined)
    sendJson(response, 200, true)
    return
  }

  const modelMatch = /^\/api\/session\/([^/]+)\/model$/.exec(path)
  if (modelMatch !== null && method === 'POST') {
    const body = await readBody(request)
    const session = sessions.get(modelMatch[1])
    if (session === undefined) {
      sendJson(response, 404, { name: 'NotFound', message: 'session not found' })
      return
    }
    if (body.model?.id === undefined || body.model?.providerID === undefined) {
      sendJson(response, 400, { name: 'BadRequest', message: 'model is required' })
      return
    }
    session.model = { id: body.model.id, providerID: body.model.providerID }
    sendJson(response, 204, undefined)
    emitEvent('session.updated', { sessionID: session.id, info: { ...session, model: session.model } })
    return
  }

  const permissionV2ReplyMatch = /^\/api\/session\/([^/]+)\/permission\/([^/]+)\/reply$/.exec(path)
  if (permissionV2ReplyMatch !== null && method === 'POST') {
    const body = await readBody(request)
    const pending = pendingPermissions.get(permissionV2ReplyMatch[2])
    if (pending === undefined) {
      sendJson(response, 404, { name: 'NotFound', message: 'permission request not found' })
      return
    }
    pendingPermissions.delete(permissionV2ReplyMatch[2])
    pending.resolve(body.reply ?? 'once')
    sendJson(response, 204, undefined)
    return
  }

  const permissionReplyMatch = /^\/permission\/([^/]+)\/reply$/.exec(path)
  if (permissionReplyMatch !== null && method === 'POST') {
    const body = await readBody(request)
    const pending = pendingPermissions.get(permissionReplyMatch[1])
    if (pending === undefined) {
      sendJson(response, 404, { name: 'NotFound', message: 'permission request not found' })
      return
    }
    pendingPermissions.delete(permissionReplyMatch[1])
    pending.resolve(body.reply ?? 'once')
    sendJson(response, 200, true)
    return
  }

  const questionReplyMatch = /^\/question\/([^/]+)\/reply$/.exec(path)
  if (questionReplyMatch !== null && method === 'POST') {
    const body = await readBody(request)
    const pending = pendingQuestions.get(questionReplyMatch[1])
    if (pending === undefined) {
      sendJson(response, 404, { name: 'NotFound', message: 'question request not found' })
      return
    }
    pendingQuestions.delete(questionReplyMatch[1])
    pending.resolve(body.answers ?? [])
    sendJson(response, 200, true)
    return
  }

  const questionRejectMatch = /^\/question\/([^/]+)\/reject$/.exec(path)
  if (questionRejectMatch !== null && method === 'POST') {
    const pending = pendingQuestions.get(questionRejectMatch[1])
    if (pending === undefined) {
      sendJson(response, 404, { name: 'NotFound', message: 'question request not found' })
      return
    }
    pendingQuestions.delete(questionRejectMatch[1])
    pending.resolve([])
    sendJson(response, 200, true)
    return
  }

  sendJson(response, 404, { name: 'NotFound', message: `no route for ${method} ${path}` })
})

if (process.env.FAKE_OPENCODE_NO_LISTEN === '1') {
  log('fake opencode: refusing to listen')
  process.exit(2)
}

server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  // The real binary prints this exact line (after an optional unsecured-server
  // warning on the same stream); the adapter parses it to find the server.
  log(`opencode server listening on http://127.0.0.1:${address.port}`)
})

// Real OpenCode ignores stdin EOF and SIGTERM; the fixture does too so dispose
// has to escalate to SIGKILL in tests exactly like against the real CLI.
process.on('SIGTERM', () => {})
process.stdin.resume()
process.stdin.on('data', () => {})
process.stdin.on('end', () => {})
