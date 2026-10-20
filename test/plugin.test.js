import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply, name } from '../src/index.js'

const fake = new URL('./fixtures/fake-pi.mjs', import.meta.url).pathname

/** Minimal Cordis-shaped host context capturing registered routes. */
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
  const root = await mkdtemp(join(tmpdir(), 'pi-bridge-plugin-'))
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
  const route = routes.get(`/api/pi-bridge/${pathname}`)
  assert.ok(route, `route ${pathname} registered`)
  return route.fetch(new Request(`http://127.0.0.1/api/pi-bridge/${path}`, init))
}

test('registers the full Pi bridge route table', () => {
  const { ctx, routes } = host()
  apply(ctx)
  assert.equal(name, 'pi-bridge')
  assert.deepEqual([...routes.keys()].sort(), [
    '/api/pi-bridge/abort',
    '/api/pi-bridge/attach',
    '/api/pi-bridge/capabilities',
    '/api/pi-bridge/detach',
    '/api/pi-bridge/events',
    '/api/pi-bridge/history-message',
    '/api/pi-bridge/models',
    '/api/pi-bridge/prompt',
    '/api/pi-bridge/session',
    '/api/pi-bridge/sessions',
    '/api/pi-bridge/settings',
    '/api/pi-bridge/state',
    '/api/pi-bridge/ui-response',
  ])
})

test('lists and reads Pi sessions without attaching', async () => {
  const { root, file } = await fixtureSession()
  const previousRoot = process.env.PI_CODING_AGENT_SESSION_DIR
  process.env.PI_CODING_AGENT_SESSION_DIR = root
  try {
    const { ctx, routes, disposers } = host()
    apply(ctx)
    try {
      const listed = await (await call(routes, 'sessions')).json()
      assert.equal(listed.ok, true)
      assert.equal(listed.sessions.length, 1)
      assert.equal(listed.sessions[0].id, 'session-x')

      const key = listed.sessions[0].key
      const detail = await (await call(routes, `session?key=${encodeURIComponent(key)}`)).json()
      assert.equal(detail.session.messages[0].content[0].text, 'old question')
      assert.equal(detail.session.path, file)
    } finally {
      for (const dispose of disposers.reverse()) await dispose?.()
    }
  } finally {
    if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousRoot
  }
})

test('attaches a Pi child, prompts it, and detaches', async () => {
  const { root } = await fixtureSession()
  const previousRoot = process.env.PI_CODING_AGENT_SESSION_DIR
  const previousBin = process.env.PI_BIN
  process.env.PI_CODING_AGENT_SESSION_DIR = root
  process.env.PI_BIN = fake
  try {
    const { ctx, routes, disposers } = host()
    apply(ctx)
    try {
      const listed = await (await call(routes, 'sessions')).json()
      const key = listed.sessions[0].key

      const attached = await (await call(routes, 'attach', {
        method: 'POST',
        body: JSON.stringify({ key }),
        headers: { 'content-type': 'application/json' },
      })).json()
      assert.equal(attached.ok, true)
      assert.equal(attached.state.sessionId, 'fake-session')

      const prompt = await (await call(routes, 'prompt', {
        method: 'POST',
        body: JSON.stringify({ key, message: 'ping' }),
        headers: { 'content-type': 'application/json' },
      })).json()
      assert.equal(prompt.ok, true)

      const state = await (await call(routes, `state?key=${encodeURIComponent(key)}`)).json()
      assert.equal(state.ok, true)
      assert.equal(state.state.sessionId, 'fake-session')

      const detached = await (await call(routes, 'detach', {
        method: 'POST',
        body: JSON.stringify({ key }),
        headers: { 'content-type': 'application/json' },
      })).json()
      assert.deepEqual(detached, { ok: true, detached: true })

      const missing = await call(routes, `state?key=${encodeURIComponent(key)}`)
      assert.equal(missing.status, 409)
    } finally {
      for (const dispose of disposers.reverse()) await dispose?.()
    }
  } finally {
    if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousRoot
    if (previousBin === undefined) delete process.env.PI_BIN
    else process.env.PI_BIN = previousBin
  }
})

test('rejects unknown session keys', async () => {
  const { ctx, routes } = host()
  apply(ctx)
  const response = await call(routes, 'session?key=bm90LWEtc2Vzc2lvbg')
  assert.equal(response.status, 400)
  const body = await response.json()
  assert.match(body.error, /outside the Pi sessions root/)
})

test('reads and updates backend settings without touching a live attachment', async () => {
  const { root } = await fixtureSession()
  const home = await mkdtemp(join(tmpdir(), 'pi-bridge-home-'))
  const previousRoot = process.env.PI_CODING_AGENT_SESSION_DIR
  const previousHome = process.env.DSH_HOME
  process.env.PI_CODING_AGENT_SESSION_DIR = root
  process.env.DSH_HOME = home
  try {
    const { ctx, routes } = host()
    apply(ctx)
    const initial = await (await call(routes, 'settings')).json()
    assert.equal(initial.ok, true)
    assert.equal(initial.settings.backend, 'pi')
    assert.deepEqual(initial.backends.map((entry) => entry.id), ['pi'])
    assert.equal(initial.sessionsRoot, root)

    const updated = await (await call(routes, 'settings', {
      method: 'PUT',
      body: JSON.stringify({ backend: 'pi', pi: { sessionsRoot: root, offline: false } }),
      headers: { 'content-type': 'application/json' },
    })).json()
    assert.equal(updated.ok, true)
    assert.equal(updated.settings.pi.offline, false)
    assert.equal(updated.sessionsRoot, root)

    const rejected = await call(routes, 'settings', {
      method: 'PUT',
      body: JSON.stringify({ backend: 'not-a-backend' }),
      headers: { 'content-type': 'application/json' },
    })
    assert.equal(rejected.status, 400)
  } finally {
    if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousRoot
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})

test('a configured sessions root gates session keys', async () => {
  const first = await fixtureSession()
  const second = await fixtureSession()
  const home = await mkdtemp(join(tmpdir(), 'pi-bridge-home-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { ctx, routes } = host()
    apply(ctx)
    await call(routes, 'settings', {
      method: 'PUT',
      body: JSON.stringify({ pi: { sessionsRoot: first.root } }),
      headers: { 'content-type': 'application/json' },
    })
    const listed = await (await call(routes, 'sessions')).json()
    assert.equal(listed.sessions.length, 1)
    const key = listed.sessions[0].key

    await call(routes, 'settings', {
      method: 'PUT',
      body: JSON.stringify({ pi: { sessionsRoot: second.root } }),
      headers: { 'content-type': 'application/json' },
    })
    const response = await call(routes, `session?key=${encodeURIComponent(key)}`)
    assert.equal(response.status, 400)
    assert.match((await response.json()).error, /outside the Pi sessions root/)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})
