import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { afterEach, beforeEach } from 'node:test'
import { apply, name, sessionKey } from '../src/index.js'
import { readArchiveStore } from '../src/archives.js'

const fake = new URL('./fixtures/fake-pi.mjs', import.meta.url).pathname

// Never let a host test touch the real ~/.dsh bridge store.
let originalHome
let originalAutoConnect
let testHome
beforeEach(async () => {
  originalHome = process.env.DSH_HOME
  originalAutoConnect = process.env.BRIDGE_AUTO_CONNECT
  testHome = await mkdtemp(join(tmpdir(), 'bridge-plugin-env-'))
  process.env.DSH_HOME = testHome
  // Most tests drive routes directly; the auto-connect probe is covered by its
  // own test. Disabling it keeps unit tests from spawning agent processes.
  process.env.BRIDGE_AUTO_CONNECT = '0'
})
afterEach(async () => {
  if (originalHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalHome
  if (originalAutoConnect === undefined) delete process.env.BRIDGE_AUTO_CONNECT
  else process.env.BRIDGE_AUTO_CONNECT = originalAutoConnect
  if (testHome !== undefined) await rm(testHome, { recursive: true, force: true })
})

function host() {
  const routes = new Map()
  const disposers = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route)
          return async () => routes.delete(route.path)
        },
      },
    },
    effect(factory) {
      const dispose = factory()
      disposers.push(dispose)
      return dispose
    },
  }
  return { ctx, routes, disposers }
}

async function fixtureSession() {
  const root = await mkdtemp(join(tmpdir(), 'bridge-plugin-'))
  const project = join(root, '--work--')
  await mkdir(project, { recursive: true })
  const file = join(project, 'session.jsonl')
  const lines = [
    { type: 'session', version: 3, id: 'session-x', timestamp: '2026-10-20T00:00:00.000Z', cwd: '/work' },
    {
      type: 'message',
      id: 'm1',
      parentId: null,
      timestamp: '2026-10-20T00:00:01.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'old question' }], timestamp: 1 },
    },
  ]
  await writeFile(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8')
  return { root, file }
}

function call(routes, path, init = {}) {
  const pathname = path.split('?', 1)[0]
  const route = routes.get(`/api/bridge/${pathname}`)
  assert.ok(route, `route ${pathname} registered`)
  return route.fetch(new Request(`http://127.0.0.1/api/bridge/${path}`, init))
}

function json(method, body) {
  return { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
}

const post = (body) => json('POST', body)
const put = (body) => json('PUT', body)
const del = (body) => json('DELETE', body)

async function settings(routes) {
  return (await call(routes, 'settings')).json()
}

test('registers the bridge-instance route table', () => {
  const { ctx, routes } = host()
  apply(ctx)
  assert.equal(name, 'bridge')
  assert.deepEqual([...routes.keys()].sort(), [
    '/api/bridge/abort',
    '/api/bridge/activity',
    '/api/bridge/archive',
    '/api/bridge/attach',
    '/api/bridge/bridges',
    '/api/bridge/capabilities',
    '/api/bridge/detach',
    '/api/bridge/directories',
    '/api/bridge/events',
    '/api/bridge/history-message',
    '/api/bridge/models',
    '/api/bridge/prompt',
    '/api/bridge/session',
    '/api/bridge/sessions',
    '/api/bridge/settings',
    '/api/bridge/state',
    '/api/bridge/stats',
    '/api/bridge/status',
    '/api/bridge/ui-response',
    '/api/bridge/workspaces',
  ])
})


test('lists and creates local directories for the workspace picker', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bridge-directories-home-'))
  const root = await mkdtemp(join(tmpdir(), 'bridge-directories-'))
  await mkdir(join(root, 'alpha'))
  await mkdir(join(root, '.hidden'))
  await writeFile(join(root, 'plain.txt'), 'x', 'utf8')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { ctx, routes } = host()
    apply(ctx)

    const listed = await (await call(routes, `directories?path=${encodeURIComponent(root)}`)).json()
    assert.equal(listed.ok, true)
    assert.equal(listed.path, root)
    assert.deepEqual(listed.entries.map((entry) => entry.name), ['.hidden', 'alpha'])
    assert.equal(listed.entries.find((entry) => entry.name === '.hidden').hidden, true)

    const created = await (await call(routes, 'directories', post({ path: root, name: 'beta' }))).json()
    assert.equal(created.ok, true)
    assert.equal(created.path, join(root, 'beta'))
    const refreshed = await (await call(routes, `directories?path=${encodeURIComponent(root)}`)).json()
    assert.ok(refreshed.entries.some((entry) => entry.name === 'beta'))

    const conflict = await call(routes, 'directories', post({ path: root, name: 'beta' }))
    assert.equal(conflict.status, 409)
    const traversal = await call(routes, 'directories', post({ path: root, name: '../escape' }))
    assert.equal(traversal.status, 400)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})

test('settings expose modes, engines and one default bridge', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bridge-plugin-home-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { ctx, routes } = host()
    apply(ctx)
    const body = await settings(routes)
    assert.equal(body.ok, true)
    assert.deepEqual(body.modes.map((mode) => mode.id), ['cli', 'web'])
    assert.deepEqual(body.engines.map((engine) => engine.id), ['pi', 'codex', 'opencode', 'dsh'])
    assert.equal(body.bridges.length, 1)
    assert.equal(body.bridges[0].id, 'pi-local')
    assert.equal(body.bridges[0].engine, 'pi')
    assert.equal(body.bridges[0].available, true)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})

test('lists and reads Pi sessions through a configured bridge', async () => {
  const { root, file } = await fixtureSession()
  const previousRoot = process.env.PI_CODING_AGENT_SESSION_DIR
  process.env.PI_CODING_AGENT_SESSION_DIR = root
  try {
    const { ctx, routes, disposers } = host()
    apply(ctx)
    try {
      const configured = await (await call(routes, 'bridges', put({
        id: 'pi-local',
        config: { sessionsRoot: root },
      }))).json()
      assert.equal(configured.bridges[0].config.sessionsRoot, root)

      const listed = await (await call(routes, 'sessions?bridge=pi-local')).json()
      assert.equal(listed.ok, true)
      assert.equal(listed.bridge.id, 'pi-local')
      assert.equal(listed.engine, 'pi')
      assert.equal(listed.sessions.length, 1)
      assert.equal(listed.sessions[0].id, 'session-x')
      assert.equal(listed.sessions[0].bridge, 'pi-local')
      assert.equal(listed.sessions[0].engine, 'pi')
      assert.equal(listed.workspaces.length, 1)
      assert.equal(listed.workspaces[0].path, '/work')
      assert.equal(listed.workspaces[0].name, 'work')
      assert.equal(listed.workspaces[0].sessionCount, 1)
      assert.equal(typeof listed.workspaces[0].id, 'string')

      const key = listed.sessions[0].key
      assert.notEqual(key, sessionKey(file))
      const detail = await (await call(routes, `session?key=${encodeURIComponent(key)}`)).json()
      assert.equal(detail.session.messages[0].content[0].text, 'old question')
      assert.equal(detail.session.path, file)
      assert.equal(detail.session.bridge, 'pi-local')
      assert.equal(detail.session.engine, 'pi')
    } finally {
      for (const dispose of disposers.reverse()) await dispose?.()
    }
  } finally {
    if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousRoot
  }
})

test('creates a new Pi session inside a workspace', async () => {
  const { root } = await fixtureSession()
  const home = await mkdtemp(join(tmpdir(), 'bridge-plugin-home-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { ctx, routes } = host()
    apply(ctx)
    await call(routes, 'bridges', put({ id: 'pi-local', config: { sessionsRoot: root } }))

    const cwd = join(root, '--work--')
    const created = await (await call(routes, 'sessions', post({ bridge: 'pi-local', cwd }))).json()
    assert.equal(created.ok, true)
    assert.equal(created.session.cwd, cwd)
    assert.equal(created.session.name, undefined)
    assert.equal(created.session.bridge, 'pi-local')

    const listed = await (await call(routes, 'sessions?bridge=pi-local')).json()
    assert.equal(listed.sessions.length, 2)
    assert.ok(listed.sessions.some((session) => session.key === created.session.key))
    assert.equal(listed.workspaces.length, 2)
    assert.equal(listed.workspaces.find((workspace) => workspace.path === cwd).sessionCount, 1)

    const invalid = await call(routes, 'sessions', post({ bridge: 'pi-local', cwd: '/definitely/missing/workspace' }))
    assert.equal(invalid.status, 404)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})

test('renames workspaces durably and soft-deletes without touching Pi data', async () => {
  const { root, file } = await fixtureSession()
  const home = await mkdtemp(join(tmpdir(), 'bridge-plugin-home-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { ctx, routes } = host()
    apply(ctx)
    await call(routes, 'bridges', put({ id: 'pi-local', config: { sessionsRoot: root } }))
    const initial = await (await call(routes, 'workspaces?bridge=pi-local')).json()
    const workspace = initial.workspaces[0]

    const renamed = await (await call(routes, 'workspaces', put({
      bridge: 'pi-local',
      id: workspace.id,
      name: 'Renamed workspace',
    }))).json()
    assert.equal(renamed.workspace.name, 'Renamed workspace')

    const afterRename = await (await call(routes, 'workspaces?bridge=pi-local')).json()
    assert.equal(afterRename.workspaces[0].name, 'Renamed workspace')

    const deleted = await (await call(routes, 'workspaces', del({ bridge: 'pi-local', id: workspace.id }))).json()
    assert.equal(deleted.deleted, true)
    assert.deepEqual(deleted.workspaces, [])

    // Re-querying the engine must not resurrect a tombstoned workspace.
    const afterDelete = await (await call(routes, 'sessions?bridge=pi-local')).json()
    assert.deepEqual(afterDelete.workspaces, [])
    assert.deepEqual(afterDelete.removedWorkspacePaths, ['/work'])
    assert.equal(afterDelete.sessions.length, 1)
    assert.equal(typeof afterDelete.sessions[0].key, 'string')
    assert.equal(existsSync(file), true)
    assert.equal(existsSync(root), true)

    // A different folder can be added while the original tombstone remains;
    // the deleted path stays ungrouped instead of being discovered again.
    const readded = await (await call(routes, 'workspaces', post({ bridge: 'pi-local', path: join(root, '--work--') }))).json()
    assert.equal(readded.workspace.name, '--work--')
    assert.deepEqual(readded.removedWorkspacePaths, ['/work'])
    const finalList = await (await call(routes, 'sessions?bridge=pi-local')).json()
    assert.equal(finalList.workspaces.length, 1)
    assert.equal(finalList.workspaces[0].path, join(root, '--work--'))
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})


test('archives sessions on the host per bridge and blocks opening them', async () => {
  const first = await fixtureSession()
  const second = await fixtureSession()
  const home = await mkdtemp(join(tmpdir(), 'bridge-plugin-home-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { ctx, routes, disposers } = host()
    apply(ctx)
    try {
      await call(routes, 'bridges', put({
        id: 'pi-local',
        config: { sessionsRoot: first.root, binPath: fake },
      }))
      const created = await (await call(routes, 'bridges', post({
        name: 'Second Pi',
        mode: 'cli',
        engine: 'pi',
        config: { sessionsRoot: second.root, binPath: fake },
      }))).json()
      const secondBridge = created.bridges.find((bridge) => bridge.name === 'Second Pi')

      const firstList = await (await call(routes, 'sessions?bridge=pi-local')).json()
      const secondList = await (await call(routes, `sessions?bridge=${encodeURIComponent(secondBridge.id)}`)).json()
      const key = firstList.sessions[0].key
      assert.deepEqual(firstList.archivedKeys, [])
      assert.equal(firstList.sessions[0].archived, false)

      const archived = await (await call(routes, 'archive', post({ key, archived: true }))).json()
      assert.equal(archived.ok, true)
      assert.deepEqual(archived.archivedKeys, [key])

      const afterArchive = await (await call(routes, 'sessions?bridge=pi-local')).json()
      assert.deepEqual(afterArchive.archivedKeys, [key])
      assert.equal(afterArchive.sessions[0].archived, true)
      assert.equal(afterArchive.sessions.length, 1)

      // Archive membership is bridge-scoped: the other bridge sees nothing.
      const otherList = await (await call(routes, `sessions?bridge=${encodeURIComponent(secondBridge.id)}`)).json()
      assert.deepEqual(otherList.archivedKeys, [])
      assert.equal(otherList.sessions[0].archived, false)

      const blocked = await call(routes, 'attach', post({ key }))
      assert.equal(blocked.status, 409)
      assert.match((await blocked.json()).error, /archived/)

      const store = readArchiveStore({ ...process.env, DSH_HOME: home })
      assert.deepEqual(store.bridges['pi-local'].sessionKeys, [decodeNativeKey(key, 'pi-local')])

      const restored = await (await call(routes, 'archive', post({ key, archived: false }))).json()
      assert.deepEqual(restored.archivedKeys, [])
      const attached = await (await call(routes, 'attach', post({ key }))).json()
      assert.equal(attached.ok, true)

      // Archiving an idle attached session closes the engine process; a later
      // state request must report no attachment.
      const archivedWhileAttached = await (await call(routes, 'archive', post({ key, archived: true }))).json()
      assert.deepEqual(archivedWhileAttached.archivedKeys, [key])
      const detachedByArchive = await call(routes, `state?key=${encodeURIComponent(key)}`)
      assert.equal(detachedByArchive.status, 409)

      await call(routes, 'archive', post({ key, archived: false }))

      // Deleting a bridge prunes its own archive set. Archive membership in
      // another bridge is independent and unaffected.
      await call(routes, 'archive', post({ key, archived: true }))
      await call(routes, 'bridges', del({ id: secondBridge.id }))
      const finalStore = readArchiveStore({ ...process.env, DSH_HOME: home })
      assert.equal(finalStore.bridges[secondBridge.id], undefined)
      assert.deepEqual(finalStore.bridges['pi-local'].sessionKeys, [decodeNativeKey(key, 'pi-local')])

    } finally {
      for (const dispose of disposers.reverse()) await dispose?.()
    }
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})

function decodeNativeKey(key, bridgeId) {
  const separator = key.lastIndexOf('.')
  assert.equal(key.slice(0, separator), bridgeId)
  return Buffer.from(key.slice(separator + 1), 'base64url').toString('utf8')
}

test('supports multiple Pi bridges with independent session roots', async () => {
  const first = await fixtureSession()
  const second = await fixtureSession()
  const home = await mkdtemp(join(tmpdir(), 'bridge-plugin-home-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { ctx, routes } = host()
    apply(ctx)
    const created = await (await call(routes, 'bridges', post({
      name: 'Second Pi',
      mode: 'cli',
      engine: 'pi',
      config: { sessionsRoot: second.root },
    }))).json()
    const secondBridge = created.bridges.find((bridge) => bridge.name === 'Second Pi')
    assert.ok(secondBridge)

    await call(routes, 'bridges', put({ id: 'pi-local', config: { sessionsRoot: first.root } }))
    const firstList = await (await call(routes, 'sessions?bridge=pi-local')).json()
    const secondList = await (await call(routes, `sessions?bridge=${encodeURIComponent(secondBridge.id)}`)).json()
    assert.equal(firstList.sessions.length, 1)
    assert.equal(secondList.sessions.length, 1)
    assert.notEqual(firstList.sessions[0].key, secondList.sessions[0].key)
    assert.equal(firstList.sessions[0].bridge, 'pi-local')
    assert.equal(secondList.sessions[0].bridge, secondBridge.id)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})

test('attaches a Pi child, prompts it, and detaches', async () => {
  const { root } = await fixtureSession()
  const home = await mkdtemp(join(tmpdir(), 'bridge-plugin-home-'))
  const previousRoot = process.env.PI_CODING_AGENT_SESSION_DIR
  const previousHome = process.env.DSH_HOME
  process.env.PI_CODING_AGENT_SESSION_DIR = root
  process.env.DSH_HOME = home
  try {
    const { ctx, routes, disposers } = host()
    apply(ctx)
    try {
      await call(routes, 'bridges', put({
        id: 'pi-local',
        config: { sessionsRoot: root, binPath: fake },
      }))
      const listed = await (await call(routes, 'sessions?bridge=pi-local')).json()
      const key = listed.sessions[0].key

      const attached = await (await call(routes, 'attach', post({ key }))).json()
      assert.equal(attached.ok, true)
      assert.equal(attached.bridge, 'pi-local')
      assert.equal(attached.engine, 'pi')
      assert.equal(attached.state.sessionId, 'fake-session')

      const prompt = await (await call(routes, 'prompt', post({ key, message: 'ping' }))).json()
      assert.equal(prompt.ok, true)

      const state = await (await call(routes, `state?key=${encodeURIComponent(key)}`)).json()
      assert.equal(state.ok, true)
      assert.equal(state.state.sessionId, 'fake-session')

      const models = await (await call(routes, `models?key=${encodeURIComponent(key)}`)).json()
      assert.equal(models.ok, true)
      assert.equal(models.models.models.length, 2)
      assert.equal(models.models.models[1].name, 'Fake Two')

      const selected = await (await call(routes, 'models', post({
        key,
        provider: 'fake',
        model: 'fake-model-2',
      }))).json()
      assert.equal(selected.ok, true)
      assert.equal(selected.model.id, 'fake-model-2')

      const stats = await (await call(routes, `stats?key=${encodeURIComponent(key)}`)).json()
      assert.equal(stats.ok, true)
      assert.equal(stats.stats.tokens.input, 12)
      assert.equal(stats.stats.tokens.cacheRead, 30)
      assert.equal(stats.stats.totalMessages, 2)

      const blocked = await call(routes, 'bridges', put({ id: 'pi-local', config: { offline: false } }))
      assert.equal(blocked.status, 409)

      const detached = await (await call(routes, 'detach', post({ key }))).json()
      assert.deepEqual(detached, { ok: true, detached: true })

      const missing = await call(routes, `state?key=${encodeURIComponent(key)}`)
      assert.equal(missing.status, 409)
    } finally {
      for (const dispose of disposers.reverse()) await dispose?.()
    }
  } finally {
    if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousRoot
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})

test('rejects unknown bridge keys and malformed keys', async () => {
  const { ctx, routes } = host()
  apply(ctx)
  const malformed = await call(routes, 'session?key=bm90LWEtc2Vzc2lvbg')
  assert.equal(malformed.status, 400)
  assert.match((await malformed.json()).error, /invalid session key/)

  const foreign = await call(routes, 'session?key=missing.bm90LWEtc2Vzc2lvbg')
  assert.equal(foreign.status, 404)
  assert.match((await foreign.json()).error, /unknown bridge/)
})

test('planned engines can be saved and report an unavailable adapter', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bridge-plugin-home-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { ctx, routes } = host()
    apply(ctx)
    const created = await (await call(routes, 'bridges', post({
      name: 'Codex CLI',
      mode: 'cli',
      engine: 'codex',
      config: { sessionsRoot: '/tmp/codex' },
    }))).json()
    const codex = created.bridges.find((bridge) => bridge.name === 'Codex CLI')
    assert.equal(codex.available, false)

    const listed = await (await call(routes, `sessions?bridge=${encodeURIComponent(codex.id)}`)).json()
    assert.equal(listed.ok, true)
    assert.equal(listed.available, false)
    assert.deepEqual(listed.sessions, [])
    assert.match(listed.unavailableReason, /not implemented/)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})

test('connection status starts idle, probes on demand, and reports per-bridge state', async () => {
  const { root } = await fixtureSession()
  const { ctx, routes } = host()
  apply(ctx)
  const initial = await (await call(routes, 'status')).json()
  assert.equal(initial.ok, true)
  assert.equal(initial.bridges.length, 1)
  assert.equal(initial.bridges[0].state, 'idle')

  await call(routes, 'bridges', put({ id: 'pi-local', config: { sessionsRoot: root } }))
  const probed = await (await call(routes, 'status', post({}))).json()
  assert.equal(probed.bridges.length, 1)
  assert.equal(probed.bridges[0].state, 'connected')
  assert.equal(probed.bridges[0].engine, 'pi')
})

test('a failing connection probe reports a red state with the reason', async () => {
  const { ctx, routes } = host()
  apply(ctx)
  await call(routes, 'bridges', put({ id: 'pi-local', config: { sessionsRoot: '/definitely/missing/sessions' } }))
  const probed = await (await call(routes, 'status', post({}))).json()
  assert.equal(probed.bridges[0].state, 'failed')
  assert.match(probed.bridges[0].error, /does not exist/)
})

test('startup readiness probe connects without spawning an agent', async () => {
  const { root } = await fixtureSession()
  const home = await mkdtemp(join(tmpdir(), 'bridge-plugin-home-'))
  const previousHome = process.env.DSH_HOME
  const previousAuto = process.env.BRIDGE_AUTO_CONNECT
  process.env.DSH_HOME = home
  process.env.BRIDGE_AUTO_CONNECT = '1'
  try {
    const { ctx, routes, disposers } = host()
    apply(ctx)
    await call(routes, 'bridges', put({
      id: 'pi-local',
      config: { sessionsRoot: root, binPath: fake },
    }))
    // The startup effect schedules its work on the next tick.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 150))
    const status = await (await call(routes, 'status')).json()
    assert.equal(status.bridges[0].state, 'connected')
    assert.equal(status.bridges[0].detail.sessionsRoot, root)
    const capabilities = await (await call(routes, 'capabilities')).json()
    assert.deepEqual(capabilities.attachments, [])
    for (const dispose of disposers.reverse()) await dispose?.()
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousAuto === undefined) delete process.env.BRIDGE_AUTO_CONNECT
    else process.env.BRIDGE_AUTO_CONNECT = previousAuto
  }
})

test('lazy attach: prompt starts the agent and agent-settled closes it', async () => {
  const { root } = await fixtureSession()
  const home = await mkdtemp(join(tmpdir(), 'bridge-plugin-home-'))
  const previousHome = process.env.DSH_HOME
  const previousAuto = process.env.BRIDGE_AUTO_CONNECT
  process.env.DSH_HOME = home
  process.env.BRIDGE_AUTO_CONNECT = '0'
  try {
    const { ctx, routes, disposers } = host()
    apply(ctx)
    try {
      await call(routes, 'bridges', put({
        id: 'pi-local',
        config: { sessionsRoot: root, binPath: fake },
      }))
      const listed = await (await call(routes, 'sessions?bridge=pi-local')).json()
      const key = listed.sessions[0].key
      assert.equal(listed.sessions[0].activity.state, 'unknown')

      const detail = await (await call(routes, `session?key=${encodeURIComponent(key)}`)).json()
      assert.equal(detail.attached, false)

      const prompted = await (await call(routes, 'prompt', post({ key, message: 'ping' }))).json()
      assert.equal(prompted.ok, true)
      // The fake agent settles immediately, so this may already be idle.
      assert.ok(['running', 'idle'].includes(prompted.activity.state))

      await new Promise((resolve) => setTimeout(resolve, 700))
      const activity = await (await call(routes, 'activity?bridge=pi-local')).json()
      assert.equal(activity.activity.length, 1)
      assert.equal(activity.activity[0].state, 'idle')

      // The settled-turn timer closes the per-turn Pi process.
      await new Promise((resolve) => setTimeout(resolve, 1200))
      const after = await (await call(routes, `session?key=${encodeURIComponent(key)}`)).json()
      assert.equal(after.attached, false)
    } finally {
      for (const dispose of disposers.reverse()) await dispose?.()
    }
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousAuto === undefined) delete process.env.BRIDGE_AUTO_CONNECT
    else process.env.BRIDGE_AUTO_CONNECT = previousAuto
  }
})

test('creates, edits, redacts and deletes bridges through the manager route', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bridge-plugin-home-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { ctx, routes } = host()
    apply(ctx)
    const created = await (await call(routes, 'bridges', post({
      name: 'Remote DSH',
      mode: 'web',
      engine: 'dsh',
      config: { baseUrl: 'https://dsh.example.com', token: 'secret-token' },
    }))).json()
    const remote = created.bridges.find((bridge) => bridge.name === 'Remote DSH')
    assert.equal(remote.config.token, null)
    assert.equal(remote.configured.token, true)
    assert.equal(created.settings.bridges.find((bridge) => bridge.id === remote.id).config.token, null)

    const updated = await (await call(routes, 'bridges', put({
      id: remote.id,
      name: 'Remote DSH 2',
      config: { token: '' },
    }))).json()
    assert.equal(updated.bridges.find((bridge) => bridge.id === remote.id).name, 'Remote DSH 2')
    assert.equal(updated.bridges.find((bridge) => bridge.id === remote.id).configured.token, true)

    const deleted = await (await call(routes, 'bridges', del({ id: remote.id }))).json()
    assert.equal(deleted.bridges.some((bridge) => bridge.id === remote.id), false)

    const rejected = await call(routes, 'bridges', post({ name: 'Bad', mode: 'web', engine: 'pi', config: {} }))
    assert.equal(rejected.status, 400)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})

test('a configured sessions root gates session keys', async () => {
  const first = await fixtureSession()
  const second = await fixtureSession()
  const home = await mkdtemp(join(tmpdir(), 'bridge-plugin-home-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { ctx, routes } = host()
    apply(ctx)
    await call(routes, 'bridges', put({ id: 'pi-local', config: { sessionsRoot: first.root } }))
    const listed = await (await call(routes, 'sessions?bridge=pi-local')).json()
    assert.equal(listed.sessions.length, 1)
    const key = listed.sessions[0].key

    await call(routes, 'bridges', put({ id: 'pi-local', config: { sessionsRoot: second.root } }))
    const response = await call(routes, `session?key=${encodeURIComponent(key)}`)
    assert.equal(response.status, 400)
    assert.match((await response.json()).error, /outside the Pi sessions root/)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})
