/**
 * The OpenCode 2.x transport and generation auto-detection.
 *
 * Everything here runs against `fixtures/fake-opencode-v2.mjs` (a replayed
 * 2.2.6 wire contract) and `fixtures/fake-opencode.mjs` (the existing 1.x fake),
 * so no test spawns the real CLI or touches the network. The important
 * assertions are the *wire shapes* the real server rejects when wrong (`{text}`
 * prompts, `model.id`, `{decision}` replies) and the generation split, because a
 * regression there silently breaks the user's other install.
 */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  OpencodeAttachment,
  createOpencodeSession,
  queryOpencodeModels,
} from '../src/backends/opencode/attachment.js'
import { OpencodeServer, parseServerUrl } from '../src/backends/opencode/launcher.js'
import {
  OpencodeV2Client,
  messagesFromV2Entries,
  modelsFromV2Catalog,
  usageFromV2Tokens,
} from '../src/backends/opencode/v2-transport.js'
import { opencodeDatabasePath } from '../src/backends/opencode/session-store.js'
import { opencodeEngine } from '../src/backends/opencode/index.js'

const fakeV2 = new URL('./fixtures/fake-opencode-v2.mjs', import.meta.url).pathname
const fakeV1 = new URL('./fixtures/fake-opencode.mjs', import.meta.url).pathname

const V2_SESSION = 'ses_v2fake00000000000000000001'
const V1_SESSION = 'ses_fake000000000000000000000'

/** Secrets are per-server, so tests never depend on a shared one. */
const SECRET = 'test-secret-0123456789abcdef'

function envWith(extra = {}) {
  return { ...process.env, OPENCODE_PASSWORD: SECRET, ...extra }
}

function v2Server(extra = {}) {
  return new OpencodeServer({
    cwd: tmpdir(),
    env: envWith(),
    resolved: { command: fakeV2, prefixArgs: [] },
    readyTimeoutMs: 10_000,
    requestTimeoutMs: 10_000,
    ...extra,
  })
}

/**
 * Build a v2 client over its own server, started for one session.
 *
 * Cleanup is registered on the test so a failed assertion cannot leave an
 * `opencode serve` child behind: a leaked child keeps the test runner alive.
 */
async function v2Client(t, extra = {}) {
  const server = extra.server ?? v2Server(extra.serverOptions ?? {})
  await server.start()
  const client = new OpencodeV2Client({
    sessionId: V2_SESSION,
    server,
    autoApprove: true,
    ...extra.clientOptions,
  })
  t.after(async () => {
    await client.dispose()
    await server.stop()
  })
  await client.start()
  return { client, server }
}

/** An attachment over a fake, with every record retained for later assertions. */
function attachment(binPath, env = {}) {
  const bridge = new OpencodeAttachment({
    sessionId: binPath === fakeV2 ? V2_SESSION : V1_SESSION,
    cwd: tmpdir(),
    env: { ...process.env, ...env },
    config: { binPath, autoApprove: true },
  })
  bridge.records = []
  bridge.on('event', (record) => bridge.records.push(record))
  return bridge
}

async function waitForRecord(bridge, from, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = bridge.records.slice(from).find(predicate)
    if (found !== undefined) return found
    if (Date.now() > deadline) throw new Error('timed out waiting for an event')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const waitForStatus = (bridge, status, from, timeoutMs) => waitForRecord(
  bridge,
  from,
  (record) => record.type === 'session-status' && record.status === status,
  timeoutMs,
)

test('parses both generations of the listening banner', () => {
  // 2.x, verified live on 2.2.6: no `opencode ` prefix.
  assert.equal(parseServerUrl('server listening on http://127.0.0.1:41999\n'), 'http://127.0.0.1:41999')
  // 1.x, verified live on 1.19.5, including the warning banner before it.
  assert.equal(
    parseServerUrl('Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.\nopencode server listening on http://127.0.0.1:40053\n'),
    'http://127.0.0.1:40053',
  )
  assert.equal(parseServerUrl('opencode server listening on http://127.0.0.1:1234.'), 'http://127.0.0.1:1234')
  assert.equal(parseServerUrl('server listening on http://[::1]:8080\n'), 'http://[::1]:8080')
  assert.equal(parseServerUrl('nothing here'), undefined)
  assert.equal(parseServerUrl(undefined), undefined)
})

test('detects the 2.x generation and sends Basic auth on every route', async () => {
  const server = v2Server()
  await server.start()
  assert.equal(await server.detectGeneration(), 'v2')
  // The probe is authenticated; an unauthenticated request must be rejected by
  // the fixture exactly like the real server does.
  const unauthenticated = await fetch(`${server.baseUrl}/api/session`)
  assert.equal(unauthenticated.status, 401)
  const authorized = await fetch(`${server.baseUrl}/api/session`, {
    headers: { authorization: server.authorization },
  })
  assert.equal(authorized.status, 200)
  assert.equal(server.authorization.startsWith('Basic '), true)
  const decoded = Buffer.from(server.authorization.slice(6), 'base64').toString()
  // The credential the server demands is the one this process minted, not the
  // one inherited from the environment: `childEnv()` overwrites it.
  assert.equal(decoded, `opencode:${server.password}`)
  assert.notEqual(server.password, SECRET)
  await server.stop()
})

test('never forwards an inherited server password to the child', async () => {
  // 1.x only reads OPENCODE_SERVER_PASSWORD; inheriting one would make it demand
  // a secret this process never learns. 2.x reads OPENCODE_PASSWORD, which the
  // server mints itself.
  const server = v2Server({ env: { ...process.env, OPENCODE_SERVER_PASSWORD: 'inherited', OPENCODE_PASSWORD: 'stale' } })
  const env = server.childEnv()
  assert.equal(env.OPENCODE_SERVER_PASSWORD, undefined)
  assert.equal(env.OPENCODE_PASSWORD, server.password)
  assert.notEqual(env.OPENCODE_PASSWORD, 'stale')
})

test('creates, reads, lists and paginates sessions through the 2.x API', async (t) => {
  const { client } = await v2Client(t)
  const created = await client.createSession({ title: 'dsh v2 test' })
  assert.match(created.id, /^ses_/)
  assert.equal(created.title, 'dsh v2 test')
  // The workspace is bound from the server's cwd and reported under location.
  assert.equal(created.location.directory, tmpdir())

  const read = await client.getSession(created.id)
  assert.equal(read.id, created.id)

  // Walk the cursor until the server stops offering one, which is how the real
  // endpoint ends pagination (`cursor.next: null`). Every page is one session
  // here because that is the page size the fixture is asked for.
  const seen = []
  let cursor
  for (let page = 0; page < 10; page += 1) {
    const result = await client.listSessions({ limit: 1, ...(cursor === undefined ? {} : { cursor }) })
    assert.equal(result.sessions.length, 1)
    seen.push(result.sessions[0].id)
    if (result.cursor.next === null) break
    assert.equal(typeof result.cursor.next, 'string')
    cursor = result.cursor.next
  }
  // The walk must visit every session exactly once: the two the fixture starts
  // with plus the one just created.
  assert.equal(new Set(seen).size, seen.length)
  assert.equal(seen.length, 3)
  assert.ok(seen.includes(created.id))
})

test('posts the 2.x prompt body and streams a turn to a settle', async (t) => {
  const { client } = await v2Client(t)
  const records = []
  client.on('event', (record) => records.push(record))
  const posted = await client.prompt(V2_SESSION, 'hello')
  assert.equal(posted.type, 'user')
  assert.equal(posted.payload.text, 'hello')

  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (records.some((record) => record.type === 'session-status' && record.status === 'idle')) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const types = records.map((record) => record.type)
  // The turn is: agent-start → message-start → updates → tool events →
  // message-end → agent-end/agent-settled. A missing agent-start leaves the
  // browser's turn clock stopped; a missing settle leaves it running forever.
  assert.equal(types.indexOf('message-end'), 0)
  assert.equal(types.indexOf('session-status'), 1)
  assert.ok(types.includes('message-start'))
  assert.ok(types.includes('message-update'))
  assert.ok(types.indexOf('tool-start') < types.indexOf('tool-end'))
  assert.equal(types.at(-1), 'session-status')
  assert.equal(records.at(-1).aborted, false)
  assert.equal(client.getState().isStreaming, false)

  const finalMessage = records.filter((record) => record.type === 'message-end').at(-1).message
  // Blocks keep arrival order: the step reasons, calls its tool, then answers.
  // Appending tools last would put the tool row below the text it produced.
  assert.deepEqual(finalMessage.content.map((block) => block.type), ['thinking', 'toolCall', 'text'])
  assert.equal(finalMessage.content[2].text, 'echo: hello')
  // 2.x names its shell tool `shell`; the bridge's row vocabulary wants `bash`.
  assert.equal(finalMessage.content[1].name, 'bash')
  assert.equal(finalMessage.usage.input, 12)
  assert.equal(finalMessage.usage.cacheRead, 30)
})

test('reports a streaming turn through getState and settles it on abort', async (t) => {
  const { client } = await v2Client(t, {
    serverOptions: { env: envWith({ FAKE_OPENCODE_V2_INTERRUPT: '1' }) },
  })
  const records = []
  client.on('event', (record) => records.push(record))
  await client.prompt(V2_SESSION, 'wait for it')
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline && client.getState().isStreaming !== true) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(client.getState().isStreaming, true)
  const interrupted = await client.interrupt()
  assert.equal(interrupted.interrupted, true)
  while (Date.now() < deadline && client.getState().isStreaming !== false) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(client.getState().isStreaming, false)
  const settled = records.filter((record) => record.type === 'session-status').at(-1)
  assert.equal(settled.aborted, true)
})

test('switches the model with the verified field name', async (t) => {
  const { client } = await v2Client(t)
  // `model.modelID` is rejected by 2.2.6 with Missing key at ["model"]["id"];
  // posting the wrong shape against the fixture fails the same way.
  const selection = await client.setModel(V2_SESSION, { providerID: 'fake-v2-provider', id: 'fake-v2-model-2' })
  assert.deepEqual(selection, { provider: 'fake-v2-provider', id: 'fake-v2-model-2' })
  // `getSession` unwraps the `{data}` envelope, so the row itself is the model.
  const info = await client.getSession(V2_SESSION)
  assert.deepEqual(info.model, { id: 'fake-v2-model-2', providerID: 'fake-v2-provider' })
})

test('answers a permission request through the session-scoped route', async (t) => {
  const { client } = await v2Client(t, {
    serverOptions: { env: envWith({ FAKE_OPENCODE_V2_PERMISSION: 'ask' }) },
  })
  const records = []
  client.on('event', (record) => records.push(record))
  await client.prompt(V2_SESSION, 'needs approval')
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (records.some((record) => record.type === 'session-status' && record.status === 'idle')) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  // Auto-approve answered `{decision:'once'}`; the turn ran past the tool and
  // settled instead of blocking on an unanswered prompt.
  assert.equal(client.getState().isStreaming, false)
  assert.ok(records.some((record) => record.type === 'tool-end'))
})

test('forwards a permission dialog and replies with a decision', async (t) => {
  const { client } = await v2Client(t, {
    serverOptions: { env: envWith({ FAKE_OPENCODE_V2_PERMISSION: 'ask' }) },
    clientOptions: { autoApprove: false },
  })
  const dialog = once(client, 'ui-request')
  await client.prompt(V2_SESSION, 'needs approval')
  const [request] = await dialog
  assert.equal(request.type, 'extension_ui_request')
  assert.equal(request.method, 'confirm')
  // The 2.x permissions name `action`/`resources`, not 1.x's
  // `permission`/`patterns`, so the shared shaper has to read both.
  assert.match(request.title, /shell/)
  assert.equal(request.message, 'echo hi')
  const records = []
  client.on('event', (record) => records.push(record))
  await client.respondUi(request.id, { confirmed: true })
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (records.some((record) => record.type === 'session-status' && record.status === 'idle')) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.ok(records.some((record) => record.type === 'tool-end'))
})

test('ends a tool with isError when the server reports a failure', async (t) => {
  const { client } = await v2Client(t, {
    serverOptions: { env: envWith({ FAKE_OPENCODE_V2_TOOL_FAILURE: '1' }) },
  })
  const records = []
  client.on('event', (record) => records.push(record))
  await client.prompt(V2_SESSION, 'it will fail')
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (records.some((record) => record.type === 'session-status' && record.status === 'idle')) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const toolEnd = records.find((record) => record.type === 'tool-end')
  assert.equal(toolEnd.isError, true)
  assert.equal(toolEnd.result, 'boom')
})

test('normalizes 2.x message entries into Pi blocks', () => {
  const transcript = messagesFromV2Entries([
    { id: 'msg_a', type: 'user', text: 'hi', time: { created: 1000 } },
    {
      id: 'msg_b',
      type: 'assistant',
      time: { created: 1100, completed: 1200 },
      model: { id: 'm1', providerID: 'p1' },
      tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 4, write: 0 } },
      content: [
        { type: 'text', text: 'answer' },
        { type: 'reasoning', text: 'because' },
        {
          type: 'tool',
          id: 'call_1',
          name: 'read',
          executed: true,
          state: { status: 'completed', input: { filePath: '/tmp/x' }, content: [{ type: 'text', text: 'file body' }] },
        },
      ],
    },
    { id: 'msg_c', type: 'idle', outcome: 'succeeded', time: { created: 1300 } },
    { id: 'msg_d', type: 'model-switched', model: { id: 'm2', providerID: 'p2' }, time: { created: 1400 } },
  ])
  assert.deepEqual(transcript.messages[0], { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1000 })
  const assistant = transcript.messages[1]
  assert.deepEqual(assistant.content.map((block) => block.type), ['text', 'thinking', 'toolCall'])
  assert.equal(assistant.content[1].thinking, 'because')
  // `filePath` is mirrored onto `path` for the browser's file-row summary.
  assert.deepEqual(assistant.content[2].arguments, { filePath: '/tmp/x', path: '/tmp/x' })
  assert.equal(assistant.content[2].name, 'read')
  assert.deepEqual(assistant.usage, { input: 10, output: 2, cacheRead: 4, cacheWrite: 0, reasoning: 1 })
  assert.equal(assistant.stopReason, 'stop')
  // The tool row and the toolResult the browser folds into it both exist.
  const result = transcript.messages[2]
  assert.equal(result.role, 'toolResult')
  assert.equal(result.content[0].text, 'file body')
  assert.equal(result.isError, false)
  assert.deepEqual(transcript.tools, [{
    id: 'call_1',
    name: 'read',
    arguments: { filePath: '/tmp/x', path: '/tmp/x' },
    status: 'completed',
  }])
  // Harness rows (idle/model-switched) are not conversation content, but a
  // model switch still updates the reported model.
  assert.equal(transcript.messages.length, 3)
  assert.deepEqual(transcript.model, { provider: 'p2', id: 'm2' })
})

test('normalizes a failed 2.x tool block into an error result', () => {
  const transcript = messagesFromV2Entries([{
    id: 'msg_e',
    type: 'assistant',
    time: { created: 1 },
    content: [{ type: 'tool', id: 'call_2', name: 'edit', state: { status: 'error', input: {}, error: { type: 'FileError', message: 'nope' } } }],
  }])
  const assistant = transcript.messages[0]
  assert.equal(assistant.content[0].name, 'edit')
  assert.equal(assistant.content[0].arguments.path, undefined)
  assert.equal(transcript.messages[1].isError, true)
  assert.equal(transcript.messages[1].content[0].text, 'FileError: nope')
  assert.equal(transcript.tools[0].status, 'error')
})

test('shapes the 2.x catalog like the 1.x one and skips disabled models', () => {
  const models = modelsFromV2Catalog({
    data: [
      {
        id: 'm1',
        modelID: 'm1',
        providerID: 'p1',
        name: 'One',
        variants: [{ id: 'none' }, { id: 'high' }],
        enabled: true,
        limit: { context: 128000 },
      },
      { id: 'm2', modelID: 'm2', providerID: 'p1', name: '', variants: [], enabled: true, limit: { context: 1000 } },
      { id: 'off', modelID: 'off', providerID: 'p1', name: 'Off', variants: [], enabled: false, limit: { context: 10 } },
    ],
  })
  assert.deepEqual(models, [
    { id: 'm1', provider: 'p1', name: 'One', contextWindow: 128000, reasoning: true },
    // A nameless model falls back to its id, and no variants means no reasoning.
    { id: 'm2', provider: 'p1', name: 'm2', contextWindow: 1000, reasoning: false },
  ])
})

test('maps 2.x token usage, including cache read/write and reasoning', () => {
  assert.deepEqual(
    usageFromV2Tokens({ input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } }),
    { input: 1, output: 2, cacheRead: 4, cacheWrite: 5, reasoning: 3 },
  )
  assert.equal(usageFromV2Tokens(undefined), undefined)
  assert.deepEqual(usageFromV2Tokens({}), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
})

test('autodetects the generation: fake v2 takes the v2 path', async () => {
  const bridge = attachment(fakeV2)
  await bridge.start()
  assert.equal(bridge.generation, 'v2')
  assert.equal(bridge.transport.constructor.name, 'OpencodeV2Transport')
  const state = bridge.getState()
  assert.equal(state.sessionId, V2_SESSION)
  assert.equal(state.isStreaming, false)
  assert.equal(state.autoApprove, true)
  // Nothing has run yet, so the session has no model of its own.
  assert.deepEqual(state.model, null)
  await bridge.dispose()
  assert.equal(bridge.running, false)
})

test('autodetects the generation: fake v1 keeps the untouched 1.x path', async () => {
  const bridge = attachment(fakeV1)
  await bridge.start()
  assert.equal(bridge.generation, 'v1')
  assert.equal(bridge.transport.constructor.name, 'OpencodeV1Transport')
  // The 1.x flow the host ships today must still produce the same records.
  const from = bridge.records.length
  await bridge.prompt('hello')
  await waitForStatus(bridge, 'idle', from)
  const records = bridge.records.slice(from)
  assert.equal(records.filter((record) => record.type === 'tool-start').length, 1)
  assert.equal(records.filter((record) => record.type === 'message-end').length, 2)
  assert.equal(bridge.getState().isStreaming, false)
  await bridge.dispose()
})

test('drives a whole 2.x turn through the attachment surface', async () => {
  const bridge = attachment(fakeV2)
  await bridge.start()
  const from = bridge.records.length
  const accepted = await bridge.prompt('hello there')
  assert.deepEqual(accepted, { accepted: true })
  await waitForStatus(bridge, 'idle', from)
  const records = bridge.records.slice(from)
  const types = records.map((record) => record.type)
  assert.equal(types.filter((type) => type === 'message-start').length, 1)
  assert.equal(types.filter((type) => type === 'tool-start').length, 1)
  assert.equal(types.filter((type) => type === 'tool-update').length, 1)
  assert.equal(types.filter((type) => type === 'tool-end').length, 1)
  const finalMessage = records.filter((record) => record.type === 'message-end').at(-1).message
  assert.deepEqual(finalMessage.content.map((block) => block.type), ['thinking', 'toolCall', 'text'])
  assert.equal(finalMessage.content[2].text, 'echo: hello there')
  assert.equal(finalMessage.content[1].name, 'bash')

  const messages = await bridge.getMessages()
  assert.equal(messages.messages.filter((message) => message.role === 'user').length, 1)
  assert.equal(messages.messages.some((message) => message.role === 'toolResult'), true)
  assert.deepEqual(messages.model, { provider: 'fake-v2-provider', id: 'fake-v2-model' })

  const stats = await bridge.getSessionStats()
  assert.equal(stats.userMessages, 1)
  assert.equal(stats.assistantMessages, 1)
  assert.equal(stats.toolCalls, 1)
  assert.equal(stats.tokens.input, 12)
  assert.equal(stats.tokens.output, 5)
  assert.equal(stats.tokens.cacheRead, 30)
  assert.equal(stats.tokens.total, 47)
  // 2.x reports no used-context figure, so the dock must not be handed one.
  assert.equal(stats.contextUsage, undefined)
  await bridge.dispose()
})

test('lists the 2.x model catalog through the attachment', async () => {
  const bridge = attachment(fakeV2)
  await bridge.start()
  const models = await bridge.getAvailableModels()
  assert.deepEqual(models, [
    { id: 'fake-v2-model', provider: 'fake-v2-provider', name: 'Fake V2 Model', contextWindow: 200000, reasoning: true },
    { id: 'fake-v2-model-2', provider: 'fake-v2-provider', name: 'Fake V2 Model Two', contextWindow: 64000, reasoning: false },
  ])
  await bridge.dispose()
})

test('switches the 2.x session model through the attachment', async () => {
  const bridge = attachment(fakeV2)
  await bridge.start()
  const selection = await bridge.setModel('fake-v2-provider', 'fake-v2-model-2')
  assert.deepEqual(selection, { provider: 'fake-v2-provider', id: 'fake-v2-model-2' })
  assert.deepEqual(bridge.getState().model, { provider: 'fake-v2-provider', id: 'fake-v2-model-2' })
  await bridge.dispose()
})

test('creates a session through the 2.x route when the binary speaks v2', async () => {
  const created = await createOpencodeSession({
    cwd: tmpdir(),
    config: { binPath: fakeV2 },
    env: envWith(),
  })
  assert.match(created.id, /^ses_/)
  assert.equal(created.nativeKey, created.id)
  // 2.x names the workspace inside `location`; the summary still exposes `cwd`.
  assert.equal(created.cwd, tmpdir())
  assert.deepEqual(created.messages, [])
})

test('queries the 2.x model catalog through a short-lived server', async () => {
  const models = await queryOpencodeModels({ binPath: fakeV2 }, envWith())
  assert.equal(models.length, 2)
  assert.equal(models[0].id, 'fake-v2-model')
  assert.equal(models[0].provider, 'fake-v2-provider')
})

test('keeps the 1.x create and catalog paths working', async () => {
  const created = await createOpencodeSession({ cwd: tmpdir(), config: { binPath: fakeV1 }, env: { ...process.env } })
  assert.match(created.id, /^ses_/)
  const models = await queryOpencodeModels({ binPath: fakeV1 }, { ...process.env })
  assert.equal(models.length, 2)
  assert.equal(models[0].id, 'fake-model')
})

test('surfaces a clear 502 when the server cannot be driven', async () => {
  // A launcher that cannot spawn is the shape of a broken install; the create
  // helper must report a 502 and never leak the child.
  await assert.rejects(
    createOpencodeSession({ cwd: tmpdir(), config: { binPath: '/nonexistent/opencode-2' }, env: { ...process.env } }),
    (error) => {
      assert.equal(error.status, 502)
      assert.match(error.message, /could not create an OpenCode session/)
      return true
    },
  )
  // A fixture that refuses to listen is the same failure one step later.
  await assert.rejects(
    createOpencodeSession({
      cwd: tmpdir(),
      config: { binPath: fakeV2 },
      env: { ...process.env, FAKE_OPENCODE_V2_NO_LISTEN: '1' },
    }),
    (error) => {
      assert.equal(error.status, 502)
      assert.match(error.message, /could not create an OpenCode session/)
      return true
    },
  )
})

test('rejects pending 2.x requests when the child exits', async () => {
  const server = v2Server()
  await server.start()
  // The handler has to be attached before the kill: the rejection lands while
  // `waitForExit` is still awaiting, and an unhandled rejection is a test error.
  const pending = assert.rejects(server.request('/api/hang'), /exited/)
  server.child.kill('SIGKILL')
  await pending
  await server.stop()
})

test('dispose kills the 2.x child and aborts in-flight requests', async () => {
  const bridge = attachment(fakeV2)
  await bridge.start()
  const child = bridge.child
  const hanging = assert.rejects(bridge.transport.client.request('/api/hang'), /exited|disposed|not running/)
  await bridge.dispose()
  await hanging
  assert.equal(bridge.running, false)
  assert.equal(child.killed || child.exitCode !== null || child.signalCode !== null, true)
  await assert.rejects(bridge.getMessages(), /not running|exited|has not been started/)
})

test('settles a running 2.x turn when the child dies', async (t) => {
  const { client, server } = await v2Client(t, {
    serverOptions: { env: envWith({ FAKE_OPENCODE_V2_INTERRUPT: '1' }) },
  })
  const records = []
  client.on('event', (record) => records.push(record))
  await client.prompt(V2_SESSION, 'will be killed')
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline && client.getState().isStreaming !== true) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(client.getState().isStreaming, true)
  server.child.kill('SIGKILL')
  while (Date.now() < deadline && client.getState().isStreaming !== false) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(client.getState().isStreaming, false)
  // The exit settles the turn with `exited: true`, so the browser stops its clock.
  const settled = records.filter((record) => record.type === 'session-status').at(-1)
  assert.equal(settled.exited, true)
})

test('probe accepts a 2.x channel database name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opencode-v2-probe-'))
  await writeFile(join(root, 'opencode-beta.db'), 'x')
  // A 2.x-only install may have no plain opencode.db at all; reporting it as
  // unready would hide a perfectly usable bridge.
  const detail = opencodeEngine.probe({ sessionsRoot: root, binPath: fakeV2 }, process.env)
  assert.equal(detail.dbPath, join(root, 'opencode-beta.db'))
  await rm(root, { recursive: true, force: true })
})

test('probe prefers opencode.db over channel databases and honours OPENCODE_DB', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opencode-v2-probe-'))
  await writeFile(join(root, 'opencode.db'), 'x')
  await writeFile(join(root, 'opencode-beta.db'), 'y')
  assert.equal(opencodeDatabasePath({ sessionsRoot: root }, process.env), join(root, 'opencode.db'))

  // An explicit OPENCODE_DB wins, which is how a 2.x channel install points at
  // any filename at all (including outside the data directory).
  const other = await mkdtemp(join(tmpdir(), 'opencode-v2-db-'))
  const explicit = join(other, 'custom.db')
  await writeFile(explicit, 'z')
  assert.equal(
    opencodeDatabasePath({ sessionsRoot: root }, { ...process.env, OPENCODE_DB: explicit }),
    explicit,
  )
  // `:memory:` is a valid 2.x value but never a readable file, so it must fall
  // through instead of failing the probe.
  assert.equal(
    opencodeDatabasePath({ sessionsRoot: root }, { ...process.env, OPENCODE_DB: ':memory:' }),
    join(root, 'opencode.db'),
  )
  await rm(root, { recursive: true, force: true })
  await rm(other, { recursive: true, force: true })
})

test('probe reports the plain path when no database exists at all', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opencode-v2-probe-'))
  await mkdir(join(root, 'empty'), { recursive: true })
  // The error must name the conventional file, not a channel guess.
  assert.throws(
    () => opencodeEngine.probe({ sessionsRoot: root, binPath: fakeV2 }, process.env),
    /OpenCode database was not found/,
  )
  await rm(root, { recursive: true, force: true })
})

test('a 2.x binary that never announces its URL fails the start', async () => {
  const server = v2Server({ env: envWith({ FAKE_OPENCODE_V2_NO_LISTEN: '1' }), readyTimeoutMs: 5000 })
  await assert.rejects(server.start(), /exited before it was ready|did not report a listening URL/)
  await server.stop()
})

test('a 2.x child that dies mid-turn settles the turn and reports the exit', async (t) => {
  const { client } = await v2Client(t, {
    serverOptions: { env: envWith({ FAKE_OPENCODE_V2_EXIT_ON_PROMPT: '1' }) },
  })
  const records = []
  client.on('event', (record) => records.push(record))
  let exited
  client.on('exit', (info) => {
    exited = info
  })
  // The prompt is accepted and the child dies a moment later, so the failure is
  // an exit rather than a rejected request: the turn still has to settle or the
  // browser's clock would run forever.
  await client.prompt(V2_SESSION, 'doomed')
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline && exited === undefined) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.notEqual(exited, undefined)
  assert.equal(client.getState().isStreaming, false)
  const settled = records.filter((record) => record.type === 'session-status').at(-1)
  assert.equal(settled.exited, true)
})

test('keeps tool calls in arrival order between text blocks', async (t) => {
  const { client } = await v2Client(t)
  const records = []
  client.on('event', (record) => records.push(record))
  await client.prompt(V2_SESSION, 'ordering')
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (records.some((record) => record.type === 'session-status' && record.status === 'idle')) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  // The fixture streams reasoning, then the tool, then the answer. A message that
  // appended tools last would render the tool row under prose it never produced.
  const message = records.filter((record) => record.type === 'message-end').at(-1).message
  assert.deepEqual(message.content.map((block) => block.type), ['thinking', 'toolCall', 'text'])
  // The tool row's id is the id the streamed `tool-start` announced.
  const toolStart = records.find((record) => record.type === 'tool-start')
  assert.equal(message.content[1].id, toolStart.toolCallId)
})

test('reports a failed execution to the user and settles the turn', async () => {
  const bridge = attachment(fakeV2)
  // The fixture has no execution.failed knob, so the notice path is driven
  // directly: the record is the one a provider/auth failure produces.
  await bridge.start()
  const notices = []
  bridge.transport.client.on('ui-notification', (notice) => notices.push(notice))
  const records = []
  bridge.transport.client.on('event', (record) => records.push(record))
  bridge.transport.client.streaming = true
  bridge.transport.client.streamingEmitted = true
  bridge.transport.client.handleEvent({
    type: 'session.execution.failed',
    data: { sessionID: V2_SESSION, error: { type: 'ProviderError', message: 'quota exhausted' } },
  })
  assert.equal(records.at(-1).type, 'session-status')
  assert.equal(records.at(-1).aborted, false)
  assert.equal(notices.length, 1)
  assert.match(notices[0].message, /ProviderError: quota exhausted/)
  await bridge.dispose()
})
