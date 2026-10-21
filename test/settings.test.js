import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createBridge,
  defaultSettings,
  deleteBridge,
  legacySettingsPath,
  normalizeSettings,
  readSettings,
  settingsPath,
  updateBridge,
  writeSettings,
} from '../src/settings.js'
import { ENGINES, getEngine } from '../src/backends/registry.js'

test('registers Pi, Codex, OpenCode and remote DSH engines', () => {
  assert.deepEqual(ENGINES.map((entry) => entry.id), ['pi', 'codex', 'opencode', 'dsh'])
  assert.equal(getEngine('pi').mode, 'cli')
  assert.equal(getEngine('codex').mode, 'cli')
  assert.equal(getEngine('opencode').mode, 'cli')
  assert.equal(getEngine('dsh').mode, 'web')
  assert.equal(getEngine('pi').available, true)
  assert.equal(getEngine('codex').available, false)
})

test('defaults start with one configurable Pi bridge', () => {
  const settings = defaultSettings()
  assert.equal(settings.version, 3)
  assert.equal(settings.bridges.length, 1)
  assert.equal(settings.bridges[0].id, 'pi-local')
  assert.equal(settings.bridges[0].engine, 'pi')
  assert.deepEqual(settings.bridges[0].config, { sessionsRoot: null, binPath: null, offline: true })
})

test('multiple bridges can use the same engine with independent configs', () => {
  let settings = defaultSettings()
  settings = createBridge(settings, {
    name: 'Work Pi',
    mode: 'cli',
    engine: 'pi',
    config: { sessionsRoot: '/work/sessions', binPath: '/opt/pi', offline: false },
  }).settings
  settings = createBridge(settings, {
    name: 'Scratch Pi',
    mode: 'cli',
    engine: 'pi',
    config: { sessionsRoot: '/tmp/pi-sessions' },
  }).settings
  assert.equal(settings.bridges.length, 3)
  const work = settings.bridges.find((bridge) => bridge.name === 'Work Pi')
  const scratch = settings.bridges.find((bridge) => bridge.name === 'Scratch Pi')
  assert.equal(work.engine, 'pi')
  assert.equal(scratch.engine, 'pi')
  assert.equal(work.config.sessionsRoot, '/work/sessions')
  assert.equal(scratch.config.sessionsRoot, '/tmp/pi-sessions')
})

test('bridge update preserves a stored secret when the field is left blank', () => {
  let settings = createBridge(defaultSettings(), {
    name: 'Remote',
    mode: 'web',
    engine: 'dsh',
    config: { baseUrl: 'https://dsh.example.com', token: 'secret-token' },
  }).settings
  const bridge = settings.bridges.find((entry) => entry.name === 'Remote')
  settings = updateBridge(settings, bridge.id, {
    name: 'Remote DSH',
    config: { token: '' },
  }).settings
  const updated = settings.bridges.find((entry) => entry.id === bridge.id)
  assert.equal(updated.name, 'Remote DSH')
  assert.equal(updated.config.token, 'secret-token')
  assert.equal(updated.config.baseUrl, 'https://dsh.example.com')
})

test('bridge validation rejects mode/engine mismatches and unknown fields', () => {
  assert.throws(() => createBridge(defaultSettings(), {
    name: 'Wrong mode', mode: 'web', engine: 'pi', config: {},
  }), /not web/)
  assert.throws(() => createBridge(defaultSettings(), {
    name: 'Bad field', mode: 'cli', engine: 'pi', config: { nope: 1 },
  }), /unknown pi setting/)
  assert.throws(() => createBridge(defaultSettings(), {
    name: '', mode: 'cli', engine: 'pi', config: {},
  }), /name is required/)
})

test('delete removes only the selected bridge', () => {
  let settings = createBridge(defaultSettings(), { name: 'Second', mode: 'cli', engine: 'pi', config: {} }).settings
  const id = settings.bridges.find((bridge) => bridge.name === 'Second').id
  settings = deleteBridge(settings, id).settings
  assert.deepEqual(settings.bridges.map((bridge) => bridge.name), ['Pi'])
  assert.throws(() => deleteBridge(settings, id), /unknown bridge/)
})

test('migrates the old per-engine settings shape into bridge instances', () => {
  const migrated = normalizeSettings({
    version: 2,
    activeBackend: 'pi',
    backends: {
      pi: { sessionsRoot: '/old', executable: '/old/bin/pi', offline: false },
      codex: { executable: '/usr/bin/codex', sessionsRoot: null },
      opencode: { executable: null, sessionsRoot: null },
      'dsh-web': { baseUrl: 'https://dsh.example.com', token: null },
    },
  })
  assert.equal(migrated.version, 3)
  assert.deepEqual(migrated.bridges.map((bridge) => bridge.engine), ['pi', 'codex', 'dsh'])
  assert.deepEqual(migrated.bridges[0].config, { sessionsRoot: '/old', binPath: '/old/bin/pi', offline: false })
  assert.equal(migrated.bridges[1].name, 'Codex')
  assert.equal(migrated.bridges[2].name, 'DSH')
})

test('migrates the legacy Pi-only settings shape', () => {
  const migrated = normalizeSettings({
    backend: 'pi',
    pi: { sessionsRoot: '/old', binary: '/old/bin/pi', offline: false },
  })
  assert.equal(migrated.bridges.length, 1)
  assert.deepEqual(migrated.bridges[0].config, { sessionsRoot: '/old', binPath: '/old/bin/pi', offline: false })
})

test('normalizes unknown bridge values back to the default bridge', () => {
  const normalized = normalizeSettings({ bridges: [{ id: 'x', name: 'X', mode: 'cli', engine: 'nope' }] })
  assert.deepEqual(normalized.bridges, [])
  assert.deepEqual(normalizeSettings(null), defaultSettings())
})

test('writes a private, atomic bridge-list settings file under DSH_HOME', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bridge-settings-'))
  const env = { ...process.env, DSH_HOME: home }
  const saved = writeSettings({ bridges: [{ id: 'a', name: 'A', mode: 'cli', engine: 'pi', config: { sessionsRoot: '/tmp/sessions' } }] }, env)
  assert.equal(saved.bridges[0].config.sessionsRoot, '/tmp/sessions')
  assert.equal(settingsPath(env), join(home, 'bridge.json'))
  const text = await readFile(settingsPath(env), 'utf8')
  assert.match(text, /"sessionsRoot": "\/tmp\/sessions"/)
  assert.deepEqual(readSettings(env), saved)
})

test('reads a legacy file when the new settings file does not exist yet', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bridge-settings-'))
  const env = { ...process.env, DSH_HOME: home }
  await writeFile(legacySettingsPath(env), JSON.stringify({ backend: 'pi', pi: { offline: false } }), 'utf8')
  const settings = readSettings(env)
  assert.equal(settings.bridges[0].engine, 'pi')
  assert.equal(settings.bridges[0].config.offline, false)
})

test('a corrupt file falls back to defaults', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bridge-settings-'))
  const env = { ...process.env, DSH_HOME: home }
  const warnings = []
  writeSettings({}, env)
  await writeFile(settingsPath(env), '{broken', 'utf8')
  const settings = readSettings(env, { warn: (line) => warnings.push(line) })
  assert.equal(settings.bridges[0].id, 'pi-local')
  assert.equal(warnings.length, 1)
})
