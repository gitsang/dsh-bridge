/**
 * One live attachment to a Session on a remote DeepSeek Harness Web instance.
 *
 * There is no child process here: the remote DSH already owns the Agent, the
 * Session log, and the turn loop. The bridge's job is to be a *client* of that
 * session — admit prompts through `session/prompt`, observe the durable log, and
 * translate new events into the same neutral vocabulary the local engines emit.
 *
 * Observation is poll-based on purpose. The durable log is the authority (the
 * same log the remote UI renders), a projections read is ~4 KB and ~20 ms, and
 * a poll needs no WebSocket, no reconnect policy, and no reimplementation of
 * dsh's remote stream framing. `session/list` is deliberately never polled: it
 * carries every row and is orders of magnitude larger.
 *
 * The class emits the remote log's own event records on `event`, exactly like
 * the CLI attachments do, so the engine's `normalizeEvent` owns the translation
 * and the host/browser never learn which engine is behind a bridge.
 */
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { DshAuthError, DshHttpError, DshRpcError, createDshClient, normalizeBaseUrl } from './http.js'
import {
  eventsFromPage,
  modelFromValues,
  modelsFromCatalog,
  statsFromProjections,
  turnEndFromEvent,
} from './session-store.js'

/** Liveness cadence: fast enough to feel live, cheap enough to leave running. */
const POLL_MS = 900
/** One history page's message budget; the browser's own follow window is 50. */
const PAGE_MESSAGES = 120
/** Bound one catch-up read so a long backlog cannot stall the poll forever. */
const MAX_CATCH_UP_PAGES = 40
/** Stop polling for a turn that never closes instead of hammering the remote. */
const MAX_TURN_MS = 30 * 60 * 1000

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Explain a remote RPC failure the way a user of this bridge can act on it.
 *
 * The remote reports its own error codes; two of them are meanings rather than
 * failures, and the rest only need the endpoint name attached.
 */
function describeRpcError(error, action) {
  if (error instanceof DshRpcError) {
    if (error.code === 'session/not-found') {
      return Object.assign(new Error(`The remote DSH no longer has this session (${action}).`), { status: 404 })
    }
    if (error.code === 'session/writer-held' || error.code === 'session/agent-busy') {
      return Object.assign(
        new Error('The remote DSH session is owned by another writer, for example an open tab on that instance. Close it there and retry.'),
        { status: 409 },
      )
    }
    if (error.code === 'session/model-unavailable') {
      return Object.assign(new Error('The remote DSH does not route that model.'), { status: 409 })
    }
    return Object.assign(new Error(`The remote DSH refused ${action}: ${error.message}`), { status: 502 })
  }
  if (error instanceof DshAuthError || error instanceof DshHttpError) return error
  return Object.assign(new Error(`The remote DSH ${action} failed: ${messageOf(error)}`), { status: 502 })
}

/** Build the shared client from one bridge's engine config. */
export function clientFromConfig(config, { logger, timeoutMs } = {}) {
  return createDshClient({
    baseUrl: config?.baseUrl ?? '',
    token: config?.token ?? null,
    allowInsecureTls: config?.allowInsecureTls === true,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    logger,
  })
}

/** The projections values block, or `{}` when the remote omits it. */
export function valuesOf(projections) {
  return projections !== null && typeof projections === 'object' && projections.values !== null && typeof projections.values === 'object'
    ? projections.values
    : {}
}

export class DshAttachment extends EventEmitter {
  constructor({ session, config, env, logger }) {
    super()
    this.session = session
    this.sessionId = session?.nativeKey ?? session?.key
    if (typeof this.sessionId !== 'string' || this.sessionId === '') {
      throw new Error('dsh attachment requires a remote session id')
    }
    this.config = config ?? {}
    this.env = env ?? process.env
    this.logger = logger
    this.client = clientFromConfig(this.config, { logger })
    this.baseUrl = normalizeBaseUrl(this.config.baseUrl ?? '').href
    this.pid = null
    this.running = false
    /** The host reads `stderr` when a start fails; there is no child stderr. */
    this.stderr = ''
    this.cursor = -1
    this.turn = undefined
    this.awaitingTurn = false
    this.aborted = false
    this.lastEvent = undefined
    this.lastEventAt = undefined
    this.sequence = 0
    this.timer = null
    this.ticking = false
    this.stopped = false
    this.turnStartedAt = undefined
    this.lastError = null
    this.modelOverride = undefined
    /**
     * Tool calls observed since this attachment started.
     *
     * dsh's projections report turns, steps, and tokens host-side but never a
     * tool-call total, and the remote UI derives it from the log too. Counting
     * what passes through this attachment is cheap and honest; a session-wide
     * total would need a full log read on every attach.
     */
    this.toolCalls = 0
  }

  /**
   * Authenticate, then pin the cursor at the log's current head.
   *
   * Starting is not "the turn begins": history up to the head was already read
   * by `readSession`, so emitting it again would duplicate the transcript.
   */
  async start() {
    const startedAt = Date.now()
    try {
      await this.client.connect()
      const projections = await this.client.call('session/projections', { request: { sessionId: this.sessionId } })
      this.cursor = typeof projections?.asOfSeq === 'number' ? projections.asOfSeq : -1
      this.values = valuesOf(projections)
      this.lastSyncAt = startedAt
      this.running = true
      this.startPolling()
      return this
    } catch (error) {
      this.stderr = messageOf(error)
      this.stopped = true
      throw describeRpcError(error, 'authenticate')
    }
  }

  startPolling() {
    if (this.timer !== null) return
    const timer = setInterval(() => {
      void this.tick()
    }, POLL_MS)
    timer.unref?.()
    this.timer = timer
  }

  stopPolling() {
    if (this.timer === null) return
    clearInterval(this.timer)
    this.timer = null
  }

  /** Publish one remote log record to the host in the engine's event channel. */
  publish(event) {
    if (this.stopped) return
    this.sequence += 1
    this.lastEvent = event?.type
    this.lastEventAt = Date.now()
    if (event?.type === 'tool/call') this.toolCalls += 1
    const end = turnEndFromEvent(event)
    if (end !== undefined) {
      this.turn = undefined
      this.awaitingTurn = false
      this.aborted = end.aborted
    } else if (event?.type === 'turn/start') {
      this.turn = typeof event.data?.turn === 'number' ? event.data.turn : undefined
      this.turnStartedAt = Date.now()
    }
    this.emit('event', event)
  }

  /**
   * Read every durable event between the cursor and `throughSeq`.
   *
   * `session/page` pages backwards from a message-aligned cut, so a backlog
   * wider than one page needs the earlier `beforeSeq` windows too; the result is
   * deduplicated by seq and returned in log order.
   */
  async readSince(afterSeq, throughSeq) {
    const bySeq = new Map()
    let beforeSeq
    let previousFirst = Number.POSITIVE_INFINITY
    for (let page = 0; page < MAX_CATCH_UP_PAGES; page += 1) {
      const request = {
        address: { kind: 'session', sessionId: this.sessionId },
        throughSeq,
        maxMessages: PAGE_MESSAGES,
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
      }
      const result = await this.client.call('session/page', { request })
      const records = Array.isArray(result?.records) ? result.records : []
      for (const event of eventsFromPage(result, { after: afterSeq })) bySeq.set(event.seq, event)
      if (result?.hasMore !== true) break
      const first = records[0]?.event?.seq
      if (typeof first !== 'number') break
      // The window already reaches the caller's cursor, or paging stopped
      // making progress; either way the backlog is covered.
      if (first <= afterSeq + 1) break
      if (first >= previousFirst) break
      previousFirst = first
      beforeSeq = first
    }
    return [...bySeq.values()].sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0))
  }

  /** One poll: reconcile the remote head, then publish anything new. */
  async tick() {
    if (this.stopped || this.ticking) return
    this.ticking = true
    try {
      const projections = await this.client.call('session/projections', { request: { sessionId: this.sessionId } })
      this.values = valuesOf(projections)
      this.lastSyncAt = Date.now()
      const head = typeof projections?.asOfSeq === 'number' ? projections.asOfSeq : undefined
      if (head === undefined || head <= this.cursor) return
      const events = await this.readSince(this.cursor, head)
      for (const event of events) {
        if (this.stopped) return
        this.cursor = Math.max(this.cursor, typeof event.seq === 'number' ? event.seq : this.cursor)
        this.publish(event)
      }
      this.cursor = Math.max(this.cursor, head)
      // A turn that never closes must not keep this attachment alive forever.
      if (this.turnStartedAt !== undefined && Date.now() - this.turnStartedAt > MAX_TURN_MS) {
        this.logger?.warn?.(`dsh: session ${this.sessionId} has had an open turn for over ${Math.round(MAX_TURN_MS / 60000)} minutes; abandoning observation`)
        this.emit('protocol-error', { message: 'the remote turn exceeded the observation limit' })
        await this.dispose()
      }
    } catch (error) {
      this.lastError = messageOf(error)
      if (error instanceof DshAuthError) {
        // A credential problem is terminal: keep reporting it instead of
        // retrying a login the user must fix.
        this.emit('protocol-error', { message: error.message })
        return
      }
      this.logger?.warn?.(`dsh: poll failed for ${this.sessionId}: ${this.lastError}`)
    } finally {
      this.ticking = false
    }
  }

  /** Live conversation state for the browser's composer and statusline. */
  stateView() {
    const values = this.values ?? {}
    const model = this.modelOverride ?? modelFromValues(values) ?? this.session?.model ?? null
    const inbox = values.inbox !== undefined && values.inbox !== null ? values.inbox : undefined
    const pending = Array.isArray(inbox?.['next-turn']) ? inbox['next-turn'].length : 0
    const steering = Array.isArray(inbox?.['next-step']) ? inbox['next-step'].length : 0
    return {
      sessionId: this.sessionId,
      sessionName: typeof values.title === 'string' && values.title !== '' ? values.title : this.session?.name,
      cwd: typeof values.workingDirectory === 'string' && values.workingDirectory !== ''
        ? values.workingDirectory
        : this.session?.cwd,
      model,
      thinkingLevel: null,
      isStreaming: this.awaitingTurn || this.turn !== undefined,
      queuedMessages: pending + steering,
      turn: this.turn,
      aborted: this.aborted,
      baseUrl: this.baseUrl,
      lastEvent: this.lastEvent,
      lastEventAt: this.lastEventAt,
      lastSyncAt: this.lastSyncAt,
      remoteSeq: this.cursor,
      ...(this.lastError === null ? {} : { lastError: this.lastError }),
    }
  }

  getState() {
    return this.stateView()
  }

  /** Reconcile against the remote before answering the HTTP state route. */
  async snapshot() {
    if (!this.stopped) await this.tick()
    return { ...this.stateView(), pid: this.pid, lastEventType: this.lastEvent }
  }

  async getMessages() {
    return []
  }

  /**
   * Admit one prompt on the remote Session.
   *
   * `session/prompt` cold-resumes a detached session and takes its writer lock,
   * so this is the attach-and-send step in one call. `mode` mirrors the bridge's
   * three submission kinds: `queue` for a new turn, `steer` to inject into the
   * running one.
   */
  async sendPrompt(message, mode) {
    if (typeof message !== 'string' || message.trim() === '') {
      throw Object.assign(new Error('message is required'), { status: 400 })
    }
    const requestId = randomUUID()
    this.awaitingTurn = true
    this.aborted = false
    this.turnStartedAt = Date.now()
    try {
      const result = await this.client.call('session/prompt', {
        request: {
          requestId,
          sessionId: this.sessionId,
          mode,
          content: [{ type: 'text', text: message }],
        },
      })
      return result?.accepted === false ? false : true
    } catch (error) {
      this.awaitingTurn = false
      this.turnStartedAt = undefined
      throw describeRpcError(error, 'send the prompt')
    }
  }

  prompt(message) {
    return this.sendPrompt(message, 'queue')
  }

  steer(message) {
    return this.sendPrompt(message, 'steer')
  }

  followUp(message) {
    return this.sendPrompt(message, 'queue')
  }

  /** Cancel the remote turn; delivery of already-emitted events is unaffected. */
  async abort() {
    this.aborted = true
    try {
      const result = await this.client.call('session/cancel', { request: { sessionId: this.sessionId } })
      return result?.accepted === true
    } catch (error) {
      // Cancelling a session with no live Agent is honest: nothing to stop.
      if (error instanceof DshRpcError && error.code === 'session/not-found') {
        this.awaitingTurn = false
        return false
      }
      throw describeRpcError(error, 'cancel the turn')
    }
  }

  /** Choose the model the remote Session uses for its next request. */
  async setModel(provider, modelId) {
    if (typeof provider !== 'string' || provider === '' || typeof modelId !== 'string' || modelId === '') {
      throw Object.assign(new Error('provider and model are required'), { status: 400 })
    }
    try {
      const result = await this.client.call('session/selectModel', {
        request: { sessionId: this.sessionId, provider, model: modelId },
      })
      const selected = result?.selected ?? { provider, model: modelId }
      this.modelOverride = { provider: selected.provider ?? provider, id: selected.model ?? modelId }
      return this.modelOverride
    } catch (error) {
      throw describeRpcError(error, 'select the model')
    }
  }

  /** The remote catalog is host-global, not per session. */
  async getAvailableModels() {
    try {
      const catalog = await this.client.call('session/modelCatalog', {})
      return modelsFromCatalog(catalog)
    } catch (error) {
      throw describeRpcError(error, 'read the model catalog')
    }
  }

  async getSessionStats() {
    if (!this.stopped) {
      try {
        await this.tick()
      } catch {
        // Fall back to the last known projections.
      }
    }
    const stats = statsFromProjections(this.values ?? {})
    return stats === null ? null : { ...stats, toolCalls: this.toolCalls }
  }

  /**
   * The remote session has no extension dialogs the bridge could answer: dsh
   * approvals belong to that instance's own UI.
   */
  respondUi() {
    throw Object.assign(new Error('the remote DSH session has no bridge-owned dialog'), { status: 409 })
  }

  /** Stop observing. Disposing is never a remote action: the turn keeps running. */
  async dispose() {
    if (this.stopped) return
    this.stopped = true
    this.running = false
    this.stopPolling()
    this.emit('exit', { intentional: true })
    this.removeAllListeners()
  }
}
