import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BackendManager } from '../src/backends.js'

async function waitUntil(fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('timed out')
}

test('checked URL backend reports ready and redacts its token', async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html', 'x-dsh-version': '2.0.0' })
    response.end('ok')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const manager = new BackendManager({
      config: {
        version: 1,
        bridges: [{
          id: 'pi', name: 'Pi', engine: 'pi', autostart: true,
          upstream: { url: `http://127.0.0.1:${server.address().port}/?token=secret` },
          health: { timeoutMs: 2000, version: '2.0.0' },
        }],
      },
      webServerPort: () => 0,
      selfTokenizedUrl: async () => undefined,
      logger: { warn() {}, info() {} },
    })
    await manager.startAll()
    const [state] = manager.states()
    assert.equal(state.status, 'ready')
    assert.equal(state.compat, 'compatible')
    assert.equal(state.upstream.url, `http://127.0.0.1:${server.address().port}/?token=***`)
    assert.equal(state.upstream.token, true)
    await manager.stopAll()
    assert.equal(manager.states()[0].status, 'stopped')
  } finally {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('version mismatch blocks the backend', async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html', 'x-dsh-version': '9.9.9' })
    response.end('ok')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const manager = new BackendManager({
      config: {
        version: 1,
        bridges: [{
          id: 'pi', name: 'Pi', engine: 'pi', autostart: false,
          upstream: { url: `http://127.0.0.1:${server.address().port}/` },
          health: { timeoutMs: 2000, version: '2.0.0' },
        }],
      },
      webServerPort: () => 0,
      selfTokenizedUrl: async () => undefined,
      logger: { warn() {}, info() {} },
    })
    await manager.get('pi').start()
    assert.equal(manager.states()[0].status, 'failed')
    assert.match(manager.states()[0].error, /incompatible dsh version/)
    await manager.stopAll()
  } finally {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('command backend spawns, discovers its announced URL and is reaped', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-v2-spawn-'))
  const script = join(root, 'fake-host.mjs')
  const { writeFile } = await import('node:fs/promises')
  await writeFile(script, `
    import { createServer } from 'node:http'
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('spawned')
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      console.log('dsh web: http://127.0.0.1:' + port + '/?token=launch')
    })
    process.on('SIGTERM', () => { server.close(() => process.exit(0)) })
  `, 'utf8')
  const manager = new BackendManager({
    config: {
      version: 1,
      bridges: [{
        id: 'spawned', name: 'Spawned', engine: 'pi', autostart: true,
        upstream: { command: process.execPath, args: [script] },
        health: { timeoutMs: 5000 },
      }],
    },
    webServerPort: () => 0,
    selfTokenizedUrl: async () => undefined,
    logger: { warn() {}, info() {} },
  })
  try {
    await manager.startAll()
    await waitUntil(() => manager.states()[0].status === 'ready')
    assert.equal(manager.get('spawned').child !== undefined, true)
    await manager.stopAll()
    assert.equal(manager.get('spawned').child, undefined)
  } finally {
    await manager.stopAll()
    await rm(root, { recursive: true, force: true })
  }
})
