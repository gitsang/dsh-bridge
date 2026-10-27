import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BridgeGateway } from '../src/gateway.js'
import { defaultConfig } from '../src/config.js'

/** Minimal dsh-shaped upstream: auth cookie, HTML shell, one API route, WS echo. */
async function fakeDsh(options = {}) {
  const seen = []
  let wsRejectOnce = options.wsRejectOnce === true
  let httpRejectOnce = options.httpRejectOnce === true
  const bodies = []
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://upstream.invalid')
    seen.push({ path: url.pathname, cookie: request.headers.cookie, host: request.headers.host })
    if (url.pathname === '/' && url.searchParams.get('token') === 'launch') {
      response.writeHead(302, {
        location: './',
        'set-cookie': 'dsh-auth-abc=valid; Path=/; HttpOnly',
      })
      response.end()
      return
    }
    if (!String(request.headers.cookie ?? '').includes('dsh-auth-abc=valid')) {
      response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('dsh web authentication required')
      return
    }
    if (url.pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><html><head><base href="./"></head><body>dsh host</body></html>')
      return
    }
    if (url.pathname === '/api/session/list') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: true, sessions: [] }))
      return
    }
    if (url.pathname === '/api/session/prompt') {
      const chunks = []
      request.on('data', (chunk) => chunks.push(chunk))
      request.on('end', () => {
        bodies.push(Buffer.concat(chunks).toString('utf8'))
        if (httpRejectOnce) {
          httpRejectOnce = false
          response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
          response.end('dsh web authentication required')
          return
        }
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ ok: true }))
      })
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain' })
    response.end('not found')
  })
  const upgraded = new Set()
  server.on('upgrade', (request, socket) => {
    upgraded.add(socket)
    socket.on('close', () => upgraded.delete(socket))
    const url = new URL(request.url ?? '/', 'http://upstream.invalid')
    seen.push({ upgrade: url.pathname, cookie: request.headers.cookie })
    if (wsRejectOnce) {
      wsRejectOnce = false
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    if (!String(request.headers.cookie ?? '').includes('dsh-auth-abc=valid')) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n')
      return
    }
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Accept: fake',
      '', '',
    ].join('\r\n'))
    socket.on('data', (chunk) => socket.write(chunk))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    server,
    seen,
    port: server.address().port,
    bodies,
    close: () => new Promise((resolve) => {
      for (const socket of upgraded) socket.destroy()
      server.closeAllConnections?.()
      server.close(() => resolve())
    }),
  }
}

async function waitUntil(fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('timed out')
}

test('prefix routing, cookie custody, shell and state', async () => {
  const upstream = await fakeDsh()
  const root = await mkdtemp(join(tmpdir(), 'bridge-v2-gateway-'))
  const configPath = join(root, 'bridge-v2.json')
  const config = defaultConfig()
  config.bridges = [{
    id: 'fake',
    name: 'Fake',
    engine: 'dsh',
    autostart: true,
    upstream: { url: `http://127.0.0.1:${upstream.port}/?token=launch` },
  }]
  await writeFile(configPath, JSON.stringify(config), 'utf8')
  const ctx = { logger: { info() {}, warn() {}, error() {} }, get: () => undefined }
  const gateway = await new BridgeGateway(ctx, {
    host: '127.0.0.1', port: 0, dataDir: root, configPath, auth: false,
  }).start()
  try {
    await waitUntil(() => gateway.state().bridges[0]?.status === 'ready')
    const base = `http://127.0.0.1:${gateway.port}`

    const shell = await fetch(`${base}/`)
    assert.equal(shell.status, 200)
    assert.match(await shell.text(), /dsh bridge/)

    const redirect = await fetch(`${base}/b/fake`, { redirect: 'manual' })
    assert.equal(redirect.status, 301)
    assert.equal(redirect.headers.get('location'), '/b/fake/')

    const index = await fetch(`${base}/b/fake/`)
    assert.equal(index.status, 200)
    assert.match(await index.text(), /dsh host/)
    assert.match(await (await fetch(`${base}/b/fake/`)).text(), /ownsHost: true/)
    assert.ok(upstream.seen.some((entry) => entry.path === '/' && entry.cookie?.includes('dsh-auth-abc=valid')))
    assert.ok(upstream.seen.every((entry) => entry.host === `127.0.0.1:${upstream.port}`))

    const api = await fetch(`${base}/b/fake/api/session/list`)
    assert.equal(api.status, 200)
    assert.deepEqual(await api.json(), { ok: true, sessions: [] })

    const state = await (await fetch(`${base}/__bridge/state`)).json()
    assert.equal(state.bridges[0].id, 'fake')
    assert.equal(state.bridges[0].mount, '/b/fake/')
  } finally {
    await gateway.close()
    await upstream.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('WebSocket upgrade keeps the mount and injects the upstream cookie', async () => {
  const upstream = await fakeDsh()
  const root = await mkdtemp(join(tmpdir(), 'bridge-v2-ws-'))
  const configPath = join(root, 'bridge-v2.json')
  await writeFile(configPath, JSON.stringify({
    version: 1,
    bridges: [{
      id: 'fake', name: 'Fake', engine: 'dsh',
      upstream: { url: `http://127.0.0.1:${upstream.port}/?token=launch` },
    }],
  }), 'utf8')
  const gateway = await new BridgeGateway({ logger: { info() {}, warn() {}, error() {} }, get: () => undefined }, {
    host: '127.0.0.1', port: 0, dataDir: root, configPath, auth: false,
  }).start()
  try {
    await waitUntil(() => gateway.state().bridges[0]?.status === 'ready')
    // Warm the upstream cookie through one HTTP request.
    await fetch(`http://127.0.0.1:${gateway.port}/b/fake/`)
    const socket = connect({ host: '127.0.0.1', port: gateway.port })
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    const received = []
    socket.on('data', (chunk) => received.push(chunk))
    socket.write([
      'GET /b/fake/api/remote.mux HTTP/1.1',
      'Host: 127.0.0.1',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version: 13',
      '', '',
    ].join('\r\n'))
    await waitUntil(() => Buffer.concat(received).toString('utf8').includes('101 Switching Protocols'))
    assert.ok(upstream.seen.some((entry) => entry.upgrade === '/api/remote.mux' && entry.cookie?.includes('dsh-auth-abc=valid')))
    socket.write('ping')
    await waitUntil(() => Buffer.concat(received).toString('utf8').includes('ping'))
    socket.destroy()
  } finally {
    await gateway.close()
    await upstream.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('password gate protects the shell and every mount', async () => {
  const upstream = await fakeDsh()
  const root = await mkdtemp(join(tmpdir(), 'bridge-v2-auth-'))
  const configPath = join(root, 'bridge-v2.json')
  await writeFile(configPath, JSON.stringify({
    version: 1,
    bridges: [{ id: 'fake', name: 'Fake', engine: 'dsh', upstream: { url: `http://127.0.0.1:${upstream.port}/?token=launch` } }],
  }), 'utf8')
  const gateway = await new BridgeGateway({ logger: { info() {}, warn() {}, error() {} }, get: () => undefined }, {
    host: '127.0.0.1', port: 0, dataDir: root, configPath, auth: true,
  }).start()
  try {
    await waitUntil(() => gateway.state().bridges[0]?.status === 'ready')
    const base = `http://127.0.0.1:${gateway.port}`
    const denied = await fetch(`${base}/b/fake/`, { redirect: 'manual' })
    assert.equal(denied.status, 302)
    assert.match(denied.headers.get('location'), /^\/login\?next=/)
    const login = await fetch(`${base}/login`, {
      method: 'POST',
      body: new URLSearchParams({ password: 'secret', confirm: 'secret' }),
      redirect: 'manual',
    })
    assert.equal(login.status, 302)
    const cookie = login.headers.get('set-cookie').split(';', 1)[0]
    const allowed = await fetch(`${base}/b/fake/`, { headers: { cookie } })
    assert.equal(allowed.status, 200)
    const apiDenied = await fetch(`${base}/__bridge/state`)
    assert.equal(apiDenied.status, 401)
  } finally {
    await gateway.close()
    await upstream.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('management API persists edits and deletes, and redacts upstream tokens', async () => {
  const upstream = await fakeDsh()
  const root = await mkdtemp(join(tmpdir(), 'bridge-v2-manage-'))
  const configPath = join(root, 'bridge-v2.json')
  await writeFile(configPath, JSON.stringify({
    version: 1,
    bridges: [{
      id: 'fake', name: 'Fake', engine: 'dsh',
      upstream: { url: `http://127.0.0.1:${upstream.port}/?token=launch` },
    }],
  }), 'utf8')
  const gateway = await new BridgeGateway({ logger: { info() {}, warn() {}, error() {} }, get: () => undefined }, {
    host: '127.0.0.1', port: 0, dataDir: root, configPath, auth: false,
  }).start()
  try {
    await waitUntil(() => gateway.state().bridges[0]?.status === 'ready')
    const base = `http://127.0.0.1:${gateway.port}`
    const state = await (await fetch(`${base}/__bridge/state`)).json()
    assert.equal(state.bridges[0].upstream.url, `http://127.0.0.1:${upstream.port}/?token=***`)
    assert.equal(state.bridges[0].upstream.token, true)

    const headers = { 'content-type': 'application/json', 'x-bridge-gateway': '1' }
    const added = await fetch(`${base}/__bridge/bridges`, {
      method: 'POST', headers,
      body: JSON.stringify({
        id: 'second', name: 'Second', engine: 'dsh', autostart: false,
        upstream: { url: 'http://127.0.0.1:1/' },
      }),
    })
    assert.equal(added.status, 200)
    assert.ok((await added.json()).bridges.some((bridge) => bridge.id === 'second'))

    const edited = await fetch(`${base}/__bridge/bridges/second`, {
      method: 'PUT', headers,
      body: JSON.stringify({ name: 'Renamed', engine: 'pi', autostart: false, upstream: { url: 'http://127.0.0.1:1/' } }),
    })
    assert.equal(edited.status, 200)
    assert.ok((await edited.json()).bridges.some((bridge) => bridge.id === 'second' && bridge.name === 'Renamed'))

    const refused = await fetch(`${base}/__bridge/bridges/native`, { method: 'DELETE', headers })
    assert.equal(refused.status, 400)

    const removed = await fetch(`${base}/__bridge/bridges/second`, { method: 'DELETE', headers })
    assert.equal(removed.status, 200)
    assert.ok(!(await removed.json()).bridges.some((bridge) => bridge.id === 'second'))
  } finally {
    await gateway.close()
    await upstream.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('WebSocket upgrade refreshes an upstream cookie once after 401', async () => {
  const upstream = await fakeDsh({ wsRejectOnce: true })
  const root = await mkdtemp(join(tmpdir(), 'bridge-v2-ws-retry-'))
  const configPath = join(root, 'bridge-v2.json')
  await writeFile(configPath, JSON.stringify({
    version: 1,
    bridges: [{ id: 'fake', name: 'Fake', engine: 'dsh', upstream: { url: `http://127.0.0.1:${upstream.port}/?token=launch` } }],
  }), 'utf8')
  const gateway = await new BridgeGateway({ logger: { info() {}, warn() {}, error() {} }, get: () => undefined }, {
    host: '127.0.0.1', port: 0, dataDir: root, configPath, auth: false,
  }).start()
  try {
    await waitUntil(() => gateway.state().bridges[0]?.status === 'ready')
    await fetch(`http://127.0.0.1:${gateway.port}/b/fake/`)
    const socket = connect({ host: '127.0.0.1', port: gateway.port })
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    const received = []
    socket.on('data', (chunk) => received.push(chunk))
    socket.write([
      'GET /b/fake/api/remote.mux HTTP/1.1',
      'Host: 127.0.0.1',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version: 13',
      '', '',
    ].join('\r\n'))
    await waitUntil(() => Buffer.concat(received).toString('utf8').includes('101 Switching Protocols'))
    const upgrades = upstream.seen.filter((entry) => entry.upgrade === '/api/remote.mux')
    assert.equal(upgrades.length, 2)
    assert.ok(upgrades.every((entry) => entry.cookie?.includes('dsh-auth-abc=valid')))
    socket.destroy()
  } finally {
    await gateway.close()
    await upstream.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('HTTP retry after a stale upstream cookie replays the request body', async () => {
  const upstream = await fakeDsh({ httpRejectOnce: true })
  const root = await mkdtemp(join(tmpdir(), 'bridge-v2-http-retry-'))
  const configPath = join(root, 'bridge-v2.json')
  await writeFile(configPath, JSON.stringify({
    version: 1,
    bridges: [{ id: 'fake', name: 'Fake', engine: 'dsh', upstream: { url: `http://127.0.0.1:${upstream.port}/?token=launch` } }],
  }), 'utf8')
  const gateway = await new BridgeGateway({ logger: { info() {}, warn() {}, error() {} }, get: () => undefined }, {
    host: '127.0.0.1', port: 0, dataDir: root, configPath, auth: false,
  }).start()
  try {
    await waitUntil(() => gateway.state().bridges[0]?.status === 'ready')
    await fetch(`http://127.0.0.1:${gateway.port}/b/fake/`)
    const body = JSON.stringify({ requestId: 'r1', sessionId: 's1', mode: 'queue', content: [{ type: 'text', text: 'hello' }] })
    const response = await fetch(`http://127.0.0.1:${gateway.port}/b/fake/api/session/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true })
    assert.deepEqual(upstream.bodies, [body, body])
  } finally {
    await gateway.close()
    await upstream.close()
    await rm(root, { recursive: true, force: true })
  }
})
