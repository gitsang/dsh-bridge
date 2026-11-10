/**
 * Read-only access to Codex CLI rollout files, plus creation of a resumable
 * session header.
 *
 * Codex appends one JSONL record per event below
 * `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<iso>-<uuid>.jsonl`. The same event
 * is often written twice in different shapes (`response_item` holds the model
 * transcript, `event_msg` holds the app-server/TUI view), so this module owns
 * the de-duplication rules: the response items are canonical, and user turns
 * fall back to `event_msg:user_message` only for rollouts that never record
 * user response items. dsh only needs the durable view, so the parser lives
 * here instead of importing codex-cli.
 */
import { randomUUID } from 'node:crypto'
import { closeSync, createReadStream, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

const MAX_TEXT = 2000
const MAX_NAME = 120

/**
 * User-role response items that Codex's own harness injects before the first
 * real turn. They are plumbing (sandbox rules, AGENTS.md, delegated-subagent
 * prompts) and must never show up as the user's message or the session title.
 */
const INJECTED_USER_PREFIXES = [
  '<environment_context>',
  '<user_instructions>',
  '<permissions instructions>',
  '<turn_aborted>',
  '<subagent_notification>',
  '<skill>',
  '# AGENTS.md instructions',
  'Warning: apply_patch was requested via exec_command.',
]

export function codexHome(env = process.env) {
  return env.CODEX_HOME || join(homedir(), '.codex')
}

export function codexSessionsRoot(env = process.env) {
  return resolve(join(codexHome(env), 'sessions'))
}

/**
 * Read the top-level `model_provider` from `$CODEX_HOME/config.toml`.
 *
 * A resumed rollout's `session_meta` must name a provider the local codex
 * knows, otherwise app-server refuses to load it. The header we write for a
 * brand-new session therefore copies the user's configured provider instead of
 * guessing; `openai` is Codex's built-in default.
 */
export function codexConfigValue(key, env = process.env) {
  try {
    const text = readFileSync(join(codexHome(env), 'config.toml'), 'utf8')
    // Top-level keys precede the first table header; later occurrences belong
    // to a profile section and must not override the active value.
    for (const line of text.split('\n')) {
      if (/^\s*\[/.test(line)) break
      const match = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`).exec(line)
      if (match !== null && match[1] !== '') return match[1]
    }
  } catch {
    // No config file: fall back to Codex's built-in defaults.
  }
  return undefined
}

/** The provider a local codex knows; `openai` is its built-in default. */
export function codexModelProvider(env = process.env) {
  return codexConfigValue('model_provider', env) ?? 'openai'
}

/** The model named in the user's own config, if any. */
export function codexModelId(env = process.env) {
  return codexConfigValue('model', env)
}

/** Encode an absolute rollout path into an opaque browser-facing key. */
export function sessionKey(filePath) {
  return Buffer.from(filePath, 'utf8').toString('base64url')
}

/** Decode and validate a browser key against the configured sessions root. */
export function pathFromSessionKey(key, root = codexSessionsRoot()) {
  if (typeof key !== 'string' || key === '') throw new Error('missing session key')
  let decoded
  try {
    decoded = Buffer.from(key, 'base64url').toString('utf8')
  } catch {
    throw new Error('invalid session key')
  }
  const absolute = resolve(decoded)
  const cleanRoot = resolve(root)
  if (absolute !== cleanRoot && !absolute.startsWith(cleanRoot + sep)) {
    throw new Error('session path is outside the Codex sessions root')
  }
  if (!absolute.endsWith('.jsonl')) throw new Error('session path must be a .jsonl file')
  return absolute
}

/** Small clipped string used for list rows. */
function clip(value, limit = MAX_TEXT) {
  const text = typeof value === 'string' ? value : ''
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/** The session title is derived from the first real user message, never invented. */
function titleFrom(text) {
  const first = (typeof text === 'string' ? text : '').trim().split('\n')[0].trim()
  return first === '' ? undefined : clip(first, MAX_NAME)
}

/** True when a user-role response item is harness plumbing, not a user turn. */
export function isInjectedUserText(text) {
  const value = typeof text === 'string' ? text.trimStart() : ''
  return INJECTED_USER_PREFIXES.some((prefix) => value.startsWith(prefix))
}

const TEXT_BLOCK_TYPES = new Set(['text', 'input_text', 'output_text'])

function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block !== null && typeof block === 'object' && typeof block.text === 'string' && TEXT_BLOCK_TYPES.has(block.type))
    .map((block) => block.text)
    .join('\n')
}

/** Reasoning is only readable through `summary`/`content`; encrypted_content never is. */
function reasoningText(payload) {
  const parts = []
  for (const list of [payload.summary, payload.content]) {
    if (!Array.isArray(list)) continue
    for (const item of list) {
      if (item !== null && typeof item === 'object' && typeof item.text === 'string' && item.text !== '') parts.push(item.text)
    }
  }
  return parts.join('\n\n')
}

/**
 * `apply_patch` arrives as free-form patch text. Surface the first touched path
 * so the client's edit row can name a file instead of dumping the patch body.
 */
function customInputArguments(name, input) {
  if (name !== 'apply_patch') return { input }
  const match = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/m.exec(input)
  return match === null ? { input } : { path: match[1].trim(), patch: input }
}

function toolCallBlock(payload) {
  const id = typeof payload.call_id === 'string'
    ? payload.call_id
    : (typeof payload.id === 'string' ? payload.id : undefined)
  if (id === undefined) return null
  let args
  if (typeof payload.arguments === 'string') {
    try {
      args = JSON.parse(payload.arguments)
    } catch {
      args = { input: payload.arguments }
    }
  } else if (payload.arguments !== undefined && payload.arguments !== null) {
    args = payload.arguments
  } else if (typeof payload.input === 'string') {
    args = customInputArguments(payload.name, payload.input)
  } else {
    args = {}
  }
  return { type: 'toolCall', id, name: typeof payload.name === 'string' ? payload.name : 'tool', arguments: args }
}

function toolOutputText(payload) {
  const output = payload.output
  if (typeof output === 'string') return output
  if (Array.isArray(output)) {
    return output
      .filter((block) => block !== null && typeof block === 'object' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
  }
  if (output !== undefined && output !== null) {
    try {
      return JSON.stringify(output)
    } catch {
      return ''
    }
  }
  return ''
}

function toolOutputIsError(payload, text) {
  if (payload.status === 'failed' || payload.status === 'declined') return true
  const output = payload.output
  if (output !== null && typeof output === 'object' && !Array.isArray(output)) {
    const exitCode = output.metadata?.exit_code
    if (typeof exitCode === 'number' && exitCode !== 0) return true
  }
  return /Process exited with code [1-9]\d*/.test(text)
}

function parseLine(line) {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

function timestampMs(record) {
  const parsed = Date.parse(record?.timestamp ?? '')
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Pull every JSONL line out of a (possibly multi-megabyte) rollout. */
async function readLines(filePath) {
  const lines = []
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(filePath, { encoding: 'utf8' })
    let buffer = ''
    stream.on('data', (chunk) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        lines.push(buffer.slice(0, newline).replace(/\r$/, ''))
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
      }
    })
    stream.on('error', reject)
    stream.on('end', () => {
      if (buffer !== '') lines.push(buffer.replace(/\r$/, ''))
      resolvePromise()
    })
  })
  return lines
}

function sessionMeta(parsed) {
  const header = parsed.find((record) => record !== null && typeof record === 'object' && record.type === 'session_meta')
  if (header === undefined) throw new Error('not a Codex rollout: missing session_meta header')
  return header
}

function settingsModel(payload) {
  const settings = payload?.thread_settings
  if (settings === null || typeof settings !== 'object') return null
  if (typeof settings.model !== 'string' || settings.model === '') return null
  return {
    provider: typeof settings.model_provider_id === 'string' ? settings.model_provider_id : null,
    id: settings.model,
  }
}

/**
 * Build the normalized transcript the browser consumes.
 *
 * One assistant message per turn collects `thinking`, `text`, and `toolCall`
 * blocks in rollout order — the same block vocabulary Pi uses — while tool
 * outputs become separate `toolResult` messages the client folds into the
 * matching call row.
 */
function transcriptFrom(parsed) {
  const messages = []
  const tools = []
  const hasEventUsers = parsed.some((record) =>
    record?.type === 'event_msg' && record.payload?.type === 'user_message' && typeof record.payload.message === 'string')
  const hasResponseAssistants = parsed.some((record) =>
    record?.type === 'response_item' && record.payload?.type === 'message' && record.payload.role === 'assistant')
  let assistant
  let provider
  let modelId
  let cwd
  let firstUser = ''
  const calls = new Map()

  const pushUser = (text, timestamp) => {
    const value = typeof text === 'string' ? text : ''
    if (value.trim() === '') return
    messages.push({ role: 'user', content: [{ type: 'text', text: value }], timestamp })
    if (firstUser === '') firstUser = value
    // A new user turn always starts a fresh assistant message, even when the
    // previous turn never emitted its own closing record.
    assistant = undefined
  }

  const ensureAssistant = (timestamp) => {
    if (assistant !== undefined) return assistant
    assistant = { role: 'assistant', content: [], timestamp }
    messages.push(assistant)
    return assistant
  }

  for (const record of parsed) {
    if (record === null || typeof record !== 'object') continue
    const payload = record.payload ?? {}
    const timestamp = timestampMs(record)
    switch (record.type) {
      case 'session_meta': {
        if (typeof payload.cwd === 'string') cwd = payload.cwd
        if (typeof payload.model_provider === 'string') provider = payload.model_provider
        continue
      }
      case 'turn_context': {
        // The most reliable workspace path: session_meta can be rewritten or
        // copied, while every turn stamps the cwd it actually ran in.
        if (typeof payload.cwd === 'string') cwd = payload.cwd
        if (typeof payload.model === 'string') modelId = payload.model
        continue
      }
      case 'event_msg': {
        if (payload.type === 'thread_settings_applied') {
          const settings = settingsModel(payload)
          if (settings !== null) {
            if (typeof settings.provider === 'string' && settings.provider !== '') provider = settings.provider
            modelId = settings.id
          }
        }
        if (hasEventUsers && payload.type === 'user_message') {
          pushUser(payload.message, timestamp)
          continue
        }
        if (!hasResponseAssistants && payload.type === 'agent_message' && typeof payload.message === 'string') {
          const message = ensureAssistant(timestamp)
          message.content.push({ type: 'text', text: payload.message })
        }
        continue
      }
      case 'response_item': {
        switch (payload.type) {
          case 'message': {
            if (payload.role === 'user') {
              if (hasEventUsers) continue
              const text = textOfContent(payload.content)
              if (isInjectedUserText(text)) continue
              pushUser(text, timestamp)
            } else if (payload.role === 'assistant') {
              const text = textOfContent(payload.content)
              if (text.trim() === '') continue
              ensureAssistant(timestamp).content.push({ type: 'text', text })
            }
            // developer/system messages are harness plumbing: never transcript.
            continue
          }
          case 'reasoning': {
            const text = reasoningText(payload)
            if (text.trim() === '') continue
            ensureAssistant(timestamp).content.push({ type: 'thinking', thinking: text })
            continue
          }
          case 'function_call':
          case 'custom_tool_call': {
            const block = toolCallBlock(payload)
            if (block === null) continue
            ensureAssistant(timestamp).content.push(block)
            calls.set(block.id, { name: block.name, arguments: block.arguments })
            tools.push({ id: block.id, name: block.name, arguments: block.arguments, status: 'done' })
            continue
          }
          case 'function_call_output':
          case 'custom_tool_call_output': {
            const id = typeof payload.call_id === 'string' ? payload.call_id : undefined
            if (id === undefined) continue
            const text = toolOutputText(payload)
            const isError = toolOutputIsError(payload, text)
            messages.push({ role: 'toolResult', toolCallId: id, content: [{ type: 'text', text }], isError })
            const tool = tools.find((entry) => entry.id === id)
            if (tool !== undefined) tool.status = isError ? 'error' : 'done'
            continue
          }
          default:
            continue
        }
      }
      default:
        // world_state, compacted, token_usage_record and future record types
        // carry no transcript content.
        continue
    }
  }
  // A model with no id is not a usable selection for the client picker; report
  // "unknown" instead of a half-empty pair.
  const model = modelId === undefined ? null : { provider: provider ?? null, id: modelId }
  return { messages, tools, model, cwd, firstUser }
}

/**
 * Parse one rollout into the full session shape the browser expects.
 *
 * The durable file — not `thread/read` — is the source of truth: codex-cli
 * 0.162.1 answers `thread/read {includeTurns:true}` with "list_turns is not
 * supported yet", and the file gives exactly the same records a live read
 * would, including turns that a crash never delivered as notifications.
 */
export async function readCodexSession(filePath) {
  const lines = await readLines(filePath)
  const parsed = lines.map(parseLine).filter((record) => record !== undefined)
  const header = sessionMeta(parsed)
  const transcript = transcriptFrom(parsed)
  const stats = statSync(filePath)
  const messages = transcript.messages
  return {
    path: filePath,
    key: sessionKey(filePath),
    id: typeof header.payload?.session_id === 'string'
      ? header.payload.session_id
      : (typeof header.payload?.id === 'string' ? header.payload.id : undefined),
    name: titleFrom(transcript.firstUser),
    cwd: transcript.cwd,
    created: typeof header.timestamp === 'string' ? header.timestamp : undefined,
    modified: stats.mtime.toISOString(),
    bytes: stats.size,
    messageCount: messages.length,
    firstMessage: clip(transcript.firstUser),
    model: transcript.model,
    thinkingLevel: null,
    messages,
    tools: transcript.tools,
  }
}

const HEAD_BYTES = 256 * 1024
const TAIL_BYTES = 64 * 1024

/**
 * Read a cheap list summary without parsing the whole rollout.
 *
 * Rollouts routinely reach several megabytes, and the first real user message
 * can sit ~150KB in (behind the session_meta instructions and the developer
 * preamble), so the head window is larger than Pi's; the tail only supplies the
 * latest turn context/model.
 */
export function readCodexSessionSummary(filePath) {
  const stats = statSync(filePath)
  if (stats.size <= HEAD_BYTES + TAIL_BYTES) {
    return summarizeRolloutText(readFileSync(filePath, 'utf8'), filePath, stats)
  }
  const fd = openSync(filePath, 'r')
  try {
    const head = Buffer.alloc(HEAD_BYTES)
    const headBytes = readSync(fd, head, 0, HEAD_BYTES, 0)
    const tail = Buffer.alloc(TAIL_BYTES)
    const tailBytes = readSync(fd, tail, 0, TAIL_BYTES, stats.size - TAIL_BYTES)
    const headText = head.subarray(0, headBytes).toString('utf8')
    const tailText = tail.subarray(0, tailBytes).toString('utf8')
    // Cut both windows on a newline so a half-read line can never parse into a
    // misleading partial record.
    return summarizeRolloutText(
      `${headText.slice(0, headText.lastIndexOf('\n') + 1)}\n${tailText.slice(tailText.indexOf('\n') + 1)}`,
      filePath,
      stats,
    )
  } finally {
    closeSync(fd)
  }
}

function summarizeRolloutText(text, filePath, stats) {
  const parsed = text.split('\n').map(parseLine).filter((record) => record !== undefined)
  const header = sessionMeta(parsed)
  const transcript = transcriptFrom(parsed)
  return {
    key: sessionKey(filePath),
    id: typeof header.payload?.session_id === 'string'
      ? header.payload.session_id
      : (typeof header.payload?.id === 'string' ? header.payload.id : undefined),
    name: titleFrom(transcript.firstUser),
    cwd: transcript.cwd,
    created: typeof header.timestamp === 'string' ? header.timestamp : undefined,
    modified: stats.mtime.toISOString(),
    bytes: stats.size,
    // The true count needs the whole file; a head/tail sample would only guess.
    messageCount: undefined,
    firstMessage: clip(transcript.firstUser),
    model: transcript.model,
  }
}

/** Recursively collect rollout files, newest first. */
export function collectRolloutFiles(root = codexSessionsRoot()) {
  if (!existsSync(root)) return []
  const files = []
  const walk = (dir, depth) => {
    if (depth > 4) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(full)
    }
  }
  walk(root, 0)
  return files.sort((left, right) => {
    try {
      return statSync(right).mtimeMs - statSync(left).mtimeMs
    } catch {
      return 0
    }
  })
}

/** List Codex sessions for the sidebar without opening full histories. */
export async function listCodexSessions(root = codexSessionsRoot(), options = {}) {
  const limit = Math.max(1, Math.min(options.limit ?? 200, 1000))
  const sessions = []
  for (const file of collectRolloutFiles(root)) {
    if (sessions.length >= limit) break
    try {
      sessions.push(readCodexSessionSummary(file))
    } catch {
      // A concurrently-written or malformed rollout must not hide every other
      // session from the list.
    }
  }
  return sessions
}

/** Read the thread id a rollout is filed under, falling back to its filename. */
export function readRolloutThreadId(filePath) {
  try {
    const first = readFileSync(filePath, 'utf8').split('\n', 1)[0]
    const header = parseLine(first)
    const payload = header?.payload ?? {}
    if (typeof payload.session_id === 'string' && payload.session_id !== '') return payload.session_id
    if (typeof payload.id === 'string' && payload.id !== '') return payload.id
  } catch {
    // Fall through to the filename: a rollout is named after its thread id.
  }
  const match = /rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(filePath)
  return match === null ? undefined : match[1]
}

/**
 * Create one minimal, Codex-resumable rollout for a workspace.
 *
 * Codex only materializes a rollout on the first turn, but the Bridge needs a
 * stable native key before composing. A single `session_meta` line is enough
 * for `thread/resume` (verified against codex-cli 0.162.1), provided the header
 * names both a `cli_version` and a `model_provider` codex knows: without them
 * app-server reports "failed to read session metadata" or "Model provider not
 * found".
 */
export async function createCodexSession(cwd, root = codexSessionsRoot(), options = {}) {
  const resolvedCwd = resolve(cwd)
  const info = await stat(resolvedCwd)
  if (!info.isDirectory()) throw Object.assign(new Error(`not a directory: ${resolvedCwd}`), { status: 400 })
  const rootInfo = await stat(resolve(root))
  if (!rootInfo.isDirectory()) throw Object.assign(new Error(`sessions root is not a directory: ${resolve(root)}`), { status: 400 })

  const id = randomUUID()
  const timestamp = new Date().toISOString()
  const fileTimestamp = timestamp.replace(/\.\d+Z$/, '').replace(/:/g, '-')
  const directory = join(resolve(root), timestamp.slice(0, 4), timestamp.slice(5, 7), timestamp.slice(8, 10))
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const file = join(directory, `rollout-${fileTimestamp}-${id}.jsonl`)
  const header = {
    timestamp,
    ordinal: 0,
    type: 'session_meta',
    payload: {
      session_id: id,
      id,
      timestamp,
      cwd: resolvedCwd,
      originator: 'dsh-bridge',
      cli_version: typeof options.cliVersion === 'string' && options.cliVersion !== '' ? options.cliVersion : '0.0.0',
      source: 'cli',
      model_provider: typeof options.modelProvider === 'string' && options.modelProvider !== ''
        ? options.modelProvider
        : codexModelProvider(options.env ?? process.env),
    },
  }
  await writeFile(file, `${JSON.stringify(header)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  return readCodexSessionSummary(file)
}
