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
  bridgeViews,
  engineView,
  getEngine,
} from './backends/registry.js'
import { decodeSessionKey, encodeSessionKey } from './backends/keys.js'
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
    for (const unsubscribe of this.subscriptions) unsubscribe()
    this.subscriptions = []
    for (const client of this.clients) client.close()
    this.clients.clear()
    await this.attachment.dispose()
  }
}

export function apply(ctx) {
  const attachments = new Map()
  const logger = ctx.logger
  let settings = readSettings(process.env, logger)

  const engineAvailable = (engine) => engine.available !== false

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

  const settingsView = () => ({
    settings: {
      version: settings.version,
      bridges: bridgeViews(settings.bridges),
    },
    bridges: bridgeViews(settings.bridges),
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
    const { bridge, engine, nativeKey, session } = await sessionFor(key)
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
    }
    attachments.set(key, live)
    logger?.info?.(`bridge: attached ${bridge.name} (${bridge.id}) session ${session.id ?? nativeKey} (pid ${attachment.pid})`)
    return live
  }

  const routes = [
    {
      path: `${ROUTE}/sessions`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
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
            })
          }
          const config = configFor(bridge, engine)
          const result = await engine.listSessions(config, process.env)
          const sessions = Array.isArray(result.sessions)
            ? result.sessions.map((session) => publicSession(bridge, engine, session))
            : []
          const workspaces = Array.isArray(result.workspaces) ? result.workspaces : []
          return json(200, {
            ok: true,
            bridge: bridgeView(bridge),
            engine: engine.id,
            available: true,
            root: result.root,
            workspaces,
            sessions,
          })
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
          bridges: bridgeViews(settings.bridges),
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
            return json(201, { ok: true, bridge: bridgeView(result.bridge), ...settingsView() })
          }
          const id = requireString(body.id, 'id')
          if (liveAttachmentForBridge(id)) {
            return json(409, { ok: false, error: 'detach every session for this bridge before changing it' })
          }
          if (request.method === 'PUT') {
            const result = updateBridge(settings, id, body)
            settings = writeSettings(result.settings, process.env)
            logger?.info?.(`bridge: updated ${id}`)
            return json(200, { ok: true, bridge: bridgeView(result.bridge), ...settingsView() })
          }
          const result = deleteBridge(settings, id)
          settings = writeSettings(result.settings, process.env)
          logger?.info?.(`bridge: deleted ${id}`)
          return json(200, { ok: true, ...settingsView() })
        } catch (error) {
          return failure(error, error.status ?? 500)
        }
      },
    },
    {
      path: `${ROUTE}/models`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const key = requireString(new URL(request.url).searchParams.get('key'), 'key')
          return json(200, { ok: true, models: await attachmentFor(key).attachment.getAvailableModels() })
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

  ctx.effect(
    () => async () => {
      const live = [...attachments.values()]
      attachments.clear()
      await Promise.allSettled(live.map((entry) => entry.close()))
    },
    'bridge: attachments',
  )
}

export { encodeSessionKey as sessionKey, decodeSessionKey }
export { normalizeSettings }
