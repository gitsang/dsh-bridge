/**
 * Host half of dsh-bridge: authenticated HTTP routes over Pi Coding Agent.
 *
 * The browser never talks to Pi directly. Every route here is registered on
 * dsh's `/api` channel, so it inherits the Host/Origin fence and the signed
 * browser-session cookie. A route only opens a Pi child for an explicit
 * attach; listing and history stay read-only JSONL reads.
 */
import { PiAttachment, messageText } from './pi-attachment.js'
import {
  listPiSessions,
  pathFromSessionKey,
  piSessionsRoot,
  readPiSession,
  sessionKey,
} from './session-store.js'

export const name = 'pi-bridge'
export const inject = ['connection']

const ROUTE = '/api/pi-bridge'
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

/** Keep only JSON-safe data on the wire. */
function wireSafe(value) {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return { unserializable: true }
  }
}

/**
 * One browser subscriber. Events are appended to the SSE stream; a bounded
 * ring lets a late subscriber catch up without replaying the whole agent run.
 */
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

/** One live Pi child plus its browser fan-out. */
class AttachmentSession {
  constructor(attachment, session) {
    this.attachment = attachment
    this.session = session
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
    listen('event', forward('pi-event'))
    listen('ui-request', forward('pi-ui-request'))
    listen('ui-notification', forward('pi-ui-notification'))
    listen('extension-error', forward('pi-extension-error'))
    listen('protocol-error', forward('pi-protocol-error'))
    listen('spawn', forward('pi-spawn'))
    listen('exit', (info) => {
      this.publish('pi-exit', info)
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

  const sessionFor = async (key) => {
    const file = pathFromSessionKey(key)
    const session = await readPiSession(file)
    return { file, session }
  }

  const attachmentFor = (key) => {
    const live = attachments.get(key)
    if (live !== undefined) return live
    throw Object.assign(new Error('Pi session is not attached'), { status: 409 })
  }

  const attach = async (key) => {
    const existing = attachments.get(key)
    if (existing !== undefined) return existing
    const { file, session } = await sessionFor(key)
    const attachment = new PiAttachment({ file, cwd: session.cwd, env: process.env })
    await attachment.start()
    const live = new AttachmentSession(attachment, {
      key,
      id: session.id,
      name: session.name,
      cwd: session.cwd,
      file,
      messageCount: session.messageCount,
    }).watch()
    live.onExit = () => {
      if (attachments.get(key) === live) attachments.delete(key)
    }
    attachments.set(key, live)
    logger?.info?.(`pi-bridge: attached ${file} (pid ${attachment.pid})`)
    return live
  }

  const routes = [
    {
      path: `${ROUTE}/sessions`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        try {
          const root = piSessionsRoot()
          const sessions = await listPiSessions(root)
          return json(200, { ok: true, root, sessions })
        } catch (error) {
          return failure(error)
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
          pid: value.attachment.pid,
          running: value.attachment.running,
          clients: value.clients.size,
        }))
        return json(200, {
          ok: true,
          sessionsRoot: piSessionsRoot(),
          attachments: live,
          protocol: 1,
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
          live.publish('pi-state', state)
          return json(200, { ok: true, state })
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
          const live = attachmentFor(key)
          return json(200, { ok: true, state: await live.attachment.snapshot() })
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
          else if (state.isStreaming === true) {
            accepted = await live.attachment.steer(message)
          } else {
            accepted = await live.attachment.prompt(message)
          }
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
    ctx.effect(() => ctx.connection.fetch.register(route), `pi-bridge: ${route.path}`)
  }

  ctx.effect(
    () => async () => {
      const live = [...attachments.values()]
      attachments.clear()
      await Promise.allSettled(live.map((entry) => entry.close()))
    },
    'pi-bridge: attachments',
  )
}

export { sessionKey }
