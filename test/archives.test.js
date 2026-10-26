import assert from 'node:assert/strict'
import { mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  archiveSession,
  archivesPath,
  defaultArchiveStore,
  deleteBridgeArchives,
  isSessionArchived,
  listArchivedSessionKeys,
  normalizeArchiveStore,
  readArchiveStore,
  unarchiveSession,
  writeArchiveStore,
} from '../src/archives.js'

test('archives are bridge-scoped, ordered, and idempotent', () => {
  let store = defaultArchiveStore()
  const first = archiveSession(store, 'pi-a', '/sessions/a.jsonl')
  assert.equal(first.changed, true)
  store = first.store
  const second = archiveSession(store, 'pi-a', '/sessions/b.jsonl')
  store = second.store
  const duplicate = archiveSession(store, 'pi-a', '/sessions/a.jsonl')
  assert.equal(duplicate.changed, false)
  assert.deepEqual(listArchivedSessionKeys(duplicate.store, 'pi-a'), ['/sessions/a.jsonl', '/sessions/b.jsonl'])
  assert.deepEqual(listArchivedSessionKeys(store, 'pi-b'), [])
  assert.equal(isSessionArchived(store, 'pi-a', '/sessions/a.jsonl'), true)
  assert.equal(isSessionArchived(store, 'pi-b', '/sessions/a.jsonl'), false)
})

test('unarchive and bridge deletion are idempotent', () => {
  let store = archiveSession(defaultArchiveStore(), 'pi-a', '/a.jsonl').store
  store = archiveSession(store, 'pi-a', '/b.jsonl').store
  const removed = unarchiveSession(store, 'pi-a', '/a.jsonl')
  assert.equal(removed.changed, true)
  assert.deepEqual(listArchivedSessionKeys(removed.store, 'pi-a'), ['/b.jsonl'])
  const missing = unarchiveSession(removed.store, 'pi-a', '/missing.jsonl')
  assert.equal(missing.changed, false)

  const deleted = deleteBridgeArchives(removed.store, 'pi-a')
  assert.equal(deleted.changed, true)
  assert.deepEqual(listArchivedSessionKeys(deleted.store, 'pi-a'), [])
  assert.equal(deleteBridgeArchives(deleted.store, 'pi-a').changed, false)
})

test('normalizes corrupt records and survives a file round trip', async () => {
  const normalized = normalizeArchiveStore({
    bridges: {
      'pi-a': { sessionKeys: ['/a', '/a', '', null, '/b'] },
      'pi-b': ['/c', '/c'],
      '': ['/ignored'],
    },
  })
  assert.deepEqual(listArchivedSessionKeys(normalized, 'pi-a'), ['/a', '/b'])
  assert.deepEqual(listArchivedSessionKeys(normalized, 'pi-b'), ['/c'])
  assert.deepEqual(Object.keys(normalized.bridges).sort(), ['pi-a', 'pi-b'])

  const home = await mkdtemp(join(tmpdir(), 'bridge-archives-'))
  const env = { ...process.env, DSH_HOME: home }
  const saved = writeArchiveStore(normalized, env)
  assert.deepEqual(readArchiveStore(env), saved)
  assert.equal(archivesPath(env), join(home, 'bridge-archives.json'))
  assert.equal((await stat(archivesPath(env))).mode & 0o777, 0o600)

  await writeFile(archivesPath(env), '{broken', 'utf8')
  const warnings = []
  assert.deepEqual(readArchiveStore(env, { warn: (line) => warnings.push(line) }), defaultArchiveStore())
  assert.equal(warnings.length, 1)
})
