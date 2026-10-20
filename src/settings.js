/**
 * Persisted bridge backends.
 *
 * The browser chooses which agent backend the Bridge panel talks to. Pi is the
 * only backend at this stage; the record keeps the shape generic so a second
 * backend can be added without rewriting the settings file.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export const SETTINGS_VERSION = 1
export const DEFAULT_BACKEND = 'pi'

/** Backends the host can serve, in menu order. */
export const BACKENDS = [
  {
    id: 'pi',
    label: 'Pi Coding Agent',
    description: 'Attach to a Pi session through `pi --mode rpc`.',
    available: true,
    capabilities: ['sessions', 'attach', 'prompt', 'abort', 'extension-ui'],
  },
]

export function bridgeHome(env = process.env) {
  return env.DSH_HOME || join(homedir(), '.dsh')
}

export function settingsPath(env = process.env) {
  return join(bridgeHome(env), 'pi-bridge.json')
}

export function defaultSettings() {
  return {
    version: SETTINGS_VERSION,
    backend: DEFAULT_BACKEND,
    pi: {
      sessionsRoot: null,
      binary: null,
      offline: true,
    },
  }
}

function stringOrNull(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** Coerce a stored or submitted record into the current schema. */
export function normalizeSettings(input) {
  const base = defaultSettings()
  if (input === null || typeof input !== 'object') return base
  const backend = typeof input.backend === 'string' && BACKENDS.some((entry) => entry.id === input.backend)
    ? input.backend
    : base.backend
  const pi = input.pi !== null && typeof input.pi === 'object' ? input.pi : {}
  return {
    version: SETTINGS_VERSION,
    backend,
    pi: {
      sessionsRoot: stringOrNull(pi.sessionsRoot),
      binary: stringOrNull(pi.binary),
      offline: pi.offline === undefined ? true : pi.offline !== false,
    },
  }
}

/** Read settings, falling back to defaults for a missing or corrupt file. */
export function readSettings(env = process.env, logger) {
  const file = settingsPath(env)
  if (!existsSync(file)) return defaultSettings()
  try {
    return normalizeSettings(JSON.parse(readFileSync(file, 'utf8')))
  } catch (error) {
    logger?.warn?.(`pi-bridge: ignoring unreadable settings file ${file}: ${error instanceof Error ? error.message : String(error)}`)
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

/**
 * Resolve the Pi session root from settings, environment, then the Pi default.
 * An explicit settings value wins so the settings page can point the panel at a
 * test or alternate Pi home without restarting dsh.
 */
export function resolveSessionsRoot(settings, env = process.env) {
  if (settings?.pi?.sessionsRoot) return resolve(settings.pi.sessionsRoot)
  if (env.PI_CODING_AGENT_SESSION_DIR) return resolve(env.PI_CODING_AGENT_SESSION_DIR)
  const agentDir = env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent')
  return resolve(join(agentDir, 'sessions'))
}

/** Reject a settings patch before it reaches the file. */
export function validateSettingsPatch(patch, current) {
  if (patch === null || typeof patch !== 'object') {
    throw Object.assign(new Error('settings body must be an object'), { status: 400 })
  }
  if (patch.backend !== undefined && !BACKENDS.some((entry) => entry.id === patch.backend)) {
    throw Object.assign(new Error(`unknown backend: ${String(patch.backend)}`), { status: 400 })
  }
  const next = { ...current }
  if (patch.backend !== undefined) next.backend = patch.backend
  if (patch.pi !== undefined) {
    if (patch.pi === null || typeof patch.pi !== 'object') {
      throw Object.assign(new Error('pi settings must be an object'), { status: 400 })
    }
    const pi = { ...current.pi }
    for (const field of ['sessionsRoot', 'binary']) {
      if (patch.pi[field] !== undefined) {
        if (patch.pi[field] !== null && typeof patch.pi[field] !== 'string') {
          throw Object.assign(new Error(`pi.${field} must be a string or null`), { status: 400 })
        }
        pi[field] = stringOrNull(patch.pi[field])
      }
    }
    if (patch.pi.offline !== undefined) {
      if (typeof patch.pi.offline !== 'boolean') {
        throw Object.assign(new Error('pi.offline must be a boolean'), { status: 400 })
      }
      pi.offline = patch.pi.offline
    }
    next.pi = pi
  }
  return normalizeSettings(next)
}
