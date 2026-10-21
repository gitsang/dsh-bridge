import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  listPiSessions,
  pathFromSessionKey,
  readPiSession,
  sessionKey,
} from '../src/backends/pi/session-store.js'

function header(id = 'session-1', cwd = '/work/demo') {
  return { type: 'session', version: 3, id, timestamp: '2026-10-20T00:00:00.000Z', cwd }
}

function message(id, parentId, body) {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: '2026-10-20T00:00:01.000Z',
    message: body,
  }
}

async function writeSession(lines) {
  const root = await mkdtemp(join(tmpdir(), 'pi-sessions-'))
  const project = join(root, '--work-demo--')
  await mkdir(project, { recursive: true })
  const file = join(project, 'session.jsonl')
  await writeFile(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8')
  return { root, file }
}

function baseLines() {
  return [
    header(),
    message('a1', null, { role: 'user', content: [{ type: 'text', text: 'hello pi' }], timestamp: 1 }),
    message('a2', 'a1', {
      role: 'assistant',
      content: [
        { type: 'text', text: 'hi there' },
        { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'README.md' } },
      ],
      timestamp: 2,
    }),
    message('a3', 'a2', {
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'read',
      content: [{ type: 'text', text: 'content' }],
      isError: false,
      timestamp: 3,
    }),
    { type: 'session_info', id: 'a4', parentId: 'a3', timestamp: '2026-10-20T00:00:04.000Z', name: 'Demo chat' },
  ]
}

test('reads header, current branch, messages and tool calls', async () => {
  const { root, file } = await writeSession(baseLines())
  const session = await readPiSession(file)
  assert.equal(session.id, 'session-1')
  assert.equal(session.name, 'Demo chat')
  assert.equal(session.cwd, '/work/demo')
  assert.equal(session.messageCount, 3)
  assert.equal(session.firstMessage, 'hello pi')
  assert.equal(session.messages[1].content[0].text, 'hi there')
  assert.deepEqual(session.tools, [
    { id: 'call-1', name: 'read', arguments: { path: 'README.md' }, status: 'done' },
  ])
  assert.equal(session.key, sessionKey(file))
  assert.equal(pathFromSessionKey(session.key, root), file)
})

test('follows the newest leaf instead of replaying an abandoned branch', async () => {
  const lines = [
    ...baseLines(),
    message('b1', 'a3', { role: 'user', content: [{ type: 'text', text: 'branch two' }], timestamp: 4 }),
    message('b2', 'b1', { role: 'assistant', content: [{ type: 'text', text: 'branch two reply' }], timestamp: 5 }),
  ]
  const { file } = await writeSession(lines)
  const session = await readPiSession(file)
  assert.equal(session.messageCount, 5)
  const texts = session.messages.map((entry) =>
    Array.isArray(entry.content) ? entry.content.map((block) => block.text ?? '').join('') : entry.content,
  )
  assert.deepEqual(texts, ['hello pi', 'hi there', 'content', 'branch two', 'branch two reply'])
})

test('rejects keys outside the sessions root', async () => {
  const { root } = await writeSession(baseLines())
  assert.throws(
    () => pathFromSessionKey(Buffer.from('/etc/passwd.jsonl').toString('base64url'), root),
    /outside the Pi sessions root/,
  )
  assert.throws(() => pathFromSessionKey('', root), /missing session key/)
})

test('lists sessions newest first and clips long previews', async () => {
  const lines = baseLines()
  const { root } = await writeSession(lines)
  const second = join(root, '--other--')
  await mkdir(second, { recursive: true })
  await writeFile(
    join(second, 'newer.jsonl'),
    [header('session-2', '/work/other'), message('c1', null, {
      role: 'user',
      content: [{ type: 'text', text: 'x'.repeat(5000) }],
      timestamp: 1,
    })].map((line) => JSON.stringify(line)).join('\n') + '\n',
    'utf8',
  )
  const sessions = await listPiSessions(root)
  assert.equal(sessions.length, 2)
  assert.equal(sessions[0].id, 'session-2')
  assert.equal(sessions[0].firstMessage.length, 2001)
  assert.equal(sessions[1].name, 'Demo chat')
})

test('skips malformed files while listing', async () => {
  const { root } = await writeSession(baseLines())
  await writeFile(join(root, 'broken.jsonl'), '{not json}\n', 'utf8')
  const sessions = await listPiSessions(root)
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].id, 'session-1')
})
