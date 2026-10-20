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
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs'
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
  for (const entry of branch) {
    if (entry.type === 'session_info' && typeof entry.name === 'string') name = entry.name
    if (entry.type !== 'message' || !entry.message) continue
    const message = entry.message
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

/**
 * List Pi sessions for the sidebar. This reads only the current branch and
 * clips previews, so a 1000-session home remains responsive.
 */
export async function listPiSessions(root = piSessionsRoot(), options = {}) {
  const limit = Math.max(1, Math.min(options.limit ?? 200, 1000))
  const sessions = []
  for (const file of collectSessionFiles(root)) {
    if (sessions.length >= limit) break
    try {
      const session = await readPiSession(file)
      sessions.push({
        key: session.key,
        id: session.id,
        name: session.name,
        cwd: session.cwd,
        created: session.created,
        modified: session.modified,
        bytes: session.bytes,
        messageCount: session.messageCount,
        firstMessage: session.firstMessage,
      })
    } catch {
      // A concurrently-written or malformed file should not hide every other
      // session from the list.
    }
  }
  return sessions
}
