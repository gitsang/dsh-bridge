/** Durable bridge-v2 backend configuration. */
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const CONFIG_VERSION = 1
export const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/

/** Resolve the config file path from the dsh home unless explicitly overridden. */
export function configPath(explicit) {
  if (typeof explicit === 'string' && explicit !== '') return explicit
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'bridge-v2.json')
}

/** The gateway may proxy its own dsh web server without an external address. */
export function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    bridges: [
      {
        id: 'native',
        name: 'Local',
        engine: 'native',
        autostart: true,
        upstream: { self: true },
      },
    ],
  }
}

function text(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} is required`)
  return value
}

function optionalText(value, field) {
  if (value === undefined || value === null || value === '') return undefined
  return text(value, field)
}

/** Validate one upstream selector and return a normalized copy. */
export function normalizeUpstream(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('upstream must be an object')
  }
  const self = input.self === true
  const url = optionalText(input.url, 'upstream.url')
  const command = optionalText(input.command, 'upstream.command')
  const token = optionalText(input.token, 'upstream.token')
  const cwd = optionalText(input.cwd, 'upstream.cwd')
  const env = input.env
  if ((self ? 1 : 0) + (url === undefined ? 0 : 1) + (command === undefined ? 0 : 1) !== 1) {
    throw new Error('upstream must select exactly one of self, url, or command')
  }
  if (url !== undefined) {
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      throw new Error(`upstream.url is not a URL: ${url}`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('upstream.url must use http or https')
    }
  }
  if (command !== undefined && (!Array.isArray(input.args) || input.args.some((arg) => typeof arg !== 'string'))) {
    throw new Error('upstream.args must be a string array')
  }
  if (env !== undefined && (env === null || typeof env !== 'object' || Array.isArray(env)
    || Object.values(env).some((value) => typeof value !== 'string'))) {
    throw new Error('upstream.env must be a string map')
  }
  return {
    ...(self ? { self: true } : {}),
    ...(url === undefined ? {} : { url }),
    ...(command === undefined ? {} : {
      command,
      args: [...input.args],
      ...(cwd === undefined ? {} : { cwd }),
      ...(env === undefined ? {} : { env: { ...env } }),
    }),
    ...(token === undefined ? {} : { token }),
  }
}

/** Validate one saved bridge and return a normalized copy. */
export function normalizeBridge(input, previousId) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('bridge must be an object')
  const id = text(input.id ?? previousId, 'id')
  if (!ID_PATTERN.test(id)) throw new Error('id must match [a-z0-9][a-z0-9-]*')
  if (previousId !== undefined && id !== previousId) throw new Error('id is immutable')
  if (input.id !== undefined && input.id !== id) throw new Error('id is immutable')
  const name = text(input.name, 'name')
  const engine = input.engine ?? 'dsh'
  if (!['native', 'dsh', 'pi', 'codex', 'opencode'].includes(engine)) {
    throw new Error(`unknown engine: ${engine}`)
  }
  return {
    id,
    name,
    engine,
    autostart: input.autostart !== false,
    upstream: normalizeUpstream(input.upstream),
    ...(input.health === undefined ? {} : {
      health: {
        timeoutMs: Number.isInteger(input.health?.timeoutMs) && input.health.timeoutMs > 0
          ? input.health.timeoutMs
          : 15_000,
        ...(optionalText(input.health?.version, 'health.version') === undefined
          ? {}
          : { version: input.health.version }),
      },
    }),
  }
}

/** Validate and normalize one complete configuration document. */
export function normalizeConfig(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('config must be an object')
  if (input.version !== undefined && input.version !== CONFIG_VERSION) {
    throw new Error(`unsupported config version: ${String(input.version)}`)
  }
  const bridges = Array.isArray(input.bridges) ? input.bridges.map((bridge) => normalizeBridge(bridge)) : []
  if (bridges.length === 0) throw new Error('at least one bridge is required')
  const ids = new Set()
  for (const bridge of bridges) {
    if (ids.has(bridge.id)) throw new Error(`duplicate bridge id: ${bridge.id}`)
    ids.add(bridge.id)
  }
  return { version: CONFIG_VERSION, bridges }
}

/** Read the config document; a missing file yields the one native backend. */
export async function readConfig(path = configPath()) {
  let raw
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return defaultConfig()
    throw error
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`invalid bridge config JSON: ${path}`)
  }
  return normalizeConfig(parsed)
}

/** Atomically persist the config as owner-only JSON. */
export async function writeConfig(config, path = configPath()) {
  const normalized = normalizeConfig(config)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  const handle = await open(temp, 'w', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
  return normalized
}

/** Replace one bridge. */
export function upsertBridge(config, bridge) {
  const normalized = normalizeBridge(bridge)
  const bridges = config.bridges.some((entry) => entry.id === normalized.id)
    ? config.bridges.map((entry) => (entry.id === normalized.id ? normalized : entry))
    : [...config.bridges, normalized]
  return normalizeConfig({ ...config, bridges })
}

/** Remove one bridge; the native backend cannot be removed. */
export function removeBridge(config, id) {
  if (id === 'native') throw new Error('the native bridge cannot be removed')
  if (!config.bridges.some((entry) => entry.id === id)) throw new Error(`unknown bridge: ${id}`)
  return normalizeConfig({ ...config, bridges: config.bridges.filter((entry) => entry.id !== id) })
}
