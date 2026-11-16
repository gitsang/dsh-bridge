/**
 * Engine registry for the Bridge adapters.
 *
 * A bridge is a saved instance created by the user. It names an engine
 * (`pi`, `codex`, `opencode`, `dsh`) and carries that engine's config record.
 * Several bridges may point at the same engine with different session roots or
 * binaries; the registry only describes the engine capabilities.
 *
 * Each engine owns exactly one connection strategy, so a bridge never picks a
 * transport: Pi, Codex, and OpenCode speak to a local process, and DSH speaks
 * to another DeepSeek Harness Web instance over HTTP.
 */
import { codexEngine } from './codex/index.js'
import { opencodeEngine } from './opencode/index.js'
import { piEngine } from './pi/index.js'

/**
 * An engine that is intentionally declared before its adapter is complete.
 * It participates in the add-bridge form, but operations fail honestly.
 */
function plannedEngine(definition) {
  const unavailable = () => {
    throw Object.assign(
      new Error(`${definition.label} is not available yet: ${definition.unavailableReason}`),
      { status: 409 },
    )
  }
  return {
    ...definition,
    available: false,
    async listSessions() {
      return unavailable()
    },
    async readSession() {
      return unavailable()
    },
    async createAttachment() {
      return unavailable()
    },
  }
}

const dshEngine = plannedEngine({
  id: 'dsh',
  label: 'DSH',
  description: 'Connect to another DeepSeek Harness Web instance.',
  unavailableReason: 'remote DSH authentication and streaming transport are not implemented yet',
  capabilities: ['sessions', 'attach', 'stream', 'prompt', 'abort'],
  configFields: [
    { key: 'baseUrl', type: 'string', labelKey: 'baseUrl', hintKey: 'baseUrlHint', placeholder: 'https://dsh.example.com' },
    { key: 'token', type: 'secret', labelKey: 'accessToken', hintKey: 'accessTokenHint', placeholder: 'optional token' },
  ],
  defaultConfig: () => ({ baseUrl: null, token: null }),
})

/** Engine registry in menu order. */
export const ENGINES = [piEngine, codexEngine, opencodeEngine, dshEngine]

export const ENGINE_BY_ID = new Map(ENGINES.map((engine) => [engine.id, engine]))

export function getEngine(id) {
  return ENGINE_BY_ID.get(id)
}

export function engineConfigDefaults(engine) {
  const defaults = typeof engine.defaultConfig === 'function' ? engine.defaultConfig() : {}
  return { ...defaults }
}

/** Validate the engine id sent by the browser. */
export function resolveEngine(engineId) {
  const engine = getEngine(engineId)
  if (engine === undefined) {
    throw Object.assign(new Error(`unknown bridge engine: ${String(engineId)}`), { status: 400 })
  }
  return engine
}

/** Strip secret values while retaining whether one is already stored. */
export function redactEngineConfig(engine, config) {
  const redacted = { ...config }
  const configured = {}
  for (const field of engine.configFields ?? []) {
    if (field.type !== 'secret') continue
    configured[field.key] = typeof redacted[field.key] === 'string' && redacted[field.key] !== ''
    redacted[field.key] = null
  }
  return { config: redacted, configured }
}

/** Public engine descriptor for the add-bridge form. */
export function engineView(engine) {
  return {
    id: engine.id,
    label: engine.label,
    description: engine.description,
    available: engine.available !== false,
    unavailableReason: engine.available === false ? engine.unavailableReason : undefined,
    capabilities: engine.capabilities,
    configFields: engine.configFields,
    defaultConfig: engineConfigDefaults(engine),
  }
}

/** Public bridge descriptor with engine capabilities and redacted config. */
export function bridgeView(bridge) {
  const engine = getEngine(bridge.engine)
  if (engine === undefined) return null
  const { config, configured } = redactEngineConfig(engine, bridge.config)
  return {
    id: bridge.id,
    name: bridge.name,
    engine: bridge.engine,
    engineLabel: engine.label,
    description: engine.description,
    available: engine.available !== false,
    unavailableReason: engine.available === false ? engine.unavailableReason : undefined,
    capabilities: engine.capabilities,
    configFields: engine.configFields,
    config,
    configured,
  }
}

export function bridgeViews(bridges) {
  return bridges.map((bridge) => bridgeView(bridge)).filter(Boolean)
}
