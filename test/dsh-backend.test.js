/**
 * DSH engine + attachment tests.
 *
 * Everything runs against `test/fixtures/fake-dsh.mjs`, which speaks the live
 * server's wire shapes (RPC envelopes, `session/list` items, projections, paged
 * history), so no remote instance is needed. The mapping modules are also
 * covered directly, because that is where the transcript vocabulary is pinned.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  blockFromDsh,
  eventsFromPage,
  historyFromEvents,
  isHumanUserMessage,
  isSubagentRow,
  messageFromEvent,
  modelsFromCatalog,
  neutralEventsFromDsh,
  parseToolArguments,
  sessionFromRow,
  statsFromProjections,
  turnEndFromEvent,
} from '../src/backends/dsh/session-store.js'
import { DshAttachment } from '../src/backends/dsh/attachment.js'
import { dshEngine } from '../src/backends/dsh/index.js'
import { startFakeDsh } from './fixtures/fake-dsh.mjs'

const TOKEN = 'token-abc'

function config(baseUrl, extra = {}) {
  return { baseUrl, token: TOKEN, allowInsecureTls: false, ...extra }
}

/** A two-turn remote log with tool use, injected context, and an abort. */
function sampleRecords() {
  return [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    {
      type: 'user/message',
      seq: 1,
      time: 2,
      data: { role: 'user', content: [{ type: 'text', text: 'list the files' }], source: { kind: 'user', rpcId: 'r1' } },
    },
    {
      type: 'user/message',
      seq: 2,
      time: 3,
      data: { role: 'user', content: [{ type: 'text', text: 'time context' }], source: { kind: 'time-context' } },
    },
    {
      type: 'assistant/message',
      seq: 3,
      time: 4,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'I should look around.' },
            { type: 'text', text: 'Listing.' },
            { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"ls"}' },
          ],
        },
        usage: { uncachedInputTokens: 10, cacheReadTokens: 2, outputTokens: 5, cacheWriteTokens: 0 },
      },
    },
    { type: 'tool/call', seq: 4, time: 5, data: { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"command":"ls"}' } },
    {
      type: 'tool/result',
      seq: 5,
      time: 6,
      data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'a.txt' }], isError: false } },
    },
    { type: 'turn/end', seq: 6, time: 7, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'session/title', seq: 7, time: 8, data: { title: 'File listing' } },
    { type: 'turn/start', seq: 8, time: 9, data: { turn: 2 } },
    {
      type: 'user/message',
      seq: 9,
      time: 10,
      data: { role: 'user', content: [{ type: 'text', text: 'stop' }], source: { kind: 'user' } },
    },
    { type: 'turn/end', seq: 10, time: 11, data: { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } } },
  ]
}

function rowFor(records) {
  const last = records[records.length - 1]
  return {
    sessionId: 'sess-sample',
    updatedAt: 1_800_000_000_000,
    running: false,
    blank: false,
    cwd: '/work/project',
    projections: {
      kind: 'sequenced',
      asOfSeq: last.seq,
      values: {
        title: 'File listing',
        workingDirectory: '/work/project',
        modelSelection: { lastUsed: { provider: 'p', model: 'm' } },
        sessionListMetadata: { blank: false, lastPromptAt: 10 },
        sessionStats: { turns: 2, steps: 1 },
        turnOutline: [{ turn: 1, seq: 4, prompt: 'list the files', response: 'Listing.' }],
      },
    },
  }
}

test('session rows map onto the bridge summary shape', () => {
  const session = sessionFromRow(rowFor(sampleRecords()))
  assert.equal(session.nativeKey, 'sess-sample')
  assert.equal(session.key, 'sess-sample')
  assert.equal(session.name, 'File listing')
  assert.equal(session.cwd, '/work/project')
  assert.deepEqual(session.model, { provider: 'p', id: 'm' })
  assert.equal(session.firstMessage, 'list the files')
  assert.equal(session.modified, new Date(1_800_000_000_000).toISOString())
  assert.throws(() => sessionFromRow({}), /without an id/)
})

test('only human user messages become transcript turns', () => {
  const human = { type: 'user/message', data: { content: [], source: { kind: 'user' } } }
  const injected = { type: 'user/message', data: { content: [], source: { kind: 'time-context' } } }
  const sourceLess = { type: 'user/message', data: { content: [] } }
  assert.equal(isHumanUserMessage(human), true)
  assert.equal(isHumanUserMessage(injected), false)
  assert.equal(isHumanUserMessage(sourceLess), true)
  assert.deepEqual(neutralEventsFromDsh(injected), [])
  assert.equal(messageFromEvent(injected), undefined)
})

test('assistant blocks translate to the bridge block vocabulary', () => {
  assert.deepEqual(blockFromDsh({ type: 'text', text: 'hi' }), { type: 'text', text: 'hi' })
  assert.deepEqual(blockFromDsh({ type: 'reasoning', text: 'why' }), { type: 'thinking', thinking: 'why' })
  assert.deepEqual(blockFromDsh({ type: 'tool-call', id: 'c', name: 'bash', arguments: '{"x":1}' }), {
    type: 'toolCall', id: 'c', name: 'bash', arguments: { x: 1 },
  })
  assert.equal(blockFromDsh({ type: 'unknown' }), null)
  assert.deepEqual(parseToolArguments('not json'), { raw: 'not json' })
  assert.deepEqual(parseToolArguments(''), {})
})

test('a durable turn maps onto the host turn brackets', () => {
  const events = sampleRecords()
  assert.deepEqual(neutralEventsFromDsh(events[0]), [{ type: 'agent-start' }])
  assert.deepEqual(neutralEventsFromDsh(events[6]), [{ type: 'agent-end' }, { type: 'agent-settled', aborted: false }])
  assert.deepEqual(neutralEventsFromDsh(events[10]), [{ type: 'agent-end' }, { type: 'agent-settled', aborted: true }])
  assert.deepEqual(neutralEventsFromDsh(events[7]), [{ type: 'session-name', name: 'File listing' }])
  const toolStart = neutralEventsFromDsh(events[4])[0]
  assert.equal(toolStart.type, 'tool-start')
  assert.equal(toolStart.toolCallId, 'call-1')
  assert.deepEqual(toolStart.arguments, { command: 'ls' })
  const toolEnd = neutralEventsFromDsh(events[5])[0]
  assert.equal(toolEnd.type, 'tool-end')
  assert.equal(toolEnd.isError, false)
  const message = neutralEventsFromDsh(events[3])[0]
  assert.equal(message.type, 'message-end')
  assert.equal(message.message.role, 'assistant')
  assert.deepEqual(message.message.usage, { input: 10, output: 5, cacheRead: 2, cacheWrite: 0 })
  // Log-only bookkeeping never reaches the browser.
  assert.deepEqual(neutralEventsFromDsh({ type: 'request/header', data: {} }), [])
  assert.deepEqual(turnEndFromEvent(events[10]), { turn: 2, kind: 'aborted', aborted: true, error: undefined })
})

test('history folds tool results into their call and keeps log order', () => {
  const history = historyFromEvents(sampleRecords())
  // Two human turns plus one assistant step and its tool result; the injected
  // time-context message is not transcript content.
  assert.deepEqual(history.messages.map((message) => message.role), ['user', 'assistant', 'toolResult', 'user'])
  assert.equal(history.lastSeq, 10)
  assert.equal(history.title, 'File listing')
  assert.equal(history.openTurn, undefined)
  // The step records call-1 twice (message block + durable tool/call); they are
  // one call, so the id de-duplicates them.
  const toolNames = history.tools.map((tool) => tool.name)
  assert.deepEqual(toolNames, ['bash'])
  assert.equal(history.messages[2].isError, false)
})

test('page records are filtered by cursor and sorted', () => {
  const records = sampleRecords().slice(4, 7).map((event) => ({ type: 'event', event }))
  const events = eventsFromPage({ records: [...records].reverse(), hasMore: false }, { after: 4 })
  assert.deepEqual(events.map((event) => event.seq), [5, 6])
  assert.deepEqual(eventsFromPage(null), [])
})

test('model catalog flattens provider groups', () => {
  const models = modelsFromCatalog({
    groups: [
      { id: 'p1', name: 'P1', models: [{ id: 'm1', name: 'M1', reasoning: { efforts: [{ id: 'high' }] } }] },
      { id: 'p2', name: 'P2', models: [{ id: 'm2' }] },
    ],
  })
  assert.deepEqual(models, [
    { id: 'm1', provider: 'p1', name: 'M1', contextWindow: 0, reasoning: true },
    { id: 'm2', provider: 'p2', name: 'm2', contextWindow: 0, reasoning: false },
  ])
})

test('projections map onto the statusline statistics', () => {
  const stats = statsFromProjections({
    tokenUsage: { uncachedInputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 0 },
    sessionStats: { turns: 2, steps: 4 },
    contextPressure: { projectedTokens: 500, contextWindow: 2000 },
  })
  assert.equal(stats.turns, 2)
  assert.equal(stats.steps, 4)
  assert.deepEqual(stats.tokens, { input: 10, output: 20, cacheRead: 30, cacheWrite: 0 })
  assert.deepEqual(stats.contextUsage, { tokens: 500, contextWindow: 2000, percent: 25 })
})

test('the engine declares exactly one connection strategy and its own fields', () => {
  assert.equal(dshEngine.id, 'dsh')
  assert.equal(dshEngine.available, true)
  assert.equal('mode' in dshEngine, false)
  assert.deepEqual(dshEngine.configFields.map((field) => field.key), ['baseUrl', 'token', 'allowInsecureTls'])
  const secrets = dshEngine.configFields.filter((field) => field.type === 'secret').map((field) => field.key)
  assert.deepEqual(secrets, ['token'])
})

test('listSessions drops blank and subagent rows', async () => {
  const fake = await startFakeDsh({
    token: TOKEN,
    sessions: [
      { id: 'sess-a', title: 'Alpha', workingDirectory: '/work/a', records: sampleRecords().slice(0, 7) },
      { id: 'sess-b', title: 'Blank', workingDirectory: '/work/b', records: [] },
      {
        id: 'sess-child',
        title: 'Subagent',
        workingDirectory: '/work/a',
        origin: 'subagent',
        parentSessionId: 'sess-a',
        records: sampleRecords().slice(0, 7),
      },
    ],
  })
  try {
    const listed = await dshEngine.listSessions(config(fake.url))
    assert.deepEqual(listed.sessions.map((session) => session.nativeKey), ['sess-a'])
    assert.equal(listed.sessions[0].name, 'Alpha')
    assert.deepEqual(listed.workspaces.map((workspace) => workspace.path), ['/work/a'])
    assert.ok(listed.root.startsWith('http://127.0.0.1:'))
  } finally {
    await fake.close()
  }
})

test('isSubagentRow recognizes only the subagent origin', () => {
  assert.equal(isSubagentRow({ origin: 'subagent' }), true)
  assert.equal(isSubagentRow({ origin: 'user' }), false)
  assert.equal(isSubagentRow({}), false)
  assert.equal(isSubagentRow(null), false)
})

test('readSession rebuilds history, title, and statistics from the remote log', async () => {
  const fake = await startFakeDsh({
    token: TOKEN,
    sessions: [{
      id: 'sess-a',
      title: 'Alpha',
      workingDirectory: '/work/a',
      provider: 'p',
      model: 'm',
      records: sampleRecords(),
    }],
  })
  try {
    const session = await dshEngine.readSession('sess-a', config(fake.url))
    assert.equal(session.name, 'File listing')
    assert.equal(session.cwd, '/work/a')
    assert.deepEqual(session.messages.map((message) => message.role), ['user', 'assistant', 'toolResult', 'user'])
    assert.equal(session.asOfSeq, 10)
    // The durable history knows the tool-call total the projections omit.
    assert.equal(session.stats.toolCalls, 1)
    assert.deepEqual(session.model, { provider: 'p', id: 'm' })
    // The fixture reports 100 projected tokens against a 1000-token window.
    assert.equal(session.stats.contextUsage.percent, 10)
  } finally {
    await fake.close()
  }
})

test('readSession walks earlier pages when the log does not fit one page', async () => {
  const records = []
  // 400 message pairs exceed the adapter's 200-message page budget.
  let seq = 0
  for (let index = 0; index < 400; index += 1) {
    records.push({ type: 'user/message', seq: seq++, time: seq, data: { role: 'user', content: [{ type: 'text', text: `q${index}` }], source: { kind: 'user' } } })
    records.push({ type: 'assistant/message', seq: seq++, time: seq, data: { turn: index, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: `a${index}` }] } } })
  }
  const fake = await startFakeDsh({ token: TOKEN, sessions: [{ id: 'sess-long', records }] })
  try {
    const session = await dshEngine.readSession('sess-long', config(fake.url))
    assert.equal(session.messages.length, 800)
    assert.equal(session.messages[0].content[0].text, 'q0')
    assert.equal(session.asOfSeq, seq - 1)
  } finally {
    await fake.close()
  }
})

test('createSession asks the remote instance and returns an openable key', async () => {
  const fake = await startFakeDsh({ token: TOKEN })
  try {
    const created = await dshEngine.createSession({ cwd: '/work/new', config: config(fake.url) })
    assert.equal(typeof created.nativeKey, 'string')
    assert.ok(created.nativeKey.length > 0)
    assert.equal(created.cwd, '/work/new')
    assert.equal(created.blank, true)
    // The created session is immediately readable through the same adapter.
    const detail = await dshEngine.readSession(created.nativeKey, config(fake.url))
    assert.deepEqual(detail.messages, [])
  } finally {
    await fake.close()
  }
})

test('probe authenticates without touching a session', async () => {
  const fake = await startFakeDsh({ token: TOKEN })
  try {
    const detail = await dshEngine.probe(config(fake.url))
    assert.equal(detail.authMode, 'token')
    assert.ok(detail.models > 0)
    assert.equal(fake.calls.some((call) => call.method.startsWith('session/page')), false)
    assert.equal(fake.calls.some((call) => call.method === 'session/modelCatalog'), true)
  } finally {
    await fake.close()
  }
})

test('probe reports a bad token and an unreachable host honestly', async () => {
  const fake = await startFakeDsh({ token: TOKEN })
  try {
    await assert.rejects(dshEngine.probe(config(fake.url, { token: 'wrong' })), (error) => {
      assert.equal(error.kind, 'bad-token')
      assert.match(error.message, /ephemeral/)
      return true
    })
  } finally {
    await fake.close()
  }
  await assert.rejects(dshEngine.probe(config('http://127.0.0.1:1')), (error) => {
    assert.match(error.message, /ECONNREFUSED|failed/)
    return true
  })
})

test('a gateway deployment is refused with a pointer at dsh web', async () => {
  const fake = await startFakeDsh({ token: TOKEN, gateway: true })
  try {
    await assert.rejects(dshEngine.probe(config(fake.url)), (error) => {
      assert.equal(error.kind, 'unauthenticated')
      // The bridge speaks the dsh web protocol only; a gateway needs a browser
      // password it has no field for, so the error must say so.
      assert.match(error.message, /dsh-gateway/)
      assert.match(error.message, /launch token/)
      return true
    })
  } finally {
    await fake.close()
  }
})

test('the attachment publishes new durable events and settles the turn', async () => {
  const fake = await startFakeDsh({
    token: TOKEN,
    sessions: [
      {
        id: 'sess-run',
        title: 'Run',
        workingDirectory: '/work/run',
        records: sampleRecords().slice(0, 7),
        promptEvents: [
          { type: 'turn/start', data: { turn: 2 } },
          { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'next' }], source: { kind: 'user' } } },
          {
            type: 'assistant/message',
            data: { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
          },
          { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
        ],
      },
    ],
  })
  const attachment = new DshAttachment({
    session: { nativeKey: 'sess-run', model: null },
    config: config(fake.url),
    logger: null,
  })
  const seen = []
  try {
    await attachment.start()
    attachment.on('event', (event) => seen.push(event.type))
    assert.equal((await attachment.getState()).isStreaming, false)
    assert.equal(await attachment.prompt('next'), true)
    await attachment.abort()
    // Poll until the terminal event lands; the fixture advances its cursor on
    // prompt, so one poll tick is enough.
    const deadline = Date.now() + 4000
    while (!seen.includes('turn/end') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.ok(seen.includes('turn/start'), `expected turn/start in ${seen.join(',')}`)
    assert.ok(seen.includes('turn/end'), `expected turn/end in ${seen.join(',')}`)
    const state = await attachment.getState()
    assert.equal(state.isStreaming, false)
    assert.equal(state.aborted, false)
    assert.equal(state.sessionName, 'Run')
  } finally {
    await attachment.dispose()
    await fake.close()
  }
})

test('a writer-held prompt and a missing session surface actionable errors', async () => {
  const fake = await startFakeDsh({ token: TOKEN, sessions: [{ id: 'sess-a', records: sampleRecords().slice(0, 7) }] })
  try {
    const missing = new DshAttachment({
      session: { nativeKey: 'sess-missing' },
      config: config(fake.url),
    })
    await assert.rejects(missing.start(), (error) => {
      assert.equal(error.status, 404)
      assert.match(error.message, /no longer has this session/)
      return true
    })
  } finally {
    await fake.close()
  }
})

test('model selection and stats work through the attachment', async () => {
  const fake = await startFakeDsh({
    token: TOKEN,
    modelCatalog: {
      default: { provider: 'p1', model: 'm1' },
      groups: [{ id: 'p1', name: 'P1', models: [{ id: 'm1', name: 'M1' }, { id: 'm2', name: 'M2' }] }],
    },
    sessions: [{ id: 'sess-a', records: sampleRecords().slice(0, 7) }],
  })
  const attachment = new DshAttachment({ session: { nativeKey: 'sess-a' }, config: config(fake.url) })
  try {
    await attachment.start()
    assert.deepEqual(await attachment.setModel('p1', 'm2'), { provider: 'p1', id: 'm2' })
    assert.deepEqual((await attachment.getState()).model, { provider: 'p1', id: 'm2' })
    const models = await attachment.getAvailableModels()
    assert.deepEqual(models.map((model) => model.id), ['m1', 'm2'])
    const stats = await attachment.getSessionStats()
    assert.equal(stats.turns, 1)
    assert.equal(stats.tokens.input, 12)
    // Nothing has run through this attachment yet, so no tool call is counted.
    assert.equal(stats.toolCalls, 0)
    await assert.rejects(attachment.setModel('', 'm1'), /provider and model are required/)
    assert.throws(() => attachment.respondUi('x', {}), /no bridge-owned dialog/)
  } finally {
    await attachment.dispose()
    await fake.close()
  }
})

test('dispose stops polling and is idempotent', async () => {
  const fake = await startFakeDsh({ token: TOKEN, sessions: [{ id: 'sess-a', records: sampleRecords().slice(0, 7) }] })
  const attachment = new DshAttachment({ session: { nativeKey: 'sess-a' }, config: config(fake.url) })
  try {
    await attachment.start()
    assert.equal(attachment.running, true)
    await attachment.dispose()
    assert.equal(attachment.running, false)
    await attachment.dispose()
    const before = fake.state.apiRequests
    await new Promise((resolve) => setTimeout(resolve, 1200))
    assert.equal(fake.state.apiRequests, before)
  } finally {
    await fake.close()
  }
})
