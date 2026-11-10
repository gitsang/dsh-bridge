import assert from 'node:assert/strict'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { opencodeEngine } from '../src/backends/opencode/index.js'
import {
  OpencodeAttachment,
  OpencodeServer,
  createOpencodeSession,
  modelsFromProviders,
  parseServerUrl,
  permissionUiRequest,
  questionUiRequest,
  queryOpencodeModels,
} from '../src/backends/opencode/attachment.js'

const fake = new URL('./fixtures/fake-opencode.mjs', import.meta.url).pathname
const SESSION_ID = 'ses_fake000000000000000000000'

/**
 * Build one attachment wired to the fixture server instead of the real CLI.
 *
 * The fixture's turn can finish before a test attaches its own listener, so
 * every emitted record is retained on the attachment from construction and the
 * tests wait on that history instead of racing the live stream.
 */
function attachment(extra = {}) {
  const { config, env, ...rest } = extra
  const bridge = new OpencodeAttachment({
    sessionId: SESSION_ID,
    cwd: tmpdir(),
    env: { ...process.env, ...(env ?? {}) },
    ...rest,
    config: { binPath: fake, autoApprove: true, ...(config ?? {}) },
  })
  bridge.records = []
  bridge.on('event', (record) => bridge.records.push(record))
  return bridge
}

const isStatus = (record, status) => record?.type === 'session-status' && record.status === status

/** Wait for a record matching `predicate` that appears after `from`. */
async function waitForRecord(bridge, from, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = bridge.records.slice(from).find(predicate)
    if (found !== undefined) return found
    if (Date.now() > deadline) throw new Error('timed out waiting for an event')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** Wait for the next session-status of the given kind after `from`. */
function waitForStatus(bridge, status, from = bridge.records.length, timeoutMs) {
  return waitForRecord(bridge, from, (record) => isStatus(record, status), timeoutMs)
}

test('parses the listening line from the CLI banner', () => {
  assert.equal(
    parseServerUrl('Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.\nopencode server listening on http://127.0.0.1:40053\n'),
    'http://127.0.0.1:40053',
  )
  assert.equal(parseServerUrl('opencode server listening on http://127.0.0.1:1234.'), 'http://127.0.0.1:1234')
  assert.equal(parseServerUrl('nothing here'), undefined)
  assert.equal(parseServerUrl(undefined), undefined)
})

test('starts the server and reconciles state', async () => {
  const bridge = attachment()
  await bridge.start()
  assert.match(bridge.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.equal(bridge.running, true)
  assert.equal(bridge.pid, bridge.child.pid)
  const state = await bridge.snapshot()
  assert.equal(state.sessionId, SESSION_ID)
  assert.equal(state.isStreaming, false)
  assert.equal(state.pid, bridge.pid)
  assert.equal(state.autoApprove, true)
  await bridge.dispose()
  assert.equal(bridge.running, false)
})

test('prompts, streams the turn, and settles in order', async () => {
  const bridge = attachment()
  await bridge.start()
  const from = bridge.records.length
  const settled = waitForStatus(bridge, 'idle', from)
  const accepted = await bridge.prompt('hello')
  assert.deepEqual(accepted, { accepted: true })
  await settled
  const records = bridge.records.slice(from)
  const types = records.map((record) => record.type)
  // The user message ends before the turn starts; the assistant message is
  // bracketed by exactly one start and one end; the tool expands once.
  assert.ok(types.indexOf('message-end') < types.indexOf('session-status'))
  assert.equal(types.filter((type) => type === 'message-start').length, 1)
  assert.equal(types.filter((type) => type === 'message-end').length, 2)
  assert.equal(types.filter((type) => type === 'tool-start').length, 1)
  assert.equal(types.filter((type) => type === 'tool-update').length, 1)
  assert.equal(types.filter((type) => type === 'tool-end').length, 1)
  assert.equal(types.at(-1), 'session-status')
  // The assistant message carries reasoning, text and the tool call.
  const finalMessage = records.filter((record) => record.type === 'message-end').at(-1).message
  assert.equal(finalMessage.role, 'assistant')
  assert.deepEqual(finalMessage.content.map((block) => block.type), ['thinking', 'text', 'toolCall'])
  assert.equal(finalMessage.content[1].text, 'echo: hello')
  assert.equal(finalMessage.content[2].name, 'bash')
  const toolStart = records.find((record) => record.type === 'tool-start')
  assert.equal(toolStart.toolCallId, finalMessage.content[2].id)
  const toolEnd = records.find((record) => record.type === 'tool-end')
  assert.equal(toolEnd.isError, false)
  await bridge.dispose()
})

test('keeps the state busy while a turn runs', async () => {
  const bridge = attachment()
  await bridge.start()
  const from = bridge.records.length
  const busy = waitForStatus(bridge, 'busy', from)
  await bridge.prompt('slow please')
  await busy
  assert.equal(bridge.getState().isStreaming, true)
  await waitForStatus(bridge, 'idle', from)
  assert.equal(bridge.getState().isStreaming, false)
  await bridge.dispose()
})

test('steers a running turn with the same endpoint', async () => {
  const bridge = attachment()
  await bridge.start()
  const from = bridge.records.length
  const busy = waitForStatus(bridge, 'busy', from)
  const idle = waitForStatus(bridge, 'idle', from)
  await bridge.prompt('first')
  await busy
  const steered = await bridge.steer('second')
  assert.deepEqual(steered, { accepted: true, queued: true })
  await idle
  // Both prompts reach the transcript as separate user messages.
  const messages = await bridge.getMessages()
  const userTexts = messages.messages.filter((message) => message.role === 'user').map((message) => message.content[0].text)
  assert.deepEqual(userTexts, ['first', 'second'])
  assert.ok(bridge.records.length > from)
  await bridge.dispose()
})

test('aborts a running turn and settles it as aborted', async () => {
  const bridge = attachment()
  await bridge.start()
  const from = bridge.records.length
  const busy = waitForStatus(bridge, 'busy', from)
  await bridge.prompt('count to a million')
  await busy
  const settledTurn = waitForStatus(bridge, 'idle', from)
  const result = await bridge.abort()
  assert.deepEqual(result, { aborted: true })
  const settled = await settledTurn
  assert.equal(settled.aborted, true)
  await bridge.dispose()
})

test('auto-approves permission prompts without a dialog', async () => {
  const bridge = attachment({ env: { ...process.env, FAKE_OPENCODE_PERMISSION: 'ask' } })
  await bridge.start()
  const dialogs = []
  bridge.on('ui-request', (request) => dialogs.push(request))
  const from = bridge.records.length
  await bridge.prompt('needs approval')
  await waitForStatus(bridge, 'idle', from)
  assert.deepEqual(dialogs, [])
  // The turn completed: the tool ran after the auto-approved permission.
  const messages = await bridge.getMessages()
  assert.equal(messages.messages.some((message) => message.role === 'toolResult'), true)
  await bridge.dispose()
})

test('forwards permission prompts and replies to the verified endpoint', async () => {
  const bridge = attachment({
    env: { ...process.env, FAKE_OPENCODE_PERMISSION: 'ask' },
    config: { autoApprove: false },
  })
  await bridge.start()
  const dialog = once(bridge, 'ui-request')
  await bridge.prompt('needs approval')
  const [request] = await dialog
  assert.equal(request.method, 'confirm')
  assert.equal(request.type, 'extension_ui_request')
  assert.match(request.title, /bash/)
  assert.equal(request.message, 'echo hi')
  const from = bridge.records.length
  await bridge.respondUi(request.id, { confirmed: true })
  await waitForStatus(bridge, 'idle', from)
  await bridge.dispose()
})

test('auto-approves the v2 permission event family through its reply route', async () => {
  const bridge = attachment({ env: { ...process.env, FAKE_OPENCODE_PERMISSION: 'v2-ask' } })
  await bridge.start()
  const dialogs = []
  bridge.on('ui-request', (request) => dialogs.push(request))
  const from = bridge.records.length
  await bridge.prompt('needs v2 approval')
  await waitForStatus(bridge, 'idle', from)
  assert.deepEqual(dialogs, [])
  await bridge.dispose()
})

test('forwards the v2 permission dialog and answers through the session route', async () => {
  const bridge = attachment({
    env: { ...process.env, FAKE_OPENCODE_PERMISSION: 'v2-ask' },
    config: { autoApprove: false },
  })
  await bridge.start()
  const dialog = once(bridge, 'ui-request')
  await bridge.prompt('needs v2 approval')
  const [request] = await dialog
  assert.equal(request.method, 'confirm')
  assert.equal(request.message, 'echo hi')
  const from = bridge.records.length
  await bridge.respondUi(request.id, { confirmed: true })
  await waitForStatus(bridge, 'idle', from)
  await bridge.dispose()
})

test('forwards questions and rejects them when cancelled', async () => {
  const bridge = attachment({
    env: { ...process.env, FAKE_OPENCODE_PERMISSION: 'question' },
    config: { autoApprove: false },
  })
  await bridge.start()
  const dialog = once(bridge, 'ui-request')
  await bridge.prompt('needs an answer')
  const [request] = await dialog
  assert.equal(request.method, 'select')
  assert.deepEqual(request.options, ['alpha', 'beta'])
  const from = bridge.records.length
  await bridge.respondUi(request.id, { cancelled: true })
  await waitForStatus(bridge, 'idle', from)
  await bridge.dispose()
})

test('rejects unknown dialogs', async () => {
  const bridge = attachment()
  await bridge.start()
  await assert.rejects(bridge.respondUi('nope', { confirmed: true }), /unknown extension UI request/)
  await bridge.dispose()
})

test('auto-answers interactive questions when approval is on', async () => {
  const bridge = attachment({ env: { ...process.env, FAKE_OPENCODE_PERMISSION: 'question' } })
  await bridge.start()
  const dialogs = []
  bridge.on('ui-request', (request) => dialogs.push(request))
  const from = bridge.records.length
  await bridge.prompt('needs an answer')
  await waitForStatus(bridge, 'idle', from)
  assert.deepEqual(dialogs, [])
  await bridge.dispose()
})

test('reports statistics folded from the transcript', async () => {
  const bridge = attachment()
  await bridge.start()
  const from = bridge.records.length
  await bridge.prompt('stats please')
  await waitForStatus(bridge, 'idle', from)
  const stats = await bridge.getSessionStats()
  assert.equal(stats.userMessages, 1)
  assert.equal(stats.assistantMessages, 1)
  assert.equal(stats.toolCalls, 1)
  assert.equal(stats.tokens.input, 12)
  assert.equal(stats.tokens.output, 5)
  await bridge.dispose()
})

test('lists the connected model catalog', async () => {
  const bridge = attachment()
  await bridge.start()
  const models = await bridge.getAvailableModels()
  assert.deepEqual(models, [
    { id: 'fake-model', provider: 'fake-provider', name: 'Fake Model', contextWindow: 128000, reasoning: true },
    { id: 'fake-model-2', provider: 'fake-provider', name: 'Fake Model Two', contextWindow: 64000, reasoning: false },
  ])
  await bridge.dispose()
})

test('switches the model through the verified endpoint', async () => {
  const bridge = attachment()
  await bridge.start()
  const selection = await bridge.setModel('fake-provider', 'fake-model-2')
  assert.deepEqual(selection, { provider: 'fake-provider', id: 'fake-model-2' })
  assert.deepEqual(bridge.getState().model, { provider: 'fake-provider', id: 'fake-model-2' })
  await bridge.dispose()
})

test('keeps the model when the endpoint cannot persist it', async () => {
  const bridge = attachment()
  await bridge.start()
  // A session missing from the fake server makes the endpoint answer 404, which
  // is the same failure mode 1.19.5 shows for legacy-only sessions.
  bridge.sessionId = SESSION_ID
  const notices = []
  bridge.on('ui-notification', (notice) => notices.push(notice))
  const original = bridge.server.request.bind(bridge.server)
  bridge.server.request = async (pathname, options) => {
    if (pathname.startsWith('/api/session/')) throw Object.assign(new Error('boom'), { status: 502 })
    return original(pathname, options)
  }
  const selection = await bridge.setModel('fake-provider', 'fake-model-2')
  assert.deepEqual(selection, { provider: 'fake-provider', id: 'fake-model-2' })
  assert.deepEqual(bridge.getState().model, { provider: 'fake-provider', id: 'fake-model-2' })
  assert.equal(notices.length, 1)
  await bridge.dispose()
})

test('rejects pending requests when the child exits', async () => {
  const bridge = attachment()
  await bridge.start()
  const pending = bridge.server.request('/session/status')
  bridge.child.kill('SIGKILL')
  await assert.rejects(pending, /exited/)
  await assert.rejects(bridge.prompt('after exit'), /not running|exited/)
  await bridge.dispose()
})

test('dispose kills the child and aborts in-flight requests', async () => {
  const bridge = attachment()
  await bridge.start()
  const child = bridge.child
  await bridge.dispose()
  assert.equal(bridge.running, false)
  assert.equal(child.killed || child.exitCode !== null || child.signalCode !== null, true)
  // A request after dispose fails instead of hanging on a dead server.
  await assert.rejects(bridge.getMessages(), /not running|exited/)
})

test('reports a server that never announces its URL', async () => {
  const server = new OpencodeServer({
    cwd: tmpdir(),
    env: { ...process.env, FAKE_OPENCODE_NO_LISTEN: '1' },
    resolved: { command: fake, prefixArgs: [] },
    readyTimeoutMs: 5000,
  })
  await assert.rejects(server.start(), /exited before it was ready|did not report a listening URL/)
  await server.stop()
})

test('creates a session through a short-lived server', async () => {
  const created = await createOpencodeSession({
    cwd: tmpdir(),
    config: { binPath: fake },
    env: { ...process.env },
  })
  assert.match(created.id, /^ses_/)
  assert.equal(created.nativeKey, created.id)
  assert.equal(created.cwd, tmpdir())
  assert.deepEqual(created.messages, [])
})

test('queries the model catalog through a short-lived server', async () => {
  const models = await queryOpencodeModels({ binPath: fake }, { ...process.env })
  assert.equal(models.length, 2)
  assert.equal(models[0].id, 'fake-model')
})

test('maps provider payloads and skips unconnected providers', () => {
  const models = modelsFromProviders({
    all: [
      {
        id: 'connected',
        name: 'Connected',
        models: {
          m1: { id: 'm1', providerID: 'connected', name: 'One', limit: { context: 1000 }, capabilities: { reasoning: true } },
        },
      },
      { id: 'offline', name: 'Offline', models: { m2: { id: 'm2', providerID: 'offline' } } },
    ],
    connected: ['connected'],
  })
  assert.deepEqual(models, [{ id: 'm1', provider: 'connected', name: 'One', contextWindow: 1000, reasoning: true }])
  // Without a `connected` list the whole catalog is used, like the raw endpoint.
  assert.equal(modelsFromProviders({ all: [{ id: 'p', models: { a: { id: 'a' } } }] }).length, 1)
})

test('shapes permission and question dialogs like Pi extension requests', () => {
  const permission = permissionUiRequest({
    id: 'per_1',
    sessionID: 'ses_1',
    permission: 'bash',
    patterns: ['echo hi'],
    metadata: { command: 'echo hi' },
  })
  assert.equal(permission.type, 'extension_ui_request')
  assert.equal(permission.id, 'per_1')
  assert.equal(permission.method, 'confirm')
  assert.equal(permission.message, 'echo hi')

  const question = questionUiRequest({
    id: 'que_1',
    sessionID: 'ses_1',
    questions: [{ header: 'Pick', question: 'Which one?', options: [{ label: 'a' }, { label: 'b' }] }],
  })
  assert.equal(question.method, 'select')
  assert.equal(question.title, 'Pick')
  assert.equal(question.message, 'Which one?')
  assert.deepEqual(question.options, ['a', 'b'])
})

test('engine maps native records onto the neutral event vocabulary', () => {
  assert.deepEqual(opencodeEngine.normalizeEvent({ type: 'session-status', status: 'busy' }), { type: 'agent-start' })
  assert.deepEqual(
    opencodeEngine.normalizeEvent({ type: 'session-status', status: 'idle', aborted: true }),
    [{ type: 'agent-end' }, { type: 'agent-settled', aborted: true }],
  )
  assert.equal(opencodeEngine.normalizeEvent({ type: 'session-status', status: 'retry' }), null)
  assert.deepEqual(opencodeEngine.normalizeEvent({ type: 'session-name', name: 'Demo' }), { type: 'session-name', name: 'Demo' })
  assert.deepEqual(
    opencodeEngine.normalizeEvent({ type: 'tool-start', toolCallId: 'call_1', name: 'glob', args: { pattern: 'x' } }),
    { type: 'tool-start', toolCallId: 'call_1', name: 'glob', arguments: { pattern: 'x' } },
  )
  const mapped = opencodeEngine.normalizeEvent({
    type: 'message-end',
    message: {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'c1', name: 'patch', arguments: {} }],
      errorMessage: 'MessageAbortedError',
    },
  })
  assert.equal(mapped.message.content[0].name, 'edit')
  assert.equal(mapped.message.stopReason, 'aborted')
  assert.equal(opencodeEngine.normalizeEvent({ type: 'future-event' }).type, 'backend-event')
  assert.equal(opencodeEngine.normalizeEvent(null), null)
})

test('engine translates OpenCode tool names into client variants', () => {
  assert.equal(opencodeEngine.normalizeEvent({ type: 'tool-start', toolCallId: 'a', name: 'bash' }).name, 'bash')
  assert.equal(opencodeEngine.normalizeEvent({ type: 'tool-start', toolCallId: 'b', name: 'webfetch' }).name, 'web_fetch')
  assert.equal(opencodeEngine.normalizeEvent({ type: 'tool-start', toolCallId: 'c', name: 'list' }).name, 'ls')
  assert.equal(opencodeEngine.normalizeEvent({ type: 'tool-start', toolCallId: 'd', name: 'todowrite' }).name, 'others')
})

test('engine declares every config key with a default', () => {
  assert.deepEqual(opencodeEngine.defaultConfig(), { sessionsRoot: null, binPath: null, autoApprove: true })
  assert.equal(opencodeEngine.defaultConfig().autoApprove, true)
  assert.deepEqual(
    opencodeEngine.configFields.map((field) => field.key),
    ['sessionsRoot', 'binPath', 'autoApprove'],
  )
  assert.deepEqual(opencodeEngine.capabilities, [
    'sessions', 'session-create', 'attach', 'stream', 'prompt', 'abort', 'models', 'permission-ui',
  ])
  assert.equal(opencodeEngine.available, true)
})

test('probe reports the launcher and database', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opencode-probe-'))
  // A probe needs a readable opencode.db; an empty file is enough for the
  // readiness check, which must never open SQLite.
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(root, 'opencode.db'), 'x')
  const detail = opencodeEngine.probe({ sessionsRoot: root, binPath: fake }, process.env)
  assert.equal(detail.dataDir, root)
  assert.equal(detail.dbPath, join(root, 'opencode.db'))
  assert.equal(detail.command, fake)
  assert.deepEqual(detail.prefixArgs, [])
  await rm(root, { recursive: true, force: true })
})

test('probe fails clearly without a database or launcher', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opencode-probe-'))
  assert.throws(
    () => opencodeEngine.probe({ sessionsRoot: root, binPath: fake }, process.env),
    /OpenCode database was not found/,
  )
  assert.throws(
    () => opencodeEngine.probe({ sessionsRoot: tmpdir(), binPath: '/nonexistent/opencode' }, process.env),
    /OpenCode executable was not found/,
  )
  await rm(root, { recursive: true, force: true })
})

test('probe resolves OPENCODE_BIN from the environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opencode-probe-'))
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(root, 'opencode.db'), 'x')
  const detail = opencodeEngine.probe({ sessionsRoot: root }, { ...process.env, OPENCODE_BIN: fake })
  assert.equal(detail.command, fake)
  await rm(root, { recursive: true, force: true })
})

test('engine rejects malformed native keys before building an attachment', async () => {
  await assert.rejects(
    opencodeEngine.readSession('ses_bad; drop table session', { sessionsRoot: tmpdir() }, process.env),
    /invalid OpenCode session id/,
  )
  await assert.rejects(
    opencodeEngine.createAttachment({
      session: { nativeKey: 'not-a-session', cwd: tmpdir() },
      config: { binPath: fake },
      env: { ...process.env },
    }),
    /invalid OpenCode session id/,
  )
})

test('engine builds an attachment with the bridge config and env', async () => {
  const bridge = await opencodeEngine.createAttachment({
    session: { nativeKey: SESSION_ID, cwd: tmpdir() },
    config: { binPath: fake, autoApprove: false },
    env: { ...process.env },
  })
  assert.equal(bridge.env.PATH, process.env.PATH)
  assert.equal(bridge.autoApprove, false)
  assert.equal(bridge.sessionId, SESSION_ID)
  await bridge.start()
  assert.equal(bridge.running, true)
  await bridge.dispose()
  assert.equal(bridge.running, false)
})

test('engine lists and reads sessions from its database', { skip: !existsSync(fake) }, async () => {
  // The engine-level check uses the real user database only when it is readable;
  // everywhere else the session-store tests cover the schema, so skip cleanly.
  const dir = await mkdtemp(join(tmpdir(), 'opencode-engine-'))
  const result = await opencodeEngine.listSessions({ sessionsRoot: dir }, process.env).catch((error) => {
    assert.match(error.message, /OpenCode database was not found/)
    return undefined
  })
  if (result !== undefined) assert.equal(result.root, dir)
  await rm(dir, { recursive: true, force: true })
})
