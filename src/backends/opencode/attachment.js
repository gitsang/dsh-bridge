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
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import {
  OpencodeServer,
  parseJsonBody,
  parseServerUrl,
  resolveOpencodeCommand,
  transportError,
} from './launcher.js'
import {
  bridgeToolArguments,
  bridgeToolName,
  messagesFromApiEntries,
  opencodeDataDir,
  summaryFromApiSession,
} from './session-store.js'
import { permissionUiRequest, questionUiRequest } from './ui.js'
import {
  OpencodeV2Client,
  messagesFromV2Entries,
  modelsFromV2Catalog,
  summaryFromV2Session,
  usageFromV2Tokens,
} from './v2-transport.js'

// Both transports share one server child implementation; re-exported here because
// this module is the OpenCode adapter's public entry point.
export { OpencodeServer, parseServerUrl, resolveOpencodeCommand }
export { permissionUiRequest, questionUiRequest }

const DEFAULT_READY_TIMEOUT_MS = 30_000
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_UI_TIMEOUT_MS = 120_000
const DEFAULT_MODEL_TIMEOUT_MS = 60_000
const DEFAULT_V2_MODEL_TIMEOUT_MS = 90_000

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
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
 * short-lived server with the workspace as its cwd (both generations bind the
 * session directory from that cwd; a `directory` body field was observed to be
 * ignored by 1.x), creates the session through whichever API the binary speaks,
 * and reaps the server. Measured cost: ~1.7 s startup plus < 1 s for the create.
 */
export async function createOpencodeSession({ cwd, config = {}, env = process.env, logger } = {}) {
  const resolved = resolveOpencodeCommand(config, env)
  try {
    return await withTemporaryServer({ cwd, env, resolved }, async (server) => {
      const generation = await server.detectGeneration()
      if (generation === 'v2') {
        // The 2.x create route answers `{data:{…}}`; the row carries the
        // workspace under `location.directory` instead of a top-level field.
        const created = await server.request('/api/session', { method: 'POST', body: {} })
        const info = created?.data
        if (info === null || typeof info !== 'object' || typeof info.id !== 'string') {
          throw transportError('OpenCode returned no session id')
        }
        const read = await server.request(`/api/session/${encodeURIComponent(info.id)}`).catch(() => undefined)
        return summaryFromV2Session(read?.data ?? info)
      }
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
 *
 * The two generations disagree about where the catalog lives (`/provider` with a
 * `{all, connected}` envelope vs `/api/model` with a flat `{data}` list), so the
 * probe decides which reader to use before any model is reported.
 */
export async function queryOpencodeModels(config = {}, env = process.env) {
  const resolved = resolveOpencodeCommand(config, env)
  const dataDir = opencodeDataDir(config, env)
  const cwd = existsSync(dataDir) ? dataDir : homedir()
  try {
    return await withTemporaryServer(
      { cwd, env, resolved, readyTimeoutMs: DEFAULT_MODEL_TIMEOUT_MS },
      async (server) => {
        const generation = await server.detectGeneration()
        if (generation === 'v2') {
          // 2.x answers a catalog for the server's cwd, so a session directory
          // and a data directory both work; the response is already flat.
          const payload = await server.request('/api/model', { timeoutMs: DEFAULT_V2_MODEL_TIMEOUT_MS })
          return modelsFromV2Catalog(payload)
        }
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
 * The OpenCode 1.x conversation, over a server the attachment already started.
 *
 * Kept as its own class so the 1.x event vocabulary, which the host has been
 * running against 1.19.5, is untouched by the 2.x work: the facade below picks
 * one transport per detected generation and forwards the same bridge events.
 */
class OpencodeV1Transport extends EventEmitter {
  /**
   * @param {object} options
   * @param {OpencodeServer} options.server started server for `options.sessionId`
   * @param {string} options.sessionId OpenCode session id (`ses_…`)
   * @param {boolean} [options.autoApprove]
   * @param {number} [options.uiTimeoutMs]
   */
  constructor(options) {
    super()
    this.sessionId = options.sessionId
    this.server = options.server
    this.autoApprove = options.autoApprove !== false
    this.uiTimeoutMs = options.uiTimeoutMs ?? DEFAULT_UI_TIMEOUT_MS
    this.server.on('exit', (info) => this.handleExit(info))

    // Streaming state, filled from SSE events and reconciled once after start.
    this.busy = false
    this.busyEmitted = false
    this.awaitingTurn = false
    this.aborted = false
    this.model = undefined
    this.lastEventAt = undefined
    this.lastEventType = undefined
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

  /** Attach the event stream and reconcile the session state. */
  async start() {
    if (this.ready) return this
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
      if (this.busy && this.busyEmitted) return
      this.busy = true
      this.awaitingTurn = true
      this.aborted = false
      this.emitBusy()
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
   * Announce the start of a turn.
   *
   * The host keys turn state on `agent-start`; it is emitted once per turn even
   * though OpenCode repeats `session.status: busy` for every step. `defer` is
   * used when the busy state is discovered during attach reconciliation, where
   * the host has not subscribed to the attachment's events yet.
   */
  emitBusy(defer = false) {
    if (this.busyEmitted) return
    this.busyEmitted = true
    const emit = () => {
      if (this.disposed || !this.busy) return
      this.emitNative({ type: 'session-status', status: 'busy' })
    }
    if (defer) setImmediate(emit)
    else emit()
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
    this.busyEmitted = false
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
      if (typeof info.model?.id === 'string') this.model = { provider: info.model.providerID, id: info.model.id }
      const name = sessionName(info.title)
      if (name !== undefined) this.lastSessionName = name
    }
    const current = status === null || typeof status !== 'object' ? undefined : status[this.sessionId]
    if (current?.type === 'busy') {
      this.busy = true
      this.awaitingTurn = true
      // Attaching mid-turn is rare (the Bridge closes an attachment shortly
      // after every settle) but must still show as running, so the deferred
      // emit lands after the host has subscribed to this attachment's events.
      this.emitBusy(true)
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
      // Auto-deny instead of leaving the turn blocked forever. Unknown-id throws
      // are possible if the dialog was answered in the same tick, so swallow
      // them: an exception escaping a timer callback would kill the host.
      try {
        void this.respondUi(uiRequest.id, { cancelled: true }).catch(() => {})
      } catch {
        // Already answered.
      }
      this.emit('ui-notification', {
        type: 'extension_ui_request',
        id: `ui-timeout-${uiRequest.id}`,
        method: 'notify',
        notifyType: 'error',
        message: `OpenCode ${context.kind} request timed out and was rejected automatically.`,
      })
    }, this.uiTimeoutMs)
    timer.unref?.()
    this.pendingUi.set(uiRequest.id, { ...context, timer, request: uiRequest })
    this.emit('ui-request', uiRequest)
  }

  /**
   * Answer one forwarded permission/question dialog (host `ui-response` route).
   *
   * The host calls this without awaiting, so state validation is synchronous (a
   * throw becomes the route's 400/409) and only the reply itself is async. A
   * transport failure is reported as a notification rather than as an unhandled
   * rejection the host would never see.
   */
  respondUi(id, response = {}) {
    const pending = this.pendingUi.get(id)
    if (pending === undefined) throw Object.assign(new Error('unknown extension UI request'), { status: 409 })
    this.pendingUi.delete(id)
    clearTimeout(pending.timer)
    return this.sendUiResponse(id, pending, response).catch((error) => {
      this.emit('ui-notification', {
        type: 'extension_ui_request',
        id: `ui-reply-error-${id}`,
        method: 'notify',
        notifyType: 'error',
        message: `OpenCode could not record the answer to ${id}: ${errorMessage(error)}`,
      })
    })
  }

  async sendUiResponse(id, pending, response) {
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

  /** Release this transport's sockets; the facade reaps the shared child. */
  async dispose() {
    if (this.disposed && this.exited) return
    this.disposed = true
    this.eventsController?.abort()
    this.eventsController = undefined
    for (const pending of this.pendingUi.values()) clearTimeout(pending.timer)
    this.pendingUi.clear()
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

/**
 * Adapts {@link OpencodeV2Client} to the bridge's attachment surface.
 *
 * The client already emits normalized records; what remains is the Pi-shaped
 * transcript/stats/catalog calls and the prompt modes. `steer` maps to the 2.x
 * inbox `delivery` hint (the server queues it into a running execution instead
 * of starting a second turn), and `followUp` is the same queued delivery.
 */
class OpencodeV2Transport extends EventEmitter {
  /**
   * @param {object} options
   * @param {OpencodeV2Client} options.client started 2.x client
   */
  constructor(options) {
    super()
    this.client = options.client
    this.sessionId = options.client.sessionId
    this.autoApprove = options.client.autoApprove
    this.client.on('event', (record) => {
      this.emit('event', record)
      this.emit(record.type, record)
    })
    this.client.on('ui-request', (request) => this.emit('ui-request', request))
    this.client.on('ui-notification', (notice) => this.emit('ui-notification', notice))
    this.client.on('exit', (info) => this.emit('exit', info))
    this.client.on('spawn', (info) => this.emit('spawn', info))
  }

  get pid() {
    return this.client.pid
  }

  get running() {
    return this.client.running
  }

  get exited() {
    return this.client.exited
  }

  get stderr() {
    return this.client.stderr
  }

  get baseUrl() {
    return this.client.baseUrl
  }

  get child() {
    return this.client.child
  }

  start() {
    return this.client.start()
  }

  getState() {
    return this.client.getState()
  }

  snapshot() {
    return this.client.snapshot()
  }

  /** Normalized transcript for the live session (Pi-shaped). */
  async getMessages() {
    const entries = await this.client.getMessages(this.sessionId)
    return messagesFromV2Entries(entries)
  }

  /**
   * Post one user message.
   *
   * 2.x serves the same prompt route for every mode: `delivery: 'steer'` is what
   * a TUI sends while a turn is running, and the server queues it into the
   * current execution. The bridge's three modes therefore differ only in that
   * hint, exactly like 1.x's single `prompt_async` route.
   */
  async sendPrompt(message, kind) {
    if (typeof message !== 'string' || message.trim() === '') {
      throw Object.assign(new Error('message is required'), { status: 400 })
    }
    const delivery = kind === 'prompt' ? 'queue' : 'steer'
    await this.client.prompt(this.sessionId, message, { delivery })
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
    await this.client.interrupt(this.sessionId)
    return { aborted: true }
  }

  async setModel(provider, model) {
    if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') {
      throw Object.assign(new Error('provider and model are required'), { status: 400 })
    }
    await this.client.setModel(this.sessionId, { providerID: provider, id: model })
    return { provider, id: model }
  }

  /**
   * Fold the 2.x transcript into the host's stats shape.
   *
   * Token totals come from the session row (2.x accumulates them there and also
   * announces them per turn via `session.usage.updated`); the 2.x catalog does
   * expose a context window, but the *used* context is not reported anywhere the
   * Bridge can read cheaply, so `contextUsage` is omitted rather than invented.
   */
  async getSessionStats() {
    const [entries, session] = await Promise.all([
      this.client.getMessages(this.sessionId),
      this.client.getSession(this.sessionId).catch(() => undefined),
    ])
    let userMessages = 0
    let assistantMessages = 0
    let toolCalls = 0
    let tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
    let cost = 0
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (entry === null || typeof entry !== 'object') continue
      if (entry.type === 'user') userMessages += 1
      if (entry.type !== 'assistant') continue
      assistantMessages += 1
      const usage = usageFromV2Tokens(entry.tokens)
      if (usage !== undefined) {
        tokens.input += usage.input
        tokens.output += usage.output
        tokens.cacheRead += usage.cacheRead
        tokens.cacheWrite += usage.cacheWrite
        tokens.reasoning += usage.reasoning ?? 0
      }
      if (typeof entry.cost === 'number') cost += entry.cost
      toolCalls += (Array.isArray(entry.content) ? entry.content : []).filter((block) => block?.type === 'tool').length
    }
    if (typeof session?.tokens === 'object' && session.tokens !== null) {
      // The session row is the server's own running total and covers compaction
      // and other turns whose rows may have been pruned from the message page.
      const total = usageFromV2Tokens(session.tokens)
      if (total !== undefined && userMessages + assistantMessages > 0) {
        tokens = {
          input: total.input,
          output: total.output,
          cacheRead: total.cacheRead,
          cacheWrite: total.cacheWrite,
          reasoning: total.reasoning ?? tokens.reasoning,
        }
      }
      if (typeof session.cost === 'number') cost = session.cost
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
    return this.client.listModels()
  }

  respondUi(id, response) {
    return this.client.respondUi(id, response)
  }

  async dispose() {
    await this.client.dispose()
  }
}

/**
 * One live OpenCode session attachment, for either server generation.
 *
 * The npm package is the only thing that names a generation (`opencode-ai` 1.x
 * vs `@opencode/cli` 2.x); the bridge config names a binary. So the server is
 * started once, asked which API it speaks, and handed to the matching transport:
 * the 1.x logic below is unchanged, and a 2.x binary reaches the new transport
 * without the user having to declare which generation they installed.
 */
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
    this.transport = undefined
    this.generation = undefined
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

  /** Spawn the server, detect its generation, and attach the matching transport. */
  async start() {
    if (this.ready) return this
    await this.server.start()
    if (this.disposed) {
      await this.server.stop()
      return this
    }
    this.generation = await this.server.detectGeneration()
    if (this.generation === 'v2') {
      this.transport = new OpencodeV2Transport({
        client: new OpencodeV2Client({
          sessionId: this.sessionId,
          server: this.server,
          autoApprove: this.autoApprove,
          uiTimeoutMs: this.uiTimeoutMs,
        }),
      })
    } else {
      this.transport = new OpencodeV1Transport({
        server: this.server,
        sessionId: this.sessionId,
        autoApprove: this.autoApprove,
        uiTimeoutMs: this.uiTimeoutMs,
      })
    }
    this.transport.on('event', (record) => this.emit('event', record))
    // `exit` is forwarded by the transport, which settles the turn first; the
    // facade's own server listener only covers an exit before a transport exists.
    for (const type of ['ui-request', 'ui-notification', 'exit', 'session-name', 'session-status', 'session-error']) {
      this.transport.on(type, (payload) => this.emit(type, payload))
    }
    await this.transport.start()
    this.ready = true
    return this
  }

  getState() {
    return this.transport?.getState() ?? {
      sessionId: this.sessionId,
      isStreaming: false,
      model: null,
      pid: this.pid,
      autoApprove: this.autoApprove,
    }
  }

  snapshot() {
    return this.transport?.snapshot() ?? Promise.resolve(this.getState())
  }

  getMessages() {
    return this.requireTransport().getMessages()
  }

  getSessionStats() {
    return this.requireTransport().getSessionStats()
  }

  prompt(message) {
    return this.requireTransport().prompt(message)
  }

  steer(message) {
    return this.requireTransport().steer(message)
  }

  followUp(message) {
    return this.requireTransport().followUp(message)
  }

  abort() {
    return this.requireTransport().abort()
  }

  setModel(provider, model) {
    return this.requireTransport().setModel(provider, model)
  }

  getAvailableModels() {
    return this.requireTransport().getAvailableModels()
  }

  respondUi(id, response) {
    return this.requireTransport().respondUi(id, response)
  }

  /**
   * A call before `start()` is a programming error in the host, not an engine
   * failure: report it as a 409 like the other unsupported-operation paths.
   */
  requireTransport() {
    if (this.transport === undefined) {
      throw Object.assign(new Error('the OpenCode attachment has not been started'), { status: 409 })
    }
    return this.transport
  }

  /**
   * The server died. With a transport attached, that transport has already
   * settled the turn and forwarded its own `exit`; emitting here too would
   * deliver two exits to the host for one child.
   */
  handleExit(info) {
    if (this.transport !== undefined) return
    this.emit('exit', info)
  }

  /** Stop the server and release every socket. */
  async dispose() {
    if (this.disposed && this.exited) return
    this.disposed = true
    try {
      await this.transport?.dispose()
    } finally {
      // The facade owns the child: both transports share this one server, so
      // reaping it here is what guarantees no `opencode serve` outlives the
      // attachment.
      await this.server.stop()
    }
  }
}
