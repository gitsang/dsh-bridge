import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { afterEach, beforeEach } from 'node:test'
import { apply, name, sessionKey } from '../src/index.js'

const fake = new URL('./fixtures/fake-pi.mjs', import.meta.url).pathname

// Never let a host test touch the real ~/.dsh bridge store.
let originalHome
let testHome
beforeEach(async () => {
  originalHome = process.env.DSH_HOME
  testHome = await mkdtemp(join(tmpdir(), 'bridge-plugin-env-'))
  process.env.DSH_HOME = testHome
})
afterEach(async () => {
  if (originalHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalHome
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
    '/api/bridge/attach',
    '/api/bridge/bridges',
    '/api/bridge/capabilities',
    '/api/bridge/detach',
    '/api/bridge/events',
    '/api/bridge/history-message',
    '/api/bridge/models',
    '/api/bridge/prompt',
    '/api/bridge/session',
    '/api/bridge/sessions',
    '/api/bridge/settings',
    '/api/bridge/state',
    '/api/bridge/ui-response',
  ])
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
      assert.deepEqual(listed.workspaces, [{ id: '/work', name: '/work', path: '/work', sessionCount: 1 }])

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
