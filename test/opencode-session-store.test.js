import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

/**
 * The reader depends on `node:sqlite`, which is a built-in only from Node 22.5.
 * Probe it before importing the module under test so an old runtime reports a
 * skip with a reason instead of an unhandled import failure.
 */
async function loadSqlite() {
  try {
    return await import('node:sqlite')
  } catch {
    return undefined
  }
}

const sqlite = await loadSqlite()
const skip = sqlite === undefined
  ? 'node:sqlite is unavailable on this Node version'
  : false

const store = skip ? undefined : await import('../src/backends/opencode/session-store.js')

const LEGACY_SESSION = 'ses_legacy0000000000000000000001'
const V2_SESSION = 'ses_v200000000000000000000000001'
const BOTH_SESSION = 'ses_both00000000000000000000001'
const V2_ONLY_SESSION = 'ses_v2only000000000000000000001'
const LEGACY_ONLY_SESSION = 'ses_legacyonly000000000000001'
const CHILD_SESSION = 'ses_child0000000000000000000001'
const LONG_MESSAGE_SESSION = 'ses_longmsg00000000000000000001'

/**
 * Build a temporary OpenCode database covering both storage generations.
 *
 * The schema mirrors the live 1.19.5 database (verified with `PRAGMA
 * table_info`), including the legacy `message`/`part` pair and the v2
 * `session_v2`/`session_message` pair that older CLI versions wrote.
 */
function buildDatabase(DatabaseSync) {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    create table project (id text primary key, worktree text, time_created integer);
    create table session (
      id text primary key,
      project_id text,
      parent_id text,
      slug text,
      directory text,
      title text,
      version text,
      agent text,
      model text,
      time_created integer,
      time_updated integer,
      time_archived integer
    );
    create table message (
      id text primary key,
      session_id text,
      time_created integer,
      time_updated integer,
      data text
    );
    create table part (
      id text primary key,
      message_id text,
      session_id text,
      time_created integer,
      time_updated integer,
      data text
    );
    create table session_v2 (
      id text primary key,
      project_id text,
      parent_id text,
      slug text,
      directory text,
      title text,
      version text,
      agent text,
      model text,
      time_created integer,
      time_updated integer,
      time_archived integer
    );
    create table session_message (
      id text primary key,
      session_id text,
      type text,
      seq integer,
      time_created integer,
      time_updated integer,
      data text
    );
  `)
  db.exec("insert into project (id) values ('global')")

  const insertSession = db.prepare(
    'insert into session (id, project_id, parent_id, directory, title, version, agent, model, time_created, time_updated) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  const insertSessionV2 = db.prepare(
    'insert into session_v2 (id, project_id, parent_id, directory, title, version, agent, model, time_created, time_updated) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  const insertMessage = db.prepare(
    'insert into message (id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?)',
  )
  const insertPart = db.prepare(
    'insert into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)',
  )
  const insertSessionMessage = db.prepare(
    'insert into session_message (id, session_id, type, seq, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?, ?)',
  )

  // A session that exists only in the legacy tables (newest of all).
  insertSession.run(
    LEGACY_SESSION, 'global', null, '/work/demo', 'Legacy chat', '1.1.49', 'builder', null,
    Date.parse('2026-01-02T00:00:00.000Z'), Date.parse('2026-01-05T00:00:00.000Z'),
  )
  const legacyModel = JSON.stringify({ id: 'legacy-model', providerID: 'legacy-provider' })
  insertSession.run(
    LEGACY_ONLY_SESSION, 'global', null, '/work/demo', 'Legacy only', '1.1.49', null, legacyModel,
    Date.parse('2026-01-03T00:00:00.000Z'), Date.parse('2026-01-04T00:00:00.000Z'),
  )
  // A v2-only session (archived). v2 rows and their transcripts.
  insertSessionV2.run(
    V2_ONLY_SESSION, 'global', null, '/work/other', 'V2 only', '1.18.3', 'sisyphus', JSON.stringify({ id: 'v2-model', providerID: 'v2-provider' }),
    Date.parse('2026-01-06T00:00:00.000Z'), Date.parse('2026-01-09T00:00:00.000Z'),
  )
  db.prepare('update session_v2 set time_archived = ? where id = ?').run(Date.parse('2026-02-01T00:00:00.000Z'), V2_ONLY_SESSION)
  // A session present in both generations: v2 is authoritative for metadata.
  insertSession.run(
    BOTH_SESSION, 'global', null, '/work/shared', 'New session - 2026-01-01T00:00:00.000Z', '1.1.49', null, null,
    Date.parse('2026-01-01T00:00:00.000Z'), Date.parse('2026-01-01T00:00:00.000Z'),
  )
  insertSessionV2.run(
    BOTH_SESSION, 'global', null, '/work/shared', 'Both chat', '1.18.3', 'sisyphus', JSON.stringify({ id: 'both-model', providerID: 'both-provider' }),
    Date.parse('2026-01-01T00:00:00.000Z'), Date.parse('2026-01-08T00:00:00.000Z'),
  )
  insertSessionV2.run(
    V2_SESSION, 'global', null, '/work/other', 'New session - 2026-01-07T00:00:00.000Z', '1.18.3', null, null,
    Date.parse('2026-01-07T00:00:00.000Z'), Date.parse('2026-01-07T00:00:01.000Z'),
  )
  // A sub-agent child session: included but marked with parentId.
  insertSessionV2.run(
    CHILD_SESSION, 'global', V2_ONLY_SESSION, '/work/other', 'Child agent', '1.18.3', null, null,
    Date.parse('2026-01-06T01:00:00.000Z'), Date.parse('2026-01-06T02:00:00.000Z'),
  )

  // Legacy transcript: user text, assistant reasoning + text + a completed tool
  // and an errored tool, each with its result part.
  insertMessage.run('msg_legacy_user', LEGACY_SESSION, 1, 1, JSON.stringify({ role: 'user', time: { created: 1 } }))
  insertPart.run('prt_lu', 'msg_legacy_user', LEGACY_SESSION, 1, 1, JSON.stringify({ type: 'text', text: 'hello from legacy' }))
  insertMessage.run('msg_legacy_assistant', LEGACY_SESSION, 2, 2, JSON.stringify({
    role: 'assistant',
    time: { created: 2, completed: 3 },
    modelID: 'legacy-model',
    providerID: 'legacy-provider',
    tokens: { input: 10, output: 4, cache: { read: 2, write: 0 } },
  }))
  insertPart.run('prt_la_r', 'msg_legacy_assistant', LEGACY_SESSION, 2, 2, JSON.stringify({ type: 'reasoning', text: 'mulling it over' }))
  insertPart.run('prt_la_t', 'msg_legacy_assistant', LEGACY_SESSION, 3, 3, JSON.stringify({ type: 'text', text: 'legacy answer' }))
  insertPart.run('prt_la_tool', 'msg_legacy_assistant', LEGACY_SESSION, 4, 4, JSON.stringify({
    type: 'tool',
    callID: 'call_read',
    tool: 'read',
    state: {
      status: 'completed',
      input: { filePath: 'README.md' },
      output: 'file body',
      time: { start: 4, end: 5 },
    },
  }))
  insertPart.run('prt_la_tool2', 'msg_legacy_assistant', LEGACY_SESSION, 5, 5, JSON.stringify({
    type: 'tool',
    callID: 'call_grep',
    tool: 'grep',
    state: { status: 'error', input: { pattern: 'nope' }, error: 'no matches', time: { start: 5, end: 6 } },
  }))
  insertPart.run('prt_la_step', 'msg_legacy_assistant', LEGACY_SESSION, 6, 6, JSON.stringify({
    type: 'step-finish',
    reason: 'stop',
    tokens: { input: 10, output: 4, cache: { read: 2, write: 0 } },
  }))

  // v2 transcript: user text, assistant reasoning + text + tool, model switch.
  insertSessionMessage.run('sesmsg_v2_user', V2_ONLY_SESSION, 'user', 0, 100, 100, JSON.stringify({ text: 'hello from v2', time: { created: 100 } }))
  insertSessionMessage.run('sesmsg_v2_assistant', V2_ONLY_SESSION, 'assistant', 1, 101, 102, JSON.stringify({
    agent: 'sisyphus',
    model: { providerID: 'v2-provider', id: 'v2-model' },
    content: [
      { type: 'reasoning', text: 'v2 reasoning' },
      { type: 'text', text: 'v2 answer' },
      {
        type: 'tool',
        id: 'call_v2',
        name: 'bash',
        state: { status: 'completed', input: { command: 'echo ok' }, output: 'ok\n' },
      },
    ],
    cost: 0.01,
    tokens: { input: 20, output: 8, reasoning: 3, cache: { read: 5, write: 1 } },
    time: { created: 101, completed: 102 },
  }))
  insertSessionMessage.run('sesmsg_v2_system', V2_ONLY_SESSION, 'system', 2, 103, 103, JSON.stringify({ text: 'tool list changed' }))
  insertSessionMessage.run('sesmsg_v2_switch', V2_ONLY_SESSION, 'model-switched', 3, 104, 104, JSON.stringify({
    time: { created: 104 },
    model: { id: 'second-model', providerID: 'v2-provider' },
  }))

  // The "both" session has v2 rows only; its legacy table stays empty.
  insertSessionMessage.run('sesmsg_both_user', BOTH_SESSION, 'user', 0, 200, 200, JSON.stringify({ text: 'both generations', time: { created: 200 } }))

  // A session whose first message exceeds the preview clip, so the list stays
  // bounded the way the Pi adapter's preview does.
  insertSession.run(
    LONG_MESSAGE_SESSION, 'global', null, '/work/long', 'Long preview', '1.1.49', null, null,
    Date.parse('2026-01-01T00:00:00.000Z'), Date.parse('2026-01-01T00:00:02.000Z'),
  )
  insertSessionMessage.run('sesmsg_long_user', LONG_MESSAGE_SESSION, 'user', 0, 50, 50, JSON.stringify({
    text: 'y'.repeat(5000),
    time: { created: 50 },
  }))

  // The v2 session with an auto-generated placeholder title gets no transcript.
  return db
}

async function makeDataDir(DatabaseSync) {
  const dir = await mkdtemp(join(tmpdir(), 'opencode-store-'))
  const dbPath = join(dir, 'opencode.db')
  // The store opens the file read-only, so the fixture has to exist on disk and
  // be closed first: node:sqlite cannot export an in-memory database, so the
  // fixture is rebuilt in memory and copied schema-first into the file.
  const memory = buildDatabase(DatabaseSync)
  const file = new DatabaseSync(dbPath)
  copyDatabase(memory, file)
  memory.close()
  file.close()
  return { dir, dbPath }
}

/** Copy the fixture schema and rows between two in-process databases. */
function copyDatabase(source, target) {
  const tables = source
    .prepare("select name, sql from sqlite_master where type = 'table' and name not like 'sqlite_%'")
    .all()
  for (const { name, sql } of tables) {
    if (typeof sql === 'string' && sql !== '') target.exec(sql)
  }
  for (const { name } of tables) {
    const columns = source.prepare(`pragma table_info(${name})`).all().map((column) => column.name)
    const rows = source.prepare(`select * from ${name}`).all()
    if (rows.length === 0) continue
    const placeholders = columns.map(() => '?').join(', ')
    const insert = target.prepare(`insert into ${name} (${columns.join(', ')}) values (${placeholders})`)
    for (const row of rows) insert.run(...columns.map((column) => row[column]))
  }
}

let fixture

test.before(async () => {
  if (skip) return
  fixture = await makeDataDir(sqlite.DatabaseSync)
})

test.after(async () => {
  if (skip || fixture === undefined) return
  await rm(fixture.dir, { recursive: true, force: true })
})

const config = () => ({ sessionsRoot: fixture.dir })
const env = { HOME: process.env.HOME, PATH: process.env.PATH }

test('lists sessions from both storage generations', { skip }, async () => {
  const result = await store.listOpencodeSessions(config(), env)
  assert.equal(result.root, fixture.dir)
  const ids = result.sessions.map((session) => session.id)
  assert.deepEqual(
    ids,
    [V2_ONLY_SESSION, BOTH_SESSION, V2_SESSION, CHILD_SESSION, LEGACY_SESSION, LEGACY_ONLY_SESSION, LONG_MESSAGE_SESSION],
  )
})

test('keeps v2-only and legacy-only sessions and prefers v2 metadata', { skip }, async () => {
  const { sessions } = await store.listOpencodeSessions(config(), env)
  const byId = new Map(sessions.map((session) => [session.id, session]))
  assert.ok(byId.has(V2_ONLY_SESSION), 'v2-only session must be listed')
  assert.ok(byId.has(LEGACY_ONLY_SESSION), 'legacy-only session must be listed')
  const both = byId.get(BOTH_SESSION)
  assert.equal(both.name, 'Both chat')
  assert.deepEqual(both.model, { provider: 'both-provider', id: 'both-model' })
  assert.equal(both.modified, '2026-01-08T00:00:00.000Z')
})

test('suppresses auto-generated session titles but keeps real ones', { skip }, async () => {
  const { sessions } = await store.listOpencodeSessions(config(), env)
  const byId = new Map(sessions.map((session) => [session.id, session]))
  assert.equal(byId.get(V2_SESSION).name, undefined)
  assert.equal(byId.get(LEGACY_ONLY_SESSION).name, 'Legacy only')
})

test('derives cwd, timestamps, model, message counts and first message', { skip }, async () => {
  const { sessions } = await store.listOpencodeSessions(config(), env)
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const legacy = byId.get(LEGACY_SESSION)
  assert.equal(legacy.cwd, '/work/demo')
  assert.equal(legacy.created, '2026-01-02T00:00:00.000Z')
  assert.equal(legacy.modified, '2026-01-05T00:00:00.000Z')
  assert.equal(legacy.firstMessage, 'hello from legacy')
  assert.equal(legacy.messageCount, 2)
  assert.equal(byId.get(LEGACY_ONLY_SESSION).model.provider, 'legacy-provider')
  assert.equal(byId.get(V2_ONLY_SESSION).firstMessage, 'hello from v2')
  assert.equal(byId.get(V2_ONLY_SESSION).parentId, undefined)
  assert.equal(byId.get(CHILD_SESSION).parentId, V2_ONLY_SESSION)
  assert.equal(byId.get(V2_ONLY_SESSION).archived, true)
  assert.equal(byId.get(LEGACY_SESSION).archived, false)
})

test('groups sessions into workspaces like the Pi engine', { skip }, async () => {
  const { opencodeEngine } = await import('../src/backends/opencode/index.js')
  const result = await opencodeEngine.listSessions(config(), env)
  assert.equal(result.root, fixture.dir)
  const workspaces = new Map(result.workspaces.map((workspace) => [workspace.path, workspace]))
  assert.deepEqual([...workspaces.keys()].sort(), ['/work/demo', '/work/long', '/work/other', '/work/shared'])
  assert.equal(workspaces.get('/work/other').name, 'other')
  assert.equal(workspaces.get('/work/other').sessionCount, 3)
  assert.equal(workspaces.get('/work/demo').sessionCount, 2)
  // Every listed session keeps its OpenCode id as the browser-facing key.
  assert.ok(result.sessions.every((session) => session.nativeKey === session.key && session.id === session.key))
})

test('clips long first messages in list previews', { skip }, async () => {
  const { sessions } = await store.listOpencodeSessions(config(), env)
  const long = sessions.find((session) => session.id === LONG_MESSAGE_SESSION)
  assert.equal(long.firstMessage.length, 2001)
  assert.ok(long.firstMessage.endsWith('…'))
})

test('bounds the session list', { skip }, async () => {
  const { sessions } = await store.listOpencodeSessions(config(), env, { limit: 2 })
  assert.equal(sessions.length, 2)
  assert.equal(sessions[0].id, V2_ONLY_SESSION)
})

test('reads a legacy transcript as Pi-shaped messages with paired tool results', { skip }, async () => {
  const session = await store.readOpencodeSession(LEGACY_SESSION, config(), env)
  assert.equal(session.id, LEGACY_SESSION)
  assert.equal(session.name, 'Legacy chat')
  assert.deepEqual(session.model, { provider: 'legacy-provider', id: 'legacy-model' })
  assert.equal(session.messages.length, 4)
  assert.deepEqual(session.messages[0], {
    role: 'user',
    content: [{ type: 'text', text: 'hello from legacy' }],
    timestamp: 1,
  })
  const assistant = session.messages[1]
  assert.equal(assistant.role, 'assistant')
  assert.deepEqual(assistant.content[0], { type: 'thinking', thinking: 'mulling it over' })
  assert.deepEqual(assistant.content[1], { type: 'text', text: 'legacy answer' })
  assert.deepEqual(assistant.content[2].type, 'toolCall')
  assert.equal(assistant.content[2].id, 'call_read')
  assert.equal(assistant.content[2].name, 'read')
  assert.deepEqual(assistant.content[2].arguments, { filePath: 'README.md', path: 'README.md' })
  // Tool results follow their assistant message, in call order.
  assert.equal(session.messages[2].role, 'toolResult')
  assert.equal(session.messages[2].toolCallId, 'call_read')
  assert.equal(session.messages[2].content[0].text, 'file body')
  assert.equal(session.messages[2].isError, false)
  assert.equal(session.messages[3].toolCallId, 'call_grep')
  assert.equal(session.messages[3].isError, true)
  assert.equal(session.messages[3].content[0].text, 'no matches')
  assert.deepEqual(session.tools, [
    { id: 'call_read', name: 'read', arguments: { filePath: 'README.md', path: 'README.md' }, status: 'completed' },
    { id: 'call_grep', name: 'grep', arguments: { pattern: 'nope' }, status: 'error' },
  ])
  assert.equal(session.firstMessage, 'hello from legacy')
})

test('reads a v2 transcript, translating reasoning and tools to Pi blocks', { skip }, async () => {
  const session = await store.readOpencodeSession(V2_ONLY_SESSION, config(), env)
  assert.equal(session.name, 'V2 only')
  // The message-level model wins over the later `model-switched` record.
  assert.deepEqual(session.model, { provider: 'v2-provider', id: 'v2-model' })
  assert.equal(session.messages.length, 3)
  assert.equal(session.messages[0].role, 'user')
  assert.equal(session.messages[0].content[0].text, 'hello from v2')
  const assistant = session.messages[1]
  assert.deepEqual(assistant.content, [
    { type: 'thinking', thinking: 'v2 reasoning' },
    { type: 'text', text: 'v2 answer' },
    { type: 'toolCall', id: 'call_v2', name: 'bash', arguments: { command: 'echo ok' } },
  ])
  assert.equal(assistant.usage.input, 20)
  assert.equal(assistant.usage.output, 8)
  assert.equal(assistant.usage.cacheRead, 5)
  assert.equal(assistant.usage.cacheWrite, 1)
  assert.equal(session.messages[2].role, 'toolResult')
  assert.equal(session.messages[2].content[0].text, 'ok\n')
  assert.equal(session.messages[2].isError, false)
  // Harness plumbing (system/synthetic/compaction) is not conversation.
  assert.equal(session.messages.some((message) => message.role === 'system'), false)
})

test('reads a session that only has v2 transcript rows', { skip }, async () => {
  const session = await store.readOpencodeSession(BOTH_SESSION, config(), env)
  assert.equal(session.name, 'Both chat')
  assert.equal(session.messages.length, 1)
  assert.equal(session.messages[0].content[0].text, 'both generations')
})

test('rejects malformed native keys before they reach SQL', { skip }, async () => {
  assert.throws(() => store.requireOpencodeSessionId(''), /missing OpenCode session id/)
  assert.throws(() => store.requireOpencodeSessionId('msg_1'), /invalid OpenCode session id/)
  assert.throws(() => store.requireOpencodeSessionId("ses_x'; drop table session; --"), /invalid OpenCode session id/)
  assert.throws(() => store.requireOpencodeSessionId('ses_short'), /invalid OpenCode session id/)
  await assert.rejects(
    store.readOpencodeSession('not-a-session', config(), env),
    /invalid OpenCode session id/,
  )
})

test('reports a missing database with a clear error', { skip }, async () => {
  const missing = { sessionsRoot: join(fixture.dir, 'nope') }
  await assert.rejects(
    store.listOpencodeSessions(missing, env),
    /OpenCode database was not found/,
  )
  await assert.rejects(
    store.readOpencodeSession(LEGACY_SESSION, missing, env),
    /OpenCode database was not found/,
  )
})

test('reports a missing session with a 404 status', { skip }, async () => {
  await assert.rejects(
    store.readOpencodeSession('ses_missing00000000000000000001', config(), env),
    (error) => error.status === 404,
  )
})

test('translates OpenCode tool names and filePath arguments', { skip }, () => {
  assert.equal(store.bridgeToolName('bash'), 'bash')
  assert.equal(store.bridgeToolName('glob'), 'glob')
  assert.equal(store.bridgeToolName('grep'), 'grep')
  assert.equal(store.bridgeToolName('webfetch'), 'web_fetch')
  assert.equal(store.bridgeToolName('patch'), 'edit')
  assert.equal(store.bridgeToolName('apply_patch'), 'edit')
  assert.equal(store.bridgeToolName('todowrite'), 'others')
  assert.equal(store.bridgeToolName(undefined), 'others')
  assert.deepEqual(store.bridgeToolArguments({ filePath: 'a.md' }), { filePath: 'a.md', path: 'a.md' })
  assert.deepEqual(store.bridgeToolArguments({ path: 'a.md' }), { path: 'a.md' })
  assert.deepEqual(store.bridgeToolArguments({}), {})
  assert.deepEqual(store.bridgeToolArguments(undefined), {})
})

test('normalizes a live API transcript into the same vocabulary', { skip }, () => {
  const transcript = store.messagesFromApiEntries([
    {
      info: { id: 'msg_u', role: 'user', time: { created: 1 } },
      parts: [{ type: 'text', text: 'live prompt' }],
    },
    {
      info: {
        id: 'msg_a',
        role: 'assistant',
        time: { created: 2, completed: 3 },
        providerID: 'fake',
        modelID: 'fake-model',
        tokens: { input: 1, output: 2, cache: { read: 3, write: 4 } },
      },
      parts: [
        { type: 'reasoning', text: 'thinking live' },
        { type: 'text', text: 'live answer' },
        {
          type: 'tool',
          callID: 'call_live',
          tool: 'bash',
          state: { status: 'error', input: { command: 'false' }, error: 'exit 1' },
        },
      ],
    },
  ])
  assert.equal(transcript.messages.length, 3)
  assert.deepEqual(transcript.messages[0], { role: 'user', content: [{ type: 'text', text: 'live prompt' }], timestamp: 1 })
  assert.deepEqual(transcript.messages[1].content[0], { type: 'thinking', thinking: 'thinking live' })
  assert.equal(transcript.messages[1].usage.input, 1)
  assert.equal(transcript.messages[2].role, 'toolResult')
  assert.equal(transcript.messages[2].isError, true)
  assert.deepEqual(transcript.tools, [{ id: 'call_live', name: 'bash', arguments: { command: 'false' }, status: 'error' }])
  assert.deepEqual(transcript.model, { provider: 'fake', id: 'fake-model' })
})

test('drops unknown and non-conversational part types', { skip }, () => {
  // OpenCode adds part kinds over time (subtask, snapshot, retry, …). An
  // unknown one must be ignored rather than surfaced as an unrenderable block,
  // and the surrounding text must survive.
  const transcript = store.messagesFromApiEntries([
    {
      info: { id: 'msg_u', role: 'assistant', time: { created: 1 }, providerID: 'p', modelID: 'x' },
      parts: [
        { type: 'future-part', data: { anything: true } },
        { type: 'text', text: 'kept' },
        { type: 'subtask', prompt: 'nested agent' },
        { type: 'step-start' },
        { type: 'snapshot', snapshot: 'abc' },
        { type: 'tool', callID: 'c1', tool: 'todowrite', state: { status: 'pending', input: {} } },
      ],
    },
  ])
  assert.deepEqual(transcript.messages[0].content, [
    { type: 'text', text: 'kept' },
    { type: 'toolCall', id: 'c1', name: 'others', arguments: {} },
  ])
  // An assistant message with nothing renderable is dropped entirely.
  const empty = store.messagesFromApiEntries([
    { info: { id: 'msg_e', role: 'assistant', time: { created: 1 } }, parts: [{ type: 'step-start' }] },
  ])
  assert.deepEqual(empty.messages, [])
})

test('drops an assistant message with no tool-call id', { skip }, () => {
  const transcript = store.messagesFromApiEntries([
    {
      info: { id: 'msg_a', role: 'assistant', time: { created: 1 } },
      parts: [{ type: 'tool', tool: 'bash', state: { status: 'completed', input: {}, output: 'x' } }],
    },
  ])
  // Without a call id the browser cannot pair the result with a tool row, so
  // the block must not be emitted at all.
  assert.deepEqual(transcript.messages, [])
  assert.deepEqual(transcript.tools, [])
})

test('shapes a created API session into the listed summary form', { skip }, () => {
  const summary = store.summaryFromApiSession({
    id: 'ses_created00000000000000000001',
    directory: '/work/new',
    title: 'New session - 2026-03-01T00:00:00.000Z',
    model: { id: 'm1', providerID: 'p1' },
    time: { created: 1000, updated: 2000 },
  })
  assert.equal(summary.key, 'ses_created00000000000000000001')
  assert.equal(summary.nativeKey, summary.id)
  assert.equal(summary.name, undefined)
  assert.equal(summary.cwd, '/work/new')
  assert.equal(summary.created, '1970-01-01T00:00:01.000Z')
  assert.deepEqual(summary.model, { provider: 'p1', id: 'm1' })
  assert.deepEqual(summary.messages, [])
})

test('keeps a failed v1 turn that produced no content blocks', { skip }, () => {
  // Same invariant as the 2.x reader: a provider/quota failure is recorded on
  // the assistant message with an empty part list, and dropping it hides the
  // turn from the transcript entirely.
  const transcript = store.messagesFromSessionMessages([
    {
      id: 'msg_user',
      type: 'user',
      seq: 1,
      time_created: 1000,
      data: JSON.stringify({ text: 'do the thing', time: { created: 1000 } }),
    },
    {
      id: 'msg_failed',
      type: 'assistant',
      seq: 2,
      time_created: 1100,
      data: JSON.stringify({
        time: { created: 1100, completed: 1200 },
        model: { id: 'm1', providerID: 'p1' },
        content: [],
        finish: 'error',
        error: { type: 'provider.free-limit', message: 'Free usage limit reached.' },
      }),
    },
  ])
  assert.equal(transcript.messages.length, 2)
  const failed = transcript.messages[1]
  assert.equal(failed.role, 'assistant')
  assert.equal(failed.errorMessage, 'Free usage limit reached.')
})

test('formats the assistant error record for display', { skip }, () => {
  assert.equal(store.assistantErrorMessage({ type: 'provider.auth', message: 'virtual key is required' }), 'virtual key is required')
  assert.equal(store.assistantErrorMessage({ name: 'provider.error' }), 'provider.error')
  assert.equal(store.assistantErrorMessage({ type: 'aborted' }), 'aborted')
  assert.equal(store.assistantErrorMessage(undefined), undefined)
  assert.equal(store.assistantErrorMessage(null), undefined)
  assert.equal(store.assistantErrorMessage({}), undefined)
})
