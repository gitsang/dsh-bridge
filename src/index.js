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
  reconcileWorkspaces,
  removedWorkspacePaths,
  renameWorkspace,
  writeWorkspaceStore,
} from './workspaces.js'

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
      for (const event of events) this.publish('bridge-event', event)
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
  const logger = ctx.logger
  let settings = readSettings(process.env, logger)
  let workspaceStore = readWorkspaceStore(process.env, logger)
  let archiveStore = readArchiveStore(process.env, logger)

  /**
   * Per-bridge connection state for the startup auto-connect and the status
   * dots in the switcher. This is a bridge-level readiness probe (launcher and
   * session root), not one agent process per session; session attachments stay
   * lazy and are keyed separately in `attachments`.
   */
  const connections = new Map()
  const probeTokens = new Map()

  const engineAvailable = (engine) => engine.available !== false

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
   * Startup connection. In auto-connect mode this warms the newest session of
   * the bridge through the real RPC attachment, then leaves the green status
   * tied to that live process. Without a session, a successful engine probe
   * still reports the bridge as ready. With auto-connect disabled, only the
   * probe runs (used by tests and by operators who want lazy sessions).
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
      const existing = [...attachments.values()].find((entry) => entry.bridgeId === bridge.id && entry.attachment.running)
      if (existing !== undefined) {
        if (probeTokens.get(bridge.id) !== token) return
        setConnection(bridge.id, {
          state: 'connected',
          error: null,
          checkedAt: Date.now(),
          latencyMs: Date.now() - startedAt,
          detail: wireSafe({ ...detail, warmSession: existing.key, pid: existing.attachment.pid }),
        })
        return
      }
      if (!autoConnectEnabled()) {
        if (probeTokens.get(bridge.id) !== token) return
        setConnection(bridge.id, {
          state: 'connected',
          error: null,
          checkedAt: Date.now(),
          latencyMs: Date.now() - startedAt,
          detail: wireSafe(detail),
        })
        return
      }

      const listed = await engine.listSessions(config, process.env)
      const sessions = Array.isArray(listed.sessions) ? listed.sessions : []
      if (sessions.length === 0) {
        if (probeTokens.get(bridge.id) !== token) return
        setConnection(bridge.id, {
          state: 'connected',
          error: null,
          checkedAt: Date.now(),
          latencyMs: Date.now() - startedAt,
          detail: wireSafe({ ...detail, warmSession: null }),
        })
        return
      }
      const openSessions = sessions.filter((session) => {
        const nativeKey = session.nativeKey ?? session.key
        return !isArchivedKey(nativeKey, bridge.id)
      })
      if (openSessions.length === 0) {
        if (probeTokens.get(bridge.id) !== token) return
        setConnection(bridge.id, {
          state: 'connected',
          error: null,
          checkedAt: Date.now(),
          latencyMs: Date.now() - startedAt,
          detail: wireSafe({ ...detail, warmSession: null }),
        })
        return
      }
      const newest = [...openSessions].sort((left, right) => String(right.modified ?? '').localeCompare(String(left.modified ?? '')))[0]
      const nativeKey = newest.nativeKey ?? newest.key
      const key = encodeSessionKey(bridge.id, nativeKey)
      const live = await attach(key)
      if (probeTokens.get(bridge.id) !== token) return
      setConnection(bridge.id, {
        state: 'connected',
        error: null,
        checkedAt: Date.now(),
        latencyMs: Date.now() - startedAt,
        detail: wireSafe({ ...detail, warmSession: key, pid: live.attachment.pid }),
      })
      logger?.info?.(`bridge: auto-connected ${bridge.name} (${bridge.id}) warm session ${key}`)
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
      logger?.warn?.(`bridge: auto-connect failed for ${bridge.name} (${bridge.id}): ${message}`)
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

  /**
   * Reconcile the durable workspace metadata with the engine's current session
   * list, then attach live session counts. This runs on every session query so
   * sessions created outside dsh (for example with the Pi CLI) are discovered
   * without a separate watcher. Existing names and tombstones are preserved.
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

  const synchronizeWorkspaces = (bridge, discovered, sessions) => {
    const synced = reconcileWorkspaces(workspaceStore, bridge.id, discovered)
    if (synced.changed) workspaceStore = writeWorkspaceStore(synced.store, process.env)
    return workspaceSnapshot(bridge.id, sessions)
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
      live.onExit = () => {
        if (attachments.get(key) === live) attachments.delete(key)
        const stillLive = [...attachments.values()].some((entry) => entry.bridgeId === bridge.id && entry.attachment.running)
        if (stillLive) return
        if (live.intentionalClose) {
          setConnection(bridge.id, { state: 'idle', error: null, checkedAt: Date.now(), latencyMs: null, detail: null })
        } else {
          setConnection(bridge.id, {
            state: 'failed',
            error: 'agent process exited',
            checkedAt: Date.now(),
            latencyMs: null,
          })
        }
      }
      attachments.set(key, live)
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
            return json(201, {
              ok: true,
              bridge: bridgeView(bridge),
              engine: engine.id,
              session: publicSession(bridge, engine, session),
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
          const sessions = Array.isArray(result.sessions)
            ? result.sessions.map((session) => publicSession(bridge, engine, session))
            : []
          const discovered = Array.isArray(result.workspaces) ? result.workspaces : []
          const workspaceState = synchronizeWorkspaces(bridge, discovered, sessions)
          const archivedKeys = archivedKeysFor(bridge.id)
          const archivedSet = new Set(archivedKeys)
          return json(200, {
            ok: true,
            bridge: bridgeView(bridge),
            engine: engine.id,
            available: true,
            root: result.root,
            ...workspaceState,
            archivedKeys,
            sessions: sessions.map((session) => ({ ...session, archived: archivedSet.has(session.key) })),
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
            const sessions = Array.isArray(result.sessions) ? result.sessions : []
            return json(200, {
              ok: true,
              bridge: bridgeView(bridge),
              available: true,
              ...synchronizeWorkspaces(
                bridge,
                Array.isArray(result.workspaces) ? result.workspaces : [],
                sessions,
              ),
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
          return json(200, { ok: true, session })
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
          protocol: 3,
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
          return json(200, { ok: true, bridge: live.bridgeId, engine: live.engineId, state })
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
          const live = attachments.get(key)
          if (live === undefined) return json(200, { ok: true, detached: false })
          attachments.delete(key)
          await live.close()
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
          const live = attachmentFor(key)
          const mode = body.mode ?? 'auto'
          const state = await live.attachment.getState()
          let accepted
          if (mode === 'steer') accepted = await live.attachment.steer(message)
          else if (mode === 'followUp') accepted = await live.attachment.followUp(message)
          else if (state.isStreaming === true) accepted = await live.attachment.steer(message)
          else accepted = await live.attachment.prompt(message)
          return json(202, { ok: true, accepted })
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
            void autoConnectBridge(result.bridge)
            return json(200, { ok: true, bridge: bridgeWithConnection(result.bridge), ...settingsView() })
          }
          const result = deleteBridge(settings, id)
          settings = writeSettings(result.settings, process.env)
          connections.delete(id)
          probeTokens.delete(id)
          const pruned = deleteBridgeArchives(archiveStore, id)
          if (pruned.changed) archiveStore = writeArchiveStore(pruned.store, process.env)
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
            const key = requireString(new URL(request.url).searchParams.get('key'), 'key')
            const attachment = attachmentFor(key).attachment
            if (typeof attachment.getAvailableModels !== 'function') {
              throw Object.assign(new Error('this bridge engine does not expose a model catalog'), { status: 409 })
            }
            return json(200, { ok: true, models: await attachment.getAvailableModels() })
          }
          const body = await readJson(request)
          const key = requireString(body.key, 'key')
          const provider = requireString(body.provider, 'provider')
          const model = requireString(body.model, 'model')
          const attachment = attachmentFor(key).attachment
          if (typeof attachment.setModel !== 'function') {
            throw Object.assign(new Error('this bridge engine does not support model selection'), { status: 409 })
          }
          const selected = await attachment.setModel(provider, model)
          return json(200, { ok: true, model: selected })
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
