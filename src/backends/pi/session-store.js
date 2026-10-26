/**
 * Read-only access to Pi Coding Agent session files.
 *
 * Pi stores one JSONL file per session below
 * `$PI_CODING_AGENT_SESSION_DIR` (or `$PI_CODING_AGENT_DIR/sessions`). The
 * first line is a session header; every later line is a tree entry linked by
 * `id` / `parentId`. This module deliberately does not import Pi: dsh only
 * needs the durable view, and keeping the parser here avoids a hard runtime
 * dependency on one Pi version.
 */
import { randomUUID } from 'node:crypto'
import { closeSync, createReadStream, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

const MAX_TEXT = 2000

export function piAgentDir(env = process.env) {
  return env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent')
}

export function piSessionsRoot(env = process.env) {
  return resolve(env.PI_CODING_AGENT_SESSION_DIR || join(piAgentDir(env), 'sessions'))
}

/** Encode an absolute session path into an opaque browser-facing key. */
export function sessionKey(filePath) {
  return Buffer.from(filePath, 'utf8').toString('base64url')
}

/** Decode and validate a browser key against the configured sessions root. */
export function pathFromSessionKey(key, root = piSessionsRoot()) {
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
    throw new Error('session path is outside the Pi sessions root')
  }
  if (!absolute.endsWith('.jsonl')) throw new Error('session path must be a .jsonl file')
  return absolute
}

/** Small clipped string used for list rows. */
function clip(value) {
  const text = typeof value === 'string' ? value : ''
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '…' : text
}

function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

function parseLine(line) {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

/** Walk session entries from the newest leaf back to the root. */
function currentBranch(entries) {
  const byId = new Map()
  for (const entry of entries) {
    if (entry && typeof entry.id === 'string') byId.set(entry.id, entry)
  }
  let leaf
  // The last entry with an id is the tree leaf. Session-info and other
  // non-message entries still belong to the branch and may carry the name.
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry && typeof entry.id === 'string') {
      leaf = entry
      break
    }
  }
  if (leaf === undefined) return entries.slice()
  const chain = []
  const seen = new Set()
  let current = leaf
  while (current && typeof current === 'object' && !seen.has(current.id)) {
    chain.push(current)
    if (typeof current.id === 'string') seen.add(current.id)
    current = typeof current.parentId === 'string' ? byId.get(current.parentId) : undefined
  }
  return chain.reverse()
}

/**
 * Parse one Pi session file into the shape consumed by the browser.
 * Large files are read line-by-line; only the current branch becomes history.
 */
export async function readPiSession(filePath) {
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

  const parsed = lines.map(parseLine).filter((item) => item !== undefined)
  const header = parsed.find((item) => item && item.type === 'session')
  if (header === undefined) throw new Error('not a Pi session file: missing session header')
  const entries = parsed.filter((item) => item && item.type !== 'session')
  const branch = currentBranch(entries)
  const messages = []
  const tools = []
  let name
  let model
  let thinkingLevel
  for (const entry of branch) {
    if (entry.type === 'session_info' && typeof entry.name === 'string') name = entry.name
    // Pi records the effective model as a dedicated tree entry whenever the
    // user switches models, and stamps every assistant message with the model
    // that produced it. Both are durable, so the current model is readable
    // without attaching an agent.
    if (entry.type === 'model_change') {
      if (typeof entry.provider === 'string' && typeof entry.modelId === 'string') {
        model = { provider: entry.provider, id: entry.modelId }
      }
      continue
    }
    if (entry.type === 'thinking_level_change') {
      if (typeof entry.level === 'string') thinkingLevel = entry.level
      continue
    }
    if (entry.type !== 'message' || !entry.message) continue
    const message = entry.message
    if (message.role === 'assistant' && typeof message.provider === 'string' && typeof message.model === 'string') {
      // The newest assistant turn is a stronger signal than an older
      // model_change when a turn used a fallback model.
      model = { provider: message.provider, id: message.model }
      if (typeof message.thinkingLevel === 'string') thinkingLevel = message.thinkingLevel
    }
    if (message.role === 'user' || message.role === 'assistant' || message.role === 'toolResult') {
      messages.push(message)
    } else if (message.role === 'custom' || message.role === 'bashExecution') {
      messages.push(message)
    }
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block && block.type === 'toolCall') {
          tools.push({ id: block.id, name: block.name, arguments: block.arguments, status: 'done' })
        }
      }
    }
  }

  const last = statSync(filePath)
  const firstUser = messages.find((message) => message.role === 'user')
  return {
    path: filePath,
    key: sessionKey(filePath),
    id: typeof header.id === 'string' ? header.id : undefined,
    name,
    cwd: typeof header.cwd === 'string' ? header.cwd : undefined,
    created: typeof header.timestamp === 'string' ? header.timestamp : undefined,
    modified: last.mtime.toISOString(),
    bytes: last.size,
    messageCount: messages.length,
    firstMessage: clip(textOfContent(firstUser?.content)),
    model: model ?? null,
    thinkingLevel: thinkingLevel ?? null,
    messages,
    tools,
  }
}

/** Recursively collect session files, newest first. */
export function collectSessionFiles(root = piSessionsRoot()) {
  if (!existsSync(root)) return []
  const files = []
  const walk = (dir, depth) => {
    if (depth > 3) return
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

const SUMMARY_CHUNK_BYTES = 128 * 1024

/**
 * Read a cheap list summary without parsing the whole session.
 *
 * Session files routinely reach several megabytes. The sidebar needs only the
 * header, the first user message, the last session name, and mtime, so this
 * reads a bounded prefix and suffix. The full branch is parsed only after the
 * user opens one session.
 */
export function readPiSessionSummary(filePath) {
  const stats = statSync(filePath)
  if (stats.size <= SUMMARY_CHUNK_BYTES * 2) return summarizeSessionText(readFileSync(filePath, 'utf8'), filePath, stats)

  const fd = openSync(filePath, 'r')
  let head
  let tail
  try {
    head = Buffer.alloc(SUMMARY_CHUNK_BYTES)
    const headBytes = readSync(fd, head, 0, SUMMARY_CHUNK_BYTES, 0)
    tail = Buffer.alloc(SUMMARY_CHUNK_BYTES)
    const tailBytes = readSync(fd, tail, 0, SUMMARY_CHUNK_BYTES, stats.size - SUMMARY_CHUNK_BYTES)
    const headText = head.subarray(0, headBytes).toString('utf8')
    const tailText = tail.subarray(0, tailBytes).toString('utf8')
    return summarizeSessionText(
      headText.slice(0, headText.lastIndexOf('\n') + 1) + '\n' + tailText.slice(tailText.indexOf('\n') + 1),
      filePath,
      stats,
    )
  } finally {
    closeSync(fd)
  }
}

function summarizeSessionText(text, filePath, stats) {
  const parsed = text
    .split('\n')
    .map(parseLine)
    .filter((item) => item !== undefined)
  const header = parsed.find((item) => item !== null && item.type === 'session')
  if (header === undefined) throw new Error('not a Pi session file: missing session header')
  let name
  let firstUser
  for (const entry of parsed) {
    if (entry === null || typeof entry !== 'object') continue
    if (entry.type === 'session_info' && typeof entry.name === 'string') name = entry.name
    if (firstUser === undefined && entry.type === 'message' && entry.message?.role === 'user') firstUser = entry.message
  }
  return {
    key: sessionKey(filePath),
    id: typeof header.id === 'string' ? header.id : undefined,
    name,
    cwd: typeof header.cwd === 'string' ? header.cwd : undefined,
    created: typeof header.timestamp === 'string' ? header.timestamp : undefined,
    modified: stats.mtime.toISOString(),
    bytes: stats.size,
    messageCount: undefined,
    firstMessage: clip(textOfContent(firstUser?.content)),
  }
}

/**
 * Encode a cwd into the same project-directory name Pi uses below its session
 * root. Keeping this local avoids importing the Pi CLI just to create a file.
 */
export function piSessionDirFor(cwd, root = piSessionsRoot()) {
  const resolvedCwd = resolve(cwd)
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
  return join(resolve(root), safePath)
}

/**
 * Create one empty, Pi-compatible JSONL session for a workspace.
 *
 * Pi normally defers creating a session file until the first user message.
 * The Bridge needs a stable file/key before the composer can attach, so we
 * write the session header ourselves. Pi opens this file by `--session` and
 * appends its own entries when the user sends the first message.
 */
export async function createPiSession(cwd, root = piSessionsRoot()) {
  const resolvedCwd = resolve(cwd)
  const info = await stat(resolvedCwd)
  if (!info.isDirectory()) throw Object.assign(new Error(`not a directory: ${resolvedCwd}`), { status: 400 })
  const directory = piSessionDirFor(resolvedCwd, root)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const id = randomUUID()
  const timestamp = new Date().toISOString()
  const fileTimestamp = timestamp.replace(/[:.]/g, '-')
  const file = join(directory, `${fileTimestamp}_${id}.jsonl`)
  const header = { type: 'session', version: 3, id, timestamp, cwd: resolvedCwd }
  await writeFile(file, `${JSON.stringify(header)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  return readPiSessionSummary(file)
}

/** List Pi sessions for the sidebar without opening full histories. */
export async function listPiSessions(root = piSessionsRoot(), options = {}) {
  const limit = Math.max(1, Math.min(options.limit ?? 200, 1000))
  const sessions = []
  for (const file of collectSessionFiles(root)) {
    if (sessions.length >= limit) break
    try {
      sessions.push(readPiSessionSummary(file))
    } catch {
      // A concurrently-written or malformed file should not hide every other
      // session from the list.
    }
  }
  return sessions
}
