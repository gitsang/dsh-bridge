import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import { PiAttachment, createLineDecoder } from '../src/backends/pi/attachment.js'

const fake = new URL('./fixtures/fake-pi.mjs', import.meta.url).pathname

function attachment(extra = {}) {
  return new PiAttachment({
    file: '/tmp/fake-session.jsonl',
    env: { ...process.env, PI_BIN: fake },
    responseTimeoutMs: 5000,
    ...extra,
  })
}

test('line decoder only splits on LF and keeps unicode separators', () => {
  const lines = []
  const decoder = createLineDecoder((line) => lines.push(line))
  decoder.push('{"a":1}\r\n{"b":"x\u2028y"}\n{"c"')
  decoder.push(':2}\n')
  decoder.flush()
  assert.deepEqual(lines, ['{"a":1}', '{"b":"x\u2028y"}', '{"c":2}'])
})

test('starts Pi and correlates RPC responses', async () => {
  const bridge = attachment()
  await bridge.start()
  const state = await bridge.snapshot()
  assert.equal(state.sessionId, 'fake-session')
  assert.equal(state.isStreaming, false)
  assert.equal(state.pid, bridge.pid)
  await bridge.dispose()
  assert.equal(bridge.running, false)
})

test('streams prompt events in order', async () => {
  const bridge = attachment()
  await bridge.start()
  const seen = []
  bridge.on('event', (event) => seen.push(event.type))
  const accepted = await bridge.prompt('hello')
  assert.deepEqual(accepted, { accepted: true })
  await once(bridge, 'agent_settled')
  assert.deepEqual(seen, [
    'agent_start',
    'turn_start',
    'message_start',
    'message_end',
    'message_start',
    'message_update',
    'message_update',
    'message_update',
    'message_update',
    'message_update',
    'message_update',
    'message_update',
    'message_update',
    'message_update',
    'message_update',
    'message_update',
    'message_end',
    'turn_end',
    'agent_end',
    'agent_settled',
  ])
  const messages = await bridge.getMessages()
  assert.equal(messages.messages.at(-1).content[0].text, 'echo: hello')
  await bridge.dispose()
})

test('forwards blocking extension dialogs and accepts a response', async () => {
  const bridge = attachment()
  await bridge.start()
  const [request] = await once(bridge, 'ui-request')
  assert.equal(request.method, 'confirm')
  const resolved = once(bridge, 'extension_ui_resolved')
  bridge.respondUi(request.id, { confirmed: true })
  const [event] = await resolved
  assert.equal(event.response.confirmed, true)
  await bridge.dispose()
})

test('rejects pending requests when the child exits', async () => {
  const bridge = attachment()
  await bridge.start()
  const pending = bridge.getState()
  bridge.child.kill('SIGKILL')
  await assert.rejects(pending, /exited before responding/)
  await bridge.dispose()
})

test('request rejects after dispose', async () => {
  const bridge = attachment()
  await bridge.start()
  await bridge.dispose()
  await assert.rejects(bridge.getState(), /not running/)
})

test('Pi adapter maps native events onto the backend-neutral vocabulary', async () => {
  const { piEngine } = await import('../src/backends/pi/index.js')
  assert.deepEqual(piEngine.normalizeEvent({ type: 'agent_start' }), { type: 'agent-start' })
  assert.deepEqual(piEngine.normalizeEvent({ type: 'agent_settled', aborted: false }), { type: 'agent-settled', aborted: false })
  assert.deepEqual(piEngine.normalizeEvent({ type: 'agent_end' }), { type: 'agent-end' })
  assert.deepEqual(
    piEngine.normalizeEvent({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: { path: 'x' } }),
    { type: 'tool-start', toolCallId: 't1', name: 'read', arguments: { path: 'x' } },
  )
  assert.deepEqual(
    piEngine.normalizeEvent({ type: 'session_info_changed', name: 'Demo' }),
    { type: 'session-name', name: 'Demo' },
  )
  assert.equal(piEngine.normalizeEvent({ type: 'future_event', value: 1 }).type, 'backend-event')
})

test('adapter passes executable and offline startup environment to Pi', async () => {
  const { piEngine } = await import('../src/backends/pi/index.js')
  const child = await piEngine.createAttachment({
    session: { nativeKey: Buffer.from('/tmp/fake-session.jsonl').toString('base64url'), cwd: '/tmp' },
    config: { sessionsRoot: '/tmp', binPath: fake, offline: true },
    env: { ...process.env },
    logger: { warn() {} },
  })
  assert.equal(child.env.PI_OFFLINE, '1')
  assert.equal(child.env.PI_BIN, fake)
  const online = await piEngine.createAttachment({
    session: { nativeKey: Buffer.from('/tmp/fake-session.jsonl').toString('base64url'), cwd: '/tmp' },
    config: { sessionsRoot: '/tmp', binPath: fake, offline: false },
    env: { ...process.env, PI_OFFLINE: '' },
    logger: { warn() {} },
  })
  assert.equal(online.env.PI_OFFLINE, '')
})
