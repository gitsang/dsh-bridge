import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import apply, { name, renderShell } from '../src/index.js'

test('apply starts a gateway beside webServer and registers its lifetime', async () => {
  const upstream = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('native dsh')
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const root = await mkdtemp(join(tmpdir(), 'bridge-v2-apply-'))
  try {
    const configPath = join(root, 'bridge-v2.json')
    await writeFile(configPath, JSON.stringify({
      version: 1,
      bridges: [{ id: 'native', name: 'Local', engine: 'native', upstream: { self: true } }],
    }), 'utf8')
    const disposers = []
    const ctx = {
      logger: { info() {}, warn() {}, error() {} },
      webServer: { port: upstream.address().port },
      get: () => undefined,
      effect(factory) {
        disposers.push(factory())
        return () => {}
      },
    }
    let gateway
    try {
      gateway = await apply(ctx, { host: '127.0.0.1', port: 0, dataDir: root, configPath, auth: false })
      assert.equal(name, 'bridge')
      assert.equal(ctx.bridgeGateway, gateway)
      const deadline = Date.now() + 3000
      while (gateway.state().bridges[0].status !== 'ready' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      assert.equal(gateway.state().bridges[0].status, 'ready')
      assert.match(renderShell({ version: '2.0.0' }), /dsh bridge/)
    } finally {
      for (const dispose of disposers.reverse()) await dispose()
      if (gateway !== undefined) await gateway.close()
    }
  } finally {
    upstream.closeAllConnections?.()
    await new Promise((resolve) => upstream.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
})
