import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CodexAttachment } from '../src/backends/codex/attachment.js'
import { bridgeToolName, codexEngine } from '../src/backends/codex/index.js'
import { sessionKey } from '../src/backends/codex/session-store.js'

const fake = new URL('./fixtures/fake-codex.mjs', import.meta.url).pathname
const THREAD_ID = '019e0b6d-c972-72e2-8107-b2df9c0f32e7'

async function makeExecutable(path) {
  await chmod(path, 0o755)
  return path
}

async function workspace() {
  return mkdtemp(join(tmpdir(), 'dsh-codex-backend-'))
}

function line(record) {
  return `${JSON.stringify(record)}\n`
}

function rolloutRecords() {
  return [
    {
      timestamp: '2026-01-02T10:00:00.000Z',
      ordinal: 0,
      type: 'session_meta',
      payload: {
        session_id: THREAD_ID,
        id: THREAD_ID,
        timestamp: '2026-01-02T10:00:00.000Z',
        cwd: '/work/project',
        originator: 'dsh-bridge',
        cli_version: '0.162.1',
        source: 'cli',
        model_provider: 'openai',
      },
    },
    { timestamp: '2026-01-02T10:00:00.500Z', type: 'turn_context', payload: { cwd: '/work/project', model: 'gpt-5.5' } },
    {
      timestamp: '2026-01-02T10:00:01.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Ship it' }] },
    },
    {
      timestamp: '2026-01-02T10:00:02.000Z',
      type: 'response_item',
      payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"pnpm test"}', call_id: 'call-1' },
    },
    {
      timestamp: '2026-01-02T10:00:03.000Z',
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'call-1', output: 'all good' },
    },
    {
      timestamp: '2026-01-02T10:00:04.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] },
    },
  ]
}

async function rolloutFile(dir = '') {
  const root = await workspace()
  const day = join(root, '2026', '01', '02')
  await mkdir(day, { recursive: true })
  const file = join(day, `rollout-2026-01-02T10-00-00-${THREAD_ID}.jsonl`)
  await writeFile(file, rolloutRecords().map(line).join(''), 'utf8')
  return { root, file }
}

async function attachment(overrides = {}) {
  const { root, file } = await rolloutFile()
  const env = { ...process.env, CODEX_BIN: fake, ...overrides.env }
  delete env.FAKE_CODEX_SILENT
  if (overrides.fakeEnv !== undefined) Object.assign(env, overrides.fakeEnv)
  return new CodexAttachment({
    file,
    threadId: THREAD_ID,
    cwd: '/tmp',
    env,
    responseTimeoutMs: 5000,
    ...overrides.options,
  })
}

function normalized(bridge, bucket) {
  bridge.on('event', (record) => {
    const event = codexEngine.normalizeEvent(record)
    if (event !== null) bucket.push(event)
  })
}

/**
 * Start one attachment, run the body, and always dispose. A failed assertion
 * must not leave a fake app-server child holding the test runner open.
 */
async function withAttachment(body, overrides = {}) {
  const bridge = await attachment(overrides)
  await bridge.start()
  try {
    return await body(bridge)
  } finally {
    await bridge.dispose()
  }
}

test('starts the app-server, reports state, and stops cleanly', async () => {
  await withAttachment(async (bridge) => {
    const state = await bridge.snapshot()
    assert.equal(state.sessionId, THREAD_ID)
    assert.equal(state.isStreaming, false)
    assert.equal(state.pid, bridge.pid)
    assert.equal(state.model.id, 'fake-model')
    assert.equal(state.model.provider, 'fake')
    assert.equal(bridge.running, true)
    assert.equal(typeof bridge.stderr, 'string')
  })
})

test('prompt streams an assistant message and settles the turn', async () => {
  await withAttachment(async (bridge) => {
    const events = []
    normalized(bridge, events)
    const accepted = await bridge.prompt('hello')
    assert.deepEqual(accepted, { accepted: true, turnId: 'turn-1' })
    await once(bridge, 'agent_settled')

    const types = events.map((event) => event.type)
    assert.equal(types[0], 'agent-start')
    // agent-settled is always the last event of a turn: the host closes the
    // process as soon as it sees it.
    assert.deepEqual(types.slice(-2), ['agent-end', 'agent-settled'])
    assert.equal(events.at(-1).aborted, false)
    const starts = events.filter((event) => event.type === 'message-start')
    assert.deepEqual(starts.map((event) => event.message.role), ['user', 'assistant'])
    const ends = events.filter((event) => event.type === 'message-end')
    assert.equal(ends[0].message.content[0].text, 'hello')
    const assistantEnd = ends.at(-1).message
    assert.deepEqual(assistantEnd.content[0], { type: 'thinking', thinking: 'Thinking about it.' })
    assert.equal(assistantEnd.content[1].text, 'echo: hello')
    // Every streaming update must precede the closing message-end of its message.
    const firstUpdate = types.indexOf('message-update')
    const lastUpdate = types.lastIndexOf('message-update')
    assert.ok(firstUpdate > 0)
    assert.ok(lastUpdate < types.lastIndexOf('message-end'))
    const state = await bridge.getState()
    assert.equal(state.isStreaming, false)
  })
})

test('steers an in-flight turn instead of starting a second one', async () => {
  await withAttachment(async (bridge) => {
    const updates = []
    bridge.on('event', (record) => {
      if (record.type === 'message_update') updates.push(record.message)
    })
    await bridge.prompt('hello')
    const steered = await bridge.steer('also this')
    assert.equal(steered.accepted, true)
    await once(bridge, 'agent_settled')
    const text = updates.map((message) => message.content.map((block) => block.text ?? '').join('')).join('\n')
    assert.match(text, /steered: also this/)
  })
})

test('followUp starts a new turn when the thread is idle', async () => {
  await withAttachment(async (bridge) => {
    await bridge.prompt('one')
    await once(bridge, 'agent_settled')
    const accepted = await bridge.followUp('two')
    assert.equal(accepted.accepted, true)
    await once(bridge, 'agent_settled')
  })
})

test('abort interrupts the active turn and settles it as aborted', async () => {
  await withAttachment(async (bridge) => {
    await bridge.prompt('hello')
    // Suspend the fake's steer/idle sequencing: interrupt wins the race because
    // the completion it emits is the one the adapter must honour.
    const settled = once(bridge, 'agent_settled')
    const result = await bridge.abort()
    assert.deepEqual(result, { aborted: true, turnId: 'turn-1' })
    const [event] = await settled
    assert.equal(event.aborted, true)
  })
  // After dispose nothing is running: an abort is a no-op, not an error.
  const idle = await attachment()
  await idle.start()
  await idle.prompt('hello')
  await once(idle, 'agent_settled')
  assert.deepEqual(await idle.abort(), { aborted: false })
  await idle.dispose()
})

test('forwards a native approval request and applies the decision', async () => {
  await withAttachment(async (bridge) => {
    const events = []
    normalized(bridge, events)
    await bridge.prompt('please approval now')
    const [request] = await once(bridge, 'ui-request')
    assert.equal(request.type, 'extension_ui_request')
    assert.equal(request.method, 'confirm')
    assert.match(request.message, /rm -rf build/)
    assert.equal(bridge.uiPending.has(request.id), true)
    bridge.respondUi(request.id, { confirmed: true })
    await once(bridge, 'agent_settled')
    await assert.rejects(async () => bridge.respondUi(request.id, { confirmed: true }), /unknown Codex approval/)
    const toolStart = events.find((event) => event.type === 'tool-start')
    assert.equal(toolStart.name, 'bash')
    assert.deepEqual(toolStart.arguments, { command: 'rm -rf build', cwd: '/tmp/fake-codex' })
    assert.ok(events.some((event) => event.type === 'tool-update' && /removing build/.test(event.partialResult)))
    const toolEnd = events.find((event) => event.type === 'tool-end')
    assert.equal(toolEnd.isError, false)
    assert.match(toolEnd.result.content[0].text, /removing build/)
    const text = events.filter((event) => event.type === 'message-end').at(-1).message.content.at(-1).text
    assert.equal(text, 'echo: please approval now')
  })
})

test('a declined approval still completes the turn', async () => {
  await withAttachment(async (bridge) => {
    const events = []
    normalized(bridge, events)
    await bridge.prompt('approval needed')
    const [request] = await once(bridge, 'ui-request')
    bridge.respondUi(request.id, { cancelled: true })
    await once(bridge, 'agent_settled')
    const toolEnd = events.find((event) => event.type === 'tool-end')
    assert.equal(toolEnd.isError, true)
  })
})

test('settles from thread/status/changed when the completion notification is missed', async () => {
  await withAttachment(async (bridge) => {
    await bridge.prompt('hello')
    const [event] = await once(bridge, 'agent_settled')
    assert.equal(event.aborted, false)
    const state = await bridge.getState()
    assert.equal(state.isStreaming, false)
  }, { fakeEnv: { FAKE_CODEX_SKIP_TURN_COMPLETED: '1' } })
})

test('rejects pending requests when the child exits', async () => {
  await withAttachment(async (bridge) => {
    const pending = bridge.getAvailableModels()
    bridge.child.kill('SIGKILL')
    await assert.rejects(pending, /exited before responding/)
  }, { fakeEnv: { FAKE_CODEX_SILENT: 'model/list' } })
})

test('requests reject after dispose', async () => {
  const bridge = await attachment()
  await bridge.start()
  await bridge.dispose()
  await assert.rejects(bridge.getAvailableModels(), /not running/)
  assert.equal(bridge.exited, true)
})

test('reads durable messages and session stats from the rollout', async () => {
  await withAttachment(async (bridge) => {
  const { messages } = await bridge.getMessages()
  assert.deepEqual(messages.map((message) => message.role), ['user', 'assistant', 'toolResult'])
  assert.equal(messages[0].content[0].text, 'Ship it')
  await bridge.prompt('hello')
  await once(bridge, 'agent_settled')
  const stats = await bridge.getSessionStats()
  assert.equal(stats.sessionId, THREAD_ID)
  assert.equal(stats.userMessages, 1)
  assert.equal(stats.assistantMessages, 1)
  assert.equal(stats.toolCalls, 1)
  assert.deepEqual(stats.tokens, { input: 0, cacheRead: 300, cacheWrite: 0, output: 50, total: 470 })
  assert.deepEqual(stats.contextUsage, { tokens: 47, contextWindow: 200000, percent: 0 })
  })
})

test('getAvailableModels hides hidden entries and keeps the catalog shape', async () => {
  await withAttachment(async (bridge) => {
    const models = await bridge.getAvailableModels()
    assert.deepEqual(models, [
      {
        id: 'fake-model',
        provider: 'fake',
        name: 'Fake Model',
        description: 'Deterministic test model',
        reasoning: true,
      },
    ])
  })
})

test('setModel applies the next turn override instead of switching the thread', async () => {
  await withAttachment(async (bridge) => {
    const selected = bridge.setModel('fake', 'fake-model-2')
    assert.deepEqual(selected, { provider: 'fake', id: 'fake-model-2' })
    assert.deepEqual(bridge.modelOverride, { provider: 'fake', id: 'fake-model-2' })
    const state = await bridge.getState()
    assert.equal(state.model.id, 'fake-model-2')
  })
})

test('normalizeEvent maps the app-server vocabulary and translates tool names', () => {
  assert.deepEqual(codexEngine.normalizeEvent({ type: 'agent_start' }), { type: 'agent-start' })
  assert.deepEqual(codexEngine.normalizeEvent({ type: 'agent_end' }), { type: 'agent-end' })
  assert.deepEqual(codexEngine.normalizeEvent({ type: 'agent_settled', aborted: true }), { type: 'agent-settled', aborted: true })
  assert.deepEqual(
    codexEngine.normalizeEvent({ type: 'tool_start', toolCallId: 'i1', name: 'shell', arguments: { command: 'ls' } }),
    { type: 'tool-start', toolCallId: 'i1', name: 'bash', arguments: { command: 'ls' } },
  )
  assert.deepEqual(
    codexEngine.normalizeEvent({ type: 'tool_update', toolCallId: 'i1', partialResult: 'x' }),
    { type: 'tool-update', toolCallId: 'i1', partialResult: 'x' },
  )
  assert.deepEqual(
    codexEngine.normalizeEvent({ type: 'tool_end', toolCallId: 'i1', result: { content: [] }, isError: true }),
    { type: 'tool-end', toolCallId: 'i1', result: { content: [] }, isError: true },
  )
  const message = { role: 'assistant', content: [{ type: 'text', text: 'hi' }], timestamp: 1 }
  assert.deepEqual(codexEngine.normalizeEvent({ type: 'message_start', message }), { type: 'message-start', message })
  assert.deepEqual(codexEngine.normalizeEvent({ type: 'message_update', message }), { type: 'message-update', message })
  assert.deepEqual(codexEngine.normalizeEvent({ type: 'message_end', message }), { type: 'message-end', message })
  // Future notifications degrade to the generic backend-event fallback.
  const unknown = { type: 'notification', method: 'thread/goal/updated', params: {} }
  assert.deepEqual(codexEngine.normalizeEvent(unknown), { type: 'backend-event', event: unknown })
  assert.equal(codexEngine.normalizeEvent(null), null)
  assert.equal(codexEngine.normalizeEvent('nope'), null)
})

test('tool names map to the six variants the client styles', () => {
  const cases = {
    apply_patch: 'edit',
    fileChange: 'edit',
    shell: 'bash',
    exec_command: 'bash',
    'container.exec': 'bash',
    exec: 'bash',
    read_file: 'read',
    read_image: 'read',
    grep: 'search',
    web_search: 'search',
    update_plan: 'others',
    mcp__server__tool: 'others',
  }
  for (const [name, expected] of Object.entries(cases)) {
    assert.equal(bridgeToolName(name), expected, `${name} should map to ${expected}`)
  }
})

test('a provider error notification never throws on the reserved error channel', async () => {
  await withAttachment(async (bridge) => {
    // Emitting EventEmitter's reserved `error` channel would crash the host;
    // the adapter must route Codex's transient provider errors through `event`.
    const events = []
    const notices = []
    bridge.on('event', (record) => events.push(record))
    bridge.on('ui-notification', (record) => notices.push(record))
    assert.doesNotThrow(() => {
      bridge.handleNotification('error', {
        error: { message: 'Reconnecting... waiting for network' },
        willRetry: true,
        threadId: THREAD_ID,
        turnId: 'turn-x',
      })
    })
    assert.equal(events.at(-1).type, 'error')
    // A retry is expected to resolve itself, so it is not surfaced as a notice.
    assert.equal(notices.length, 0)
    bridge.handleNotification('error', {
      error: { message: 'stream ended' },
      willRetry: false,
      threadId: THREAD_ID,
      turnId: 'turn-x',
    })
    assert.equal(notices.length, 1)
    assert.match(notices[0].message, /stream ended/)
  })
})

test('unknown thread items degrade to a generic tool row instead of throwing', async () => {
  await withAttachment(async (bridge) => {
    const events = []
    normalized(bridge, events)
    bridge.handleNotification('item/started', {
      item: { id: 'future-1', type: 'futureWidget', status: 'inProgress' },
      threadId: THREAD_ID,
      turnId: 'turn-x',
    })
    bridge.handleNotification('item/completed', {
      item: { id: 'future-1', type: 'futureWidget', status: 'completed' },
      threadId: THREAD_ID,
      turnId: 'turn-x',
    })
    const toolStart = events.find((event) => event.type === 'tool-start')
    assert.equal(toolStart.name, 'others')
    assert.equal(events.find((event) => event.type === 'tool-end').isError, false)
  })
})

test('probe succeeds for a readable root and a resolvable launcher', async () => {
  const { root } = await rolloutFile()
  const detail = codexEngine.probe({ sessionsRoot: root, binPath: fake }, { ...process.env })
  assert.equal(detail.sessionsRoot, root)
  assert.equal(detail.command, fake)
  assert.deepEqual(detail.prefixArgs, ['app-server', '--stdio'])
  // CODEX_BIN is the fallback when the bridge has no explicit binPath.
  const fromEnv = codexEngine.probe({ sessionsRoot: root }, { ...process.env, CODEX_BIN: fake })
  assert.equal(fromEnv.command, fake)
})

test('probe rejects a missing root, a file root, and a missing executable', async () => {
  const { root } = await rolloutFile()
  assert.throws(
    () => codexEngine.probe({ sessionsRoot: join(root, 'missing'), binPath: fake }, process.env),
    /sessions root does not exist/,
  )
  assert.throws(
    () => codexEngine.probe({ sessionsRoot: join(root, 'rollout.jsonl'), binPath: fake }, process.env),
    /sessions root does not exist/,
  )
  assert.throws(
    () => codexEngine.probe({ sessionsRoot: root, binPath: '/definitely/not/codex' }, { ...process.env, PATH: '' }),
    /Codex executable was not found/,
  )
})

test('createAttachment honors skipApprovals and binPath', async () => {
  const { root, file } = await rolloutFile()
  const session = { nativeKey: sessionKey(file), cwd: '/tmp', id: THREAD_ID }
  const tolerant = await codexEngine.createAttachment({
    session,
    config: { sessionsRoot: root, binPath: fake, skipApprovals: false },
    env: { ...process.env },
    logger: { warn() {} },
  })
  assert.equal(tolerant.approvalPolicy, 'on-request')
  assert.equal(tolerant.env.CODEX_BIN, fake)
  assert.equal(tolerant.threadId, THREAD_ID)
  const strict = await codexEngine.createAttachment({
    session,
    config: { sessionsRoot: root, binPath: fake, skipApprovals: true },
    env: { ...process.env },
    logger: { warn() {} },
  })
  assert.equal(strict.approvalPolicy, 'never')
})

test('createAttachment rejects a native key outside the configured root', async () => {
  const { root } = await rolloutFile()
  await assert.rejects(
    codexEngine.createAttachment({
      session: { nativeKey: sessionKey('/tmp/rollout-evil.jsonl'), cwd: '/tmp' },
      config: { sessionsRoot: root, binPath: fake },
      env: { ...process.env },
      logger: { warn() {} },
    }),
    /outside the Codex sessions root/,
  )
})

test('listModels queries the live catalog and maps it', async () => {
  const home = await workspace()
  await writeFile(join(home, 'config.toml'), 'model_provider = "fake"\nmodel = "fake-model"\n', 'utf8')
  const models = await codexEngine.listModels(
    { binPath: fake },
    { ...process.env, CODEX_BIN: fake, CODEX_HOME: home, PATH: process.env.PATH ?? '' },
  )
  assert.deepEqual(models.map((model) => model.id), ['fake-model'])
  assert.equal(models[0].provider, 'fake')
  assert.equal(models[0].name, 'Fake Model')
})

test('listModels falls back to the configured model when the live query fails', async () => {
  const home = await workspace()
  await writeFile(join(home, 'config.toml'), 'model_provider = "fake"\nmodel = "configured-model"\n', 'utf8')
  const models = await codexEngine.listModels(
    { binPath: '/definitely/not/codex' },
    { ...process.env, CODEX_HOME: home, PATH: '' },
  )
  assert.deepEqual(models, [{ id: 'configured-model', provider: 'fake', name: 'configured-model', reasoning: false }])
})

test('fake CLI answers --version so createSession can stamp the header', async () => {
  const executable = await makeExecutable(fake)
  const root = await workspace()
  const cwd = await workspace()
  const session = await codexEngine.createSession({
    cwd,
    config: { sessionsRoot: root, binPath: executable },
    env: { ...process.env, CODEX_HOME: root },
  })
  const { readFile } = await import('node:fs/promises')
  const { pathFromSessionKey } = await import('../src/backends/codex/session-store.js')
  const header = JSON.parse((await readFile(pathFromSessionKey(session.nativeKey, root), 'utf8')).trim())
  assert.equal(header.type, 'session_meta')
  assert.equal(header.payload.cli_version, '0.0.0-fake')
  assert.equal(header.payload.cwd, cwd)
  assert.equal(typeof session.id, 'string')
})
