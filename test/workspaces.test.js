import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createWorkspace,
  defaultWorkspaceName,
  defaultWorkspaceStore,
  deleteWorkspace,
  legacyWorkspacesPath,
  listWorkspaces,
  normalizeWorkspaceStore,
  readWorkspaceStore,
  reconcileWorkspaces,
  removedWorkspacePaths,
  renameWorkspace,
  workspacesPath,
  writeWorkspaceStore,
} from '../src/workspaces.js'

test('default workspace names use the last folder segment, not the path', () => {
  assert.equal(defaultWorkspaceName('/work/demo'), 'demo')
  assert.equal(defaultWorkspaceName('/work/demo/'), 'demo')
  assert.equal(defaultWorkspaceName('C:\\work\\demo'), 'demo')
  assert.equal(defaultWorkspaceName('C:\\work\\demo\\'), 'demo')
  assert.equal(defaultWorkspaceName('/'), '/')
})

test('normalizes legacy auto-generated path titles to the folder name', () => {
  const normalized = normalizeWorkspaceStore({
    bridges: {
      'pi-local': {
        workspaces: [
          { id: '/work/demo', path: '/work/demo', name: '/work/demo' },
          { id: '/work/other', path: '/work/other' },
          { id: 'custom', path: '/work/custom', name: 'My custom name' },
        ],
      },
    },
  })
  const workspaces = normalized.bridges['pi-local'].workspaces
  assert.equal(workspaces.find((workspace) => workspace.path === '/work/demo').name, 'demo')
  assert.equal(workspaces.find((workspace) => workspace.path === '/work/other').name, 'other')
  assert.equal(workspaces.find((workspace) => workspace.path === '/work/custom').name, 'My custom name')
})


test('reconciles discovered cwds without overwriting a user title', () => {
  let store = defaultWorkspaceStore()
  const first = reconcileWorkspaces(store, 'pi-local', [{ id: '/work/demo', name: 'demo' }], '2026-10-20T00:00:00.000Z')
  assert.equal(first.changed, true)
  store = first.store
  const workspace = listWorkspaces(store, 'pi-local')[0]
  assert.equal(workspace.name, 'demo')

  const renamed = renameWorkspace(store, 'pi-local', workspace.id, 'My project', '2026-10-20T00:01:00.000Z')
  store = renamed.store
  const second = reconcileWorkspaces(store, 'pi-local', [
    { id: '/work/demo', name: 'demo' },
    { id: '/work/new', name: 'new' },
  ], '2026-10-20T00:02:00.000Z')
  store = second.store
  const workspaces = listWorkspaces(store, 'pi-local')
  assert.equal(workspaces.length, 2)
  assert.equal(workspaces.find((entry) => entry.path === '/work/demo').name, 'My project')
  assert.equal(workspaces.find((entry) => entry.path === '/work/new').name, 'new')
})

test('delete is a tombstone and a later scan does not resurrect it', () => {
  let store = reconcileWorkspaces(defaultWorkspaceStore(), 'pi-local', [{ id: '/work/demo', name: 'demo' }]).store
  const workspace = listWorkspaces(store, 'pi-local')[0]
  store = deleteWorkspace(store, 'pi-local', workspace.id, '2026-10-20T00:03:00.000Z').store
  assert.deepEqual(listWorkspaces(store, 'pi-local'), [])
  assert.deepEqual(removedWorkspacePaths(store, 'pi-local'), ['/work/demo'])

  const discoveredAgain = reconcileWorkspaces(store, 'pi-local', [{ id: '/work/demo', name: 'demo' }])
  assert.equal(discoveredAgain.changed, false)
  assert.deepEqual(listWorkspaces(discoveredAgain.store, 'pi-local'), [])
  assert.deepEqual(removedWorkspacePaths(discoveredAgain.store, 'pi-local'), ['/work/demo'])
})

test('adding a soft-deleted path revives it with the requested title', () => {
  let store = reconcileWorkspaces(defaultWorkspaceStore(), 'pi-local', [{ id: '/work/demo', name: 'demo' }]).store
  const workspace = listWorkspaces(store, 'pi-local')[0]
  store = deleteWorkspace(store, 'pi-local', workspace.id).store
  const revived = createWorkspace(store, 'pi-local', { path: '/work/demo', name: 'Restored' }, '2026-10-20T00:04:00.000Z')
  assert.equal(revived.workspace.id, workspace.id)
  assert.equal(revived.workspace.name, 'Restored')
  assert.equal(revived.workspace.deletedAt, null)
  assert.deepEqual(removedWorkspacePaths(revived.store, 'pi-local'), [])
})

test('rename and delete resolve a path as well as a record id', () => {
  const path = '/work/demo'
  const created = createWorkspace(defaultWorkspaceStore(), 'pi-local', { path, name: 'demo' })
  const renamed = renameWorkspace(created.store, 'pi-local', path, 'Titled by path', '2026-10-20T00:05:00.000Z')
  assert.equal(renamed.workspace.id, created.workspace.id)
  assert.equal(renamed.workspace.name, 'Titled by path')
  assert.equal(listWorkspaces(renamed.store, 'pi-local')[0].name, 'Titled by path')

  const deleted = deleteWorkspace(renamed.store, 'pi-local', path, '2026-10-20T00:06:00.000Z')
  assert.equal(deleted.workspace.id, created.workspace.id)
  assert.notEqual(deleted.workspace.deletedAt, null)
  assert.deepEqual(listWorkspaces(deleted.store, 'pi-local'), [])
  assert.deepEqual(removedWorkspacePaths(deleted.store, 'pi-local'), [path])
})

test('deleting a session-derived group tombstones the path that has no record', () => {
  const store = deleteWorkspace(defaultWorkspaceStore(), 'pi-local', '/work/legacy', '2026-10-20T00:07:00.000Z').store
  assert.deepEqual(listWorkspaces(store, 'pi-local'), [])
  assert.deepEqual(removedWorkspacePaths(store, 'pi-local'), ['/work/legacy'])

  const rescanned = reconcileWorkspaces(store, 'pi-local', [{ id: '/work/legacy', name: 'legacy' }])
  assert.equal(rescanned.changed, false)
  assert.deepEqual(listWorkspaces(rescanned.store, 'pi-local'), [])
})

test('renaming a session-derived group materializes durable metadata', () => {
  const renamed = renameWorkspace(defaultWorkspaceStore(), 'pi-local', '/work/legacy', 'Legacy', '2026-10-20T00:08:00.000Z')
  assert.equal(renamed.workspace.path, '/work/legacy')
  assert.equal(renamed.workspace.name, 'Legacy')
  assert.equal(typeof renamed.workspace.id, 'string')
  assert.notEqual(renamed.workspace.id, '/work/legacy')
  assert.equal(listWorkspaces(renamed.store, 'pi-local')[0].name, 'Legacy')
})

test('opaque unknown workspace ids stay a 404', () => {
  assert.throws(() => deleteWorkspace(defaultWorkspaceStore(), 'pi-local', 'not-a-path'), { status: 404 })
  assert.throws(() => renameWorkspace(defaultWorkspaceStore(), 'pi-local', 'not-a-path', 'X'), { status: 404 })
})

test('workspace records are bridge-scoped and survive a settings file round trip', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bridge-workspaces-'))
  const env = { ...process.env, DSH_HOME: home }
  const first = createWorkspace(defaultWorkspaceStore(), 'pi-a', { path: '/work/a', name: 'A' })
  const second = createWorkspace(first.store, 'pi-b', { path: '/work/b', name: 'B' })
  const saved = writeWorkspaceStore(second.store, env)
  assert.equal(listWorkspaces(saved, 'pi-a').length, 1)
  assert.equal(listWorkspaces(saved, 'pi-b').length, 1)
  assert.deepEqual(readWorkspaceStore(env), saved)
  assert.equal(workspacesPath(env), join(home, 'bridge', 'workspaces.json'))
  assert.equal((await stat(workspacesPath(env))).mode & 0o777, 0o600)
})

test('adopts the pre-0.4.1 flat workspace file into the data directory', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bridge-workspaces-'))
  const env = { ...process.env, DSH_HOME: home }
  await writeFile(legacyWorkspacesPath(env), JSON.stringify({
    version: 1,
    bridges: { 'pi-a': { workspaces: [{ id: 'w1', path: '/work/a', name: 'A' }] } },
  }), 'utf8')
  const store = readWorkspaceStore(env)
  assert.equal(listWorkspaces(store, 'pi-a')[0].name, 'A')
  assert.equal(existsSync(legacyWorkspacesPath(env)), false)
  assert.deepEqual(readWorkspaceStore(env), store)
})

test('normalizes duplicates and corrupt workspace files back to a safe store', async () => {
  const normalized = normalizeWorkspaceStore({
    bridges: {
      'pi-local': {
        workspaces: [
          { id: 'one', path: '/work', name: 'One' },
          { id: 'two', path: '/work', name: 'Dup' },
          { path: '', name: 'bad' },
        ],
      },
    },
  })
  assert.equal(normalized.bridges['pi-local'].workspaces.length, 1)
  assert.equal(normalized.bridges['pi-local'].workspaces[0].name, 'One')

  const home = await mkdtemp(join(tmpdir(), 'bridge-workspaces-'))
  const env = { ...process.env, DSH_HOME: home }
  await mkdir(join(home, 'bridge'), { recursive: true })
  await writeFile(workspacesPath(env), '{broken', 'utf8')
  const warnings = []
  assert.deepEqual(readWorkspaceStore(env, { warn: (line) => warnings.push(line) }), defaultWorkspaceStore())
  assert.equal(warnings.length, 1)
})
