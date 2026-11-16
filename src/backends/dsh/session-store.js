/**
 * Durable-view mapping for a remote DeepSeek Harness Web instance.
 *
 * A remote DSH owns its own session log. The bridge never writes it, never
 * parses its storage, and never assumes a filesystem path: everything here
 * turns *wire* values (RPC results and durable Session events) into the neutral
 * session/message/event vocabulary the rest of the bridge already speaks, which
 * is the same vocabulary the Pi, Codex, and OpenCode adapters produce.
 *
 * Keeping the mapping pure is what makes it testable: no HTTP, no timers, and
 * no live instance is needed to pin the translation down.
 */

/** dsh event types that carry no conversation content of their own. */
const INTERNAL_EVENT_TYPES = new Set([
  'request/header',
  'request/context',
  'agent/inherited',
  'job/registered',
  'job/settled',
  'job/output',
  'llm/retry',
  'llm/retry-started',
  'workspace/changes',
  'agent/inbox/spliced',
  'session/compaction',
])

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => isObject(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/** A user-role message the human actually sent, not harness-injected context. */
export function isHumanUserMessage(event) {
  if (event?.type !== 'user/message' || !isObject(event.data)) return false
  const source = isObject(event.data.source) ? event.data.source : undefined
  // dsh labels injected context (`time-context`, `skill`, `agent-instruction`,
  // goal continuation rounds, …) with its own source kind. Only an explicit
  // human/rpc source is a transcript turn.
  if (source === undefined) return true
  return source.kind === 'user' || source.kind === 'rpc'
}

/** Parse a tool-call argument string, which dsh keeps exactly as the model wrote it. */
export function parseToolArguments(raw) {
  if (isObject(raw)) return raw
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  try {
    const parsed = JSON.parse(raw)
    return isObject(parsed) ? parsed : { value: parsed }
  } catch {
    return { raw }
  }
}

/**
 * Session title and workspace are durable *projections*, not event payloads, so
 * a list row and a targeted projections read both surface them identically.
 */
export function valuesFromRow(row) {
  const projections = isObject(row?.projections) ? row.projections : {}
  const values = isObject(projections.values) ? projections.values : {}
  return { projections, values }
}

/**
 * Convert one `session/list` row into the bridge's neutral session summary.
 *
 * `nativeKey` is the remote Session id; it is opaque to the host and only ever
 * handed back to the same bridge.
 */
export function sessionFromRow(row) {
  if (!isObject(row) || typeof row.sessionId !== 'string' || row.sessionId === '') {
    throw new Error('dsh returned a session row without an id')
  }
  const { projections, values } = valuesFromRow(row)
  const listMetadata = isObject(values.sessionListMetadata) ? values.sessionListMetadata : {}
  const model = modelFromValues(values)
  const updatedAt = typeof row.updatedAt === 'number' ? row.updatedAt : row.updatedAt !== undefined ? Date.parse(row.updatedAt) : undefined
  const modified = Number.isFinite(updatedAt) ? new Date(updatedAt).toISOString() : new Date().toISOString()
  const cwd = typeof values.workingDirectory === 'string' && values.workingDirectory !== ''
    ? values.workingDirectory
    : typeof row.cwd === 'string' ? row.cwd : undefined
  const outline = Array.isArray(values.turnOutline) ? values.turnOutline : []
  const firstUserTurn = outline.find((turn) => isObject(turn) && typeof turn.prompt === 'string' && turn.prompt !== '')
  return {
    nativeKey: row.sessionId,
    key: row.sessionId,
    id: row.sessionId,
    name: typeof values.title === 'string' && values.title !== '' ? values.title : undefined,
    cwd,
    created: undefined,
    modified,
    messageCount: typeof values.sessionStats?.steps === 'number' ? values.sessionStats.steps : undefined,
    firstMessage: firstUserTurn === undefined ? undefined : clip(firstUserTurn.prompt),
    model,
    running: row.running === true,
    blank: row.blank === true,
    asOfSeq: typeof projections.asOfSeq === 'number' ? projections.asOfSeq : undefined,
    // A last-projected blank flag is the list's own answer for "no turn yet".
    lastPromptAt: typeof listMetadata.lastPromptAt === 'number' ? listMetadata.lastPromptAt : undefined,
  }
}

function clip(value, limit = 2000) {
  const text = typeof value === 'string' ? value : ''
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/** Current or next model selection from a projections block. */
export function modelFromValues(values) {
  const selection = isObject(values?.modelSelection) ? values.modelSelection : undefined
  const chosen = isObject(selection?.next) ? selection.next : isObject(selection?.lastUsed) ? selection.lastUsed : undefined
  if (chosen === undefined) return null
  if (typeof chosen.provider !== 'string' || typeof chosen.model !== 'string') return null
  return { provider: chosen.provider, id: chosen.model }
}

/** Map one assistant content block onto the bridge's block vocabulary. */
export function blockFromDsh(block) {
  if (!isObject(block)) return null
  switch (block.type) {
    case 'text':
      return { type: 'text', text: typeof block.text === 'string' ? block.text : '' }
    case 'reasoning':
      // The bridge renders reasoning as a `thinking` disclosure block, the same
      // shape Pi and OpenCode produce.
      return { type: 'thinking', thinking: typeof block.text === 'string' ? block.text : '' }
    case 'tool-call':
      return {
        type: 'toolCall',
        id: typeof block.id === 'string' ? block.id : undefined,
        name: typeof block.name === 'string' ? block.name : 'unknown',
        arguments: parseToolArguments(block.arguments),
      }
    case 'image':
      return { type: 'image', source: block.source ?? block }
    default:
      return null
  }
}

/** Normalize dsh token accounting onto the bridge's usage shape. */
export function usageFromDsh(usage) {
  if (!isObject(usage)) return undefined
  const input = numberOrZero(usage.input ?? usage.uncachedInputTokens)
  const output = numberOrZero(usage.output ?? usage.outputTokens)
  const cacheRead = numberOrZero(usage.cacheRead ?? usage.cacheReadTokens)
  const cacheWrite = numberOrZero(usage.cacheWrite ?? usage.cacheWriteTokens)
  if (input + output + cacheRead + cacheWrite === 0) return undefined
  return { input, output, cacheRead, cacheWrite }
}

function numberOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/**
 * Convert one durable Session event into a neutral message, or `undefined` when
 * the event is not transcript content.
 *
 * dsh persists a whole assistant message per step (plus its tool calls as
 * separate `assistant/message` blocks) and pairs every `tool/call` with a later
 * `tool/result`; the neutral shape mirrors Pi's, so the browser's transcript
 * renderer needs no DSH-specific branch.
 */
export function messageFromEvent(event) {
  if (!isObject(event) || !isObject(event.data)) return undefined
  const data = event.data
  if (event.type === 'user/message') {
    if (!isHumanUserMessage(event)) return undefined
    return {
      role: 'user',
      content: Array.isArray(data.content) ? data.content : [],
      id: typeof data.id === 'string' ? data.id : undefined,
      source: isObject(data.source) ? data.source : undefined,
    }
  }
  if (event.type === 'assistant/message') {
    const raw = isObject(data.message) ? data.message : {}
    const content = Array.isArray(raw.content) ? raw.content.map(blockFromDsh).filter(Boolean) : []
    return {
      role: 'assistant',
      content,
      usage: usageFromDsh(data.usage ?? raw.usage),
      ...(data.interrupted === true ? { stopReason: 'aborted' } : {}),
    }
  }
  if (event.type === 'tool/result') {
    const message = isObject(data.message) ? data.message : {}
    return {
      role: 'toolResult',
      toolCallId: typeof message.toolCallId === 'string' ? message.toolCallId : undefined,
      content: Array.isArray(message.content) ? message.content : [],
      isError: message.isError === true,
    }
  }
  return undefined
}

/** True for the event that closes one turn, with its normalized reason. */
export function turnEndFromEvent(event) {
  if (event?.type !== 'turn/end' || !isObject(event.data)) return undefined
  const reason = isObject(event.data.reason) ? event.data.reason : {}
  return {
    turn: typeof event.data.turn === 'number' ? event.data.turn : undefined,
    kind: typeof reason.kind === 'string' ? reason.kind : 'completed',
    aborted: reason.kind === 'aborted',
    error: isObject(reason.error) ? reason.error : undefined,
  }
}

/**
 * Convert a batch of durable events into the neutral live-event vocabulary the
 * host already fans out, then fold the same records into a transcript.
 *
 * One durable event can yield several neutral events (an assistant message is a
 * `message-end`; a turn close is `agent-end` followed by `agent-settled`), and
 * `normalizeEvent` in the engine delegates here.
 */
export function neutralEventsFromDsh(event) {
  if (!isObject(event)) return []
  const out = []
  if (event.type === 'turn/start') {
    out.push({ type: 'agent-start' })
    return out
  }
  const end = turnEndFromEvent(event)
  if (end !== undefined) {
    out.push({ type: 'agent-end' })
    out.push({ type: 'agent-settled', aborted: end.aborted })
    if (end.error !== undefined && typeof end.error.message === 'string') {
      out.push({ type: 'backend-event', event: { type: 'turn-error', message: end.error.message, code: end.error.code } })
    }
    return out
  }
  if (event.type === 'session/title') {
    const title = isObject(event.data) && typeof event.data.title === 'string' ? event.data.title : undefined
    return title === undefined ? [] : [{ type: 'session-name', name: title }]
  }
  if (event.type === 'tool/call') {
    const data = event.data
    return [{
      type: 'tool-start',
      toolCallId: typeof data.callId === 'string' ? data.callId : undefined,
      name: typeof data.name === 'string' ? data.name : 'unknown',
      arguments: parseToolArguments(data.arguments),
    }]
  }
  if (event.type === 'tool/result') {
    const message = isObject(event.data.message) ? event.data.message : {}
    return [{
      type: 'tool-end',
      toolCallId: typeof message.toolCallId === 'string' ? message.toolCallId : undefined,
      result: { content: Array.isArray(message.content) ? message.content : [] },
      isError: message.isError === true,
    }]
  }
  const message = messageFromEvent(event)
  if (message !== undefined) {
    // The remote log has no token deltas, so one durable message is complete.
    return [{ type: 'message-end', message }]
  }
  // Injected context is model-visible but not a transcript turn: dropping it
  // here is what keeps the bridge transcript identical to the remote one.
  if (event.type === 'user/message') return []
  if (INTERNAL_EVENT_TYPES.has(event.type)) return []
  return [{ type: 'backend-event', event }]
}

/**
 * Fold a chronological event batch into the session history shape.
 *
 * Tool results are folded into their call (the transcript renderer pairs them by
 * id), so this mirrors what the Pi reader returns and what `/session` sends.
 */
function addTool(tools, tool) {
  const index = tool.id === undefined ? -1 : tools.findIndex((existing) => existing.id === tool.id)
  if (index === -1) tools.push(tool)
  else tools[index] = { ...tools[index], ...tool }
}

export function historyFromEvents(events) {
  const messages = []
  const tools = []
  let title
  let model
  let lastSeq = -1
  let openTurn
  for (const event of events) {
    if (!isObject(event)) continue
    if (typeof event.seq === 'number' && event.seq > lastSeq) lastSeq = event.seq
    if (event.type === 'session/title' && isObject(event.data) && typeof event.data.title === 'string') title = event.data.title
    const message = messageFromEvent(event)
    if (message !== undefined) messages.push(message)
    // A step records each call twice: once as an `assistant/message` block and
    // once as the durable `tool/call` event. They are one call, so the id is
    // the identity and the later record wins.
    if (event.type === 'tool/call' && isObject(event.data)) {
      const id = typeof event.data.callId === 'string' ? event.data.callId : undefined
      addTool(tools, {
        id,
        name: typeof event.data.name === 'string' ? event.data.name : 'unknown',
        arguments: parseToolArguments(event.data.arguments),
        status: 'done',
      })
    }
    if (event.type === 'assistant/message') {
      for (const block of messages[messages.length - 1]?.content ?? []) {
        if (block.type === 'toolCall') addTool(tools, { id: block.id, name: block.name, arguments: block.arguments, status: 'done' })
      }
    }
    if (event.type === 'turn/start') openTurn = isObject(event.data) ? event.data.turn : undefined
    if (event.type === 'turn/end') openTurn = undefined
  }
  return { messages, tools, title, model, lastSeq, openTurn }
}

/**
 * The page result is `{records:[{type:'event',event}], hasMore}`; only the event
 * payloads matter here, and only those newer than a caller's cursor.
 */
export function eventsFromPage(page, { after = -1 } = {}) {
  const records = Array.isArray(page?.records) ? page.records : []
  const events = []
  for (const record of records) {
    const event = isObject(record) && isObject(record.event) ? record.event : undefined
    if (event === undefined) continue
    if (typeof event.seq === 'number' && event.seq <= after) continue
    events.push(event)
  }
  return events.sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0))
}

/**
 * Flatten the host-global model catalog into the bridge's model list.
 * `groups[i].models[j]` becomes one entry carrying its provider id.
 */
export function modelsFromCatalog(catalog) {
  const groups = Array.isArray(catalog?.groups) ? catalog.groups : []
  const models = []
  for (const group of groups) {
    if (!isObject(group)) continue
    const provider = typeof group.id === 'string' ? group.id : ''
    const list = Array.isArray(group.models) ? group.models : []
    for (const model of list) {
      if (!isObject(model) || typeof model.id !== 'string' || model.id === '') continue
      models.push({
        id: model.id,
        provider,
        name: typeof model.name === 'string' && model.name !== '' ? model.name : model.id,
        contextWindow: numberOrZero(model.contextWindow ?? model.limit?.context),
        reasoning: isObject(model.reasoning) && Array.isArray(model.reasoning.efforts) && model.reasoning.efforts.length > 0,
      })
    }
  }
  return models
}

/**
 * Projections carry dsh's own accounting; map it onto the statusline shape the
 * bridge already renders for Pi.
 */
export function statsFromProjections(values) {
  if (!isObject(values)) return null
  const usage = isObject(values.tokenUsage) ? values.tokenUsage : {}
  const stats = isObject(values.sessionStats) ? values.sessionStats : {}
  const pressure = isObject(values.contextPressure) ? values.contextPressure : {}
  const contextWindow = numberOrZero(pressure.contextWindow)
  const contextUsed = numberOrZero(pressure.projectedTokens ?? pressure.pressureTokens)
  return {
    userMessages: numberOrZero(stats.turns),
    assistantMessages: numberOrZero(stats.steps),
    turns: numberOrZero(stats.turns),
    steps: numberOrZero(stats.steps),
    // The remote projections carry no tool-call total; callers that read the
    // log (the engine's readSession) fill this in from the durable history.
    toolCalls: numberOrZero(values.toolCallCount),
    totalMessages: numberOrZero(stats.steps) + numberOrZero(stats.turns),
    tokens: {
      input: numberOrZero(usage.uncachedInputTokens),
      output: numberOrZero(usage.outputTokens),
      cacheRead: numberOrZero(usage.cacheReadTokens),
      cacheWrite: numberOrZero(usage.cacheWriteTokens),
    },
    contextUsage: contextWindow > 0
      ? { tokens: contextUsed, contextWindow, percent: contextWindow > 0 ? (contextUsed / contextWindow) * 100 : 0 }
      : undefined,
  }
}
