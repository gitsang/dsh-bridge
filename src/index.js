/**
 * Host half of dsh-bridge.
 *
 * The host is bridge-instance oriented: every request names a saved bridge
 * (or carries an opaque session key containing one), resolves its engine, and
 * then delegates to that engine adapter. No engine-specific protocol lives in
 * this module.
 */
import {
  BRIDGE_MODES,
  ENGINES,
  bridgeView,
  engineView,
  getEngine,
} from './backends/registry.js'
import { decodeSessionKey, encodeSessionKey } from './backends/keys.js'
import { mkdir, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { messageText } from './message.js'
import {
  createBridge,
  deleteBridge,
  findBridge,
  normalizeEngineConfig,
  normalizeSettings,
  readSettings,
  updateBridge,
  writeSettings,
} from './settings.js'
import {
  archiveSession as archiveNativeSession,
  deleteBridgeArchives,
  isSessionArchived,
  listArchivedSessionKeys,
  readArchiveStore,
  unarchiveSession as unarchiveNativeSession,
  writeArchiveStore,
} from './archives.js'
import {
  createWorkspace,
  deleteWorkspace,
  listWorkspaces,
  publicWorkspace,
  readWorkspaceStore,
  removedWorkspacePaths,
  renameWorkspace,
  writeWorkspaceStore,
} from './workspaces.js'
import {
  deleteBridgeImports,
  importSessions as importNativeSessions,
  listImportedSessionKeys,
  readImportStore,
  writeImportStore,
} from './imports.js'

export const name = 'bridge'
export const inject = ['connection']

const ROUTE = '/api/bridge'
const MAX_BODY_BYTES = 1024 * 1024
const EVENT_RING = 400
const KEEPALIVE_MS = 15_000

const encoder = new TextEncoder()

function json(status, value, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  })
}

function failure(error, status = 500) {
  const message = error instanceof Error ? error.message : String(error)
  return json(status, { ok: false, error: message })
}

async function readJson(request) {
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw Object.assign(new Error('request body too large'), { status: 413 })
  }
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) {
    throw Object.assign(new Error('request body too large'), { status: 413 })
  }
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw Object.assign(new Error('invalid JSON body'), { status: 400 })
  }
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw Object.assign(new Error(`${field} is required`), { status: 400 })
  }
  return value
}

function wireSafe(value) {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return { unserializable: true }
  }
}

function publicSession(bridge, engine, session) {
  if (session === null || typeof session !== 'object') throw new Error('engine returned an invalid session')
  const nativeKey = session.nativeKey ?? session.key
  if (typeof nativeKey !== 'string' || nativeKey === '') throw new Error('engine returned a session without a key')
  const { nativeKey: _nativeKey, ...rest } = session
  return {
    ...rest,
    engine: engine.id,
    bridge: bridge.id,
    key: encodeSessionKey(bridge.id, nativeKey),
  }
}

class EventClient {
  constructor(controller) {
    this.controller = controller
    this.closed = false
  }

  send(event, data) {
    if (this.closed) return
    try {
      this.controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
    } catch {
      this.closed = true
    }
  }

  close() {
    if (this.closed) return
    this.closed = true
    try {
      this.controller.close()
    } catch {
      // The browser may already have cancelled the stream.
    }
  }
}

class AttachmentSession {
  constructor({ bridge, engine, attachment, session, key }) {
    this.bridge = bridge
    this.bridgeId = bridge.id
    this.engine = engine
    this.engineId = engine.id
    this.attachment = attachment
    this.session = session
    this.key = key
    this.clients = new Set()
    this.ring = []
    this.subscriptions = []
    this.sequence = 0
    this.disposed = false
    this.intentionalClose = false
    this.onAgentStart = null
    this.onAgentSettled = null
  }

  publish(event, data) {
    const payload = wireSafe(data)
    this.sequence += 1
    const record = { seq: this.sequence, event, data: payload, at: Date.now() }
    this.ring.push(record)
    if (this.ring.length > EVENT_RING) this.ring.shift()
    for (const client of this.clients) client.send(event, payload)
  }

  subscribe(client) {
    this.clients.add(client)
    client.send('snapshot', {
      ok: true,
      bridge: this.bridgeId,
      engine: this.engineId,
      session: this.session,
      pid: this.attachment.pid,
      running: this.attachment.running,
      activity: typeof this.activity === 'function' ? this.activity() : null,
      sequence: this.sequence,
      recentEvents: this.ring.slice(-100),
    })
    return () => this.clients.delete(client)
  }

  watch() {
    const listen = (event, handler) => {
      this.attachment.on(event, handler)
      this.subscriptions.push(() => this.attachment.off(event, handler))
    }
    const forward = (event) => (record) => this.publish(event, record)
    listen('event', (record) => {
      const normalized = typeof this.engine.normalizeEvent === 'function'
        ? this.engine.normalizeEvent(record)
        : { type: 'backend-event', event: record }
      const events = Array.isArray(normalized) ? normalized : normalized === null ? [] : [normalized]
      for (const event of events) {
        if (event.type === 'agent-start') this.onAgentStart?.(event)
        else if (event.type === 'agent-settled') this.onAgentSettled?.(event)
        this.publish('bridge-event', event)
      }
    })
    listen('ui-request', forward('bridge-ui-request'))
    listen('ui-notification', forward('bridge-ui-notification'))
    listen('extension-error', forward('bridge-extension-error'))
    listen('protocol-error', forward('bridge-protocol-error'))
    listen('spawn', forward('bridge-spawn'))
    listen('exit', (info) => {
      this.publish('bridge-exit', info)
      this.onExit?.()
    })
    return this
  }

  async close() {
    if (this.disposed) return
    this.disposed = true
    this.intentionalClose = true
    // Let subscribers learn that the per-turn agent is gone before their
    // streams are torn down; otherwise the browser keeps a stale attached flag.
    this.publish('bridge-session-closed', { key: this.key, activity: typeof this.activity === 'function' ? this.activity() : null })
    for (const unsubscribe of this.subscriptions) unsubscribe()
    this.subscriptions = []
    for (const client of this.clients) client.close()
    this.clients.clear()
    await this.attachment.dispose()
  }
}

const DIRECTORY_LIMIT = 1000

/**
 * Resolve one browsable directory. The directory browser is deliberately local
 * to the authenticated dsh host and accepts absolute paths, matching dsh's own
 * workspace picker. Relative paths are resolved against the host home so an
 * empty/missing path opens Home instead of the process working directory.
 */
async function resolveDirectoryPath(value) {
  if (value === undefined || value === null || value === '') return realpath(homedir())
  if (typeof value !== 'string') throw Object.assign(new Error('path must be a string'), { status: 400 })
  const path = isAbsolute(value) ? resolve(value) : resolve(homedir(), value)
  let resolved
  try {
    resolved = await realpath(path)
  } catch {
    throw Object.assign(new Error(`directory does not exist: ${path}`), { status: 404 })
  }
  const info = await stat(resolved)
  if (!info.isDirectory()) throw Object.assign(new Error(`not a directory: ${path}`), { status: 400 })
  return resolved
}

/** List immediate child folders for the Bridge workspace directory picker. */
async function listDirectories(requestPath) {
  const path = await resolveDirectoryPath(requestPath)
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch (error) {
    throw Object.assign(new Error(`could not read directory: ${error instanceof Error ? error.message : String(error)}`), { status: 403 })
  }
  const folders = []
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    let directory = entry.isDirectory()
    if (!directory) {
      try {
        directory = (await stat(join(path, entry.name))).isDirectory()
      } catch {
        directory = false
      }
    }
    if (!directory) continue
    folders.push({
      name: entry.name,
      path: join(path, entry.name),
      hidden: entry.name.startsWith('.'),
    })
  }
  folders.sort((left, right) => left.name.localeCompare(right.name))
  return {
    home: homedir(),
    path,
    parent: resolve(path, '..') === path ? null : resolve(path, '..'),
    entries: folders.slice(0, DIRECTORY_LIMIT),
    truncated: folders.length > DIRECTORY_LIMIT,
  }
}

/** Create one child directory for the workspace picker and return its path. */
async function createDirectory(parentValue, nameValue) {
  const parent = await resolveDirectoryPath(parentValue)
  if (typeof nameValue !== 'string') throw Object.assign(new Error('name is required'), { status: 400 })
  const name = nameValue.trim()
  if (name === '' || name === '.' || name === '..' || /[\\/\0]/.test(name)) {
    throw Object.assign(new Error('folder name must be a single path segment'), { status: 400 })
  }
  const path = join(parent, name)
  try {
    await mkdir(path)
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'EEXIST') {
      throw Object.assign(new Error(`folder already exists: ${name}`), { status: 409 })
    }
    throw Object.assign(new Error(`could not create folder: ${error instanceof Error ? error.message : String(error)}`), { status: 500 })
  }
  return { path, name: basename(path), parent }
}

export function apply(ctx) {
  const attachments = new Map()
  const pendingAttachments = new Map()
  const sessionActivity = new Map()
  const disposeTimers = new Map()
  // Model catalogs are engine-wide, not session-wide: cache per bridge so an
  // unconnected session can still show the picker. Cold start spawns one
  // short-lived Pi child, warm reads are free.
  const modelCatalogs = new Map()
  const modelCatalogPending = new Map()
  // Chosen model while no agent is alive; applied right after the next attach.
  const pendingModels = new Map()
  const logger = ctx.logger
  let settings = readSettings(process.env, logger)
  let workspaceStore = readWorkspaceStore(process.env, logger)
  let archiveStore = readArchiveStore(process.env, logger)
  let importStore = readImportStore(process.env, logger)

  /**
   * Per-bridge connection state for the startup auto-connect and the status
   * dots in the switcher. This is a bridge-level readiness probe (launcher and
   * session root), not one agent process per session; session attachments stay
   * lazy and are keyed separately in `attachments`.
   */
  const connections = new Map()
  const probeTokens = new Map()

  const engineAvailable = (engine) => engine.available !== false

  /** Guardrail: a settled turn keeps its process only long enough to flush. */
  const SESSION_SETTLE_CLOSE_MS = 1200
  const MODEL_CATALOG_TTL_MS = 10 * 60 * 1000

  const modelsForBridge = async (bridge, { force = false } = {}) => {
    const cached = modelCatalogs.get(bridge.id)
    if (!force && cached !== undefined && Date.now() - cached.at < MODEL_CATALOG_TTL_MS) {
      return { models: cached.models, cached: true, at: cached.at }
    }
    const pending = modelCatalogPending.get(bridge.id)
    if (pending !== undefined) return pending
    const job = (async () => {
      const engine = engineFor(bridge)
      if (!engineAvailable(engine)) {
        throw Object.assign(new Error(engine.unavailableReason ?? `${engine.label} is not available`), { status: 409 })
      }
      if (typeof engine.listModels !== 'function') {
        throw Object.assign(new Error(`${engine.label} does not expose a model catalog`), { status: 409 })
      }
      const models = await engine.listModels(configFor(bridge, engine), process.env)
      const entry = { at: Date.now(), models: Array.isArray(models) ? models : [] }
      modelCatalogs.set(bridge.id, entry)
      return { models: entry.models, cached: false, at: entry.at }
    })()
    modelCatalogPending.set(bridge.id, job)
    try {
      return await job
    } finally {
      if (modelCatalogPending.get(bridge.id) === job) modelCatalogPending.delete(bridge.id)
    }
  }

  const activityView = (key) => ({
    state: 'unknown',
    startedAt: null,
    completedAt: null,
    error: null,
    aborted: false,
    ...(sessionActivity.get(key) ?? {}),
  })

  const setActivity = (key, patch) => {
    sessionActivity.set(key, { ...activityView(key), ...patch })
  }

  /**
   * A finished turn is only interesting until the user looks at the session.
   * Opening it (or an explicit ack) drops the completion marker so the green
   * dot disappears; a running/connecting turn is never cleared.
   */
  const clearFinishedActivity = (key) => {
    const activity = sessionActivity.get(key)
    if (activity === undefined) return false
    // The recorded idle/failed state is the completion acknowledgement. The
    // engine process may still be alive while it waits for its settle timeout,
    // so process liveness must not keep the completion dot from clearing.
    if (activity.state !== 'idle' && activity.state !== 'failed') return false
    sessionActivity.delete(key)
    return true
  }

  const cancelDispose = (key) => {
    const timer = disposeTimers.get(key)
    if (timer === undefined) return
    clearTimeout(timer)
    disposeTimers.delete(key)
  }

  const connectionView = (bridgeId) => {
    const value = connections.get(bridgeId)
    return value === undefined
      ? { state: 'idle', error: null, checkedAt: null, latencyMs: null }
      : { ...value }
  }

  const bridgeWithConnection = (bridge) => {
    const view = bridgeView(bridge)
    return view === null ? null : { ...view, connection: connectionView(bridge.id) }
  }

  const bridgesWithConnection = () => settings.bridges.map(bridgeWithConnection).filter(Boolean)

  const setConnection = (bridgeId, patch) => {
    connections.set(bridgeId, { ...(connections.get(bridgeId) ?? {}), ...patch })
  }

  const autoConnectEnabled = () => process.env.BRIDGE_AUTO_CONNECT !== '0'

  /**
   * Startup readiness probe. It answers "would a lazy attach for this bridge
   * be able to start?" without spawning an agent: launcher plus session root.
   * Sessions are attached only for the duration of one turn, so no process is
   * created here and the bridge dot means "ready", not "child running".
   */
  const autoConnectBridge = async (bridge) => {
    const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    probeTokens.set(bridge.id, token)
    const startedAt = Date.now()
    setConnection(bridge.id, { state: 'connecting', error: null, checkedAt: startedAt, latencyMs: null })
    try {
      const engine = engineFor(bridge)
      if (!engineAvailable(engine)) throw new Error(engine.unavailableReason ?? `${engine.label} is not available`)
      const config = configFor(bridge, engine)
      const detail = typeof engine.probe === 'function' ? await engine.probe(config, process.env) : null
      if (probeTokens.get(bridge.id) !== token) return
      setConnection(bridge.id, {
        state: 'connected',
        error: null,
        checkedAt: Date.now(),
        latencyMs: Date.now() - startedAt,
        detail: wireSafe(detail),
      })
      logger?.info?.(`bridge: ready ${bridge.name} (${bridge.id})`)
    } catch (error) {
      if (probeTokens.get(bridge.id) !== token) return
      const message = error instanceof Error ? error.message : String(error)
      setConnection(bridge.id, {
        state: 'failed',
        error: message,
        checkedAt: Date.now(),
        latencyMs: Date.now() - startedAt,
        detail: null,
      })
      logger?.warn?.(`bridge: readiness probe failed for ${bridge.name} (${bridge.id}): ${message}`)
    }
  }

  const autoConnectAllBridges = async () => {
    await Promise.allSettled(settings.bridges.map((bridge) => autoConnectBridge(bridge)))
  }

  const bridgeFor = (id) => {
    const bridge = findBridge(settings, requireString(id, 'bridge'))
    if (bridge === undefined) throw Object.assign(new Error(`unknown bridge: ${id}`), { status: 404 })
    return bridge
  }

  const engineFor = (bridge) => {
    const engine = getEngine(bridge.engine)
    if (engine === undefined) throw Object.assign(new Error(`unknown bridge engine: ${bridge.engine}`), { status: 500 })
    return engine
  }

  const configFor = (bridge, engine) => normalizeEngineConfig(engine, bridge.config)

  const resolveSessionKey = (key) => {
    let decoded
    try {
      decoded = decodeSessionKey(key)
    } catch (error) {
      throw Object.assign(error, { status: 400 })
    }
    const bridge = findBridge(settings, decoded.bridgeId)
    if (bridge === undefined) throw Object.assign(new Error(`unknown bridge: ${decoded.bridgeId}`), { status: 404 })
    const engine = engineFor(bridge)
    if (!engineAvailable(engine)) {
      throw Object.assign(new Error(`${engine.label} is not available yet: ${engine.unavailableReason}`), { status: 409 })
    }
    return { bridge, engine, nativeKey: decoded.nativeKey }
  }

  const sessionFor = async (key) => {
    const { bridge, engine, nativeKey } = resolveSessionKey(key)
    const session = await engine.readSession(nativeKey, configFor(bridge, engine), process.env)
    return { bridge, engine, nativeKey, session: publicSession(bridge, engine, session) }
  }

  /**
   * Browser-facing archive state for one bridge. Native keys are encoded with
   * the same bridge-id prefix as session keys, so the sidebar can keep its
   * existing Set<session.key> filtering while the durable authority stays on
   * the host.
   */
  const archivedKeysFor = (bridgeId) =>
    listArchivedSessionKeys(archiveStore, bridgeId)
      .map((nativeKey) => encodeSessionKey(bridgeId, nativeKey))

  const isArchivedKey = (nativeKey, bridgeId) =>
    isSessionArchived(archiveStore, bridgeId, nativeKey)

  const assertNotArchived = (nativeKey, bridgeId) => {
    if (!isArchivedKey(nativeKey, bridgeId)) return
    throw Object.assign(new Error('session is archived; unarchive it before opening'), { status: 409 })
  }

  const saveArchiveStore = (result) => {
    if (result.changed) archiveStore = writeArchiveStore(result.store, process.env)
    return result
  }

  const importedNativeKeysFor = (bridgeId) => new Set(listImportedSessionKeys(importStore, bridgeId))

  const importedKeysFor = (bridgeId) =>
    listImportedSessionKeys(importStore, bridgeId)
      .map((nativeKey) => encodeSessionKey(bridgeId, nativeKey))

  const saveImportStore = (result) => {
    if (result.changed) importStore = writeImportStore(result.store, process.env)
    return result
  }

  /**
   * Create durable workspace metadata for an imported workspace. Existing
   * active records are left untouched; an explicitly imported tombstoned path
   * is revived so import can always bring a folder back into the sidebar.
   */
  const ensureImportedWorkspace = (bridgeId, path, name) => {
    if (typeof path !== 'string' || path === '') return false
    if (listWorkspaces(workspaceStore, bridgeId).some((workspace) => workspace.path === path)) return false
    const result = createWorkspace(workspaceStore, bridgeId, { path, name })
    workspaceStore = writeWorkspaceStore(result.store, process.env)
    return true
  }

  /**
   * Reconcile the durable workspace metadata with the engine's current session
   * list, then attach live session counts. This runs on every session query so
   * only imported sessions are passed in; unimported sessions discovered under
   * the engine root remain candidates in the import dialog. Existing names and
   * tombstones are preserved.
   */
  const workspaceSnapshot = (bridgeId, sessions = []) => {
    const counts = new Map()
    for (const session of sessions) {
      if (typeof session.cwd !== 'string' || session.cwd === '') continue
      counts.set(session.cwd, (counts.get(session.cwd) ?? 0) + 1)
    }
    return {
      workspaces: listWorkspaces(workspaceStore, bridgeId)
        .map((workspace) => publicWorkspace(workspace, counts.get(workspace.path) ?? 0)),
      removedWorkspacePaths: removedWorkspacePaths(workspaceStore, bridgeId),
    }
  }

  const settingsView = () => ({
    settings: {
      version: settings.version,
      bridges: bridgesWithConnection(),
    },
    bridges: bridgesWithConnection(),
    engines: ENGINES.map(engineView),
    modes: BRIDGE_MODES,
  })

  const attachmentFor = (key) => {
    const live = attachments.get(key)
    if (live !== undefined) return live
    throw Object.assign(new Error('session is not attached'), { status: 409 })
  }

  const liveAttachmentForBridge = (bridgeId) =>
    [...attachments.values()].some((live) => live.bridgeId === bridgeId)

  const attach = async (key) => {
    const existing = attachments.get(key)
    if (existing !== undefined) return existing
    // Startup auto-connect, the status route, and a user attach can race for
    // the same session. Share one spawn promise so a session never gets two
    // Pi children writing the same JSONL.
    const pending = pendingAttachments.get(key)
    if (pending !== undefined) return pending

    const job = (async () => {
      cancelDispose(key)
      setActivity(key, { state: 'connecting', startedAt: Date.now(), completedAt: null, error: null, aborted: false })
      const { bridge, engine, nativeKey, session } = await sessionFor(key)
      assertNotArchived(nativeKey, bridge.id)
      const config = configFor(bridge, engine)
      const attachment = await engine.createAttachment({
        session: { ...session, nativeKey },
        config,
        env: process.env,
        logger,
      })
      await attachment.start()
      try {
        await attachment.getState()
        const pendingModel = pendingModels.get(key)
        if (pendingModel !== undefined && typeof attachment.setModel === 'function') {
          try {
            await attachment.setModel(pendingModel.provider, pendingModel.id)
            pendingModels.delete(key)
          } catch (error) {
            logger?.warn?.(`bridge: could not apply pending model ${pendingModel.provider}/${pendingModel.id}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      } catch (error) {
        const detail = attachment.stderr.trim()
        await attachment.dispose()
        const failure = new Error(
          detail === ''
            ? `${engine.label} exited during startup (${error instanceof Error ? error.message : String(error)})`
            : `${engine.label} exited during startup: ${detail}`,
        )
        failure.status = 502
        throw failure
      }
      const live = new AttachmentSession({ bridge, engine, attachment, session, key }).watch()
      live.activity = () => activityView(key)
      live.onAgentStart = () => {
        setActivity(key, { state: 'running', startedAt: Date.now(), completedAt: null, error: null, aborted: false })
      }
      live.onAgentSettled = (event) => {
        setActivity(key, {
          state: 'idle',
          completedAt: Date.now(),
          error: null,
          aborted: event?.aborted === true,
        })
        scheduleDispose(key)
      }
      live.onExit = () => {
        if (attachments.get(key) === live) attachments.delete(key)
        const stillLive = [...attachments.values()].some((entry) => entry.bridgeId === bridge.id && entry.attachment.running)
        if (stillLive) return
        if (live.intentionalClose) {
          setConnection(bridge.id, { state: 'connected', error: null, checkedAt: Date.now(), latencyMs: null, detail: null })
        } else {
          setConnection(bridge.id, {
            state: 'failed',
            error: 'agent process exited',
            checkedAt: Date.now(),
            latencyMs: null,
          })
          setActivity(key, {
            state: 'failed',
            completedAt: Date.now(),
            error: 'agent process exited',
          })
        }
      }
      attachments.set(key, live)
      setActivity(key, { state: 'idle', startedAt: null, completedAt: null, error: null, aborted: false })
      setConnection(bridge.id, { state: 'connected', error: null, checkedAt: Date.now(), latencyMs: null })
      logger?.info?.(`bridge: attached ${bridge.name} (${bridge.id}) session ${session.id ?? nativeKey} (pid ${attachment.pid})`)
      return live
    })()

    pendingAttachments.set(key, job)
    try {
      return await job
    } finally {
      if (pendingAttachments.get(key) === job) pendingAttachments.delete(key)
    }
  }

  const closeSession = async (key) => {
    cancelDispose(key)
    const live = attachments.get(key)
    if (live === undefined) return false
    attachments.delete(key)
    await live.close()
    return true
  }

  const scheduleDispose = (key) => {
    cancelDispose(key)
    const timer = setTimeout(() => {
      disposeTimers.delete(key)
      void closeSession(key)
    }, SESSION_SETTLE_CLOSE_MS)
    timer.unref?.()
    disposeTimers.set(key, timer)
  }

  const routes = [
    {
      path: `${ROUTE}/sessions`,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          if (request.method === 'POST') {
            const body = await readJson(request)
            const bridge = bridgeFor(requireString(body.bridge, 'bridge'))
            const engine = engineFor(bridge)
            if (!engineAvailable(engine)) {
              throw Object.assign(new Error(`${engine.label} is not available yet: ${engine.unavailableReason}`), { status: 409 })
            }
            if (typeof engine.createSession !== 'function') {
              throw Object.assign(new Error(`${engine.label} does not support creating sessions`), { status: 409 })
            }
            const cwd = await resolveDirectoryPath(body.cwd)
            const session = await engine.createSession({
              cwd,
              config: configFor(bridge, engine),
              env: process.env,
            })
            // A session created from Bridge is already an explicit user
            // action; import it immediately so it appears in the sidebar.
            const nativeKey = session.nativeKey ?? session.key
            saveImportStore(importNativeSessions(importStore, bridge.id, [nativeKey]))
            ensureImportedWorkspace(bridge.id, session.cwd, typeof session.cwd === 'string' ? basename(session.cwd) : undefined)
            return json(201, {
              ok: true,
              bridge: bridgeView(bridge),
              engine: engine.id,
              session: publicSession(bridge, engine, session),
              ...workspaceSnapshot(bridge.id, [session]),
            })
          }
          const id = requireString(new URL(request.url).searchParams.get('bridge'), 'bridge')
          const bridge = bridgeFor(id)
          const engine = engineFor(bridge)
          if (!engineAvailable(engine)) {
            return json(200, {
              ok: true,
              bridge: bridgeView(bridge),
              engine: engine.id,
              available: false,
              unavailableReason: engine.unavailableReason,
              sessions: [],
              workspaces: [],
              archivedKeys: archivedKeysFor(bridge.id),
            })
          }
          const config = configFor(bridge, engine)
          const result = await engine.listSessions(config, process.env)
          const importedNativeKeys = importedNativeKeysFor(bridge.id)
          const discovered = Array.isArray(result.sessions) ? result.sessions : []
          // Import is the only admission path into the sidebar. Sessions that
          // merely exist under the engine root stay in the import dialog until
          // the user explicitly selects them.
          const sessions = discovered
            .filter((session) => importedNativeKeys.has(session.nativeKey ?? session.key))
            .map((session) => publicSession(bridge, engine, session))
          const archivedKeys = archivedKeysFor(bridge.id)
          const archivedSet = new Set(archivedKeys)
          return json(200, {
            ok: true,
            bridge: bridgeView(bridge),
            engine: engine.id,
            available: true,
            root: result.root,
            ...workspaceSnapshot(bridge.id, sessions),
            importedKeys: importedKeysFor(bridge.id),
            archivedKeys,
            sessions: sessions.map((session) => ({
              ...session,
              archived: archivedSet.has(session.key),
              activity: activityView(session.key),
            })),
          })
        } catch (error) {
          return failure(error, error.status ?? 500)
        }
      },
    },
    {
      path: `${ROUTE}/imports`,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const body = request.method === 'GET'
            ? { bridge: new URL(request.url).searchParams.get('bridge') }
            : await readJson(request)
          const bridge = bridgeFor(requireString(body.bridge, 'bridge'))
          const engine = engineFor(bridge)
          if (!engineAvailable(engine)) {
            return json(200, {
              ok: true,
              bridge: bridgeView(bridge),
              available: false,
              unavailableReason: engine.unavailableReason,
              sessions: [],
              workspaces: [],
            })
          }
          const result = await engine.listSessions(configFor(bridge, engine), process.env)
          const discovered = Array.isArray(result.sessions) ? result.sessions : []
          const existingWorkspaces = new Map(
            listWorkspaces(workspaceStore, bridge.id).map((workspace) => [workspace.path, workspace]),
          )
          const importedNativeKeys = importedNativeKeysFor(bridge.id)

          if (request.method === 'GET') {
            const candidates = discovered.map((session) => ({
              ...publicSession(bridge, engine, session),
              imported: importedNativeKeys.has(session.nativeKey ?? session.key),
            }))
            const paths = new Map()
            for (const workspace of Array.isArray(result.workspaces) ? result.workspaces : []) {
              if (typeof workspace?.path !== 'string' || workspace.path === '') continue
              paths.set(workspace.path, workspace)
            }
            for (const session of discovered) {
              if (typeof session.cwd !== 'string' || session.cwd === '') continue
              if (!paths.has(session.cwd)) paths.set(session.cwd, { path: session.cwd, name: basename(session.cwd) })
            }
            return json(200, {
              ok: true,
              bridge: bridgeView(bridge),
              engine: engine.id,
              available: true,
              root: result.root,
              sessions: candidates,
              workspaces: [...paths.values()].map((workspace) => {
                const saved = existingWorkspaces.get(workspace.path)
                return {
                  id: saved?.id ?? workspace.id ?? workspace.path,
                  path: workspace.path,
                  name: saved?.name ?? workspace.name ?? basename(workspace.path),
                  sessionCount: candidates.filter((session) => session.cwd === workspace.path).length,
                  imported: saved !== undefined,
                }
              }),
            })
          }

          const requested = Array.isArray(body.sessionKeys) ? body.sessionKeys : []
          const requestedPaths = Array.isArray(body.workspacePaths) ? body.workspacePaths : []
          const byNativeKey = new Map(discovered.map((session) => [session.nativeKey ?? session.key, session]))
          const nativeKeys = []
          for (const raw of requested) {
            if (typeof raw !== 'string' || raw === '') continue
            let nativeKey = raw
            try {
              const decoded = decodeSessionKey(raw)
              if (decoded.bridgeId !== bridge.id) continue
              nativeKey = decoded.nativeKey
            } catch {
              // Accept a raw engine key as well; it is still validated below.
            }
            if (byNativeKey.has(nativeKey) && !nativeKeys.includes(nativeKey)) nativeKeys.push(nativeKey)
          }
          const allowedPaths = new Set([
            ...byNativeKey.values().map((session) => session.cwd).filter((path) => typeof path === 'string' && path !== ''),
            ...(Array.isArray(result.workspaces) ? result.workspaces.map((workspace) => workspace.path) : []),
          ])
          const workspacePaths = []
          for (const raw of requestedPaths) {
            const path = typeof raw === 'string' ? raw : raw?.path
            if (typeof path !== 'string' || path === '' || !allowedPaths.has(path) || workspacePaths.includes(path)) continue
            workspacePaths.push(path)
          }
          if (nativeKeys.length === 0 && workspacePaths.length === 0) {
            throw Object.assign(new Error('select at least one session or workspace to import'), { status: 400 })
          }

          const saved = saveImportStore(importNativeSessions(importStore, bridge.id, nativeKeys))
          for (const nativeKey of nativeKeys) {
            const session = byNativeKey.get(nativeKey)
            if (typeof session?.cwd === 'string' && session.cwd !== '') {
              ensureImportedWorkspace(bridge.id, session.cwd, basename(session.cwd))
            }
          }
          for (const path of workspacePaths) {
            const workspace = existingWorkspaces.get(path)
            ensureImportedWorkspace(bridge.id, path, workspace?.name ?? basename(path))
          }
          const importedSet = new Set(saved.importedKeys)
          const sessions = discovered
            .filter((session) => importedSet.has(session.nativeKey ?? session.key))
            .map((session) => publicSession(bridge, engine, session))
          logger?.info?.(`bridge: imported ${nativeKeys.length} session(s) and ${workspacePaths.length} workspace(s) (${bridge.id})`)
          return json(200, {
            ok: true,
            bridge: bridgeView(bridge),
            engine: engine.id,
            importedKeys: importedKeysFor(bridge.id),
            importedSessionKeys: saved.addedKeys.map((nativeKey) => encodeSessionKey(bridge.id, nativeKey)),
            sessions,
            ...workspaceSnapshot(bridge.id, sessions),
          })
        } catch (error) {
          return failure(error, error.status ?? 500)
        }
      },
    },
    {
      path: `${ROUTE}/workspaces`,
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const body = request.method === 'GET'
            ? { bridge: new URL(request.url).searchParams.get('bridge') }
            : await readJson(request)
          const bridge = bridgeFor(requireString(body.bridge, 'bridge'))
          if (request.method === 'GET') {
            const engine = engineFor(bridge)
            if (!engineAvailable(engine)) {
              return json(200, { ok: true, bridge: bridgeView(bridge), available: false, workspaces: [] })
            }
            const result = await engine.listSessions(configFor(bridge, engine), process.env)
            const importedNativeKeys = importedNativeKeysFor(bridge.id)
            const sessions = (Array.isArray(result.sessions) ? result.sessions : [])
              .filter((session) => importedNativeKeys.has(session.nativeKey ?? session.key))
            return json(200, {
              ok: true,
              bridge: bridgeView(bridge),
              available: true,
              ...workspaceSnapshot(bridge.id, sessions),
            })
          }
          if (request.method === 'POST') {
            const path = await resolveDirectoryPath(body.path)
            const result = createWorkspace(workspaceStore, bridge.id, { path, name: body.name })
            workspaceStore = writeWorkspaceStore(result.store, process.env)
            return json(201, {
              ok: true,
              workspace: publicWorkspace(result.workspace),
              ...workspaceSnapshot(bridge.id),
            })
          }
          if (request.method === 'PUT') {
            const result = renameWorkspace(workspaceStore, bridge.id, body.id, body.name)
            workspaceStore = writeWorkspaceStore(result.store, process.env)
            return json(200, {
              ok: true,
              workspace: publicWorkspace(result.workspace),
              ...workspaceSnapshot(bridge.id),
            })
          }
          const result = deleteWorkspace(workspaceStore, bridge.id, body.id)
          workspaceStore = writeWorkspaceStore(result.store, process.env)
          logger?.info?.(`bridge: soft-deleted workspace ${result.workspace.path} (${bridge.id})`)
          return json(200, {
            ok: true,
            deleted: true,
            workspace: publicWorkspace(result.workspace),
            ...workspaceSnapshot(bridge.id),
          })
        } catch (error) {
          return failure(error, error.status ?? 500)
        }
      },
    },
    {
      path: `${ROUTE}/directories`,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          if (request.method === 'GET') {
            const url = new URL(request.url)
            return json(200, { ok: true, ...(await listDirectories(url.searchParams.get('path') ?? undefined)) })
          }
          const body = await readJson(request)
          return json(201, { ok: true, ...(await createDirectory(body.path, body.name)) })
        } catch (error) {
          return failure(error, error.status ?? 500)
        }
      },
    },
    {
      path: `${ROUTE}/session`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const key = requireString(new URL(request.url).searchParams.get('key'), 'key')
          const { session } = await sessionFor(key)
          // Viewing a finished session acknowledges its completion dot.
          clearFinishedActivity(key)
          return json(200, {
            ok: true,
            session,
            attached: attachments.has(key),
            activity: activityView(key),
          })
        } catch (error) {
          return failure(error, error.status ?? 400)
        }
      },
    },
    {
      path: `${ROUTE}/capabilities`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        const live = [...attachments.entries()].map(([key, value]) => ({
          key,
          bridge: value.bridgeId,
          engine: value.engineId,
          pid: value.attachment.pid,
          running: value.attachment.running,
          clients: value.clients.size,
        }))
        return json(200, {
          ok: true,
          bridges: bridgesWithConnection(),
          engines: ENGINES.map(engineView),
          modes: BRIDGE_MODES,
          attachments: live,
          activity: [...sessionActivity.entries()].map(([key, value]) => ({ key, ...activityView(key) })),
          protocol: 4,
        })
      },
    },
    {
      path: `${ROUTE}/attach`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const body = await readJson(request)
          const key = requireString(body.key, 'key')
          const live = await attach(key)
          const state = await live.attachment.snapshot()
          live.publish('bridge-state', state)
          return json(200, {
            ok: true,
            bridge: live.bridgeId,
            engine: live.engineId,
            state,
            activity: activityView(key),
          })
        } catch (error) {
          return failure(error, error.status ?? 500)
        }
      },
    },
    {
      path: `${ROUTE}/detach`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const body = await readJson(request)
          const key = requireString(body.key, 'key')
          const detached = await closeSession(key)
          if (!detached) return json(200, { ok: true, detached: false })
          return json(200, { ok: true, detached: true })
        } catch (error) {
          return failure(error, error.status ?? 500)
        }
      },
    },
    {
      path: `${ROUTE}/state`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const key = requireString(new URL(request.url).searchParams.get('key'), 'key')
          return json(200, { ok: true, state: await attachmentFor(key).attachment.snapshot() })
        } catch (error) {
          return failure(error, error.status ?? 400)
        }
      },
    },
    {
      path: `${ROUTE}/prompt`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const body = await readJson(request)
          const key = requireString(body.key, 'key')
          const message = requireString(body.message, 'message')
          const { bridge, nativeKey } = resolveSessionKey(key)
          assertNotArchived(nativeKey, bridge.id)
          // Lazy attach: the first send starts the agent, later sends reuse it
          // until the settled-turn timer closes it.
          cancelDispose(key)
          const live = await attach(key)
          const mode = body.mode ?? 'auto'
          const state = await live.attachment.getState()
          setActivity(key, { state: 'running', startedAt: Date.now(), completedAt: null, error: null, aborted: false })
          let accepted
          try {
            if (mode === 'steer') accepted = await live.attachment.steer(message)
            else if (mode === 'followUp') accepted = await live.attachment.followUp(message)
            else if (state.isStreaming === true) accepted = await live.attachment.steer(message)
            else accepted = await live.attachment.prompt(message)
          } catch (error) {
            setActivity(key, {
              state: 'failed',
              completedAt: Date.now(),
              error: error instanceof Error ? error.message : String(error),
            })
            throw error
          }
          return json(202, { ok: true, accepted, activity: activityView(key) })
        } catch (error) {
          return failure(error, error.status ?? 409)
        }
      },
    },
    {
      path: `${ROUTE}/abort`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const body = await readJson(request)
          const key = requireString(body.key, 'key')
          return json(202, { ok: true, result: await attachmentFor(key).attachment.abort() })
        } catch (error) {
          return failure(error, error.status ?? 409)
        }
      },
    },
    {
      path: `${ROUTE}/ui-response`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const body = await readJson(request)
          const key = requireString(body.key, 'key')
          const id = requireString(body.id, 'id')
          const response = body.response
          if (response === null || typeof response !== 'object') {
            throw Object.assign(new Error('response is required'), { status: 400 })
          }
          attachmentFor(key).attachment.respondUi(id, response)
          return json(202, { ok: true })
        } catch (error) {
          return failure(error, error.status ?? 409)
        }
      },
    },
    {
      path: `${ROUTE}/activity`,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          if (request.method === 'POST') {
            const body = await readJson(request)
            const key = requireString(body.key, 'key')
            resolveSessionKey(key)
            const cleared = clearFinishedActivity(key)
            return json(200, { ok: true, cleared, activity: activityView(key) })
          }
          const bridgeId = new URL(request.url).searchParams.get('bridge')
          if (bridgeId === null || bridgeId === '') {
            return json(200, {
              ok: true,
              activity: [...sessionActivity.entries()].map(([key, value]) => ({ key, ...activityView(key) })),
            })
          }
          const bridge = bridgeFor(bridgeId)
          const prefix = `${bridge.id}.`
          return json(200, {
            ok: true,
            bridge: bridge.id,
            activity: [...sessionActivity.entries()]
              .filter(([key]) => key.startsWith(prefix))
              .map(([key]) => ({ key, ...activityView(key) })),
          })
        } catch (error) {
          return failure(error, error.status ?? 500)
        }
      },
    },
    {
      path: `${ROUTE}/status`,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          if (request.method === 'POST') {
            const body = await readJson(request)
            const bridgeId = typeof body.bridge === 'string' && body.bridge !== '' ? body.bridge : null
            if (bridgeId === null) await autoConnectAllBridges()
            else {
              const bridge = findBridge(settings, bridgeId)
              if (bridge !== undefined) await autoConnectBridge(bridge)
            }
          }
          return json(200, {
            ok: true,
            bridges: settings.bridges.map((bridge) => ({
              id: bridge.id,
              name: bridge.name,
              engine: bridge.engine,
              ...connectionView(bridge.id),
            })),
          })
        } catch (error) {
          return failure(error, error.status ?? 500)
        }
      },
    },
    {
      path: `${ROUTE}/settings`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => json(200, { ok: true, ...settingsView() }),
    },
    {
      path: `${ROUTE}/bridges`,
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          if (request.method === 'GET') return json(200, { ok: true, ...settingsView() })
          const body = await readJson(request)
          if (request.method === 'POST') {
            const result = createBridge(settings, body)
            settings = writeSettings(result.settings, process.env)
            logger?.info?.(`bridge: created ${result.bridge.id}`)
            void autoConnectBridge(result.bridge)
            return json(201, { ok: true, bridge: bridgeWithConnection(result.bridge), ...settingsView() })
          }
          const id = requireString(body.id, 'id')
          if (liveAttachmentForBridge(id)) {
            return json(409, { ok: false, error: 'detach every session for this bridge before changing it' })
          }
          if (request.method === 'PUT') {
            const result = updateBridge(settings, id, body)
            settings = writeSettings(result.settings, process.env)
            logger?.info?.(`bridge: updated ${id}`)
            connections.delete(id)
            modelCatalogs.delete(id)
            void autoConnectBridge(result.bridge)
            return json(200, { ok: true, bridge: bridgeWithConnection(result.bridge), ...settingsView() })
          }
          const result = deleteBridge(settings, id)
          settings = writeSettings(result.settings, process.env)
          connections.delete(id)
          probeTokens.delete(id)
          modelCatalogs.delete(id)
          const pruned = deleteBridgeArchives(archiveStore, id)
          if (pruned.changed) archiveStore = writeArchiveStore(pruned.store, process.env)
          const prunedImports = deleteBridgeImports(importStore, id)
          if (prunedImports.changed) importStore = writeImportStore(prunedImports.store, process.env)
          logger?.info?.(`bridge: deleted ${id}`)
          return json(200, { ok: true, ...settingsView() })
        } catch (error) {
          return failure(error, error.status ?? 500)
        }
      },
    },
    {
      path: `${ROUTE}/archive`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const body = await readJson(request)
          const key = requireString(body.key, 'key')
          const { bridge, nativeKey } = resolveSessionKey(key)
          if (typeof body.archived !== 'boolean') {
            throw Object.assign(new Error('archived must be a boolean'), { status: 400 })
          }
          if (body.archived) {
            const live = attachments.get(key)
            if (live !== undefined) {
              const state = await live.attachment.getState()
              if (state.isStreaming === true) {
                throw Object.assign(new Error('session is running; abort it before archiving'), { status: 409 })
              }
            }
            const result = saveArchiveStore(archiveNativeSession(archiveStore, bridge.id, nativeKey))
            // An idle attachment has no work to stop, but keeping it alive would
            // leave an engine process attached to a session the user archived.
            const liveAttachment = attachments.get(key)
            if (liveAttachment !== undefined) {
              attachments.delete(key)
              await liveAttachment.close()
            }
            logger?.info?.(`bridge: archived session ${nativeKey} (${bridge.id})`)
            return json(200, {
              ok: true,
              key,
              archived: true,
              archivedKeys: result.archivedKeys.map((value) => encodeSessionKey(bridge.id, value)),
            })
          }
          const result = saveArchiveStore(unarchiveNativeSession(archiveStore, bridge.id, nativeKey))
          logger?.info?.(`bridge: unarchived session ${nativeKey} (${bridge.id})`)
          return json(200, {
            ok: true,
            key,
            archived: false,
            archivedKeys: result.archivedKeys.map((value) => encodeSessionKey(bridge.id, value)),
          })
        } catch (error) {
          return failure(error, error.status ?? 500)
        }
      },
    },
    {
      path: `${ROUTE}/models`,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          if (request.method === 'GET') {
            const url = new URL(request.url)
            const key = url.searchParams.get('key')
            if (key !== null && key !== '') {
              const live = attachments.get(key)
              if (live !== undefined && typeof live.attachment.getAvailableModels === 'function') {
                return json(200, {
                  ok: true,
                  models: await live.attachment.getAvailableModels(),
                  source: 'attachment',
                })
              }
              // Fall through: an unconnected session still needs a catalog.
              const { bridge } = resolveSessionKey(key)
              const catalog = await modelsForBridge(bridge, { force: url.searchParams.get('refresh') === '1' })
              return json(200, { ok: true, models: catalog.models, source: 'catalog', cached: catalog.cached, at: catalog.at })
            }
            const bridgeId = requireString(url.searchParams.get('bridge'), 'bridge')
            const bridge = bridgeFor(bridgeId)
            const catalog = await modelsForBridge(bridge, { force: url.searchParams.get('refresh') === '1' })
            return json(200, { ok: true, models: catalog.models, source: 'catalog', cached: catalog.cached, at: catalog.at })
          }
          const body = await readJson(request)
          const key = requireString(body.key, 'key')
          const provider = requireString(body.provider, 'provider')
          const model = requireString(body.model, 'model')
          const selection = { provider, id: model }
          const live = attachments.get(key)
          if (live === undefined) {
            // No agent yet: remember the choice and apply it on the next attach.
            pendingModels.set(key, selection)
            return json(200, { ok: true, model: selection, pending: true })
          }
          if (typeof live.attachment.setModel !== 'function') {
            throw Object.assign(new Error('this bridge engine does not support model selection'), { status: 409 })
          }
          const selected = await live.attachment.setModel(provider, model)
          pendingModels.delete(key)
          return json(200, { ok: true, model: selected ?? selection })
        } catch (error) {
          return failure(error, error.status ?? 409)
        }
      },
    },
    {
      path: `${ROUTE}/stats`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const key = requireString(new URL(request.url).searchParams.get('key'), 'key')
          const attachment = attachmentFor(key).attachment
          if (typeof attachment.getSessionStats !== 'function') {
            throw Object.assign(new Error('this bridge engine does not expose session statistics'), { status: 409 })
          }
          return json(200, { ok: true, stats: await attachment.getSessionStats() })
        } catch (error) {
          return failure(error, error.status ?? 409)
        }
      },
    },
    {
      path: `${ROUTE}/events`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const key = requireString(new URL(request.url).searchParams.get('key'), 'key')
          const live = attachmentFor(key)
          const signal = request.signal
          let keepalive
          const stream = new ReadableStream({
            start(controller) {
              const client = new EventClient(controller)
              const unsubscribe = live.subscribe(client)
              keepalive = setInterval(() => client.send('ping', { at: Date.now() }), KEEPALIVE_MS)
              const close = () => {
                clearInterval(keepalive)
                unsubscribe()
                client.close()
              }
              signal.addEventListener('abort', close, { once: true })
            },
            cancel() {
              clearInterval(keepalive)
            },
          })
          return new Response(stream, {
            status: 200,
            headers: {
              'content-type': 'text/event-stream; charset=utf-8',
              'cache-control': 'no-cache, no-transform',
              connection: 'keep-alive',
              'x-accel-buffering': 'no',
            },
          })
        } catch (error) {
          return failure(error, error.status ?? 409)
        }
      },
    },
    {
      path: `${ROUTE}/history-message`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const key = requireString(new URL(request.url).searchParams.get('key'), 'key')
          const { session } = await sessionFor(key)
          const text = session.messages.map(messageText).filter(Boolean).join('\n\n')
          return json(200, { ok: true, text, key: session.key })
        } catch (error) {
          return failure(error, error.status ?? 400)
        }
      },
    },
  ]

  for (const route of routes) {
    ctx.effect(() => ctx.connection.fetch.register(route), `bridge: ${route.path}`)
  }

  // Auto-connect every configured bridge when the dsh host starts. The probe
  // is lightweight (no session process); the dropdown shows its state.
  ctx.effect(() => {
    if (process.env.BRIDGE_AUTO_CONNECT === '0') return () => {}
    let cancelled = false
    const timer = setTimeout(() => {
      if (!cancelled) void autoConnectAllBridges()
    }, 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, 'bridge: auto-connect')

  ctx.effect(
    () => async () => {
      const live = [...attachments.values()]
      attachments.clear()
      pendingAttachments.clear()
      await Promise.allSettled(live.map((entry) => entry.close()))
    },
    'bridge: attachments',
  )
}

export { encodeSessionKey as sessionKey, decodeSessionKey }
export { normalizeSettings }
