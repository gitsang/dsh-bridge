#!/usr/bin/env node
/**
 * Live smoke test against a running dsh web with the bridge installed.
 *
 * Usage:
 *   node tests/live-smoke.mjs                 # read-only checks
 *   DSH_SMOKE_ATTACH=1 node tests/live-smoke.mjs
 *   DSH_PORT=3080 node tests/live-smoke.mjs
 *
 * Read-only mode never writes anything. Attach mode opens a Pi RPC child for
 * the newest session, sends one prompt, and detaches; it needs a working Pi
 * login, so it is opt-in.
 */
import assert from 'node:assert/strict'
import { createClient } from './lib/dsh-rpc.mjs'

const port = Number(process.env.DSH_PORT ?? 3080)
const attach = process.env.DSH_SMOKE_ATTACH === '1'
const prompt = process.env.DSH_SMOKE_PROMPT ?? 'Reply with exactly BRIDGE_SMOKE_OK and nothing else.'
const client = createClient({ port })

function step(name) {
  process.stdout.write(`• ${name} … `)
}

function ok(detail = '') {
  process.stdout.write(`ok${detail === '' ? '' : ` (${detail})`}\n`)
}

step('GET /api/bridge/capabilities')
const capabilities = await client.route('capabilities')
assert.equal(capabilities.status, 200, JSON.stringify(capabilities.data))
assert.equal(capabilities.data.ok, true)
assert.equal(capabilities.data.protocol, 3)
ok(`${capabilities.data.attachments.length} attached`)

step('GET /api/bridge/settings')
const settings = await client.route('settings')
assert.equal(settings.status, 200, JSON.stringify(settings.data))
assert.deepEqual(settings.data.modes.map((entry) => entry.id), ['cli', 'web'])
assert.deepEqual(settings.data.engines.map((entry) => entry.id), ['pi', 'codex', 'opencode', 'dsh'])
const piBridge = settings.data.bridges.find((bridge) => bridge.engine === 'pi' && bridge.available)
assert.ok(piBridge, 'a usable Pi bridge')
ok(`${settings.data.bridges.length} bridges · using ${piBridge.name}`)

step('GET /api/bridge/sessions')
const listed = await client.route(`sessions?bridge=${encodeURIComponent(piBridge.id)}`)
assert.equal(listed.status, 200, JSON.stringify(listed.data))
assert.ok(Array.isArray(listed.data.sessions))
ok(`${listed.data.sessions.length} sessions`)

if (listed.data.sessions.length > 0) {
  const newest = [...listed.data.sessions].sort((a, b) => String(b.modified).localeCompare(String(a.modified)))[0]
  step('GET /api/bridge/session')
  const detail = await client.route(`session?key=${encodeURIComponent(newest.key)}`)
  assert.equal(detail.status, 200, JSON.stringify(detail.data))
  assert.ok(Array.isArray(detail.data.session.messages))
  ok(`${detail.data.session.messages.length} messages`)

  step('POST /api/bridge/attach')
  const attached = await client.route('attach', { method: 'POST', body: JSON.stringify({ key: newest.key }) })
  assert.equal(attached.status, 200, JSON.stringify(attached.data))
  assert.equal(attached.data.ok, true)
  ok(`pid ${attached.data.state.pid ?? '?'}`)

  try {
    step('GET /api/bridge/state')
    const state = await client.route(`state?key=${encodeURIComponent(newest.key)}`)
    assert.equal(state.status, 200)
    ok(state.data.state.model?.id ?? 'unknown model')

    if (attach) {
      step('SSE /api/bridge/events')
      const controller = new AbortController()
      const events = []
      const stream = fetch(`${client.base}/api/bridge/events?key=${encodeURIComponent(newest.key)}`, {
        headers: { cookie: client.cookie },
        signal: controller.signal,
      }).then(async (response) => {
        assert.equal(response.status, 200)
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let at = buffer.indexOf('\n\n')
          while (at !== -1) {
            const frame = buffer.slice(0, at)
            buffer = buffer.slice(at + 2)
            const event = { type: undefined, data: undefined }
            for (const line of frame.split('\n')) {
              if (line.startsWith('event: ')) event.type = line.slice(7)
              else if (line.startsWith('data: ')) event.data = line.slice(6)
            }
            events.push(event)
            at = buffer.indexOf('\n\n')
          }
        }
      }).catch((error) => {
        if (error.name !== 'AbortError') throw error
      })

      step('POST /api/bridge/prompt')
      const accepted = await client.route('prompt', { method: 'POST', body: JSON.stringify({ key: newest.key, message: prompt }) })
      assert.equal(accepted.status, 202, JSON.stringify(accepted.data))
      ok(JSON.stringify(accepted.data.accepted ?? {}))

      const decode = () => events
        .filter((event) => event.type === 'bridge-event' && event.data !== undefined)
        .map((event) => {
          try {
            return JSON.parse(event.data)
          } catch {
            return null
          }
        })
        .filter(Boolean)
      const deadline = Date.now() + 120_000
      while (Date.now() < deadline) {
        if (decode().some((event) => event.type === 'agent-end')) break
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      controller.abort()
      await stream
      const textOf = (message) => {
        if (typeof message?.content === 'string') return message.content
        return Array.isArray(message?.content)
          ? message.content.filter((block) => block?.type === 'text').map((block) => block.text ?? '').join('')
          : ''
      }
      const reply = decode()
        .filter((event) => event.type === 'message-update' || event.type === 'message-end')
        .map((event) => textOf(event.message))
        .filter(Boolean)
        .at(-1) ?? ''
      assert.match(reply, /BRIDGE_SMOKE_OK|SMOKE/i, 'expected the streamed reply to arrive')
      step('streamed reply')
      ok(JSON.stringify(reply))
    }
  } finally {
    step('POST /api/bridge/detach')
    const detached = await client.route('detach', { method: 'POST', body: JSON.stringify({ key: newest.key }) })
    assert.equal(detached.status, 200, JSON.stringify(detached.data))
    assert.equal(detached.data.detached, true)
    ok()
  }
}

process.stdout.write('\nbridge live smoke: all checks passed\n')
