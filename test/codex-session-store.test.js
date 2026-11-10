import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  bridgeToolName,
  collectRolloutFiles,
  createCodexSession,
  isInjectedUserText,
  listCodexSessions,
  pathFromSessionKey,
  readCodexSession,
  readCodexSessionSummary,
  readRolloutThreadId,
  sessionKey,
} from '../src/backends/codex/session-store.js'
import { codexEngine } from '../src/backends/codex/index.js'

const THREAD_ID = '019e0b6d-c972-72e2-8107-b2df9c0f32e7'

function line(record) {
  return `${JSON.stringify(record)}\n`
}

function rolloutPath(root, day = '02') {
  return join(root, '2026', '01', day, `rollout-2026-01-${day}T10-00-00-${THREAD_ID}.jsonl`)
}

async function writeRollout(root, records, day = '02') {
  const file = rolloutPath(root, day)
  await mkdir(join(root, '2026', '01', day), { recursive: true })
  await writeFile(file, records.map(line).join(''), 'utf8')
  return file
}

function sessionMeta(overrides = {}) {
  return {
    timestamp: '2026-01-02T10:00:00.000Z',
    ordinal: 0,
    type: 'session_meta',
    payload: {
      session_id: THREAD_ID,
      id: THREAD_ID,
      timestamp: '2026-01-02T10:00:00.000Z',
      cwd: '/work/project',
      originator: 'codex-tui',
      cli_version: '0.162.1',
      source: 'cli',
      model_provider: 'openai',
      ...overrides,
    },
  }
}

function message(role, text, type = 'message') {
  return {
    timestamp: '2026-01-02T10:00:01.000Z',
    type: 'response_item',
    payload: { type, role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] },
  }
}

function tempRoot() {
  return mkdtemp(join(tmpdir(), 'dsh-codex-store-'))
}

test('list summaries expose the sidebar fields without a full parse', async () => {
  const root = await tempRoot()
  const file = await writeRollout(root, [
    sessionMeta(),
    { timestamp: '2026-01-02T10:00:00.500Z', type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions>' }] } },
    { timestamp: '2026-01-02T10:00:00.600Z', type: 'turn_context', payload: { cwd: '/work/project', model: 'gpt-5.5', approval_policy: 'never' } },
    message('user', 'Fix the flaky test'),
    message('assistant', 'On it.'),
  ])
  const sessions = await listCodexSessions(root)
  assert.equal(sessions.length, 1)
  const [summary] = sessions
  assert.equal(summary.key, sessionKey(file))
  assert.equal(summary.id, THREAD_ID)
  assert.equal(summary.name, 'Fix the flaky test')
  assert.equal(summary.firstMessage, 'Fix the flaky test')
  assert.equal(summary.cwd, '/work/project')
  assert.deepEqual(summary.model, { provider: 'openai', id: 'gpt-5.5' })
  assert.equal(summary.created, '2026-01-02T10:00:00.000Z')
  assert.equal(summary.messageCount, undefined)
  assert.equal(summary.bytes, (await stat(file)).size)
  assert.equal(typeof summary.modified, 'string')
})

test('list summaries read the head and the tail of a large rollout', async () => {
  const root = await tempRoot()
  const file = rolloutPath(root)
  await mkdir(join(root, '2026', '01', '02'), { recursive: true })
  const filler = message('developer', 'x'.repeat(2000))
  const records = [sessionMeta(), message('user', 'First real prompt')]
  // Push the file past the summary window, then stamp a later turn context and
  // a second real turn near the tail; a whole-file parse would see both.
  for (let index = 0; index < 220; index += 1) records.push(filler)
  records.push({ timestamp: '2026-01-02T11:00:00.000Z', type: 'turn_context', payload: { cwd: '/work/tail', model: 'gpt-6.1' } })
  records.push(message('assistant', 'tail answer'))
  await writeFile(file, records.map(line).join(''), 'utf8')
  const summary = readCodexSessionSummary(file)
  assert.equal(summary.name, 'First real prompt')
  assert.equal(summary.cwd, '/work/tail')
  assert.deepEqual(summary.model, { provider: 'openai', id: 'gpt-6.1' })
})

test('workspace grouping matches the Pi engine shape', async () => {
  const root = await tempRoot()
  await writeRollout(root, [sessionMeta(), message('user', 'one')], '02')
  await writeRollout(root, [
    sessionMeta({ session_id: 'aaaabbbb-cccc-4ddd-8eee-ffff00001111' }),
    message('user', 'two'),
  ], '03')
  const result = await codexEngine.listSessions({ sessionsRoot: root }, {})
  assert.equal(result.root, root)
  assert.equal(result.sessions.length, 2)
  const workspace = result.workspaces.find((entry) => entry.path === '/work/project')
  assert.equal(workspace.name, 'project')
  assert.equal(workspace.sessionCount, 2)
})

test('session keys validate the root and the .jsonl suffix', () => {
  const root = '/work/sessions'
  assert.throws(
    () => pathFromSessionKey(sessionKey('/work/sessions/2026/01/02/rollout.txt'), root),
    /must be a \.jsonl file/,
  )
  assert.throws(
    () => pathFromSessionKey(sessionKey('/work/other/rollout.jsonl'), root),
    /outside the Codex sessions root/,
  )
  assert.throws(() => pathFromSessionKey(''), /missing session key/)
  assert.equal(
    pathFromSessionKey(sessionKey('/work/sessions/2026/01/02/rollout-1.jsonl'), root),
    '/work/sessions/2026/01/02/rollout-1.jsonl',
  )
})

test('readSession normalizes the transcript into the Pi block vocabulary', async () => {
  const root = await tempRoot()
  const file = await writeRollout(root, [
    sessionMeta(),
    { timestamp: '2026-01-02T10:00:00.100Z', type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'harness plumbing' }] } },
    { timestamp: '2026-01-02T10:00:00.200Z', type: 'response_item', payload: { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'system prompt' }] } },
    message('user', 'Please refactor the parser'),
    { timestamp: '2026-01-02T10:00:01.000Z', type: 'response_item', payload: { type: 'reasoning', summary: [], content: [], encrypted_content: 'gAAAA-secret' } },
    { timestamp: '2026-01-02T10:00:02.000Z', type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Reading the parser first.' }], content: [] } },
    message('assistant', 'Starting now.'),
    {
      timestamp: '2026-01-02T10:00:03.000Z',
      type: 'response_item',
      payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"rg parser"}', call_id: 'call-1' },
    },
    {
      timestamp: '2026-01-02T10:00:04.000Z',
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'call-1', output: 'src/parser.js\n' },
    },
    {
      timestamp: '2026-01-02T10:00:05.000Z',
      type: 'response_item',
      payload: { type: 'custom_tool_call', status: 'completed', name: 'apply_patch', call_id: 'call-2', input: '*** Begin Patch\n*** Update File: src/parser.js\n@@\n-a\n+b\n*** End Patch' },
    },
    {
      timestamp: '2026-01-02T10:00:06.000Z',
      type: 'response_item',
      payload: { type: 'custom_tool_call_output', call_id: 'call-2', output: '{"output":"Success."}' },
    },
  ])
  const session = await readCodexSession(file)
  assert.equal(session.name, 'Please refactor the parser')
  assert.equal(session.firstMessage, 'Please refactor the parser')
  assert.equal(session.cwd, '/work/project')
  assert.equal(session.messageCount, session.messages.length)
  // developer/system payloads are harness plumbing and never enter the transcript.
  assert.equal(session.messages.some((entry) => entry.content.some((block) => block.text === 'harness plumbing')), false)
  assert.equal(session.messages.some((entry) => entry.content.some((block) => block.text === 'system prompt')), false)
  const assistant = session.messages.find((entry) => entry.role === 'assistant')
  assert.deepEqual(assistant.content[0], { type: 'thinking', thinking: 'Reading the parser first.' })
  assert.equal(assistant.content[1].type, 'text')
  // Encrypted reasoning has no readable text and must never surface.
  assert.equal(JSON.stringify(session.messages).includes('gAAAA-secret'), false)
  const toolCalls = assistant.content.filter((block) => block.type === 'toolCall')
  assert.equal(toolCalls.length, 2)
  assert.deepEqual(toolCalls[0].arguments, { cmd: 'rg parser' })
  // History names use the client's narrow vocabulary, exactly like live
  // tool-start events, so a durable transcript and a streaming one agree.
  assert.equal(toolCalls[0].name, 'bash')
  assert.equal(toolCalls[1].name, 'edit')
  assert.equal(toolCalls[1].arguments.path, 'src/parser.js')
  const results = session.messages.filter((entry) => entry.role === 'toolResult')
  assert.deepEqual(results.map((entry) => entry.toolCallId), ['call-1', 'call-2'])
  assert.equal(results[0].content[0].text, 'src/parser.js\n')
  assert.equal(results[0].isError, false)
  assert.deepEqual(session.tools.map((tool) => tool.id), ['call-1', 'call-2'])
  assert.deepEqual(session.tools.map((tool) => tool.status), ['done', 'done'])
})

test('history tool names match the live vocabulary for every Codex tool shape', async () => {
  // The browser styles a tool row from its name. A history row whose name came
  // straight from Codex (`exec`, `apply_patch`) would render as a generic row
  // while the same call streamed live rendered as a bash/edit row.
  for (const name of ['shell', 'exec', 'exec_command', 'local_shell', 'bash']) {
    assert.equal(bridgeToolName(name), 'bash', name)
  }
  for (const name of ['apply_patch', 'fileChange']) assert.equal(bridgeToolName(name), 'edit', name)
  assert.equal(bridgeToolName('read_file'), 'read')
  assert.equal(bridgeToolName('web_search'), 'search')
  assert.equal(bridgeToolName('wait'), 'others')
  assert.equal(bridgeToolName(undefined), 'others')

  const root = await tempRoot()
  const file = await writeRollout(root, [
    sessionMeta(),
    { timestamp: '2026-01-02T10:00:01.000Z', type: 'turn_context', payload: { cwd: '/work/project' } },
    { timestamp: '2026-01-02T10:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] } },
    {
      timestamp: '2026-01-02T10:00:03.000Z',
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        status: 'completed',
        name: 'exec',
        call_id: 'call-exec',
        input: 'const r = await Promise.all([tools.exec_command({cmd:"rg parser",workdir:"/work"})])',
      },
    },
  ])
  const session = await readCodexSession(file)
  const call = session.messages.flatMap((entry) => entry.content ?? []).find((block) => block.type === 'toolCall')
  assert.equal(call.name, 'bash')
  // The scripted `exec` shape hides its command one level down; the row must be
  // able to name it instead of printing the whole script.
  assert.equal(call.arguments.command, 'rg parser')
})

test('readSession prefers response items over the duplicate event_msg copies', async () => {
  const root = await tempRoot()
  const file = await writeRollout(root, [
    sessionMeta(),
    message('user', '# AGENTS.md instructions for /work/project\n<INSTRUCTIONS>rules</INSTRUCTIONS>'),
    { timestamp: '2026-01-02T10:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'Real question?' } },
    { timestamp: '2026-01-02T10:00:02.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Real answer.' } },
    message('assistant', 'Real answer.'),
  ])
  const session = await readCodexSession(file)
  // Exactly one user turn: the injected AGENTS.md user item and the event_msg
  // echo are both duplicates of durable content.
  const users = session.messages.filter((entry) => entry.role === 'user')
  assert.equal(users.length, 1)
  assert.equal(users[0].content[0].text, 'Real question?')
  const assistants = session.messages.filter((entry) => entry.role === 'assistant')
  assert.equal(assistants.length, 1)
  assert.equal(assistants[0].content[0].text, 'Real answer.')
  assert.equal(session.name, 'Real question?')
})

test('injected harness user text is recognized', () => {
  assert.equal(isInjectedUserText('<environment_context>\n<cwd>/x</cwd>'), true)
  assert.equal(isInjectedUserText('# AGENTS.md instructions for /x'), true)
  assert.equal(isInjectedUserText('  <turn_aborted>'), true)
  assert.equal(isInjectedUserText('Fix the parser'), false)
})

test('createSession writes one resumable session_meta header', async () => {
  const root = await tempRoot()
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-codex-work-'))
  const session = await createCodexSession(workspace, root, {
    cliVersion: '0.162.1',
    modelProvider: 'openai',
  })
  assert.equal(session.nativeKey, undefined)
  const file = pathFromSessionKey(session.key, root)
  const text = await readFile(file, 'utf8')
  const lines = text.trim().split('\n')
  assert.equal(lines.length, 1)
  const header = JSON.parse(lines[0])
  assert.equal(header.type, 'session_meta')
  assert.equal(header.payload.session_id, session.id)
  assert.equal(header.payload.cwd, workspace)
  assert.equal(header.payload.cli_version, '0.162.1')
  assert.equal(header.payload.model_provider, 'openai')
  assert.equal(header.payload.originator, 'dsh-bridge')
  assert.equal(header.payload.source, 'cli')
  const info = await stat(file)
  assert.equal(info.mode & 0o777, 0o600)
  assert.equal(session.name, undefined)
  assert.equal(session.firstMessage, '')
  // The file is a real rollout as far as this module is concerned.
  const reread = await readCodexSession(file)
  assert.equal(reread.id, session.id)
  assert.equal(reread.cwd, workspace)
})

test('createSession refuses a cwd that is not a directory', async () => {
  const root = await tempRoot()
  await assert.rejects(createCodexSession('/definitely/not/a/real/cwd', root), /ENOENT|not a directory/)
})

test('collectRolloutFiles walks the date tree newest first', async () => {
  const root = await tempRoot()
  const older = await writeRollout(root, [sessionMeta(), message('user', 'older')], '02')
  const newer = await writeRollout(root, [sessionMeta(), message('user', 'newer')], '03')
  // Set explicit mtimes: two writes in one test can land in the same
  // millisecond, and newest-first is mtime order, not filename order.
  await utimes(older, new Date('2026-01-02T10:00:00Z'), new Date('2026-01-02T10:00:00Z'))
  await utimes(newer, new Date('2026-01-03T10:00:00Z'), new Date('2026-01-03T10:00:00Z'))
  const files = collectRolloutFiles(root)
  assert.equal(files.length, 2)
  assert.ok(files[0].endsWith('03/rollout-2026-01-03T10-00-00-019e0b6d-c972-72e2-8107-b2df9c0f32e7.jsonl'))
})

test('rollout thread ids come from the header and fall back to the filename', async () => {
  const root = await tempRoot()
  const file = await writeRollout(root, [sessionMeta(), message('user', 'hello')])
  assert.equal(readRolloutThreadId(file), THREAD_ID)
  const empty = join(root, 'rollout-2026-01-02T10-00-00-aaaabbbb-cccc-4ddd-8eee-ffff00001111.jsonl')
  await writeFile(empty, '', 'utf8')
  assert.equal(readRolloutThreadId(empty), 'aaaabbbb-cccc-4ddd-8eee-ffff00001111')
})
