/**
 * Persisted Bridge configuration.
 *
 * A user can create several bridges, including several instances of the same
 * engine. Each bridge record carries its mode, engine and engine-specific
 * config; the settings layer never interprets CLI protocols or session paths.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  ENGINES,
  engineConfigDefaults,
  getEngine,
  resolveEngine,
} from './backends/registry.js'

export const SETTINGS_VERSION = 3
export const DEFAULT_BRIDGE_ID = 'pi-local'

export function bridgeHome(env = process.env) {
  return env.DSH_HOME || join(homedir(), '.dsh')
}

export function settingsPath(env = process.env) {
  return join(bridgeHome(env), 'bridge.json')
}

/** Pre-0.3 settings were named after Pi; keep reading them for migration. */
export function legacySettingsPath(env = process.env) {
  return join(bridgeHome(env), 'pi-bridge.json')
}

function piDefaultConfig() {
  const engine = getEngine('pi')
  return engineConfigDefaults(engine)
}

export function defaultSettings() {
  return {
    version: SETTINGS_VERSION,
    bridges: [
      {
        id: DEFAULT_BRIDGE_ID,
        name: 'Pi',
        mode: 'cli',
        engine: 'pi',
        config: piDefaultConfig(),
      },
    ],
  }
}

function stringOrNull(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function defaultBridgeName(engine) {
  return engine?.label ?? 'Bridge'
}

function bridgeId(prefix = 'bridge') {
  return `${prefix}-${randomUUID()}`
}

/** Coerce one engine config record into the engine's declared field set. */
export function normalizeEngineConfig(engine, input) {
  const next = engineConfigDefaults(engine)
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return next
  for (const field of engine.configFields ?? []) {
    const value = input[field.key]
    if (value === undefined) continue
    next[field.key] = field.type === 'boolean' ? value !== false : stringOrNull(value)
  }
  return next
}

function normalizeBridge(input, index = 0) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null
  const engine = getEngine(input.engine)
  if (engine === undefined) return null
  const mode = typeof input.mode === 'string' && input.mode === engine.mode ? input.mode : engine.mode
  const id = typeof input.id === 'string' && input.id.trim() !== ''
    ? input.id.trim()
    : index === 0 ? DEFAULT_BRIDGE_ID : bridgeId(engine.id)
  const name = typeof input.name === 'string' && input.name.trim() !== ''
    ? input.name.trim()
    : defaultBridgeName(engine)
  return {
    id,
    name,
    mode,
    engine: engine.id,
    config: normalizeEngineConfig(engine, input.config),
  }
}

function legacyEngineConfig(engineId, legacy) {
  if (legacy === null || typeof legacy !== 'object') return {}
  const migrated = { ...legacy }
  if (migrated.binPath === undefined && (migrated.executable !== undefined || migrated.binary !== undefined)) {
    migrated.binPath = migrated.executable ?? migrated.binary
  }
  delete migrated.executable
  delete migrated.binary
  return migrated
}

function hasConfiguredValue(engine, config) {
  return Object.values(normalizeEngineConfig(engine, config)).some((value) => value !== null && value !== false)
}

function migrateLegacySettings(input) {
  const legacyBackends = input?.backends !== null && typeof input?.backends === 'object'
    ? input.backends
    : {}
  const piLegacy = legacyBackends.pi ?? input?.pi ?? {}
  const bridges = [{
    id: DEFAULT_BRIDGE_ID,
    name: 'Pi',
    mode: 'cli',
    engine: 'pi',
    config: normalizeEngineConfig(getEngine('pi'), legacyEngineConfig('pi', piLegacy)),
  }]

  for (const engine of ENGINES) {
    if (engine.id === 'pi') continue
    const legacy = legacyBackends[engine.id] ?? (engine.id === 'dsh' ? legacyBackends['dsh-web'] : undefined)
    if (!hasConfiguredValue(engine, legacyEngineConfig(engine.id, legacy))) continue
    bridges.push({
      id: `${engine.id}-local`,
      name: engine.label,
      mode: engine.mode,
      engine: engine.id,
      config: normalizeEngineConfig(engine, legacyEngineConfig(engine.id, legacy)),
    })
  }
  return bridges
}

/** Coerce a stored or submitted record into the current bridge-list schema. */
export function normalizeSettings(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return defaultSettings()
  let rawBridges
  if (Array.isArray(input.bridges)) rawBridges = input.bridges
  else if (input.backends !== undefined || input.pi !== undefined || input.backend !== undefined) {
    rawBridges = migrateLegacySettings(input)
  } else {
    return defaultSettings()
  }

  const seen = new Set()
  const bridges = []
  rawBridges.forEach((raw, index) => {
    const bridge = normalizeBridge(raw, index)
    if (bridge === null || seen.has(bridge.id)) return
    seen.add(bridge.id)
    bridges.push(bridge)
  })
  return { version: SETTINGS_VERSION, bridges }
}

/** Read settings from the current file, falling back to the legacy Pi file. */
export function readSettings(env = process.env, logger) {
  const file = settingsPath(env)
  const legacy = legacySettingsPath(env)
  const source = existsSync(file) ? file : existsSync(legacy) ? legacy : undefined
  if (source === undefined) return defaultSettings()
  try {
    return normalizeSettings(JSON.parse(readFileSync(source, 'utf8')))
  } catch (error) {
    logger?.warn?.(`bridge: ignoring unreadable settings file ${source}: ${error instanceof Error ? error.message : String(error)}`)
    return defaultSettings()
  }
}

/** Replace the settings file atomically so a crash cannot leave half a record. */
export function writeSettings(settings, env = process.env) {
  const normalized = normalizeSettings(settings)
  const file = settingsPath(env)
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(normalized, null, 2) + '\n', { mode: 0o600 })
  renameSync(temporary, file)
  return normalized
}

export function findBridge(settings, id) {
  return settings?.bridges?.find((bridge) => bridge.id === id)
}

function assertConfigValue(engine, field, value) {
  if (field.type === 'boolean') {
    if (typeof value !== 'boolean') {
      throw Object.assign(new Error(`${engine.id}.${field.key} must be a boolean`), { status: 400 })
    }
    return
  }
  if (value !== null && typeof value !== 'string') {
    throw Object.assign(new Error(`${engine.id}.${field.key} must be a string or null`), { status: 400 })
  }
}

function applyConfigPatch(engine, current, patch, { preserveSecret = false } = {}) {
  if (patch === undefined) return normalizeEngineConfig(engine, current)
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw Object.assign(new Error('config must be an object'), { status: 400 })
  }
  const next = normalizeEngineConfig(engine, current)
  for (const [key, value] of Object.entries(patch)) {
    const field = (engine.configFields ?? []).find((candidate) => candidate.key === key)
    if (field === undefined) {
      throw Object.assign(new Error(`unknown ${engine.id} setting: ${key}`), { status: 400 })
    }
    assertConfigValue(engine, field, value)
    if (field.type === 'secret' && preserveSecret && (value === null || value === '')) continue
    next[field.key] = field.type === 'boolean' ? value : stringOrNull(value)
  }
  return next
}

function bridgePayload(input, existing, { preserveSecret = false } = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new Error('bridge body must be an object'), { status: 400 })
  }
  const mode = input.mode ?? existing?.mode
  const engineId = input.engine ?? existing?.engine
  const engine = resolveEngine(mode, engineId)
  const name = input.name === undefined ? existing?.name : input.name
  if (typeof name !== 'string' || name.trim() === '') {
    throw Object.assign(new Error('bridge name is required'), { status: 400 })
  }
  const currentConfig = existing !== undefined && existing.engine === engine.id ? existing.config : {}
  const config = applyConfigPatch(engine, currentConfig, input.config, { preserveSecret })
  return {
    name: name.trim(),
    mode: engine.mode,
    engine: engine.id,
    config,
  }
}

/** Append a new bridge and return the new settings + record. */
export function createBridge(settings, input) {
  const next = normalizeSettings(settings)
  const bridge = bridgePayload(input, undefined)
  const created = { id: bridgeId(bridge.engine), ...bridge }
  return {
    settings: { ...next, bridges: [...next.bridges, created] },
    bridge: created,
  }
}

/** Update one bridge in place. Empty secret fields preserve the stored value. */
export function updateBridge(settings, id, input) {
  const next = normalizeSettings(settings)
  const index = next.bridges.findIndex((bridge) => bridge.id === id)
  if (index === -1) throw Object.assign(new Error(`unknown bridge: ${id}`), { status: 404 })
  const existing = next.bridges[index]
  const bridge = { id, ...bridgePayload(input, existing, { preserveSecret: true }) }
  const bridges = [...next.bridges]
  bridges[index] = bridge
  return { settings: { ...next, bridges }, bridge }
}

export function deleteBridge(settings, id) {
  const next = normalizeSettings(settings)
  const bridges = next.bridges.filter((bridge) => bridge.id !== id)
  if (bridges.length === next.bridges.length) {
    throw Object.assign(new Error(`unknown bridge: ${id}`), { status: 404 })
  }
  return { settings: { ...next, bridges } }
}
