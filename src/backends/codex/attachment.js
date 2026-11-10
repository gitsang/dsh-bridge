/**
 * One live Codex attachment over `codex app-server --stdio`.
 *
 * app-server speaks newline-delimited JSON-RPC 2.0: requests on stdin, matched
 * responses plus unsolicited notifications on stdout, and server-initiated
 * requests (native approvals) that must be answered. The bridge never writes
 * the rollout file itself; the app-server child owns that handle, so dsh cannot
 * race Codex's own append-only history.
 *
 * The adapter emits native-ish records on its `event` channel and leaves the
 * translation to `codexEngine.normalizeEvent`, so the wire-to-browser mapping
 * stays unit-testable without a child process.
 */
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { createLineDecoder, createStderrRing, resolveCliCommand } from '../cli.js'
import { codexModelProvider, readCodexSession, readRolloutThreadId } from './session-store.js'

const DEFAULT_RESPONSE_TIMEOUT_MS = 60_000
const MODEL_QUERY_TIMEOUT_MS = 20_000

function packageVersion() {
  try {
    const value = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'))
    return typeof value.version === 'string' ? value.version : '0.1.0'
  } catch {
    return '0.1.0'
  }
}

const CLIENT_INFO = {
  name: 'dsh-bridge',
  title: 'DeepSeek Harness Bridge',
  version: packageVersion(),
}

/** Thread items that are tool calls rather than transcript text. */
const TOOL_ITEM_TYPES = new Set([
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'functionCall',
  'customToolCall',
  'functionCallOutput',
  'customToolCallOutput',
  'webSearch',
  'imageView',
  'imageGeneration',
  'sleep',
  'collabAgentToolCall',
  'subAgentActivity',
  'plan',
])

function textOfUserInput(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block !== null && typeof block === 'object' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/** Reasoning items expose readable text through `summary`/`content` arrays only. */
function reasoningItemText(item) {
  const parts = []
  for (const list of [item.summary, item.content]) {
    if (!Array.isArray(list)) continue
    for (const value of list) {
      if (typeof value === 'string' && value !== '') parts.push(value)
    }
  }
  return parts.join('\n\n')
}

function errorText(value, fallback) {
  if (value === null || typeof value !== 'object') return fallback
  if (typeof value.message === 'string' && value.message !== '') return value.message
  return fallback
}

function approvalRequest(method, params) {
  if (method === 'item/fileChange/requestApproval') {
    return {
      method: 'confirm',
      title: 'Apply file changes?',
      message: typeof params?.reason === 'string' && params.reason !== ''
        ? params.reason
        : 'Codex wants to write files in this workspace.',
    }
  }
  const command = typeof params?.command === 'string' && params.command !== '' ? params.command : 'a command'
  const cwd = typeof params?.cwd === 'string' && params.cwd !== '' ? ` in ${params.cwd}` : ''
  const reason = typeof params?.reason === 'string' && params.reason !== '' ? ` (${params.reason})` : ''
  return {
    method: 'confirm',
    title: 'Run this command?',
    message: `Codex wants to run \`${command}\`${cwd}${reason}`,
  }
}

export class CodexAttachment extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.file absolute rollout JSONL path
   * @param {string} [options.threadId] Codex thread id; derived from the rollout when absent
   * @param {string} [options.cwd] working directory for Codex and its tools
   * @param {NodeJS.ProcessEnv} [options.env]
   * @param {string} [options.approvalPolicy] `never` or `on-request`
   * @param {string} [options.sandbox] `workspace-write`, `read-only`, `danger-full-access`
   * @param {number} [options.responseTimeoutMs]
   */
  constructor(options) {
    super()
    this.file = options.file
    this.threadId = options.threadId
    this.cwd = options.cwd && existsSync(options.cwd) ? options.cwd : homedir()
    this.env = { ...(options.env ?? process.env) }
    this.approvalPolicy = options.approvalPolicy ?? 'never'
    this.sandbox = options.sandbox ?? 'workspace-write'
    this.responseTimeoutMs = options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS
    this.provider = codexModelProvider(this.env)
    this.model = undefined
    this.modelOverride = undefined
    this.pending = new Map()
    this.uiPending = new Map()
    this.approvals = new Map()
    this.stderrRing = createStderrRing(16 * 1024)
    this.child = undefined
    this.exited = false
    this.startedAt = Date.now()
    this.lastEventAt = undefined
    this.lastEventType = undefined
    this.nextId = 1
    this.isStreaming = false
    this.currentTurnId = undefined
    this.streamingMessage = undefined
    this.itemBlocks = new Map()
    this.toolOutput = new Map()
    this.tokenUsage = undefined
    this.counts = { userMessages: 0, assistantMessages: 0, toolCalls: 0 }
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

  /** Spawn the app-server child and complete the initialize + thread handshake. */
  async start() {
    if (this.child !== undefined) return this
    if (typeof this.threadId !== 'string' || this.threadId === '') {
      this.threadId = readRolloutThreadId(this.file)
    }
    const resolved = resolveCliCommand({ envVar: 'CODEX_BIN', defaultNames: ['codex'], env: this.env })
    const args = [...resolved.prefixArgs, 'app-server', '--stdio']
    this.child = spawn(resolved.command, args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    const decoder = createLineDecoder((line) => this.handleLine(line))
    this.child.stdout.on('data', (chunk) => decoder.push(chunk))
    this.child.stdout.on('end', () => decoder.flush())
    this.child.stderr.on('data', (chunk) => this.stderrRing.push(chunk))
    this.child.on('error', (error) => this.handleExit({ error }))
    this.child.on('exit', (code, signal) => this.handleExit({ code, signal }))
    this.emit('spawn', { pid: this.child.pid, command: resolved.command, args })

    try {
      await this.request('initialize', {
        clientInfo: CLIENT_INFO,
        // `thread/resume.path` (loading a rollout that CODEX_HOME does not
        // index, e.g. a custom sessionsRoot) is gated behind this opt-in.
        capabilities: { experimentalApi: true },
      })
      await this.openThread()
    } catch (error) {
      const detail = this.stderr.trim()
      const failure = new Error(
        detail === ''
          ? `Codex app-server failed to start: ${error instanceof Error ? error.message : String(error)}`
          : `Codex app-server failed to start: ${detail}`,
      )
      failure.cause = error
      try {
        this.child?.kill('SIGKILL')
      } catch {
        // The child may already be gone.
      }
      throw failure
    }
    return this
  }

  /** Resume the durable thread, falling back to a fresh one when it is gone. */
  async openThread() {
    const base = {
      cwd: this.cwd,
      approvalPolicy: this.approvalPolicy,
      sandbox: this.sandbox,
    }
    let result
    if (typeof this.threadId === 'string' && this.threadId !== '') {
      try {
        // Passing the path makes the resume independent of Codex's session
        // index, which is what lets a Bridge `sessionsRoot` differ from
        // CODEX_HOME.
        result = await this.request('thread/resume', { ...base, threadId: this.threadId, path: this.file })
      } catch (error) {
        this.emit('ui-notification', {
          type: 'extension_ui_notification',
          method: 'notify',
          message: `Codex could not resume thread ${this.threadId}; starting a fresh one (${error instanceof Error ? error.message : String(error)})`,
          notifyType: 'warning',
        })
      }
    }
    if (result === undefined) {
      result = await this.request('thread/start', {
        ...base,
        ...(this.modelOverride === undefined ? {} : { model: this.modelOverride.id }),
      })
    }
    const thread = result?.thread ?? {}
    if (typeof thread.id === 'string' && thread.id !== '') this.threadId = thread.id
    if (typeof result?.modelProvider === 'string' && result.modelProvider !== '') this.provider = result.modelProvider
    if (typeof result?.model === 'string' && result.model !== '') this.model = { provider: this.provider, id: result.model }
    return result
  }

  write(record) {
    if (!this.running || this.child?.stdin.destroyed) throw new Error('Codex attachment is not running')
    this.child.stdin.write(`${JSON.stringify(record)}\n`)
  }

  /** Send one JSON-RPC request and wait for its correlated response. */
  request(method, params = {}, timeoutMs = this.responseTimeoutMs) {
    if (!this.running || this.child?.stdin.destroyed) {
      return Promise.reject(new Error('Codex attachment is not running'))
    }
    const id = this.nextId
    this.nextId += 1
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex command timed out: ${method}`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer, method })
      try {
        this.write({ id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  /** Reply to one server-initiated request without waiting for a response. */
  respondToServer(id, result) {
    try {
      this.write({ id, result })
    } catch {
      // A dead child makes the reply moot; the pending approval is dropped on exit.
    }
  }

  handleLine(line) {
    let record
    try {
      record = JSON.parse(line)
    } catch {
      this.emit('protocol-error', { line })
      return
    }
    if (record === null || typeof record !== 'object') return

    // Server-initiated request: has both an id and a method.
    if (record.id !== undefined && typeof record.method === 'string') {
      this.handleServerRequest(record.id, record.method, record.params ?? {})
      return
    }
    if (record.id !== undefined) {
      const entry = this.pending.get(record.id)
      if (entry === undefined) return
      this.pending.delete(record.id)
      clearTimeout(entry.timer)
      if (record.error !== undefined && record.error !== null) {
        const error = new Error(
          typeof record.error.message === 'string' && record.error.message !== ''
            ? record.error.message
            : `Codex command failed: ${entry.method}`,
        )
        error.code = record.error.code
        error.data = record.error.data
        entry.reject(error)
      } else {
        entry.resolve(record.result)
      }
      return
    }
    if (typeof record.method !== 'string') return
    this.lastEventAt = Date.now()
    this.handleNotification(record.method, record.params ?? {})
  }

  handleServerRequest(id, method, params) {
    this.lastEventAt = Date.now()
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      const requestId = `codex-${id}`
      const record = { id: requestId, type: 'extension_ui_request', ...approvalRequest(method, params) }
      this.approvals.set(requestId, { rpcId: id, itemId: params?.itemId })
      this.uiPending.set(requestId, record)
      this.emit('ui-request', record)
      return
    }
    if (method === 'item/tool/requestUserInput') {
      // No Bridge dialog exists for a free-form question; an empty answer map
      // lets the turn continue instead of deadlocking on a prompt nobody sees.
      this.respondToServer(id, { answers: {} })
      this.emit('ui-notification', {
        type: 'extension_ui_notification',
        method: 'notify',
        message: 'Codex asked for extra tool input; the Bridge declined it.',
        notifyType: 'warning',
      })
      return
    }
    if (method === 'mcpServer/elicitation/request') {
      this.respondToServer(id, { action: 'decline' })
      return
    }
    if (method === 'item/tool/call') {
      this.respondToServer(id, { contentItems: [], success: false })
      return
    }
    // Unknown server request: answer with an error instead of leaving both
    // sides waiting forever (a wedged request blocks the whole turn).
    try {
      this.write({ id, error: { code: -32601, message: `dsh-bridge cannot handle ${method}` } })
    } catch {
      // Child already gone.
    }
  }

  /** Answer one pending native approval in Codex's decision vocabulary. */
  respondUi(id, response) {
    if (!this.running) throw new Error('Codex attachment is not running')
    const pending = this.approvals.get(id)
    if (pending === undefined) throw new Error('unknown Codex approval request')
    this.approvals.delete(id)
    this.uiPending.delete(id)
    const decision = response?.confirmed === true ? 'accept' : 'decline'
    this.write({ id: pending.rpcId, result: { decision } })
  }

  emitEvent(record) {
    this.lastEventAt = Date.now()
    this.lastEventType = record.type
    this.emit('event', record)
    if (typeof record.type === 'string') this.emit(record.type, record)
  }

  handleNotification(method, params) {
    switch (method) {
      case 'thread/started': {
        const thread = params.thread ?? {}
        if (typeof thread.id === 'string' && thread.id !== '') this.threadId = thread.id
        if (typeof thread.model === 'string' && thread.model !== '') {
          this.model = { provider: typeof thread.modelProvider === 'string' ? thread.modelProvider : this.provider, id: thread.model }
        }
        this.emitEvent({ type: 'thread_started', thread })
        return
      }
      case 'thread/status/changed': {
        // Internal state only: this notification often arrives right after
        // turn/completed, and a browser event here would land after
        // agent-settled, when the host is already closing the attachment.
        this.lastEventAt = Date.now()
        this.lastEventType = method
        const status = params.status ?? {}
        // A missed turn/completed must not leave the browser spinning forever.
        if (status.type === 'idle' && this.isStreaming) this.settle(false)
        return
      }
      case 'turn/started': {
        const turn = params.turn ?? {}
        this.isStreaming = true
        if (typeof turn.id === 'string') this.currentTurnId = turn.id
        this.emitEvent({ type: 'agent_start' })
        this.emitEvent({ type: 'turn_started', turn })
        return
      }
      case 'turn/completed': {
        const turn = params.turn ?? {}
        // Record the native completion before settling: the host closes the
        // per-turn process right after `agent-settled`, so that event must stay
        // the last one the browser sees for a turn.
        this.emitEvent({ type: 'turn_completed', turn })
        this.settle(turn.status === 'interrupted')
        if (turn.status === 'failed') {
          this.emit('ui-notification', {
            type: 'extension_ui_notification',
            method: 'notify',
            message: `Codex turn failed: ${errorText(turn.error, 'unknown error')}`,
            notifyType: 'error',
          })
        }
        return
      }
      case 'item/started': {
        this.handleItem(params.item, params.turnId, false)
        return
      }
      case 'item/completed': {
        this.handleItem(params.item, params.turnId, true)
        return
      }
      case 'item/agentMessage/delta': {
        this.appendText(params.itemId, 'text', params.delta)
        return
      }
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta': {
        this.appendText(params.itemId, 'thinking', params.delta)
        return
      }
      case 'item/commandExecution/outputDelta':
      case 'item/fileChange/outputDelta': {
        if (typeof params.itemId !== 'string' || typeof params.delta !== 'string') return
        const accumulated = (this.toolOutput.get(params.itemId) ?? '') + params.delta
        this.toolOutput.set(params.itemId, accumulated)
        this.emitEvent({ type: 'tool_update', toolCallId: params.itemId, partialResult: accumulated })
        return
      }
      case 'item/mcpToolCall/progress': {
        if (typeof params.itemId !== 'string') return
        const message = typeof params.message === 'string' ? params.message : ''
        if (message === '') return
        this.emitEvent({ type: 'tool_update', toolCallId: params.itemId, partialResult: message })
        return
      }
      case 'item/plan/delta': {
        this.emitEvent({ type: 'notification', method, params })
        return
      }
      case 'thread/tokenUsage/updated': {
        this.tokenUsage = params.tokenUsage
        this.emitEvent({ type: 'token_usage', tokenUsage: params.tokenUsage })
        return
      }
      case 'error': {
        this.emitEvent({ type: 'error', error: params.error, willRetry: params.willRetry === true })
        if (params.willRetry !== true) {
          this.emit('ui-notification', {
            type: 'extension_ui_notification',
            method: 'notify',
            message: `Codex error: ${errorText(params.error, 'unknown error')}`,
            notifyType: 'error',
          })
        }
        return
      }
      case 'warning':
      case 'guardianWarning':
      case 'configWarning': {
        const message = typeof params.message === 'string' ? params.message : ''
        this.emitEvent({ type: 'warning', message })
        if (message !== '') {
          this.emit('ui-notification', {
            type: 'extension_ui_notification',
            method: 'notify',
            message,
            notifyType: method === 'configWarning' ? 'warning' : 'error',
          })
        }
        return
      }
      case 'serverRequest/resolved': {
        this.dropApprovalForItem(params.itemId)
        return
      }
      default: {
        this.emitEvent({ type: 'notification', method, params })
      }
    }
  }

  /** app-server resolved an approval by itself (e.g. an auto-review pass). */
  dropApprovalForItem(itemId) {
    for (const [requestId, pending] of this.approvals) {
      if (itemId !== undefined && pending.itemId !== itemId) continue
      this.approvals.delete(requestId)
      this.uiPending.delete(requestId)
    }
  }

  blockFor(item, kind) {
    let state = this.itemBlocks.get(item.id)
    if (state !== undefined) return state
    const message = this.ensureAssistant()
    const block = kind === 'thinking'
      ? { type: 'thinking', thinking: '' }
      : { type: 'text', text: '' }
    message.content.push(block)
    state = { kind, index: message.content.length - 1 }
    this.itemBlocks.set(item.id, state)
    this.emitMessageUpdate()
    return state
  }

  ensureAssistant() {
    if (this.streamingMessage !== undefined) return this.streamingMessage
    const message = { role: 'assistant', content: [], timestamp: Date.now() }
    this.streamingMessage = message
    this.counts.assistantMessages += 1
    this.emitEvent({ type: 'message_start', message: cloneMessage(message) })
    return message
  }

  emitMessageUpdate() {
    if (this.streamingMessage === undefined) return
    this.emitEvent({ type: 'message_update', message: cloneMessage(this.streamingMessage) })
  }

  appendText(itemId, kind, delta) {
    if (typeof itemId !== 'string' || typeof delta !== 'string' || delta === '') return
    const state = this.itemBlocks.get(itemId) ?? this.blockFor({ id: itemId }, kind)
    const message = this.ensureAssistant()
    const block = message.content[state.index]
    if (block === undefined) return
    if (kind === 'thinking') block.thinking = (block.thinking ?? '') + delta
    else block.text = (block.text ?? '') + delta
    this.emitMessageUpdate()
  }

  /** Track one ThreadItem lifecycle; unknown variants degrade to a generic tool row. */
  handleItem(item, turnId, completed) {
    if (item === null || typeof item !== 'object' || typeof item.id !== 'string') return
    if (item.type === 'userMessage') {
      // The live user turn arrives as its own item; the client settles its
      // optimistic echo against the durable message-end carrying the same text.
      if (completed) return
      const text = textOfUserInput(item.content)
      if (text.trim() === '') return
      const message = { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() }
      this.counts.userMessages += 1
      this.emitEvent({ type: 'message_start', message: cloneMessage(message) })
      this.emitEvent({ type: 'message_end', message: cloneMessage(message) })
      return
    }
    if (item.type === 'reasoning') {
      this.applyReasoningItem(item, completed)
      return
    }
    if (item.type === 'agentMessage') {
      const state = this.itemBlocks.get(item.id) ?? this.blockFor(item, 'text')
      if (typeof item.text === 'string' && item.text !== '') {
        const block = this.streamingMessage?.content[state.index]
        if (block !== undefined) block.text = item.text
        this.emitMessageUpdate()
      }
      // An agent message is its own transcript entry: close it here so a
      // commentary message and the final answer do not fuse into one bubble.
      if (completed) this.endAssistantMessage()
      return
    }
    if (TOOL_ITEM_TYPES.has(item.type)) {
      if (completed) this.finishToolItem(item)
      else this.startToolItem(item, turnId)
      return
    }
    // Unsupported future variants still get one visible row instead of a throw.
    if (completed) this.finishToolItem(item)
    else this.startToolItem(item, turnId)
  }

  /**
   * Reasoning items stream deltas and then a completed item with the final
   * summary. Thinking blocks stay in the pending assistant message until the
   * following agent message closes it, so reasoning and its answer read as one
   * turn fragment.
   */
  applyReasoningItem(item, completed) {
    const state = this.itemBlocks.get(item.id)
    if (state === undefined) {
      const message = this.ensureAssistant()
      message.content.push({ type: 'thinking', thinking: '' })
      this.itemBlocks.set(item.id, { kind: 'thinking', index: message.content.length - 1 })
      this.emitMessageUpdate()
    }
    const finalState = this.itemBlocks.get(item.id)
    const text = reasoningItemText(item)
    if (text !== '') {
      const block = this.streamingMessage?.content[finalState.index]
      if (block !== undefined && block.thinking !== text) {
        block.thinking = text
        this.emitMessageUpdate()
      }
    }
  }

  startToolItem(item) {
    this.counts.toolCalls += 1
    this.toolOutput.set(item.id, '')
    this.emitEvent({
      type: 'tool_start',
      toolCallId: item.id,
      name: toolNameForItem(item),
      arguments: toolArgumentsForItem(item),
    })
  }

  finishToolItem(item) {
    const { text, isError } = toolResultForItem(item, this.toolOutput.get(item.id) ?? '')
    this.toolOutput.delete(item.id)
    this.emitEvent({
      type: 'tool_end',
      toolCallId: item.id,
      result: { content: [{ type: 'text', text }] },
      isError,
    })
  }

  /** Close the pending assistant message, if any. */
  endAssistantMessage() {
    if (this.streamingMessage === undefined) return
    this.emitEvent({ type: 'message_end', message: cloneMessage(this.streamingMessage) })
    this.streamingMessage = undefined
  }

  /** Close the streaming assistant message and announce the turn result. */
  settle(aborted) {
    // thread/status/changed can report idle both before and after
    // turn/completed; the second report must not emit a duplicate settle.
    if (!this.isStreaming && this.streamingMessage === undefined) return
    this.endAssistantMessage()
    this.isStreaming = false
    this.currentTurnId = undefined
    this.itemBlocks.clear()
    this.toolOutput.clear()
    this.emitEvent({ type: 'agent_end' })
    this.emitEvent({ type: 'agent_settled', aborted: aborted === true })
  }

  handleExit(info) {
    if (this.exited) return
    this.exited = true
    const detail = this.stderr.trim()
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      const failure = new Error(
        detail === ''
          ? 'Codex app-server exited before responding'
          : `Codex app-server exited before responding: ${detail}`,
      )
      failure.cause = info
      entry.reject(failure)
    }
    this.pending.clear()
    this.uiPending.clear()
    this.approvals.clear()
    this.emit('exit', { ...info, stderr: this.stderr })
  }

  async getState() {
    return {
      sessionId: this.threadId,
      isStreaming: this.isStreaming,
      model: this.model ?? null,
      pid: this.pid,
      lastEventAt: this.lastEventAt,
      lastEventType: this.lastEventType,
    }
  }

  /** Snapshot used by the HTTP state route. */
  async snapshot() {
    return { ...(await this.getState()), pid: this.pid, lastEventAt: this.lastEventAt, lastEventType: this.lastEventType }
  }

  /**
   * Durable messages for the side panel.
   *
   * The rollout file is preferred over `thread/read {includeTurns:true}`: that
   * request is rejected by codex-cli 0.162.1 ("list_turns is not supported
   * yet"), and the file yields exactly the same transcript after the turn is
   * flushed.
   */
  async getMessages() {
    const session = await readCodexSession(this.file)
    return { messages: session.messages }
  }

  async prompt(message, options = {}) {
    if (typeof this.threadId !== 'string' || this.threadId === '') {
      throw new Error('Codex thread is not ready')
    }
    const params = { threadId: this.threadId, input: inputFor(message, options) }
    // Codex has no thread-level model switch: a per-turn override is the only
    // way to change models, and it applies from this turn on.
    const model = this.modelOverride ?? (options.model === undefined ? undefined : { id: options.model })
    if (model !== undefined) params.model = model.id
    // Optimistic so a second send that races turn/started steers instead of
    // starting a concurrent turn the app-server would reject.
    this.isStreaming = true
    let result
    try {
      result = await this.request('turn/start', params)
    } catch (error) {
      this.isStreaming = false
      throw error
    }
    if (typeof result?.turn?.id === 'string') this.currentTurnId = result.turn.id
    return { accepted: true, turnId: this.currentTurnId }
  }

  async steer(message, options = {}) {
    if (typeof this.threadId !== 'string' || this.threadId === '') {
      throw new Error('Codex thread is not ready')
    }
    if (typeof this.currentTurnId !== 'string') return this.prompt(message, options)
    const result = await this.request('turn/steer', {
      threadId: this.threadId,
      expectedTurnId: this.currentTurnId,
      input: inputFor(message, options),
    })
    if (typeof result?.turnId === 'string') this.currentTurnId = result.turnId
    return { accepted: true, turnId: this.currentTurnId }
  }

  async followUp(message, options = {}) {
    if (this.isStreaming) return this.steer(message, options)
    return this.prompt(message, options)
  }

  async abort() {
    if (!this.running) return { aborted: false }
    const turnId = this.currentTurnId
    if (typeof turnId !== 'string') return { aborted: false }
    try {
      await this.request('turn/interrupt', { threadId: this.threadId, turnId })
    } catch (error) {
      if (!this.running) return { aborted: false }
      throw error
    }
    return { aborted: true, turnId }
  }

  setModel(provider, modelId) {
    if (typeof modelId !== 'string' || modelId === '') throw new Error('model is required')
    this.modelOverride = { provider: typeof provider === 'string' ? provider : undefined, id: modelId }
    // Reflect the choice immediately so the picker does not snap back; the
    // running thread itself only picks it up on the next turn/start.
    this.model = { provider: this.modelOverride.provider ?? this.provider, id: modelId }
    return this.model
  }

  async getAvailableModels() {
    const result = await this.request('model/list', {})
    return mapCodexModels(result, this.provider)
  }

  async getSessionStats() {
    let messages = []
    try {
      messages = (await readCodexSession(this.file)).messages
    } catch {
      // A brand-new session has no flushed transcript yet; live counters cover it.
    }
    let userMessages = 0
    let assistantMessages = 0
    let toolCalls = 0
    for (const message of messages) {
      if (message.role === 'user') userMessages += 1
      else if (message.role === 'assistant') assistantMessages += 1
      if (Array.isArray(message.content)) {
        toolCalls += message.content.filter((block) => block?.type === 'toolCall').length
      }
    }
    if (messages.length === 0) {
      userMessages = this.counts.userMessages
      assistantMessages = this.counts.assistantMessages
      toolCalls = this.counts.toolCalls
    }
    const total = this.tokenUsage?.total ?? null
    const last = this.tokenUsage?.last ?? null
    const input = total === null ? 0 : Math.max(0, (total.inputTokens ?? 0) - (total.cachedInputTokens ?? 0))
    const tokens = {
      input,
      cacheRead: total?.cachedInputTokens ?? 0,
      cacheWrite: total?.cacheWriteInputTokens ?? 0,
      output: total?.outputTokens ?? 0,
      total: total?.totalTokens ?? 0,
    }
    const contextWindow = typeof this.tokenUsage?.modelContextWindow === 'number' ? this.tokenUsage.modelContextWindow : 0
    const used = last?.totalTokens ?? 0
    return {
      sessionId: this.threadId,
      userMessages,
      assistantMessages,
      toolCalls,
      totalMessages: messages.length || userMessages + assistantMessages,
      tokens,
      contextUsage: {
        tokens: used,
        contextWindow,
        percent: contextWindow > 0 ? Math.round((used / contextWindow) * 1000) / 10 : 0,
      },
    }
  }

  /** Stop the child; stdin EOF is the graceful shutdown signal. */
  async dispose() {
    if (this.child === undefined || this.exited) return
    const child = this.child
    try {
      child.stdin.end()
    } catch {
      // The child may already have closed stdin.
    }
    const exited = await new Promise((resolve) => {
      if (this.exited) {
        resolve(true)
        return
      }
      const timer = setTimeout(() => resolve(false), 1500)
      timer.unref?.()
      this.once('exit', () => {
        clearTimeout(timer)
        resolve(true)
      })
    })
    if (!exited) {
      try {
        child.kill('SIGTERM')
      } catch {
        // Already gone.
      }
      await new Promise((resolve) => {
        if (this.exited) {
          resolve()
          return
        }
        const timer = setTimeout(resolve, 1000)
        timer.unref?.()
        this.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
    if (!this.exited) {
      try {
        child.kill('SIGKILL')
      } catch {
        // Already gone.
      }
    }
  }
}

function cloneMessage(message) {
  return { ...message, content: message.content.map((block) => ({ ...block })) }
}

function inputFor(message, options) {
  const input = [{ type: 'text', text: typeof message === 'string' ? message : String(message ?? '') }]
  if (Array.isArray(options.images)) {
    for (const image of options.images) {
      if (image !== null && typeof image === 'object' && typeof image.path === 'string') {
        input.push({ type: 'localImage', path: image.path })
      }
    }
  }
  return input
}

function toolNameForItem(item) {
  switch (item.type) {
    case 'commandExecution':
      return 'shell'
    case 'fileChange':
      return 'apply_patch'
    case 'webSearch':
      return 'web_search'
    case 'imageView':
      return 'read_image'
    case 'mcpToolCall':
      return `${item.server}.${item.tool}`
    case 'dynamicToolCall':
      return typeof item.tool === 'string' ? item.tool : 'tool'
    case 'functionCall':
    case 'customToolCall':
      return typeof item.name === 'string' ? item.name : (typeof item.tool === 'string' ? item.tool : 'tool')
    default:
      return item.type
  }
}

function toolArgumentsForItem(item) {
  switch (item.type) {
    case 'commandExecution':
      return { command: item.command, cwd: item.cwd }
    case 'fileChange': {
      const changes = Array.isArray(item.changes) ? item.changes : []
      return { path: changes[0]?.path, changes }
    }
    case 'mcpToolCall':
    case 'dynamicToolCall':
      return item.arguments ?? {}
    case 'functionCall':
    case 'customToolCall':
      return item.arguments ?? item.input ?? {}
    case 'webSearch':
      return { query: item.query }
    case 'imageView':
      return { path: item.path }
    default:
      return {}
  }
}

function toolResultForItem(item, accumulated) {
  switch (item.type) {
    case 'commandExecution': {
      const text = accumulated !== '' ? accumulated : (typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : '')
      const failed = item.status === 'failed' || item.status === 'declined'
        || (typeof item.exitCode === 'number' && item.exitCode !== 0)
      return { text: text === '' && !failed ? 'Command completed.' : text, isError: failed }
    }
    case 'fileChange': {
      const changes = Array.isArray(item.changes) ? item.changes : []
      const failed = item.status === 'failed' || item.status === 'declined'
      const text = accumulated !== ''
        ? accumulated
        : (changes.length === 0 ? 'No file changes.' : `Changed ${changes.length} file(s): ${changes.map((change) => change.path).join(', ')}`)
      return { text, isError: failed }
    }
    case 'mcpToolCall': {
      const content = item.result?.content
      let text = accumulated
      if (text === '' && Array.isArray(content)) {
        text = content.filter((block) => block !== null && typeof block === 'object' && typeof block.text === 'string').map((block) => block.text).join('\n')
      }
      return { text, isError: item.status === 'failed' || item.error !== undefined && item.error !== null }
    }
    case 'functionCallOutput':
    case 'customToolCallOutput': {
      const output = item.output
      const text = accumulated !== '' ? accumulated : (typeof output === 'string' ? output : JSON.stringify(output ?? ''))
      return { text, isError: false }
    }
    default: {
      if (accumulated !== '') return { text: accumulated, isError: item.status === 'failed' }
      let text = ''
      try {
        text = JSON.stringify(item)
      } catch {
        text = ''
      }
      return { text, isError: item.status === 'failed' }
    }
  }
}

/** Map app-server's model catalog onto the shape the browser picker normalizes. */
export function mapCodexModels(result, provider = 'openai') {
  const data = Array.isArray(result?.data) ? result.data : []
  const models = []
  for (const model of data) {
    if (model === null || typeof model !== 'object' || model.hidden === true) continue
    const id = typeof model.id === 'string' && model.id !== '' ? model.id : model.model
    if (typeof id !== 'string' || id === '') continue
    models.push({
      id,
      provider,
      name: typeof model.displayName === 'string' && model.displayName !== '' ? model.displayName : id,
      description: typeof model.description === 'string' ? model.description : undefined,
      reasoning: Array.isArray(model.supportedReasoningEfforts) && model.supportedReasoningEfforts.length > 0,
    })
  }
  return models
}

/**
 * Query the live model catalog with a short-lived app-server child.
 *
 * The catalog merges the user's config, credentials, and gateway models, so it
 * cannot be derived from the rollout files. A wedged child is killed after
 * `MODEL_QUERY_TIMEOUT_MS` and every timer is unref'd so a failed query can
 * never keep the host process alive.
 */
export function queryCodexModels(env = process.env) {
  const resolved = resolveCliCommand({ envVar: 'CODEX_BIN', defaultNames: ['codex'], env })
  const args = [...resolved.prefixArgs, 'app-server', '--stdio']
  const provider = codexModelProvider(env)
  return new Promise((resolve, reject) => {
    const child = spawn(resolved.command, args, {
      cwd: tryExisting(env.HOME) ?? process.cwd(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    let settled = false
    let nextId = 1
    const send = (method, params) => {
      const id = nextId
      nextId += 1
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
      return id
    }
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.stdin.end() } catch { /* already closed */ }
      try { child.kill('SIGTERM') } catch { /* already gone */ }
      const force = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
      }, 1000)
      force.unref?.()
      if (error !== undefined) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(() => {
      finish(new Error(`Codex model query timed out after ${MODEL_QUERY_TIMEOUT_MS}ms`))
    }, MODEL_QUERY_TIMEOUT_MS)
    timer.unref?.()

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4096) })
    child.on('error', (error) => finish(error))
    child.on('exit', () => {
      if (!settled) {
        finish(new Error(stderr.trim() === '' ? 'Codex exited before answering the model query' : `Codex exited: ${stderr.trim()}`))
      }
    })
    let initialized = false
    const decoder = createLineDecoder((line) => {
      let record
      try { record = JSON.parse(line) } catch { return }
      if (record?.id !== undefined && typeof record.method === 'string') {
        // Approval and tool requests cannot happen during a catalog query, but
        // answering keeps a stray request from wedging the child.
        try { child.stdin.write(`${JSON.stringify({ id: record.id, result: { decision: 'decline' } })}\n`) } catch { /* closed */ }
        return
      }
      if (record?.id === undefined) return
      if (record.error !== undefined && record.error !== null) {
        finish(new Error(typeof record.error.message === 'string' ? record.error.message : 'Codex model query failed'))
        return
      }
      if (!initialized) {
        initialized = true
        send('model/list', {})
        return
      }
      finish(undefined, mapCodexModels(record.result, provider))
    })
    child.stdout.on('data', (chunk) => decoder.push(chunk))
    child.stdout.on('end', () => decoder.flush())
    try {
      send('initialize', { clientInfo: { name: 'dsh-bridge', version: CLIENT_INFO.version, title: CLIENT_INFO.title } })
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

function tryExisting(path) {
  if (typeof path !== 'string' || path === '') return undefined
  try {
    return existsSync(path) ? path : undefined
  } catch {
    return undefined
  }
}
