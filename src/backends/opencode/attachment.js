/**
 * One live OpenCode attachment over its local HTTP + SSE server.
 *
 * OpenCode exposes a headless server (`opencode serve`) that binds a session
 * directory from its own cwd. Talking to that server is far cheaper than ACP:
 * measured on this machine `serve` is ready in ~1.7 s, prompt/history calls
 * answer in 8-20 ms, `prompt_async` returns 204 immediately and the turn
 * streams over SSE, while ACP's `session/load` took 32 s+.
 *
 * Protocol facts verified against CLI 1.19.5 (the installed version):
 * - readiness is announced on stdout as `opencode server listening on http://…`
 *   (stdout also carries an "unsecured server" warning banner);
 * - `POST /session/{id}/prompt_async` accepts `{model:{providerID,modelID},parts}`
 *   and also queues a second prompt into a busy session (steering);
 * - `POST /session/{id}/abort` answers `true`;
 * - `POST /api/session/{id}/model` `{model:{id,providerID}}` switches the model
 *   of an existing session (204), but only for sessions that have a
 *   `session_v2` row — sessions created by 1.19.5 live in the legacy tables and
 *   the call fails with a foreign-key error. That case falls back to pinning
 *   the model for the next `prompt_async` (see `setModel`);
 * - `PATCH /session/{id}` silently ignores a `model` field, so it is not used;
 * - permission prompts arrive as `permission.asked` and are answered through
 *   `POST /permission/{id}/reply` `{reply:"once"|"always"|"reject"}` (verified
 *   live); the v2 event family (`permission.v2.asked`) is answered through the
 *   session-scoped `POST /api/session/{sid}/permission/{id}/reply` route from
 *   the same server binary;
 * - interactive questions arrive as `question.asked` and are answered through
 *   `POST /question/{id}/reply` `{answers:[[label]]}` or `POST /question/{id}/reject`,
 *   with the v2 family's `POST /api/session/{sid}/question/{id}/{reply,reject}`
 *   as the fallback;
 * - the server ignores stdin EOF and SIGTERM, so shutdown ends with SIGKILL.
 */
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { createStderrRing, resolveCliCommand } from '../cli.js'
import {
  bridgeToolArguments,
  bridgeToolName,
  messagesFromApiEntries,
  opencodeDataDir,
  summaryFromApiSession,
} from './session-store.js'

const DEFAULT_READY_TIMEOUT_MS = 30_000
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_UI_TIMEOUT_MS = 120_000
const DEFAULT_MODEL_TIMEOUT_MS = 60_000
const STDERR_RING_BYTES = 16 * 1024
const LISTEN_LINE = /opencode server listening on (https?:\/\/[^\s]+)/

/** Resolve the launcher without spawning: config wins, then OPENCODE_BIN, then PATH. */
export function resolveOpencodeCommand(config = {}, env = process.env) {
  return resolveCliCommand({
    configBin: config.binPath,
    envVar: 'OPENCODE_BIN',
    defaultNames: ['opencode'],
    env,
  })
}

/**
 * Extract the server URL from the CLI's stdout.
 *
 * The banner line is plain text on stdout, not JSON, and the URL is followed by
 * a newline: tolerate trailing punctuation so a future "listening on …)." form
 * still parses.
 */
export function parseServerUrl(text) {
  if (typeof text !== 'string') return undefined
  const match = LISTEN_LINE.exec(text)
  if (match === null) return undefined
  return match[1].replace(/[),.;]+$/, '')
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Give every transport failure the 502 shape the host reports to the browser. */
function transportError(message, cause) {
  return Object.assign(new Error(message), { status: 502, cause })
}

/** True when a fetch failed at the socket level rather than with an HTTP status. */
function isNetworkFailure(error) {
  if (error === null || typeof error !== 'object') return false
  if (error.name === 'TypeError' && error.message === 'fetch failed') return true
  const code = error.cause?.code ?? error.code
  return code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'EPIPE' || code === 'UND_ERR_SOCKET'
}

function parseJsonBody(text) {
  if (typeof text !== 'string' || text === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * One `opencode serve` child plus bounded JSON requests to it.
 *
 * The attachment owns exactly one server (cwd = session directory); the
 * session-create helper and the model catalog spawn their own short-lived copies
 * and reap them. Requests are tracked so a disposed attachment aborts every
 * in-flight fetch instead of leaving a socket to keep the event loop alive.
 */
export class OpencodeServer extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} [options.cwd] directory the server binds (its own cwd)
   * @param {NodeJS.ProcessEnv} [options.env]
   * @param {{command: string, prefixArgs?: string[]}} [options.resolved]
   * @param {number} [options.readyTimeoutMs]
   * @param {number} [options.requestTimeoutMs]
   */
  constructor(options = {}) {
    super()
    this.cwd = typeof options.cwd === 'string' && options.cwd !== '' && existsSync(options.cwd)
      ? options.cwd
      : homedir()
    this.env = options.env ?? process.env
    this.resolved = options.resolved ?? resolveOpencodeCommand({}, this.env)
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
    this.requestTimeoutMs = options.requestTimeoutMs ?? options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.child = undefined
    this.exited = false
    this.stopping = false
    this.baseUrl = undefined
    this.stdout = ''
    this.stderrRing = createStderrRing(STDERR_RING_BYTES)
    this.inflight = new Set()
    this.urls = []
    this.exitInfo = undefined
  }

  get pid() {
    return this.child?.pid
  }

  get running() {
    return this.child !== undefined && !this.exited
  }

  get stderr() {
    return this.stderrRing.value
  }

  /** Spawn the server and resolve once it reports a listening URL and /health. */
  async start() {
    if (this.child !== undefined) return this
    const args = [...(this.resolved.prefixArgs ?? []), 'serve', '--port', '0', '--hostname', '127.0.0.1']
    let child
    try {
      child = spawn(this.resolved.command, args, {
        cwd: this.cwd,
        env: this.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      throw transportError(`could not start the OpenCode server: ${errorMessage(error)}`, error)
    }
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      // Keep only a bounded prefix: the listening line is printed once, before
      // any other stdout traffic, so a long-running server cannot grow this.
      if (this.baseUrl === undefined) this.stdout = (this.stdout + chunk).slice(-64 * 1024)
      this.checkForServerUrl()
    })
    child.stderr.on('data', (chunk) => this.stderrRing.push(chunk))
    child.on('error', (error) => this.handleExit(undefined, error))
    child.on('exit', (code, signal) => this.handleExit({ code, signal }))
    this.emit('spawn', { pid: child.pid, command: this.resolved.command, args, cwd: this.cwd })
    try {
      await this.waitForServerUrl()
      // A server that printed its URL but cannot answer /health is not usable;
      // failing here keeps the attachment's start error close to its cause.
      await this.request('/global/health')
    } catch (error) {
      // A failed start must not leave the child running: the caller's only
      // handle to it is this object, which it will not start again.
      await this.stop()
      throw error
    }
    return this
  }

  checkForServerUrl() {
    if (this.baseUrl !== undefined) return
    const url = parseServerUrl(this.stdout)
    if (url === undefined) return
    this.baseUrl = url.replace(/\/+$/, '')
    const waiters = this.urls
    this.urls = []
    for (const resolve of waiters) resolve(this.baseUrl)
  }

  waitForServerUrl() {
    if (this.baseUrl !== undefined) return Promise.resolve(this.baseUrl)
    if (this.exited) {
      return Promise.reject(transportError(`OpenCode server exited before it was ready${this.failureSuffix()}`))
    }
    return new Promise((resolve, reject) => {
      const onExit = () => {
        clearTimeout(timer)
        cleanup()
        reject(transportError(`OpenCode server exited before it was ready${this.failureSuffix()}`))
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(transportError(
          `OpenCode server did not report a listening URL within ${this.readyTimeoutMs}ms${this.stderrSuffix()}`,
        ))
      }, this.readyTimeoutMs)
      timer.unref?.()
      const onReady = (url) => {
        clearTimeout(timer)
        cleanup()
        resolve(url)
      }
      const cleanup = () => {
        this.urls = this.urls.filter((entry) => entry !== onReady)
        this.off('exit', onExit)
      }
      this.urls.push(onReady)
      this.once('exit', onExit)
    })
  }

  stderrSuffix() {
    const detail = this.stderr.trim()
    return detail === '' ? '' : `: ${detail}`
  }

  /**
   * Failure detail for a start that never became ready. A spawn error (ENOENT,
   * EACCES) has no stderr, so its message is the only useful diagnostic.
   */
  failureSuffix() {
    const spawnError = this.exitInfo?.error
    if (spawnError !== undefined && spawnError !== null) {
      const message = errorMessage(spawnError)
      if (message !== '') return `: ${message}`
    }
    return this.stderrSuffix()
  }

  handleExit(info, error) {
    if (this.exited) return
    this.exited = true
    this.exitInfo = error === undefined ? info : { error }
    this.urls = []
    this.abortInflight(transportError(`OpenCode server exited before responding${this.stderrSuffix()}`, error))
    this.emit('exit', { ...(info ?? {}), ...(error === undefined ? {} : { error }), stderr: this.stderr })
  }

  /**
   * One bounded JSON request. `timeoutMs: 0` disables the timeout.
   */
  async request(pathname, options = {}) {
    if (!this.running || this.baseUrl === undefined) {
      throw transportError('OpenCode server is not running')
    }
    const url = new URL(pathname, this.baseUrl)
    const controller = new AbortController()
    const entry = { controller, failure: undefined }
    this.inflight.add(entry)
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs
    const timer = timeoutMs > 0
      ? setTimeout(() => controller.abort(), timeoutMs)
      : undefined
    timer?.unref?.()
    try {
      const response = await fetch(url, {
        method: options.method ?? 'GET',
        headers: options.body === undefined ? {} : { 'content-type': 'application/json' },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      })
      const text = await response.text()
      if (!response.ok) {
        throw transportError(
          `OpenCode ${options.method ?? 'GET'} ${pathname} failed with ${response.status}${text === '' ? '' : `: ${text.slice(0, 500)}`}`,
        )
      }
      return parseJsonBody(text)
    } catch (error) {
      if (entry.failure !== undefined) throw entry.failure
      if (error?.name === 'AbortError') {
        throw transportError(`OpenCode ${options.method ?? 'GET'} ${pathname} timed out after ${timeoutMs}ms`)
      }
      // A killed server resets the socket before the process exit is delivered,
      // so a network-level failure has to give the exit event a moment before it
      // can be reported as a plain connection error. Callers (and the host's
      // error copy) need to tell a dead child from a network fault.
      if (error?.status !== 502 && isNetworkFailure(error) && !this.exited) {
        await this.waitForExit(250)
      }
      if (this.exited) {
        throw transportError(`OpenCode server exited before responding${this.stderrSuffix()}`, error)
      }
      if (error?.status === 502) throw error
      throw transportError(`OpenCode ${options.method ?? 'GET'} ${pathname} failed: ${errorMessage(error)}`, error)
    } finally {
      clearTimeout(timer)
      this.inflight.delete(entry)
    }
  }

  /**
   * Abort every open socket. The attachment's own event stream is not tracked
   * here: it is a long-lived read that only its owner can cancel.
   */
  abortInflight(failure) {
    for (const entry of this.inflight) {
      entry.failure = failure
      entry.controller.abort()
    }
    this.inflight.clear()
  }

  /**
   * Streamed GET (the SSE `/event` feed). The response body is pumped by the
   * caller; `signal` lets the attachment cancel the read during dispose.
   */
  async streamRequest(pathname, signal) {
    if (!this.running || this.baseUrl === undefined) {
      throw transportError('OpenCode server is not running')
    }
    try {
      const response = await fetch(new URL(pathname, this.baseUrl), { signal })
      if (!response.ok) {
        throw transportError(`OpenCode GET ${pathname} failed with ${response.status}`)
      }
      return response
    } catch (error) {
      if (error?.name === 'AbortError') throw error
      if (error?.status === 502) throw error
      throw transportError(`OpenCode GET ${pathname} failed: ${errorMessage(error)}`, error)
    }
  }

  /**
   * Shut the server down. Real OpenCode ignores stdin EOF and SIGTERM (verified
   * on 1.19.5), so this is a bounded escalation and only SIGKILL is guaranteed:
   * leaving the child alive would keep the host's event loop busy forever.
   */
  async stop() {
    if (this.child === undefined || this.exited) return
    this.stopping = true
    this.abortInflight(transportError('OpenCode server was disposed'))
    const child = this.child
    try {
      child.stdin.end()
    } catch {
      // The child may already have closed stdin.
    }
    if (await this.waitForExit(300)) return
    try {
      child.kill('SIGTERM')
    } catch {
      // Already gone.
    }
    if (await this.waitForExit(250)) return
    try {
      child.kill('SIGKILL')
    } catch {
      // Already gone.
    }
    await this.waitForExit(1000)
  }

  waitForExit(timeoutMs) {
    if (this.exited) return Promise.resolve(true)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.off('exit', onExit)
        resolve(false)
      }, timeoutMs)
      timer.unref?.()
      const onExit = () => {
        clearTimeout(timer)
        resolve(true)
      }
      this.once('exit', onExit)
    })
  }
}

/**
 * Turn the `GET /provider` catalog into the client's model shape.
 *
 * `all` lists every provider OpenCode knows; `connected` narrows it to the ones
 * with usable credentials. Showing 239 providers and ~9k models in the picker
 * would bury the handful the user can actually call, so `connected` wins when
 * the server sends it.
 */
export function modelsFromProviders(payload) {
  const providers = Array.isArray(payload?.all) ? payload.all : Array.isArray(payload) ? payload : []
  const connected = Array.isArray(payload?.connected) ? new Set(payload.connected) : undefined
  const models = []
  for (const provider of providers) {
    if (provider === null || typeof provider !== 'object') continue
    if (connected !== undefined && !connected.has(provider.id)) continue
    const providerId = typeof provider.id === 'string' ? provider.id : ''
    const providerModels = provider.models !== null && typeof provider.models === 'object' ? provider.models : {}
    for (const model of Object.values(providerModels)) {
      if (model === null || typeof model !== 'object') continue
      const id = typeof model.id === 'string' ? model.id : undefined
      if (id === undefined || id === '') continue
      const contextWindow = typeof model.limit?.context === 'number' ? model.limit.context : undefined
      models.push({
        id,
        provider: typeof model.providerID === 'string' ? model.providerID : providerId,
        name: typeof model.name === 'string' && model.name !== '' ? model.name : id,
        ...(contextWindow === undefined ? {} : { contextWindow }),
        reasoning: model.capabilities?.reasoning === true,
      })
    }
  }
  return models
}

/** Spawn a short-lived server, run `reader`, and always reap the child. */
async function withTemporaryServer(options, reader) {
  const server = new OpencodeServer({
    ...options,
    readyTimeoutMs: options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
  })
  try {
    await server.start()
    return await reader(server)
  } finally {
    await server.stop()
  }
}

/**
 * Create one OpenCode session through its own service.
 *
 * Sessions are service-owned records with project/workspace bookkeeping, so
 * inserting into SQLite directly would be a schema bet. Instead this spawns a
 * short-lived server with the workspace as its cwd (OpenCode binds the session
 * directory from that cwd; a `directory` body field was observed to be ignored),
 * posts `/session`, and reaps the server. Measured cost: ~1.7 s startup plus
 * <1 s for the create.
 */
export async function createOpencodeSession({ cwd, config = {}, env = process.env, logger } = {}) {
  const resolved = resolveOpencodeCommand(config, env)
  try {
    return await withTemporaryServer({ cwd, env, resolved }, async (server) => {
      const created = await server.request('/session', { method: 'POST', body: {} })
      const id = typeof created?.id === 'string' ? created.id : undefined
      if (id === undefined) throw transportError('OpenCode returned no session id')
      // The create response carries the id but not always the timestamps/title;
      // a follow-up read makes the returned summary match a listed session.
      const info = await server.request(`/session/${encodeURIComponent(id)}`).catch(() => created)
      return summaryFromApiSession(info)
    })
  } catch (error) {
    logger?.warn?.(`bridge: OpenCode session creation failed: ${errorMessage(error)}`)
    throw Object.assign(
      new Error(`could not create an OpenCode session: ${errorMessage(error)}`),
      { status: 502 },
    )
  }
}

/**
 * Query the model catalog with a short-lived server. The host caches the
 * result per bridge for ten minutes, so paying one server start is acceptable;
 * every wait is bounded and the child is always reaped.
 */
export async function queryOpencodeModels(config = {}, env = process.env) {
  const resolved = resolveOpencodeCommand(config, env)
  const dataDir = opencodeDataDir(config, env)
  const cwd = existsSync(dataDir) ? dataDir : homedir()
  try {
    return await withTemporaryServer(
      { cwd, env, resolved, readyTimeoutMs: DEFAULT_MODEL_TIMEOUT_MS },
      async (server) => {
        const payload = await server.request('/provider', { timeoutMs: DEFAULT_MODEL_TIMEOUT_MS })
        return modelsFromProviders(payload)
      },
    )
  } catch (error) {
    throw Object.assign(
      new Error(`could not read the OpenCode model catalog: ${errorMessage(error)}`),
      { status: 502 },
    )
  }
}

/**
 * Build the Pi-shaped extension dialog payload for one permission request.
 *
 * The v2 event family names the fields `action`/`resources` instead of
 * `permission`/`patterns`; both shapes reach the same dialog.
 */
export function permissionUiRequest(request) {
  const permission = typeof request?.permission === 'string'
    ? request.permission
    : typeof request?.action === 'string' ? request.action : 'tool'
  const patterns = Array.isArray(request?.patterns)
    ? request.patterns
    : Array.isArray(request?.resources) ? request.resources : []
  const command = request?.metadata?.command
  const detail = typeof command === 'string' && command !== ''
    ? command
    : patterns.length > 0 ? patterns.join(', ') : ''
  return {
    type: 'extension_ui_request',
    id: request.id,
    method: 'confirm',
    title: `OpenCode wants to run ${permission}`,
    message: detail === '' ? `OpenCode is asking for permission to use ${permission}.` : detail,
  }
}

/** Build the Pi-shaped extension dialog payload for one interactive question. */
export function questionUiRequest(request) {
  const questions = Array.isArray(request?.questions) ? request.questions : []
  const first = questions[0] ?? {}
  const options = Array.isArray(first.options)
    ? first.options.map((option) => (typeof option === 'string' ? option : option?.label)).filter(Boolean)
    : []
  return {
    type: 'extension_ui_request',
    id: request.id,
    method: options.length > 0 ? 'select' : 'confirm',
    title: typeof first.header === 'string' && first.header !== '' ? first.header : 'OpenCode question',
    message: typeof first.question === 'string' && first.question !== '' ? first.question : 'OpenCode is asking a question.',
    ...(options.length === 0 ? {} : { options }),
  }
}

/** One live OpenCode session attachment. */
export class OpencodeAttachment extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.sessionId OpenCode session id (`ses_…`)
   * @param {string} [options.cwd] workspace directory the server should bind
   * @param {NodeJS.ProcessEnv} [options.env]
   * @param {object} [options.config] bridge config (`binPath`, `autoApprove`, …)
   * @param {number} [options.readyTimeoutMs]
   * @param {number} [options.requestTimeoutMs]
   * @param {number} [options.uiTimeoutMs]
   */
  constructor(options) {
    super()
    this.sessionId = options.sessionId
    this.config = options.config ?? {}
    this.env = options.env ?? process.env
    this.autoApprove = this.config.autoApprove !== false
    this.requestTimeoutMs = options.requestTimeoutMs ?? options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.uiTimeoutMs = options.uiTimeoutMs ?? DEFAULT_UI_TIMEOUT_MS
    this.resolved = options.resolved ?? resolveOpencodeCommand(this.config, this.env)
    this.server = new OpencodeServer({
      cwd: options.cwd,
      env: this.env,
      resolved: this.resolved,
      readyTimeoutMs: options.readyTimeoutMs ?? options.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
      requestTimeoutMs: this.requestTimeoutMs,
    })
    this.timeoutMs = this.requestTimeoutMs
    this.server.on('spawn', (info) => this.emit('spawn', info))
    this.server.on('exit', (info) => this.handleExit(info))

    // Streaming state, filled from SSE events and reconciled once after start.
    this.busy = false
    this.awaitingTurn = false
    this.aborted = false
    this.model = undefined
    this.lastEventAt = undefined
    this.lastEventType = undefined
    this.sessionInfo = undefined
    this.lastSessionName = undefined
    this.messages = new Map()
    this.messageOrder = []
    this.parts = new Map()
    this.partsByMessage = new Map()
    this.startedMessages = new Set()
    this.endedMessages = new Set()
    this.toolStates = new Map()
    this.pendingUserMessage = undefined
    this.pendingUi = new Map()
    this.eventsController = undefined
    this.disposed = false
    this.ready = false
  }

  get child() {
    return this.server.child
  }

  get pid() {
    return this.server.pid
  }

  get running() {
    return this.server.running
  }

  get exited() {
    return this.server.exited
  }

  get stderr() {
    return this.server.stderr
  }

  get baseUrl() {
    return this.server.baseUrl
  }

  /** Spawn the server, attach the event stream, and reconcile the session. */
  async start() {
    if (this.ready) return this
    await this.server.start()
    if (this.disposed) {
      await this.server.stop()
      return this
    }
    this.ready = true
    this.openEventStream()
    await this.reconcile()
    return this
  }

  openEventStream() {
    const controller = new AbortController()
    this.eventsController = controller
    void this.pumpEvents(controller).catch(() => {
      // The stream ending is expected on dispose; anything else surfaces through
      // the request paths, not here.
    })
  }

  async pumpEvents(controller) {
    const response = await this.server.streamRequest('/event', controller.signal)
    const decoder = new TextDecoder()
    const reader = response.body.getReader()
    let buffer = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let boundary = buffer.indexOf('\n\n')
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          this.handleFrame(frame)
          boundary = buffer.indexOf('\n\n')
        }
      }
    } finally {
      try {
        reader.releaseLock()
      } catch {
        // The reader is already closed when the abort wins the race.
      }
    }
  }

  handleFrame(frame) {
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data:')) continue
      const raw = line.slice(5).trim()
      if (raw === '') continue
      const record = parseJsonBody(raw)
      if (record === null || typeof record !== 'object') continue
      this.handleEvent(record)
    }
  }

  /** Translate one native `{id,type,properties}` SSE record into bridge events. */
  handleEvent(record) {
    const type = typeof record.type === 'string' ? record.type : ''
    if (type === 'server.heartbeat') return
    const properties = record.properties !== null && typeof record.properties === 'object' ? record.properties : {}
    if (type === 'server.connected') {
      this.lastEventAt = Date.now()
      this.lastEventType = type
      return
    }
    // Every session-scoped event names its session; other sessions may be busy
    // on the same server, and their turns must not leak into this transcript.
    if (typeof properties.sessionID === 'string' && properties.sessionID !== this.sessionId) return
    if (type !== 'message.part.updated' && type !== 'message.part.delta') this.flushPendingUserMessage()
    this.lastEventAt = Date.now()
    this.lastEventType = type
    switch (type) {
      case 'session.status':
        this.handleSessionStatus(properties.status)
        return
      case 'session.idle':
        this.settleTurn(false)
        return
      case 'session.updated':
        this.handleSessionUpdated(properties.info)
        return
      case 'message.updated':
        this.handleMessageUpdated(properties.info)
        return
      case 'message.part.updated':
        this.handlePartUpdated(properties.part)
        return
      case 'message.part.delta':
        this.handlePartDelta(properties)
        return
      case 'message.part.removed':
        this.handlePartRemoved(properties)
        return
      case 'session.error':
        this.handleSessionError(properties.error)
        return
      case 'permission.asked':
      case 'permission.v2.asked':
        void this.handlePermissionRequest(type, properties)
        return
      case 'question.asked':
        void this.handleQuestionRequest(properties, false)
        return
      case 'question.v2.asked':
        void this.handleQuestionRequest(properties, true)
        return
      case 'tui.toast.show':
        this.emit('ui-notification', {
          type: 'extension_ui_request',
          id: `toast-${Date.now().toString(36)}`,
          method: 'notify',
          message: typeof properties.message === 'string' ? properties.message : '',
          title: typeof properties.title === 'string' ? properties.title : undefined,
          variant: properties.variant,
          // The Bridge client colours a notice from `notifyType`, not from the
          // engine's own variant vocabulary.
          ...(properties.variant === 'error' || properties.variant === 'warning' ? { notifyType: 'error' } : {}),
        })
        return
      case 'session.created':
      case 'session.deleted':
      case 'session.diff':
      case 'session.compacted':
      case 'catalog.updated':
      case 'plugin.added':
      case 'reference.updated':
      case 'integration.updated':
        return
      default:
        return
    }
  }

  handleSessionStatus(status) {
    const kind = typeof status?.type === 'string' ? status.type : ''
    if (kind === 'busy') {
      if (this.busy) return
      this.busy = true
      this.awaitingTurn = true
      this.aborted = false
      this.emitNative({ type: 'session-status', status: 'busy' })
      return
    }
    if (kind === 'idle') {
      this.settleTurn(false)
      return
    }
    if (kind === 'retry') {
      this.emitNative({ type: 'session-status', status: 'retry', attempt: status.attempt, message: status.message })
    }
  }

  handleSessionUpdated(info) {
    if (info === null || typeof info !== 'object') return
    this.sessionInfo = { ...(this.sessionInfo ?? {}), ...info }
    if (info.model !== null && typeof info.model === 'object' && typeof info.model.id === 'string') {
      this.model = { provider: info.model.providerID, id: info.model.id }
    }
    const name = sessionName(info.title)
    if (name !== undefined && name !== this.lastSessionName) {
      this.lastSessionName = name
      this.emitNative({ type: 'session-name', name })
    }
  }

  handleSessionError(error) {
    const name = typeof error?.name === 'string' ? error.name : ''
    const message = typeof error?.data?.message === 'string' ? error.data.message : ''
    if (name === 'MessageAbortedError') {
      this.aborted = true
      return
    }
    this.emitNative({ type: 'session-error', name, message })
    // A provider/auth failure ends the turn too; the idle event that follows
    // settles it, but the reason must reach the user rather than a silent stop.
    this.emit('ui-notification', {
      type: 'extension_ui_request',
      id: `error-${Date.now().toString(36)}`,
      method: 'notify',
      notifyType: 'error',
      message: message === '' ? (name === '' ? 'OpenCode reported an error' : name) : `${name}: ${message}`,
    })
  }

  handleMessageUpdated(info) {
    if (info === null || typeof info !== 'object' || typeof info.id !== 'string') return
    const previous = this.messages.get(info.id)
    // Later `message.updated` records can be partial (a summary-only update for
    // a user message); merging keeps the last complete picture per message.
    const merged = { ...(previous ?? {}), ...info }
    if (previous === undefined) this.messageOrder.push(info.id)
    this.messages.set(info.id, merged)
    if (merged.role === 'user') {
      this.pendingUserMessage = info.id
      return
    }
    if (merged.role !== 'assistant') return
    if (merged.error?.name === 'MessageAbortedError') this.aborted = true
    if (!this.startedMessages.has(info.id)) {
      this.startedMessages.add(info.id)
      this.emitNative({ type: 'message-start', message: this.buildMessage(info.id) })
    }
    // `time.completed` is the authoritative end of one assistant message; the
    // session only turns idle after the whole step sequence is done.
    if (typeof merged.time?.completed === 'number' && !this.endedMessages.has(info.id)) {
      this.endMessage(info.id)
    }
  }

  handlePartUpdated(part) {
    if (part === null || typeof part !== 'object') return
    const partId = typeof part.id === 'string' ? part.id : undefined
    const messageId = typeof part.messageID === 'string' ? part.messageID : undefined
    if (partId === undefined || messageId === undefined) return
    if (!this.parts.has(partId)) {
      const list = this.partsByMessage.get(messageId)
      if (list === undefined) this.partsByMessage.set(messageId, [partId])
      else list.push(partId)
    }
    this.parts.set(partId, part)
    if (part.type === 'tool') {
      this.handleToolPart(part)
      this.emitMessageUpdate(messageId)
      return
    }
    if (part.type === 'text' || part.type === 'reasoning') {
      this.emitMessageUpdate(messageId)
    }
  }

  handlePartDelta(properties) {
    const messageId = typeof properties.messageID === 'string' ? properties.messageID : undefined
    const partId = typeof properties.partID === 'string' ? properties.partID : undefined
    const field = typeof properties.field === 'string' ? properties.field : ''
    const delta = typeof properties.delta === 'string' ? properties.delta : ''
    if (messageId === undefined || partId === undefined) return
    if (field !== 'text' && field !== 'reasoning') return
    let part = this.parts.get(partId)
    if (part === undefined) {
      if (!this.partsByMessage.has(messageId)) this.partsByMessage.set(messageId, [])
      this.partsByMessage.get(messageId).push(partId)
      part = { id: partId, messageID: messageId, type: field, text: '' }
      this.parts.set(partId, part)
    }
    // Deltas append to a base that `message.part.updated` re-sends cumulatively;
    // the cumulative snapshot always arrives after the deltas it covers, so
    // replacing with it and appending later deltas stays consistent.
    part.text = `${typeof part.text === 'string' ? part.text : ''}${delta}`
    this.emitMessageUpdate(messageId)
  }

  handlePartRemoved(properties) {
    const partId = typeof properties.partID === 'string' ? properties.partID : undefined
    if (partId === undefined) return
    const part = this.parts.get(partId)
    if (part === undefined) return
    this.parts.delete(partId)
    const list = this.partsByMessage.get(part.messageID)
    if (list !== undefined) this.partsByMessage.set(part.messageID, list.filter((id) => id !== partId))
  }

  handleToolPart(part) {
    const callId = typeof part.callID === 'string' && part.callID !== ''
      ? part.callID
      : typeof part.id === 'string' ? part.id : undefined
    if (callId === undefined) return
    const name = bridgeToolName(part.tool)
    const state = part.state !== null && typeof part.state === 'object' ? part.state : {}
    const status = typeof state.status === 'string' ? state.status : 'pending'
    const input = bridgeToolArguments(state.input)
    const known = this.toolStates.get(callId)
    if (known === undefined) {
      // `pending` carries an empty input; starting the row then would show a
      // tool with no arguments. The running transition has the real input, and
      // that is the first useful sighting for a one-line tool row.
      if (status === 'pending' && !hasKeys(input)) return
      const entry = { name, status: undefined, output: '', started: true, ended: false }
      this.toolStates.set(callId, entry)
      this.emitNative({ type: 'tool-start', toolCallId: callId, toolName: name, args: input })
      entry.status = status
    } else {
      known.status = status
    }
    const current = this.toolStates.get(callId)
    if (status === 'running') {
      const partial = typeof state.metadata?.output === 'string' && state.metadata.output !== ''
        ? state.metadata.output
        : typeof state.title === 'string' ? state.title : ''
      if (partial !== '' && partial !== current.output) {
        current.output = partial
        this.emitNative({ type: 'tool-update', toolCallId: callId, partialResult: partial })
      }
      return
    }
    if (status === 'completed') {
      if (current.ended) return
      current.ended = true
      this.emitNative({
        type: 'tool-end',
        toolCallId: callId,
        result: typeof state.output === 'string' ? state.output : '',
        isError: false,
      })
      return
    }
    if (status === 'error') {
      if (current.ended) return
      current.ended = true
      this.emitNative({
        type: 'tool-end',
        toolCallId: callId,
        result: typeof state.error === 'string' ? state.error : '',
        isError: true,
      })
    }
  }

  /** Rebuild one assistant/user message from accumulated parts. */
  buildMessage(messageId) {
    const info = this.messages.get(messageId) ?? {}
    const timestamp = typeof info.time?.created === 'number' ? info.time.created : undefined
    const parts = (this.partsByMessage.get(messageId) ?? [])
      .map((partId) => this.parts.get(partId))
      .filter((part) => part !== undefined)
    if (info.role === 'user') {
      const text = parts
        .filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n')
      return { role: 'user', content: [{ type: 'text', text }], timestamp }
    }
    const content = []
    let usage
    for (const part of parts) {
      if (part.type === 'text' && typeof part.text === 'string' && part.text !== '') {
        content.push({ type: 'text', text: part.text })
      } else if (part.type === 'reasoning' && typeof part.text === 'string' && part.text !== '') {
        content.push({ type: 'thinking', thinking: part.text })
      } else if (part.type === 'tool') {
        const callId = typeof part.callID === 'string' && part.callID !== ''
          ? part.callID
          : typeof part.id === 'string' ? part.id : undefined
        if (callId === undefined) continue
        const name = bridgeToolName(part.tool)
        content.push({ type: 'toolCall', id: callId, name, arguments: bridgeToolArguments(part.state?.input) })
      } else if (part.type === 'step-finish') {
        usage = usageFromTokens(part.tokens) ?? usage
      }
    }
    return {
      role: 'assistant',
      content,
      timestamp,
      ...(typeof info.providerID === 'string' ? { provider: info.providerID } : {}),
      ...(typeof info.modelID === 'string' ? { model: info.modelID } : {}),
      ...(usage === undefined ? {} : { usage }),
      ...(typeof info.time?.completed === 'number' ? { stopReason: 'stop' } : {}),
      ...(typeof info.error?.name === 'string' ? { errorMessage: info.error.name } : {}),
    }
  }

  emitMessageUpdate(messageId) {
    if (this.messages.get(messageId)?.role !== 'assistant') return
    if (!this.startedMessages.has(messageId)) {
      this.startedMessages.add(messageId)
      this.emitNative({ type: 'message-start', message: this.buildMessage(messageId) })
      return
    }
    if (this.endedMessages.has(messageId)) return
    this.emitNative({ type: 'message-update', message: this.buildMessage(messageId) })
  }

  endMessage(messageId) {
    if (this.endedMessages.has(messageId)) return
    this.endedMessages.add(messageId)
    this.emitNative({ type: 'message-end', message: this.buildMessage(messageId) })
  }

  /**
   * User messages have no completion event: their text parts arrive, then the
   * next event of the turn begins. Flushing on that boundary gives the browser
   * one `message-end` with the full text, which is what settles the submitted
   * echo locally.
   */
  flushPendingUserMessage() {
    const messageId = this.pendingUserMessage
    if (messageId === undefined) return
    this.pendingUserMessage = undefined
    const message = this.buildMessage(messageId)
    const text = Array.isArray(message.content)
      ? message.content.map((block) => block.text ?? '').join('')
      : ''
    if (text.trim() === '') return
    this.emitNative({ type: 'message-end', message })
  }

  /**
   * End the current turn exactly once.
   *
   * The host keys turn state on `agent-start` / `agent-settled`; a missing
   * settle leaves the session stuck "running", so an idle event or a child exit
   * always settles a turn the attachment started.
   */
  settleTurn(fromExit) {
    this.flushPendingUserMessage()
    if (!this.busy && !this.awaitingTurn) return
    for (const messageId of this.messageOrder) {
      if (this.messages.get(messageId)?.role !== 'assistant') continue
      if (this.startedMessages.has(messageId) && !this.endedMessages.has(messageId)) this.endMessage(messageId)
    }
    this.busy = false
    this.awaitingTurn = false
    this.emitNative({ type: 'session-status', status: 'idle', aborted: this.aborted, ...(fromExit ? { exited: true } : {}) })
    this.aborted = false
  }

  emitNative(record) {
    this.lastEventAt = Date.now()
    this.lastEventType = record.type
    this.emit('event', record)
    this.emit(record.type, record)
  }

  /** Reconcile cached state with the server (status + session metadata). */
  async reconcile() {
    const [status, info] = await Promise.all([
      this.server.request('/session/status').catch(() => undefined),
      this.server.request(`/session/${encodeURIComponent(this.sessionId)}`).catch(() => undefined),
    ])
    if (info !== null && typeof info === 'object') {
      this.sessionInfo = info
      if (typeof info.model?.id === 'string') this.model = { provider: info.model.providerID, id: info.model.id }
      const name = sessionName(info.title)
      if (name !== undefined) this.lastSessionName = name
    }
    const current = status === null || typeof status !== 'object' ? undefined : status[this.sessionId]
    if (current?.type === 'busy') {
      this.busy = true
      this.awaitingTurn = true
    }
    return this.stateView()
  }

  stateView() {
    return {
      sessionId: this.sessionId,
      isStreaming: this.busy,
      model: this.model ?? null,
      pid: this.pid,
      lastEventAt: this.lastEventAt,
      lastEventType: this.lastEventType,
      sessionName: this.lastSessionName,
      autoApprove: this.autoApprove,
    }
  }

  /** Cached state; `snapshot()` is the reconciling variant the HTTP state route uses. */
  getState() {
    return this.stateView()
  }

  async snapshot() {
    await this.reconcile()
    return this.stateView()
  }

  /** POST one user message; the turn itself streams over SSE. */
  async sendPrompt(message, kind) {
    if (typeof message !== 'string' || message.trim() === '') {
      throw Object.assign(new Error('message is required'), { status: 400 })
    }
    const payload = { parts: [{ type: 'text', text: message }] }
    if (this.model !== undefined && this.model !== null) {
      payload.model = { providerID: this.model.provider, modelID: this.model.id }
    }
    this.awaitingTurn = true
    this.aborted = false
    try {
      await this.server.request(`/session/${encodeURIComponent(this.sessionId)}/prompt_async`, {
        method: 'POST',
        body: payload,
      })
    } catch (error) {
      // The turn never started, so an idle event will not arrive to clear it and
      // the next `prompt` must be able to start a turn again.
      this.awaitingTurn = false
      throw error
    }
    return { accepted: true, ...(kind === 'steer' ? { queued: true } : {}) }
  }

  prompt(message) {
    return this.sendPrompt(message, 'prompt')
  }

  steer(message) {
    return this.sendPrompt(message, 'steer')
  }

  followUp(message) {
    return this.sendPrompt(message, 'followUp')
  }

  async abort() {
    this.aborted = true
    await this.server.request(`/session/${encodeURIComponent(this.sessionId)}/abort`, { method: 'POST' })
    return { aborted: true }
  }

  /**
   * Switch the session model.
   *
   * Verified against 1.19.5: `POST /api/session/{id}/model` with
   * `{model:{id,providerID}}` returns 204 for a session that has a v2 row, and
   * fails with a foreign-key error for a session created by the 1.19.5 CLI
   * (which only writes the legacy tables). `PATCH /session/{id}` accepts but
   * ignores a model field. So: try the endpoint, and on failure pin the model
   * for the next `prompt_async` — every prompt carries it, which is the only
   * lever left for legacy-only sessions.
   */
  async setModel(provider, model) {
    if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') {
      throw Object.assign(new Error('provider and model are required'), { status: 400 })
    }
    const selection = { provider, id: model }
    try {
      await this.server.request(`/api/session/${encodeURIComponent(this.sessionId)}/model`, {
        method: 'POST',
        body: { model: { id: model, providerID: provider } },
      })
      this.model = selection
      return selection
    } catch (error) {
      this.model = selection
      this.emit('ui-notification', {
        type: 'extension_ui_request',
        id: `model-${Date.now().toString(36)}`,
        method: 'notify',
        message: `OpenCode could not persist the model for this session (${errorMessage(error)}); the Bridge will send it with each prompt instead.`,
      })
      return selection
    }
  }

  /** Normalized transcript for the live session (Pi-shaped). */
  async getMessages() {
    const entries = await this.server.request(`/session/${encodeURIComponent(this.sessionId)}/message`)
    const transcript = messagesFromApiEntries(entries)
    return { messages: transcript.messages, tools: transcript.tools, model: transcript.model ?? null }
  }

  /**
   * Token/turn statistics. The host's `/stats` route prefers a live attachment,
   * and OpenCode has no stats RPC, so this folds the transcript instead.
   */
  async getSessionStats() {
    const entries = await this.server.request(`/session/${encodeURIComponent(this.sessionId)}/message`)
    const list = Array.isArray(entries) ? entries : []
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
    let userMessages = 0
    let assistantMessages = 0
    let toolCalls = 0
    let cost = 0
    for (const entry of list) {
      const info = entry?.info
      if (info === null || typeof info !== 'object') continue
      if (info.role === 'user') userMessages += 1
      if (info.role !== 'assistant') continue
      assistantMessages += 1
      const usage = usageFromTokens(info.tokens)
      if (usage !== undefined) {
        tokens.input += usage.input
        tokens.output += usage.output
        tokens.cacheRead += usage.cacheRead
        tokens.cacheWrite += usage.cacheWrite
      }
      if (typeof info.tokens?.reasoning === 'number') tokens.reasoning += info.tokens.reasoning
      if (typeof info.cost === 'number') cost += info.cost
      for (const part of Array.isArray(entry.parts) ? entry.parts : []) {
        if (part?.type === 'tool') toolCalls += 1
      }
    }
    return {
      sessionId: this.sessionId,
      userMessages,
      assistantMessages,
      toolCalls,
      totalMessages: userMessages + assistantMessages,
      tokens: { ...tokens, total: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite },
      cost,
    }
  }

  async getAvailableModels() {
    const payload = await this.server.request('/provider')
    return modelsFromProviders(payload)
  }

  /**
   * Auto-answer one permission prompt.
   *
   * With `autoApprove` the server must never wait for a human: a Bridge turn has
   * no attached TUI, so an unanswered prompt would hang the turn forever. The
   * reply endpoint is the verified lever regardless of which ruleset produced
   * the ask.
   */
  async handlePermissionRequest(type, request) {
    const id = typeof request?.id === 'string' ? request.id : undefined
    if (id === undefined) return
    if (this.autoApprove) {
      try {
        await this.replyPermission(id, 'once', type === 'permission.v2.asked')
      } catch (error) {
        this.emit('ui-notification', {
          type: 'extension_ui_request',
          id: `permission-error-${id}`,
          method: 'notify',
          message: `OpenCode permission ${id} could not be auto-approved: ${errorMessage(error)}`,
        })
      }
      return
    }
    this.forwardUiRequest(permissionUiRequest(request), {
      kind: 'permission',
      v2: type === 'permission.v2.asked',
      request,
    })
  }

  async handleQuestionRequest(request, v2) {
    const id = typeof request?.id === 'string' ? request.id : undefined
    if (id === undefined) return
    const questions = Array.isArray(request.questions) ? request.questions : []
    const first = questions[0] ?? {}
    const firstOption = Array.isArray(first.options) ? first.options[0] : undefined
    const label = typeof firstOption === 'string' ? firstOption : firstOption?.label
    if (this.autoApprove) {
      try {
        if (typeof label === 'string' && label !== '') await this.replyQuestion(id, [[label]], v2)
        else await this.rejectQuestion(id, v2)
      } catch (error) {
        this.emit('ui-notification', {
          type: 'extension_ui_request',
          id: `question-error-${id}`,
          method: 'notify',
          message: `OpenCode question ${id} could not be auto-answered: ${errorMessage(error)}`,
        })
      }
      return
    }
    this.forwardUiRequest(questionUiRequest(request), { kind: 'question', v2: v2 === true, request })
  }

  /**
   * Forward one native prompt to the browser and remember it for `respondUi`.
   * The timer is the deadlock guard: an unattended dialog is auto-denied rather
   * than leaving the session busy forever.
   */
  forwardUiRequest(uiRequest, context) {
    const timer = setTimeout(() => {
      void this.respondUi(uiRequest.id, { cancelled: true }).catch(() => {})
      this.emit('ui-notification', {
        type: 'extension_ui_request',
        id: `ui-timeout-${uiRequest.id}`,
        method: 'notify',
        message: `OpenCode ${context.kind} request timed out and was rejected automatically.`,
      })
    }, this.uiTimeoutMs)
    timer.unref?.()
    this.pendingUi.set(uiRequest.id, { ...context, timer, request: uiRequest })
    this.emit('ui-request', uiRequest)
  }

  /** Answer one forwarded permission/question dialog (host `ui-response` route). */
  async respondUi(id, response = {}) {
    const pending = this.pendingUi.get(id)
    if (pending === undefined) throw Object.assign(new Error('unknown extension UI request'), { status: 409 })
    this.pendingUi.delete(id)
    clearTimeout(pending.timer)
    const cancelled = response.cancelled === true
    const v2 = pending.v2 === true
    if (pending.kind === 'permission') {
      await this.replyPermission(id, cancelled ? 'reject' : 'once', v2)
      return
    }
    if (cancelled) {
      await this.rejectQuestion(id, v2)
      return
    }
    const answer = typeof response.value === 'string' && response.value !== ''
      ? response.value
      : typeof response.answer === 'string' ? response.answer : ''
    await this.replyQuestion(id, [[answer]], v2)
  }

  /** Answer one permission request through the family its event arrived in. */
  async replyPermission(id, reply, v2) {
    const path = v2 === true
      ? `/api/session/${encodeURIComponent(this.sessionId)}/permission/${encodeURIComponent(id)}/reply`
      : `/permission/${encodeURIComponent(id)}/reply`
    await this.server.request(path, { method: 'POST', body: { reply } })
  }

  /** Answer one interactive question. `answers` is one array per question. */
  async replyQuestion(id, answers, v2) {
    const path = v2 === true
      ? `/api/session/${encodeURIComponent(this.sessionId)}/question/${encodeURIComponent(id)}/reply`
      : `/question/${encodeURIComponent(id)}/reply`
    await this.server.request(path, { method: 'POST', body: { answers } })
  }

  async rejectQuestion(id, v2) {
    const path = v2 === true
      ? `/api/session/${encodeURIComponent(this.sessionId)}/question/${encodeURIComponent(id)}/reject`
      : `/question/${encodeURIComponent(id)}/reject`
    await this.server.request(path, { method: 'POST' })
  }

  handleExit(info) {
    // Settle first: a child that dies mid-turn must not leave the browser's
    // turn clock running forever, whatever the reason for the exit.
    this.settleTurn(true)
    for (const pending of this.pendingUi.values()) clearTimeout(pending.timer)
    this.pendingUi.clear()
    this.eventsController?.abort()
    this.eventsController = undefined
    this.emit('exit', info)
  }

  /** Stop the server and release every socket. */
  async dispose() {
    if (this.disposed && this.exited) return
    this.disposed = true
    this.eventsController?.abort()
    this.eventsController = undefined
    for (const pending of this.pendingUi.values()) clearTimeout(pending.timer)
    this.pendingUi.clear()
    await this.server.stop()
  }
}

function sessionName(title) {
  if (typeof title !== 'string' || title.trim() === '') return undefined
  if (/^New session\s*-\s*\d{4}-\d{2}-\d{2}T/.test(title)) return undefined
  return title
}

function hasKeys(value) {
  return value !== null && typeof value === 'object' && Object.keys(value).length > 0
}

function usageFromTokens(tokens) {
  if (tokens === null || typeof tokens !== 'object') return undefined
  const cache = tokens.cache
  return {
    input: numberOrZero(tokens.input),
    output: numberOrZero(tokens.output),
    cacheRead: numberOrZero(cache?.read ?? tokens.cacheRead),
    cacheWrite: numberOrZero(cache?.write ?? tokens.cacheWrite),
    ...(typeof tokens.total === 'number' ? { total: tokens.total } : {}),
  }
}

function numberOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
