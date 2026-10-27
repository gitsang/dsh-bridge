import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  defaultConfig, normalizeBridge, normalizeConfig, normalizeUpstream,
  readConfig, removeBridge, upsertBridge, writeConfig,
} from '../src/config.js'

test('default config is one native host', () => {
  const config = defaultConfig()
  assert.equal(config.version, 1)
  assert.deepEqual(config.bridges.map((bridge) => bridge.id), ['native'])
  assert.deepEqual(config.bridges[0].upstream, { self: true })
})

test('upstream accepts exactly one selector', () => {
  assert.deepEqual(normalizeUpstream({ url: 'http://127.0.0.1:3090/' }), { url: 'http://127.0.0.1:3090/' })
  assert.deepEqual(normalizeUpstream({ command: 'dsh', args: ['web'] }), { command: 'dsh', args: ['web'] })
  assert.deepEqual(normalizeUpstream({ self: true }), { self: true })
  assert.throws(() => normalizeUpstream({ url: 'http://a', command: 'dsh', args: [] }), /exactly one/)
  assert.throws(() => normalizeUpstream({ url: 'ftp://a' }), /http/)
  assert.throws(() => normalizeUpstream({ command: 'dsh' }), /args/)
})

test('bridge ids are slugs and immutable', () => {
  const bridge = normalizeBridge({ id: 'pi', name: 'Pi', upstream: { self: true } })
  assert.equal(bridge.id, 'pi')
  assert.equal(bridge.engine, 'dsh')
  assert.equal(bridge.autostart, true)
  assert.throws(() => normalizeBridge({ id: 'Pi', name: 'Pi', upstream: { self: true } }), /must match/)
  assert.throws(() => normalizeBridge({ id: 'other', name: 'Pi', upstream: { self: true } }, 'pi'), /immutable/)
})

test('config rejects duplicate ids and losing the native backend', () => {
  assert.throws(() => normalizeConfig({
    version: 1,
    bridges: [
      { id: 'same', name: 'A', upstream: { self: true } },
      { id: 'same', name: 'B', upstream: { self: true } },
    ],
  }), /duplicate/)
  const config = normalizeConfig(defaultConfig())
  assert.throws(() => removeBridge(config, 'native'), /cannot be removed/)
  const withPi = upsertBridge(config, { id: 'pi', name: 'Pi', engine: 'pi', upstream: { self: true } })
  assert.deepEqual(withPi.bridges.map((bridge) => bridge.id), ['native', 'pi'])
})

test('config round-trips atomically with owner-only permissions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-v2-config-'))
  try {
    const path = join(root, 'bridge-v2.json')
    const config = upsertBridge(defaultConfig(), {
      id: 'work', name: 'Work', engine: 'pi', upstream: { command: 'dsh', args: ['web'] },
    })
    await writeConfig(config, path)
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    assert.match(await readFile(path, 'utf8'), /"id": "work"/)
    assert.deepEqual(await readConfig(path), config)
    await writeFile(path, '{"version":1,"bridges":[]}\n', 'utf8')
    await assert.rejects(readConfig(path), /at least one bridge/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
