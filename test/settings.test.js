import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  BACKENDS,
  defaultSettings,
  normalizeSettings,
  readSettings,
  resolveSessionsRoot,
  settingsPath,
  validateSettingsPatch,
  writeSettings,
} from '../src/settings.js'

test('exposes Pi as the only available backend', () => {
  assert.deepEqual(BACKENDS.map((entry) => entry.id), ['pi'])
  assert.equal(BACKENDS[0].available, true)
  assert.ok(BACKENDS[0].capabilities.includes('extension-ui'))
})

test('normalizes unknown values back to defaults', () => {
  const normalized = normalizeSettings({ backend: 'nope', pi: { sessionsRoot: '', binary: '  ', offline: 'yes' } })
  assert.equal(normalized.backend, 'pi')
  assert.equal(normalized.pi.sessionsRoot, null)
  assert.equal(normalized.pi.binary, null)
  assert.equal(normalized.pi.offline, true)
  assert.deepEqual(normalizeSettings(null), defaultSettings())
})

test('writes a private, atomic settings file under DSH_HOME', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pi-bridge-settings-'))
  const env = { ...process.env, DSH_HOME: home }
  const saved = writeSettings({ pi: { sessionsRoot: '/tmp/sessions', offline: false } }, env)
  assert.equal(saved.pi.sessionsRoot, '/tmp/sessions')
  assert.equal(settingsPath(env), join(home, 'pi-bridge.json'))
  const text = await readFile(settingsPath(env), 'utf8')
  assert.match(text, /"sessionsRoot": "\/tmp\/sessions"/)
  assert.deepEqual(readSettings(env), saved)
})

test('a corrupt file falls back to defaults', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pi-bridge-settings-'))
  const env = { ...process.env, DSH_HOME: home }
  const warnings = []
  writeSettings({}, env)
  await (await import('node:fs/promises')).writeFile(settingsPath(env), '{broken', 'utf8')
  const settings = readSettings(env, { warn: (line) => warnings.push(line) })
  assert.equal(settings.backend, 'pi')
  assert.equal(warnings.length, 1)
})

test('validates patches before they reach the file', () => {
  const current = defaultSettings()
  assert.equal(validateSettingsPatch({ backend: 'pi' }, current).backend, 'pi')
  assert.equal(validateSettingsPatch({ pi: { offline: false } }, current).pi.offline, false)
  assert.throws(() => validateSettingsPatch({ backend: 'claude' }, current), /unknown backend/)
  assert.throws(() => validateSettingsPatch({ pi: { binary: 42 } }, current), /pi.binary/)
  assert.throws(() => validateSettingsPatch({ pi: { offline: 'yes' } }, current), /pi.offline/)
  assert.throws(() => validateSettingsPatch(null, current), /must be an object/)
})

test('resolves the sessions root from settings, then the environment', () => {
  const env = { ...process.env, PI_CODING_AGENT_SESSION_DIR: '/env/sessions', PI_CODING_AGENT_DIR: '' }
  assert.equal(resolveSessionsRoot({ pi: { sessionsRoot: '/settings/sessions' } }, env), '/settings/sessions')
  assert.equal(resolveSessionsRoot(defaultSettings(), env), '/env/sessions')
})
