import assert from 'node:assert/strict'
import { mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  defaultImportStore,
  deleteBridgeImports,
  importsPath,
  importSessions,
  isSessionImported,
  listImportedSessionKeys,
  normalizeImportStore,
  readImportStore,
  writeImportStore,
} from '../src/imports.js'

test('imports are bridge-scoped, ordered, and idempotent', () => {
  let store = defaultImportStore()
  const first = importSessions(store, 'pi-a', ['one', 'two', 'one'])
  assert.equal(first.changed, true)
  assert.deepEqual(first.addedKeys, ['one', 'two'])
  assert.deepEqual(listImportedSessionKeys(first.store, 'pi-a'), ['one', 'two'])
  store = first.store

  const second = importSessions(store, 'pi-a', ['two', 'three'])
  assert.deepEqual(second.addedKeys, ['three'])
  assert.deepEqual(listImportedSessionKeys(second.store, 'pi-a'), ['one', 'two', 'three'])
  store = second.store

  const other = importSessions(store, 'pi-b', ['one'])
  assert.deepEqual(listImportedSessionKeys(other.store, 'pi-b'), ['one'])
  assert.equal(isSessionImported(other.store, 'pi-a', 'three'), true)
  assert.equal(isSessionImported(other.store, 'pi-a', 'missing'), false)

  const noop = importSessions(other.store, 'pi-a', ['one', 'two'])
  assert.equal(noop.changed, false)
  assert.deepEqual(noop.addedKeys, [])
})

test('delete removes only one bridge import set', () => {
  let store = importSessions(defaultImportStore(), 'pi-a', ['one']).store
  store = importSessions(store, 'pi-b', ['two']).store
  const removed = deleteBridgeImports(store, 'pi-a')
  assert.equal(removed.changed, true)
  assert.equal(removed.store.bridges['pi-a'], undefined)
  assert.deepEqual(listImportedSessionKeys(removed.store, 'pi-b'), ['two'])
  assert.equal(deleteBridgeImports(removed.store, 'pi-a').changed, false)
})

test('normalizes corrupt records and survives a file round trip', async () => {
  const normalized = normalizeImportStore({
    bridges: {
      'pi-a': { sessionKeys: ['one', 'one', '', 4, 'two'] },
      '': ['ignored'],
      'pi-b': ['three'],
    },
  })
  assert.deepEqual(normalized.bridges['pi-a'].sessionKeys, ['one', 'two'])
  assert.deepEqual(normalized.bridges['pi-b'].sessionKeys, ['three'])
  assert.equal(normalized.bridges[''], undefined)

  const home = await mkdtemp(join(tmpdir(), 'bridge-imports-'))
  const env = { ...process.env, DSH_HOME: home }
  const saved = writeImportStore(normalized, env)
  assert.deepEqual(readImportStore(env), saved)
  assert.equal(importsPath(env), join(home, 'bridge-imports.json'))
  assert.equal((await stat(importsPath(env))).mode & 0o777, 0o600)

  await writeFile(importsPath(env), '{broken', 'utf8')
  const warnings = []
  assert.deepEqual(readImportStore(env, { warn: (line) => warnings.push(line) }), defaultImportStore())
  assert.equal(warnings.length, 1)
})
