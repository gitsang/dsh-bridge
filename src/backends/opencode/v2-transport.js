/**
 * The OpenCode 2.x server transport.
 *
 * `@opencode/cli` (2.2.6 verified) answers the same `serve` command as 1.x but
 * speaks a different API: everything lives under `/api`, every request needs
 * HTTP Basic auth (`opencode:<OPENCODE_PASSWORD>`), a turn is posted as
 * `{text}` to `/api/session/{id}/prompt`, and the stream is a much richer event
 * family than 1.x's `message.part.*` records.
 *
 * What 2.x reports and 1.x does not:
 * - `session.execution.started|succeeded|failed|interrupted` bracket a whole
 *   turn (one prompt may run several steps), while `session.step.*` brackets one
 *   model call;
 * - reasoning/text/tool streams carry `assistantMessageID` + `ordinal` instead
 *   of part ids, so this transport rebuilds blocks from deltas;
 * - `session.tool.input.started|ended` announce a tool *before* it is called,
 *   `session.tool.called` is the first sighting with real arguments, and
 *   `success|failed` close it;
 * - token totals are announced by `session.usage.updated` and repeated on the
 *   session row.
 *
 * The class emits the bridge's already-normalized records (`agent-start`,
 * `message-update`, `tool-start`, …), exactly like the 1.x attachment, so the
 * host and the engine's `normalizeEvent` never learn that a second API exists.
 *
 * Verified live against 2.2.6: create → prompt `{text}` → streamed text →
 * `session.execution.succeeded`; the captured event sequence is what the fake
 * fixture replays.
 */
import { EventEmitter } from 'node:events'
import {
  bridgeToolArguments,
  bridgeToolName,
  summaryFromApiSession,
} from './session-store.js'
import { OpencodeServer, transportError } from './launcher.js'
import { permissionUiRequest } from './ui.js'

const DEFAULT_UI_TIMEOUT_MS = 120_000

const API = '/api'

/**
 * Event types that end a turn. `session.idle` is not in this set: it is a
 * session-scope notice that also fires between prompts and would settle a turn
 * the user just started.
 */
const TURN_END_EVENTS = new Map([
  ['session.execution.succeeded', { aborted: false }],
  ['session.execution.failed', { aborted: false }],
  // An interrupt is how both this transport's `abort()` and the TUI stop a turn.
  ['session.execution.interrupted', { aborted: true }],
])

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function numberOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Normalize 2.x `TokenUsage.Info` into the bridge's usage block. */
export function usageFromV2Tokens(tokens) {
  if (tokens === null || typeof tokens !== 'object') return undefined
  const cache = tokens.cache !== null && typeof tokens.cache === 'object' ? tokens.cache : {}
  return {
    input: numberOrZero(tokens.input),
    output: numberOrZero(tokens.output),
    cacheRead: numberOrZero(cache.read),
    cacheWrite: numberOrZero(cache.write),
    ...(typeof tokens.reasoning === 'number' ? { reasoning: numberOrZero(tokens.reasoning) } : {}),
  }
}

/** Join the `Tool.Content` blocks a 2.x tool result carries. */
function toolContentText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block !== null && typeof block === 'object' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/** A structured error (`{type,message}`) rendered as one line of text. */
function structuredErrorText(error) {
  if (error === null || typeof error !== 'object') return ''
  const type = typeof error.type === 'string' ? error.type : ''
  const message = typeof error.message === 'string' ? error.message : ''
  if (type === '' && message === '') return ''
  if (message === '') return type
  return type === '' ? message : `${type}: ${message}`
}

/**
 * Fold one `GET /api/session/{id}/message` entry into the bridge's block
 * vocabulary. The endpoint returns role-tagged records rather than the
 * `{info, parts}` pairs 1.x uses, and only user/assistant rows carry
 * conversation content: `idle`, `model-switched`, `system`, `synthetic` and
 * `compaction` rows are harness bookkeeping the browser does not render.
 */
export function messagesFromV2Entries(entries) {
  const messages = []
  const tools = []
  let model
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry === null || typeof entry !== 'object') continue
    const timestamp = typeof entry.time?.created === 'number' ? entry.time.created : undefined
    if (entry.type === 'user') {
      const text = typeof entry.text === 'string' ? entry.text : ''
      if (text === '') continue
      messages.push({ role: 'user', content: [{ type: 'text', text }], timestamp })
      continue
    }
    if (entry.type === 'model-switched') {
      if (typeof entry.model?.id === 'string' && typeof entry.model?.providerID === 'string') {
        model = { provider: entry.model.providerID, id: entry.model.id }
      }
      continue
    }
    if (entry.type !== 'assistant') continue
    const blocks = []
    const results = []
    const usage = usageFromV2Tokens(entry.tokens) ?? undefined
    if (typeof entry.model?.providerID === 'string' && typeof entry.model?.id === 'string') {
      model = { provider: entry.model.providerID, id: entry.model.id }
    }
    for (const block of Array.isArray(entry.content) ? entry.content : []) {
      if (block === null || typeof block !== 'object') continue
      if (block.type === 'text') {
        if (typeof block.text !== 'string' || block.text === '') continue
        blocks.push({ type: 'text', text: block.text })
        continue
      }
      if (block.type === 'reasoning') {
        if (typeof block.text !== 'string' || block.text === '') continue
        blocks.push({ type: 'thinking', thinking: block.text })
        continue
      }
      if (block.type !== 'tool') continue
      const callId = typeof block.id === 'string' && block.id !== '' ? block.id : undefined
      if (callId === undefined) continue
      const name = bridgeToolName(block.name)
      const state = block.state !== null && typeof block.state === 'object' ? block.state : {}
      const args = bridgeToolArguments(state.input)
      blocks.push({ type: 'toolCall', id: callId, name, arguments: args })
      const failed = state.status === 'error'
      tools.push({ id: callId, name, arguments: args, status: failed ? 'error' : state.status === 'completed' ? 'completed' : 'running' })
      results.push({
        role: 'toolResult',
        toolCallId: callId,
        content: [{ type: 'text', text: failed ? structuredErrorText(state.error) : toolContentText(state.content) }],
        isError: failed,
        timestamp,
      })
    }
    if (blocks.length === 0 && results.length === 0) continue
    messages.push({
      role: 'assistant',
      content: blocks,
      timestamp,
      ...(typeof entry.model?.providerID === 'string' ? { provider: entry.model.providerID } : {}),
      ...(typeof entry.model?.id === 'string' ? { model: entry.model.id } : {}),
      ...(usage === undefined ? {} : { usage }),
      ...(typeof entry.time?.completed === 'number' ? { stopReason: 'stop' } : {}),
      ...(typeof entry.error?.type === 'string' ? { errorMessage: entry.error.type } : {}),
    }, ...results)
  }
  return { messages, tools, model }
}

/** Shape the 2.x `/api/model` catalog into the bridge's model list. */
export function modelsFromV2Catalog(payload) {
  const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : []
  const models = []
  for (const model of list) {
    if (model === null || typeof model !== 'object') continue
    const id = typeof model.modelID === 'string' && model.modelID !== ''
      ? model.modelID
      : typeof model.id === 'string' ? model.id : undefined
    if (id === undefined || id === '') continue
    if (model.enabled === false) continue
    const contextWindow = typeof model.limit?.context === 'number' ? model.limit.context : undefined
    models.push({
      id,
      provider: typeof model.providerID === 'string' ? model.providerID : '',
      name: typeof model.name === 'string' && model.name !== '' ? model.name : id,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      // 2.x advertises tool/text capability only; a reasoning-capable model is
      // one that offers reasoning variants or a reasoning field mapping.
      reasoning: Array.isArray(model.variants)
        ? model.variants.some((variant) => typeof variant?.id === 'string' && variant.id !== 'none')
        : false,
    })
  }
  return models
}

/**
 * One live OpenCode 2.x conversation over one server child.
 *
 * Owns the HTTP conversation and the SSE subscriber. Requests are bounded and
 * tracked by the server child, so `dispose()` aborts anything still in flight and
 * the event loop is left idle.
 */
export class OpencodeV2Client extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.sessionId OpenCode session id (`ses_…`)
   * @param {OpencodeServer} [options.server] already-started server to reuse
   * @param {string} [options.cwd] directory the server binds
   * @param {NodeJS.ProcessEnv} [options.env]
   * @param {{command: string, prefixArgs?: string[]}} [options.resolved]
   * @param {boolean} [options.autoApprove] answer permission requests instead of forwarding them
   * @param {number} [options.readyTimeoutMs]
   * @param {number} [options.requestTimeoutMs]
   * @param {number} [options.uiTimeoutMs]
   */
  constructor(options) {
    super()
    this.sessionId = options.sessionId
    this.autoApprove = options.autoApprove !== false
    this.uiTimeoutMs = options.uiTimeoutMs ?? DEFAULT_UI_TIMEOUT_MS
    // The attachment facade spawns one server and picks a transport per
    // generation, so a client built over an injectable server is what keeps a
    // 2.x conversation from paying for a second `serve` start.
    this.ownsServer = options.server === undefined
    this.server = options.server ?? new OpencodeServer({
      cwd: options.cwd,
      env: options.env,
      resolved: options.resolved,
      readyTimeoutMs: options.readyTimeoutMs,
      requestTimeoutMs: options.requestTimeoutMs,
    })
    this.server.on('spawn', (info) => this.emit('spawn', info))
    this.server.on('exit', (info) => this.handleExit(info))

    // Turn state. `streaming` spans `execution.started` … `execution.*`; the host
    // reads it through `getState().isStreaming`.
    this.streaming = false
    this.streamingEmitted = false
    this.awaitingTurn = false
    this.aborted = false
    this.model = undefined
    this.lastEventAt = undefined
    this.lastEventType = undefined
    this.sessionName = undefined
    this.tokens = undefined
    this.cost = 0

    // Per-message block accumulation, keyed by `assistantMessageID`. Blocks are
    // ordered as they arrive: the ordinal only distinguishes same-kind streams.
    this.messages = new Map()
    this.order = []
    this.startedMessages = new Set()
    this.endedMessages = new Set()
    this.tools = new Map()
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

  /** Start the server when owned, attach the event stream, reconcile state. */
  async start() {
    if (this.ready) return this
    if (this.ownsServer) await this.server.start()
    const generation = await this.server.detectGeneration()
    if (generation !== 'v2') {
      if (this.ownsServer) await this.server.stop()
      throw transportError(`the configured OpenCode binary speaks the ${generation} server API, not 2.x`)
    }
    if (this.disposed) {
      if (this.ownsServer) await this.server.stop()
      return this
    }
    this.ready = true
    this.openEventStream()
    await this.reconcile()
    return this
  }

  /**
   * Subscribe to `/api/event` before anything else happens: the stream carries
   * no replay, so a prompt posted before the subscription would lose its turn.
   */
  openEventStream() {
    const controller = new AbortController()
    this.eventsController = controller
    void this.pumpEvents(controller).catch(() => {
      // The stream ending is expected on dispose; anything else surfaces through
      // the request paths, not here.
    })
  }

  async pumpEvents(controller) {
    const response = await this.server.streamRequest(`${API}/event`, controller.signal)
    const decoder = new TextDecoder()
    const reader = response.body.getReader()
    let buffer = ''
    let opened = false
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
          opened = true
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
    if (!opened && !controller.signal.aborted) {
      // A 200 with an immediately empty body would otherwise look like a quiet
      // server and hang the first prompt; surface it instead.
      throw transportError('the OpenCode 2.x event stream closed before sending anything')
    }
  }

  handleFrame(frame) {
    // 2.x frames are `data: {json}` with an optional `event:` name line; the
    // payload always carries `type`, so the name line is not needed.
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data:')) continue
      const raw = line.slice(5).trim()
      if (raw === '') continue
      let record
      try {
        record = JSON.parse(raw)
      } catch {
        continue
      }
      if (record === null || typeof record !== 'object') continue
      this.handleEvent(record)
    }
  }

  /** Translate one `{id,type,data}` SSE record into bridge events. */
  handleEvent(record) {
    const type = typeof record.type === 'string' ? record.type : ''
    const data = record.data !== null && typeof record.data === 'object' ? record.data : {}
    if (type === 'server.connected') {
      this.lastEventAt = Date.now()
      this.lastEventType = type
      return
    }
    // Most v2 events name their session in `data.sessionID`; a few top-level
    // notices carry none. Anything scoped to another session must not leak into
    // this transcript, and shared servers do run several sessions.
    const sessionId = typeof data.sessionID === 'string' ? data.sessionID : undefined
    if (sessionId !== undefined && sessionId !== this.sessionId) return
    if (type === 'permission.asked') {
      void this.handlePermissionRequest(data)
      return
    }
    if (sessionId === undefined) return
    if (type !== 'session.text.delta' && type !== 'session.reasoning.delta') this.flushPendingUserMessage()
    this.lastEventAt = Date.now()
    this.lastEventType = type
    const turnEnd = TURN_END_EVENTS.get(type)
    if (turnEnd !== undefined) {
      this.aborted = turnEnd.aborted
      // A failed execution carries the only structured reason the UI can show;
      // settling alone would look like a silent, successful stop.
      if (type === 'session.execution.failed') {
        const detail = structuredErrorText(data.error)
        if (detail !== '') this.notifyError(`OpenCode: ${detail}`)
      }
      this.settleTurn(false)
      return
    }
    switch (type) {
      case 'session.execution.started':
        this.beginTurn()
        return
      case 'session.step.started':
        this.handleStepStarted(data)
        return
      case 'session.step.streamed':
        return
      case 'session.step.ended':
        this.handleStepEnded(data)
        return
      case 'session.step.failed':
        this.handleStepFailed(data)
        return
      case 'session.text.started':
      case 'session.text.delta':
      case 'session.text.ended':
        this.handleStreamEvent('text', type, data)
        return
      case 'session.reasoning.started':
      case 'session.reasoning.delta':
      case 'session.reasoning.ended':
        this.handleStreamEvent('reasoning', type, data)
        return
      case 'session.tool.input.started':
        this.handleToolStarted(data)
        return
      case 'session.tool.input.ended':
        this.handleToolInputEnded(data)
        return
      case 'session.tool.called':
        this.handleToolCalled(data)
        return
      case 'session.tool.progress':
        this.handleToolProgress(data)
        return
      case 'session.tool.success':
      case 'session.tool.failed':
        this.handleToolFinished(type, data)
        return
      case 'session.usage.updated':
        this.tokens = usageFromV2Tokens(data.tokens) ?? this.tokens
        if (typeof data.cost === 'number') this.cost = data.cost
        return
      case 'session.renamed':
      case 'session.created':
        this.handleSessionName(data.title)
        return
      case 'session.model.selected':
        if (typeof data.model?.id === 'string') {
          this.model = { provider: data.model.providerID, id: data.model.id }
        }
        return
      case 'session.retry.scheduled':
        this.emitNative({ type: 'session-status', status: 'retry', attempt: data.attempt, message: structuredErrorText(data.error) })
        return
      case 'session.synthetic':
        this.flushPendingUserMessage()
        return
      // Shell/pty/project/config/instruction notices share the server with the
      // conversation but say nothing about this turn.
      default:
        return
    }
  }

  handleSessionName(title) {
    const name = sessionName(title)
    if (name === undefined || name === this.sessionName) return
    this.sessionName = name
    this.emitNative({ type: 'session-name', name })
  }

  beginTurn() {
    this.flushPendingUserMessage()
    this.awaitingTurn = true
    this.aborted = false
    if (this.streaming && this.streamingEmitted) return
    this.streaming = true
    this.emitBusy()
  }

  handleStepStarted(data) {
    const messageId = typeof data.assistantMessageID === 'string' ? data.assistantMessageID : undefined
    if (messageId === undefined) return
    if (typeof data.model?.id === 'string') {
      this.model = { provider: data.model.providerID, id: data.model.id }
    }
    this.messageFor(messageId)
    if (!this.startedMessages.has(messageId)) {
      this.startedMessages.add(messageId)
      this.emitNative({ type: 'message-start', message: this.buildMessage(messageId) })
    }
  }

  /** `step.ended` closes one assistant message; a turn may have several. */
  handleStepEnded(data) {
    const messageId = typeof data.assistantMessageID === 'string' ? data.assistantMessageID : undefined
    if (messageId === undefined) return
    const entry = this.messageFor(messageId)
    const usage = usageFromV2Tokens(data.tokens)
    if (usage !== undefined) entry.usage = usage
    if (typeof data.finish === 'string') entry.finish = data.finish
    if (typeof data.cost === 'number') entry.cost = data.cost
    entry.completed = true
    if (!this.startedMessages.has(messageId)) {
      this.startedMessages.add(messageId)
      this.emitNative({ type: 'message-start', message: this.buildMessage(messageId) })
    }
    this.endMessage(messageId)
  }

  handleStepFailed(data) {
    const messageId = typeof data.assistantMessageID === 'string' ? data.assistantMessageID : undefined
    if (messageId === undefined) return
    const entry = this.messageFor(messageId)
    const text = structuredErrorText(data.error)
    if (text !== '') entry.errorMessage = text
    entry.completed = true
    if (!this.startedMessages.has(messageId)) {
      this.startedMessages.add(messageId)
      this.emitNative({ type: 'message-start', message: this.buildMessage(messageId) })
    }
    this.endMessage(messageId)
    if (text !== '') this.notifyError(text)
  }

  /**
   * Accumulate one text/reasoning stream.
   *
   * `started` opens a block keyed by the message's next block position, deltas
   * append to it, and `ended` carries the full text: replacing with it keeps the
   * renderer correct if a delta was dropped by the transport (which SSE can do).
   */
  handleStreamEvent(kind, type, data) {
    const messageId = typeof data.assistantMessageID === 'string' ? data.assistantMessageID : undefined
    if (messageId === undefined) return
    const ordinal = typeof data.ordinal === 'number' ? data.ordinal : 0
    const entry = this.messageFor(messageId)
    const key = `${kind}:${ordinal}`
    let block = entry.streams.get(key)
    if (block === undefined) {
      block = { type: kind, text: '', messageId }
      entry.streams.set(key, block)
      entry.blocks.push(block)
    }
    if (type === 'session.text.delta' || type === 'session.reasoning.delta') {
      if (typeof data.delta === 'string') block.text += data.delta
    } else if (type === 'session.text.ended' || type === 'session.reasoning.ended') {
      if (typeof data.text === 'string') block.text = data.text
    }
    if (type === 'session.text.started' || type === 'session.reasoning.started') {
      if (block.text === '' && data.delta === undefined) return
    }
    this.emitMessageUpdate(messageId)
  }

  /** `tool.input.started` is the first sighting: it names the call and its tool. */
  handleToolStarted(data) {
    const callId = typeof data.id === 'string' && data.id !== '' ? data.id : undefined
    if (callId === undefined) return
    const name = bridgeToolName(data.name)
    if (this.tools.has(callId)) return
    this.tools.set(callId, { id: callId, name, input: undefined, output: '', ended: false })
    this.placeTool(data.assistantMessageID, callId)
    this.emitNative({ type: 'tool-start', toolCallId: callId, toolName: name, args: {} })
  }

  /**
   * Record a tool's position in its assistant message.
   *
   * A turn interleaves text and tool calls (a step calls a tool, the next step
   * answers with text), and the rendered message must keep that order: appending
   * every tool after every text block would put a tool row below the sentence it
   * produced. A tool that runs before any `input.started` still gets a slot.
   */
  placeTool(messageId, callId) {
    if (typeof messageId !== 'string') return
    const entry = this.messageFor(messageId)
    if (entry.blocks.some((block) => block.type === 'tool' && block.id === callId)) return
    entry.blocks.push({ type: 'tool', id: callId })
  }

  /**
   * The argument JSON arrives as one string; a streamed `input.delta` variant is
   * answered by `tool.called` with the parsed object, so a partial parse is only
   * a best-effort update here.
   */
  handleToolInputEnded(data) {
    const callId = typeof data.id === 'string' ? data.id : undefined
    if (callId === undefined) return
    const entry = this.tools.get(callId)
    if (entry === undefined) return
    const text = typeof data.text === 'string' ? data.text : ''
    if (text === '') return
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      return
    }
    if (parsed === null || typeof parsed !== 'object') return
    entry.input = bridgeToolArguments(parsed)
  }

  /** `tool.called` carries the authoritative (parsed) arguments. */
  handleToolCalled(data) {
    const callId = typeof data.id === 'string' && data.id !== '' ? data.id : undefined
    if (callId === undefined) return
    const args = bridgeToolArguments(data.input)
    let entry = this.tools.get(callId)
    if (entry === undefined) {
      // A tool executed without a preceding `input.started` (a replay or a
      // plugin-run tool) still needs its row.
      const name = bridgeToolName(data.name)
      entry = { id: callId, name, input: undefined, output: '', ended: false }
      this.tools.set(callId, entry)
      this.emitNative({ type: 'tool-start', toolCallId: callId, toolName: name, args })
    }
    entry.input = args
    this.placeTool(data.assistantMessageID, callId)
    if (typeof data.assistantMessageID === 'string') this.emitMessageUpdate(data.assistantMessageID)
  }

  handleToolProgress(data) {
    const callId = typeof data.id === 'string' ? data.id : undefined
    if (callId === undefined) return
    const entry = this.tools.get(callId)
    if (entry === undefined) return
    const metadata = data.metadata !== null && typeof data.metadata === 'object' ? data.metadata : {}
    const partial = typeof metadata.output === 'string' && metadata.output !== ''
      ? metadata.output
      : typeof metadata.title === 'string' ? metadata.title : ''
    if (partial === '' || partial === entry.output) return
    entry.output = partial
    this.emitNative({ type: 'tool-update', toolCallId: callId, partialResult: partial })
  }

  handleToolFinished(type, data) {
    const callId = typeof data.id === 'string' ? data.id : undefined
    if (callId === undefined) return
    let entry = this.tools.get(callId)
    if (entry === undefined) {
      entry = { id: callId, name: bridgeToolName(data.name), input: undefined, output: '', ended: false }
      this.tools.set(callId, entry)
      this.placeTool(data.assistantMessageID, callId)
      this.emitNative({ type: 'tool-start', toolCallId: callId, toolName: entry.name, args: {} })
    }
    if (entry.ended) return
    entry.ended = true
    const isError = type === 'session.tool.failed'
    const content = toolContentText(data.content)
    this.emitNative({
      type: 'tool-end',
      toolCallId: callId,
      result: isError ? (content === '' ? structuredErrorText(data.error) : content) : content,
      isError,
    })
    const messageId = typeof data.assistantMessageID === 'string' ? data.assistantMessageID : undefined
    if (messageId !== undefined) this.emitMessageUpdate(messageId)
  }

  /** Lazily create the accumulation entry for one assistant message. */
  messageFor(messageId) {
    let entry = this.messages.get(messageId)
    if (entry !== undefined) return entry
    entry = { id: messageId, blocks: [], streams: new Map(), usage: undefined, finish: undefined, cost: 0, completed: false, errorMessage: undefined }
    this.messages.set(messageId, entry)
    this.order.push(messageId)
    return entry
  }

  /** Rebuild one assistant message from its accumulated blocks and tools. */
  buildMessage(messageId) {
    const entry = this.messages.get(messageId)
    const content = []
    let usage
    if (entry !== undefined) {
      for (const block of entry.blocks) {
        if (block.type === 'tool') {
          const tool = this.tools.get(block.id)
          if (tool === undefined) continue
          content.push({ type: 'toolCall', id: tool.id, name: tool.name, arguments: tool.input ?? {} })
          continue
        }
        if (block.text === '') continue
        if (block.type === 'text') content.push({ type: 'text', text: block.text })
        else content.push({ type: 'thinking', thinking: block.text })
      }
      usage = entry.usage
    }
    return {
      role: 'assistant',
      content,
      ...(this.model === undefined ? {} : { provider: this.model.provider, model: this.model.id }),
      ...(usage === undefined ? {} : { usage }),
      ...(entry?.completed === true ? { stopReason: entry.finish ?? 'stop' } : {}),
      ...(entry?.errorMessage === undefined ? {} : { errorMessage: entry.errorMessage }),
    }
  }

  emitMessageUpdate(messageId) {
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

  /** Emit the submitted user echo once the turn moves past the inbox handoff. */
  flushPendingUserMessage() {
    const pending = this.pendingUserMessage
    if (pending === undefined) return
    this.pendingUserMessage = undefined
    this.emitNative({
      type: 'message-end',
      message: { role: 'user', content: [{ type: 'text', text: pending.text }], timestamp: pending.timestamp },
    })
  }

  /**
   * Announce the start of a turn once.
   *
   * `defer` is used when the busy state is discovered during attach
   * reconciliation, where the host has not subscribed to this transport's events
   * yet.
   */
  emitBusy(defer = false) {
    if (this.streamingEmitted) return
    this.streamingEmitted = true
    const emit = () => {
      if (this.disposed || !this.streaming) return
      this.emitNative({ type: 'session-status', status: 'busy' })
    }
    if (defer) setImmediate(emit)
    else emit()
  }

  /**
   * End the current turn exactly once.
   *
   * The host keys turn state on the `agent-start` / `agent-settled` mapping, so a
   * missing settle would leave the session stuck "running": a child exit always
   * settles a turn this transport began.
   */
  settleTurn(fromExit) {
    this.flushPendingUserMessage()
    if (!this.streaming && !this.awaitingTurn) return
    for (const messageId of this.order) {
      if (this.startedMessages.has(messageId) && !this.endedMessages.has(messageId)) this.endMessage(messageId)
    }
    this.streaming = false
    this.streamingEmitted = false
    this.awaitingTurn = false
    const aborted = this.aborted
    this.emitNative({ type: 'session-status', status: 'idle', aborted, ...(fromExit ? { exited: true } : {}) })
    this.aborted = false
  }

  emitNative(record) {
    this.lastEventAt = Date.now()
    this.lastEventType = record.type
    this.emit('event', record)
    this.emit(record.type, record)
  }

  notifyError(message) {
    this.emit('ui-notification', {
      type: 'extension_ui_request',
      id: `error-${Date.now().toString(36)}`,
      method: 'notify',
      notifyType: 'error',
      message,
    })
  }

  /** Reconcile cached state with the server (session row + active executions). */
  async reconcile() {
    const [info, active] = await Promise.all([
      this.request(`${API}/session/${encodeURIComponent(this.sessionId)}`).catch(() => undefined),
      this.request(`${API}/session/active`).catch(() => undefined),
    ])
    const session = info?.data
    if (session !== null && typeof session === 'object') {
      if (typeof session.model?.id === 'string') {
        this.model = { provider: session.model.providerID, id: session.model.id }
      }
      this.handleSessionName(session.title)
      this.tokens = usageFromV2Tokens(session.tokens) ?? this.tokens
      if (typeof session.cost === 'number') this.cost = session.cost
    }
    // `/api/session/active` lists the executions this server process currently
    // owns, which is the only way to see a turn that began before we attached.
    const entries = active?.data !== null && typeof active?.data === 'object' ? active.data : undefined
    if (entries !== undefined && entries[this.sessionId] !== undefined) {
      this.streaming = true
      this.awaitingTurn = true
      this.emitBusy(true)
    }
    return this.stateView()
  }

  async request(pathname, options = {}) {
    return this.server.request(pathname, options)
  }

  stateView() {
    return {
      sessionId: this.sessionId,
      isStreaming: this.streaming,
      model: this.model ?? null,
      pid: this.pid,
      lastEventAt: this.lastEventAt,
      lastEventType: this.lastEventType,
      sessionName: this.sessionName,
      autoApprove: this.autoApprove,
    }
  }

  getState() {
    return this.stateView()
  }

  async snapshot() {
    await this.reconcile()
    return this.stateView()
  }

  /** `GET /api/session` with 2.x cursor pagination. */
  async listSessions(options = {}) {
    const search = new URLSearchParams()
    if (typeof options.limit === 'number') search.set('limit', String(options.limit))
    if (typeof options.cursor === 'string' && options.cursor !== '') search.set('cursor', options.cursor)
    const query = search.toString()
    const payload = await this.request(`${API}/session${query === '' ? '' : `?${query}`}`)
    return {
      sessions: Array.isArray(payload?.data) ? payload.data : [],
      cursor: payload?.cursor ?? { previous: null, next: null },
    }
  }

  async createSession(options = {}) {
    const body = {}
    if (typeof options.title === 'string' && options.title !== '') body.title = options.title
    if (typeof options.agent === 'string' && options.agent !== '') body.agent = options.agent
    if (options.model !== undefined && options.model !== null) {
      body.model = { id: options.model.id, providerID: options.model.provider }
    }
    // The workspace is bound from the server's own cwd; `location` is accepted
    // but only an override, so it is omitted unless a caller asks for it.
    const payload = await this.request(`${API}/session`, { method: 'POST', body })
    const info = payload?.data
    if (info === null || typeof info !== 'object' || typeof info.id !== 'string') {
      throw transportError('OpenCode returned no session id')
    }
    return info
  }

  async getSession(sessionId = this.sessionId) {
    const payload = await this.request(`${API}/session/${encodeURIComponent(sessionId)}`)
    return payload?.data
  }

  /** `GET /api/session/{id}/message`, following the next-page cursor. */
  async getMessages(sessionId = this.sessionId, options = {}) {
    const list = []
    let cursor = typeof options.cursor === 'string' ? options.cursor : undefined
    const maxPages = Math.max(1, options.maxPages ?? 50)
    for (let page = 0; page < maxPages; page += 1) {
      const search = new URLSearchParams()
      if (cursor !== undefined && cursor !== '') search.set('cursor', cursor)
      const query = search.toString()
      const payload = await this.request(
        `${API}/session/${encodeURIComponent(sessionId)}/message${query === '' ? '' : `?${query}`}`,
      )
      if (Array.isArray(payload?.data)) list.push(...payload.data)
      const next = payload?.cursor?.next
      if (typeof next !== 'string' || next === '') break
      cursor = next
    }
    return list
  }

  /**
   * Post one user message. 2.x takes `{text}` (the 1.x `{parts}` body is
   * rejected with `Missing key at ["text"]`) and runs the turn asynchronously.
   */
  async prompt(sessionId, text, options = {}) {
    if (typeof text !== 'string' || text.trim() === '') {
      throw Object.assign(new Error('message is required'), { status: 400 })
    }
    const body = { text }
    if (typeof options.delivery === 'string') body.delivery = options.delivery
    // The echo is staged before the request: SSE events for this turn can reach
    // the stream before the response does, and a pending echo set after the
    // await would be flushed by the wrong event.
    this.pendingUserMessage = { text, timestamp: Date.now() }
    this.awaitingTurn = true
    this.aborted = false
    try {
      const payload = await this.request(`${API}/session/${encodeURIComponent(sessionId)}/prompt`, {
        method: 'POST',
        body,
      })
      return payload?.data
    } catch (error) {
      // The turn never started, so no execution event will arrive to clear it.
      this.awaitingTurn = false
      this.pendingUserMessage = undefined
      throw error
    }
  }

  async interrupt(sessionId = this.sessionId) {
    this.aborted = true
    return this.request(`${API}/session/${encodeURIComponent(sessionId)}/interrupt`, { method: 'POST' })
  }

  /** Switch the session model. The field is `model.id`, not `model.modelID`. */
  async setModel(sessionId, selection) {
    if (typeof selection?.id !== 'string' || selection.id === ''
      || typeof selection?.providerID !== 'string' || selection.providerID === '') {
      throw Object.assign(new Error('provider and model are required'), { status: 400 })
    }
    await this.request(`${API}/session/${encodeURIComponent(sessionId)}/model`, {
      method: 'POST',
      body: { model: { id: selection.id, providerID: selection.providerID } },
    })
    this.model = { provider: selection.providerID, id: selection.id }
    return this.model
  }

  async listModels() {
    const payload = await this.request(`${API}/model`)
    return modelsFromV2Catalog(payload)
  }

  async listProviders() {
    const payload = await this.request(`${API}/provider`)
    return Array.isArray(payload?.data) ? payload.data : []
  }

  /** Answer a permission request. `decision` is `once|always|reject`. */
  async replyPermission(sessionId, requestId, decision, message) {
    await this.request(
      `${API}/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`,
      { method: 'POST', body: { decision, ...(message === undefined ? {} : { message }) } },
    )
  }

  async listPermissions(sessionId = this.sessionId) {
    const payload = await this.request(`${API}/session/${encodeURIComponent(sessionId)}/permission`)
    return Array.isArray(payload?.data) ? payload.data : []
  }

  /** Auto-answer, or forward to the browser when approval is off. */
  async handlePermissionRequest(request) {
    const id = typeof request?.id === 'string' ? request.id : undefined
    if (id === undefined) return
    if (this.autoApprove) {
      try {
        await this.replyPermission(this.sessionId, id, 'once')
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
    this.forwardUiRequest(permissionUiRequest(request), { kind: 'permission' })
  }

  /**
   * Forward one native prompt to the browser and remember it for `respondUi`.
   * The timer is the deadlock guard: an unattended dialog is auto-denied rather
   * than leaving the session busy forever.
   */
  forwardUiRequest(uiRequest, context) {
    const timer = setTimeout(() => {
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
   * Answer one forwarded dialog. Validation is synchronous (the host calls this
   * without awaiting) and the reply itself is a tracked async request.
   */
  respondUi(id, response = {}) {
    const pending = this.pendingUi.get(id)
    if (pending === undefined) throw Object.assign(new Error('unknown extension UI request'), { status: 409 })
    this.pendingUi.delete(id)
    clearTimeout(pending.timer)
    const decision = response.cancelled === true ? 'reject' : 'once'
    return this.replyPermission(this.sessionId, id, decision).catch((error) => {
      this.emit('ui-notification', {
        type: 'extension_ui_request',
        id: `ui-reply-error-${id}`,
        method: 'notify',
        notifyType: 'error',
        message: `OpenCode could not record the answer to ${id}: ${errorMessage(error)}`,
      })
    })
  }

  handleExit(info) {
    this.settleTurn(true)
    for (const pending of this.pendingUi.values()) clearTimeout(pending.timer)
    this.pendingUi.clear()
    this.eventsController?.abort()
    this.eventsController = undefined
    this.emit('exit', info)
  }

  /** Release this client's sockets; only an owned server child is reaped. */
  async dispose() {
    if (this.disposed && this.exited) return
    this.disposed = true
    this.eventsController?.abort()
    this.eventsController = undefined
    for (const pending of this.pendingUi.values()) clearTimeout(pending.timer)
    this.pendingUi.clear()
    if (this.ownsServer) await this.server.stop()
  }
}

/** OpenCode seeds every session with a timestamp placeholder title. */
function sessionName(title) {
  if (typeof title !== 'string' || title.trim() === '') return undefined
  if (/^New session\s*-\s*\d{4}-\d{2}-\d{2}T/.test(title)) return undefined
  return title
}

/**
 * Shape a 2.x session row into the same summary the session store returns, so a
 * session created or listed through the API is addressed by the sidebar exactly
 * like one read from SQLite.
 */
export function summaryFromV2Session(info) {
  if (info === null || typeof info !== 'object' || typeof info.id !== 'string') {
    throw new Error('OpenCode returned an invalid session record')
  }
  // `location.directory` is where 2.x puts the workspace; the field moved out of
  // the session row itself and the summary shape must not depend on the age.
  const directory = typeof info.location?.directory === 'string' && info.location.directory !== ''
    ? info.location.directory
    : typeof info.directory === 'string' && info.directory !== '' ? info.directory : undefined
  return summaryFromApiSession({
    ...info,
    ...(directory === undefined ? {} : { directory }),
  })
}
