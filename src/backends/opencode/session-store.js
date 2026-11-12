/**
 * Read-only access to the OpenCode session database.
 *
 * OpenCode persists the durable view of every session in a single SQLite file
 * (`<dataDir>/opencode.db`, WAL mode). Two storage generations coexist there:
 *
 * - legacy: `session` + `message`/`part`, where a part is a JSON document with
 *   `type` ∈ text|reasoning|tool|step-start|step-finish|patch|file|compaction;
 * - v2: `session_v2` + `session_message`, where one row already holds a role
 *   and, for assistants, a complete block array in `data.content`.
 *
 * The installed CLI is the authority on which generation a session uses, not
 * this module: 1.19.5 writes new sessions into the legacy tables, while older
 * sessions carry v2 rows (and some carry both). The adapter therefore unions
 * both generations for listing and picks the transcript source per session.
 *
 * dsh only ever reads this database. OpenCode owns the single write handle, and
 * every read closes the connection immediately: a long-lived WAL reader would
 * pin the WAL checkpoint and make the owner's writes more expensive.
 */
import { accessSync, constants, existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const MAX_TEXT = 2000
const DEFAULT_LIMIT = 200
const MAX_LIMIT = 1000

/**
 * OpenCode mints session ids as `ses_` plus a 24-char base62 token. Browser
 * keys reach this module as query strings, so a malformed value must be
 * rejected before it becomes a SQL parameter (or a path segment elsewhere).
 */
const SESSION_ID_PATTERN = /^ses_[A-Za-z0-9]{6,64}$/

/**
 * OpenCode tool names mapped onto the vocabulary dsh's tool rows are styled by.
 *
 * The browser derives a row's icon, title and argument summary from the tool
 * *name* (its `TOOL_VARIANT_BY_NAME` table), so every entry here resolves to a
 * name that table knows: `grep`/`glob` render as search rows, `web_fetch` and
 * `ls` as read rows, and an unknown tool becomes `others` rather than a name the
 * client would render unstyled.
 */
const BRIDGE_TOOL_NAME = new Map([
  ['bash', 'bash'],
  ['shell', 'bash'],
  ['pwsh', 'bash'],
  ['read', 'read'],
  ['read_file', 'read'],
  ['ls', 'ls'],
  ['list', 'ls'],
  ['grep', 'grep'],
  ['glob', 'glob'],
  ['webfetch', 'web_fetch'],
  ['web_fetch', 'web_fetch'],
  ['websearch', 'web_search'],
  ['web_search', 'web_search'],
  ['write', 'write'],
  ['edit', 'edit'],
  ['multiedit', 'edit'],
  ['patch', 'edit'],
  ['apply_patch', 'edit'],
  ['run_code', 'run_code'],
])

/** Translate one native OpenCode tool name into the dsh bridge vocabulary. */
export function bridgeToolName(name) {
  if (typeof name !== 'string') return 'others'
  const key = name.trim().toLowerCase()
  return BRIDGE_TOOL_NAME.get(key) ?? 'others'
}

/**
 * Normalize tool-call arguments for the transcript rows.
 *
 * OpenCode renamed `filePath` to `path` in its tool schemas. Old sessions keep
 * the old key, and the browser's summary/file-path logic only reads `path`, so
 * mirror the value instead of mutating what the agent actually sent.
 */
export function bridgeToolArguments(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return {}
  if (typeof args.filePath !== 'string' || typeof args.path === 'string') return args
  return { ...args, path: args.filePath }
}

/** Resolve the OpenCode data directory that holds `opencode.db`. */
export function opencodeDataDir(config = {}, env = process.env) {
  if (typeof config.sessionsRoot === 'string' && config.sessionsRoot.trim() !== '') {
    return resolve(config.sessionsRoot.trim())
  }
  const dataHome = typeof env.XDG_DATA_HOME === 'string' && env.XDG_DATA_HOME.trim() !== ''
    ? env.XDG_DATA_HOME.trim()
    : join(homedir(), '.local', 'share')
  return resolve(join(dataHome, 'opencode'))
}

/**
 * Resolve the SQLite file the engine keeps its sessions in.
 *
 * `opencode.db` is what both 1.x and 2.x write, but 2.x also honours
 * `OPENCODE_DB` (an explicit path) and channels can name their file
 * `opencode-<channel>.db`. A 2.x-only install whose database is one of those
 * must still pass the readiness probe, so the lookup is: an explicit
 * `OPENCODE_DB`, then `opencode.db`, then any `opencode-*.db` sibling. When
 * nothing exists the plain path is returned so the error names what was tried.
 */
export function opencodeDatabasePath(config = {}, env = process.env) {
  const dataDir = opencodeDataDir(config, env)
  const explicit = typeof env.OPENCODE_DB === 'string' ? env.OPENCODE_DB.trim() : ''
  // `:memory:` is a valid 2.x value but is not a readable file, so it can never
  // satisfy the probe; fall through to the on-disk candidates instead.
  if (explicit !== '' && explicit !== ':memory:') {
    const resolved = resolve(explicit.startsWith('~') ? join(homedir(), explicit.slice(1)) : explicit)
    if (existsSync(resolved)) return resolved
  }
  const standard = join(dataDir, 'opencode.db')
  if (existsSync(standard)) return standard
  const channel = findChannelDatabase(dataDir)
  return channel ?? standard
}

/** Pick the newest `opencode-<channel>.db` in one data directory. */
function findChannelDatabase(dataDir) {
  let names
  try {
    names = readdirSync(dataDir)
  } catch {
    return undefined
  }
  const candidates = names.filter((name) => /^opencode-[^/]+\.db$/.test(name))
  if (candidates.length === 0) return undefined
  let best
  let bestTime = -Infinity
  for (const name of candidates) {
    const path = join(dataDir, name)
    try {
      const info = statSync(path)
      if (!info.isFile()) continue
      if (info.mtimeMs > bestTime) {
        bestTime = info.mtimeMs
        best = path
      }
    } catch {
      // An unreadable entry is simply not a candidate.
    }
  }
  return best
}

/**
 * Readiness check shared by the probe and the readers: the database file must
 * exist and be readable. This stays synchronous and opens nothing so the
 * startup probe never spawns or locks anything.
 */
export function assertOpencodeDatabase(dbPath) {
  if (!existsSync(dbPath)) {
    throw new Error(`OpenCode database was not found: ${dbPath}`)
  }
  let info
  try {
    info = statSync(dbPath)
  } catch (error) {
    throw new Error(`OpenCode database is not readable: ${dbPath} (${errorMessage(error)})`)
  }
  if (!info.isFile()) throw new Error(`OpenCode database is not a file: ${dbPath}`)
  try {
    accessSync(dbPath, constants.R_OK)
  } catch (error) {
    throw new Error(`OpenCode database is not readable: ${dbPath} (${errorMessage(error)})`)
  }
  return info
}

/** Validate a browser-supplied native key before it reaches a SQL parameter. */
export function requireOpencodeSessionId(nativeKey) {
  if (typeof nativeKey !== 'string' || nativeKey === '') {
    throw Object.assign(new Error('missing OpenCode session id'), { status: 400 })
  }
  if (!SESSION_ID_PATTERN.test(nativeKey)) {
    throw Object.assign(new Error(`invalid OpenCode session id: ${nativeKey.slice(0, 80)}`), { status: 400 })
  }
  return nativeKey
}

let sqliteModule

/**
 * Load `node:sqlite` lazily so importing the engine never fails on a Node
 * version that predates the built-in SQLite binding; only an operation that
 * actually needs the database reports the missing module.
 */
async function loadSqlite() {
  if (sqliteModule !== undefined) return sqliteModule
  try {
    sqliteModule = await import('node:sqlite')
  } catch (error) {
    throw new Error(
      'OpenCode session history needs the Node.js built-in node:sqlite module (Node 22.5 or newer)',
      { cause: error },
    )
  }
  return sqliteModule
}

/**
 * Open the database read-only, run one reader, and always close it.
 *
 * WAL readers are cheap (a measured session list costs tens of milliseconds),
 * so there is no pooling: holding a handle would keep the WAL from being
 * checkpointed by the owning TUI/server process.
 */
async function withDatabase(dbPath, reader) {
  assertOpencodeDatabase(dbPath)
  const { DatabaseSync } = await loadSqlite()
  let db
  try {
    // `timeout` is the busy timeout; an OpenCode writer holding the schema lock
    // for a moment must not turn into an instant failure.
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 })
  } catch (error) {
    throw new Error(`could not open the OpenCode database ${dbPath}: ${errorMessage(error)}`)
  }
  try {
    return await reader(db)
  } catch (error) {
    if (isDatabaseFailure(error)) {
      throw new Error(`could not read the OpenCode database ${dbPath}: ${errorMessage(error)}`)
    }
    throw error
  } finally {
    try {
      db.close()
    } catch {
      // A close failure must not mask the reader's result or error.
    }
  }
}

function isDatabaseFailure(error) {
  const code = typeof error?.code === 'string' ? error.code : ''
  if (code.startsWith('SQLITE_')) return true
  const message = errorMessage(error)
  return /SQLITE_|database is locked|database disk image|readonly|not a database/i.test(message)
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * One-line, user-facing text for an assistant entry's `error` record.
 *
 * OpenCode stores `{name|type, message}` there. The name alone ("provider.error")
 * tells the user nothing, so prefer the message and fall back to the name for
 * rows written by older CLI versions that only had one.
 */
export function assistantErrorMessage(error) {
  if (error === null || typeof error !== 'object') return undefined
  if (typeof error.message === 'string' && error.message.trim() !== '') return error.message.trim()
  if (typeof error.name === 'string' && error.name !== '') return error.name
  if (typeof error.type === 'string' && error.type !== '') return error.type
  return undefined
}

function hasTable(db, table) {
  const row = db.prepare("select name from sqlite_master where type = 'table' and name = ?").get(table)
  return row !== undefined && row !== null
}

const SESSION_COLUMNS = ['id', 'parent_id', 'directory', 'title', 'agent', 'model', 'time_created', 'time_updated', 'time_archived']

/**
 * Build a SELECT list that tolerates an older/newer schema. OpenCode has
 * migrated these tables several times; a missing optional column must not fail
 * the whole listing.
 */
function sessionSelect(db, table) {
  const available = new Set(db.prepare(`pragma table_info(${table})`).all().map((column) => column.name))
  return SESSION_COLUMNS.map((column) => (available.has(column) ? column : `null as ${column}`)).join(', ')
}

function parseJson(value) {
  if (typeof value !== 'string' || value === '') return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function clip(value) {
  const text = typeof value === 'string' ? value : ''
  if (text.length <= MAX_TEXT) return text
  return text.slice(0, MAX_TEXT) + '…'
}

/** OpenCode seeds every session with a timestamp placeholder title. */
function sessionNameFrom(title) {
  if (typeof title !== 'string' || title.trim() === '') return undefined
  if (/^New session\s*-\s*\d{4}-\d{2}-\d{2}T/.test(title)) return undefined
  return title
}

function isoFrom(epochMs) {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs) || epochMs <= 0) return undefined
  return new Date(epochMs).toISOString()
}

/** The `model` column holds `{providerID, id}` (v2) or `{providerID, id}` (legacy). */
function modelFromColumn(value) {
  const parsed = typeof value === 'string' ? parseJson(value) : value
  if (parsed === null || typeof parsed !== 'object') return undefined
  const provider = typeof parsed.providerID === 'string' ? parsed.providerID : undefined
  const id = typeof parsed.id === 'string' ? parsed.id : undefined
  if (provider === undefined || id === undefined) return undefined
  return { provider, id }
}

/** Split a v2 user row into text. `data.text` is the current shape. */
function v2UserText(data) {
  if (data === null || typeof data !== 'object') return ''
  if (typeof data.text === 'string') return data.text
  return textOfBlocks(data.content)
}

function textOfBlocks(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/** Tool state to a normalized tool result body shared by both generations. */
function toolResultText(state) {
  if (state === null || typeof state !== 'object') return ''
  if (typeof state.output === 'string' && state.output !== '') return state.output
  if (state.content !== undefined) {
    const text = textOfBlocks(state.content)
    if (text !== '') return text
  }
  if (Array.isArray(state.content)) {
    const joined = state.content
      .filter((block) => block && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
    if (joined !== '') return joined
  }
  if (typeof state.error === 'string') return state.error
  return ''
}

function toolStatus(state) {
  const status = typeof state?.status === 'string' ? state.status : ''
  if (status === 'completed') return 'completed'
  if (status === 'error') return 'error'
  if (status === 'running') return 'running'
  return 'pending'
}

function usageFromTokens(tokens) {
  if (tokens === null || typeof tokens !== 'object') return undefined
  const cache = tokens.cache ?? tokens.cacheRead
  return {
    input: numberOrZero(tokens.input),
    output: numberOrZero(tokens.output),
    cacheRead: numberOrZero(tokens.cache?.read ?? cache),
    cacheWrite: numberOrZero(tokens.cache?.write),
    ...(typeof tokens.total === 'number' ? { total: tokens.total } : {}),
  }
}

function numberOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Fold one generation's transcripts into Pi's message vocabulary.
 *
 * The browser folds tool results into their tool row by `toolCallId`, so a
 * tool part always produces both a `toolCall` block on its assistant message
 * and a matching `toolResult` message right after it.
 */
function assistantEntry(entry) {
  const blocks = []
  const results = []
  const tools = []
  for (const block of entry.blocks) {
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
    const callId = typeof block.callID === 'string' && block.callID !== ''
      ? block.callID
      : typeof block.id === 'string' ? block.id : ''
    if (callId === '') continue
    const name = bridgeToolName(block.tool ?? block.name)
    const state = block.state ?? {}
    const args = bridgeToolArguments(state.input)
    blocks.push({ type: 'toolCall', id: callId, name, arguments: args })
    tools.push({ id: callId, name, arguments: args, status: toolStatus(state) })
    results.push({
      role: 'toolResult',
      toolCallId: callId,
      content: [{ type: 'text', text: toolResultText(state) }],
      isError: toolStatus(state) === 'error',
      timestamp: entry.timestamp,
    })
  }
  // A failed turn usually carries no content blocks at all: OpenCode records the
  // provider/auth/limit failure on the assistant entry instead of a message. The
  // turn still happened and the user must see why it produced nothing, so keep
  // the entry whenever it names an error.
  if (blocks.length === 0 && results.length === 0 && entry.error === undefined) return undefined
  const message = {
    role: 'assistant',
    content: blocks,
    timestamp: entry.timestamp,
    ...(entry.provider !== undefined && entry.modelId !== undefined
      ? { provider: entry.provider, model: entry.modelId }
      : {}),
    ...(entry.usage === undefined ? {} : { usage: entry.usage }),
    ...(entry.error === undefined ? {} : { errorMessage: entry.error }),
  }
  return { message, results, tools }
}

/** Normalize `session_message` rows (v2) for one session, oldest first. */
export function messagesFromSessionMessages(rows) {
  const messages = []
  const tools = []
  let model
  for (const row of rows) {
    const data = parseJson(row.data)
    if (data === null || typeof data !== 'object') continue
    const timestamp = typeof data.time?.created === 'number' ? data.time.created : row.time_created
    if (row.type === 'user') {
      const text = v2UserText(data)
      if (text === '') continue
      messages.push({ role: 'user', content: [{ type: 'text', text }], timestamp })
      continue
    }
    if (row.type !== 'assistant') {
      // system/synthetic/compaction/idle/model-switched rows are harness
      // plumbing: they are not part of the conversation the Bridge renders.
      if (row.type === 'model-switched') {
        model = modelFromColumn(data.model) ?? model
      }
      continue
    }
    const fromModel = modelFromColumn(data.model)
    if (fromModel !== undefined) model = fromModel
    const entry = assistantEntry({
      blocks: Array.isArray(data.content) ? data.content : [],
      timestamp,
      provider: typeof data.model?.providerID === 'string' ? data.model.providerID : undefined,
      modelId: typeof data.model?.id === 'string' ? data.model.id : undefined,
      usage: usageFromTokens(data.tokens),
      error: assistantErrorMessage(data.error),
    })
    if (entry === undefined) continue
    messages.push(entry.message, ...entry.results)
    tools.push(...entry.tools)
  }
  return { messages, tools, model }
}

/** Normalize legacy `message` + `part` rows for one session, oldest first. */
export function messagesFromLegacyParts(messageRows, partRows) {
  const partsByMessage = new Map()
  for (const part of partRows) {
    const list = partsByMessage.get(part.message_id)
    if (list === undefined) partsByMessage.set(part.message_id, [part])
    else list.push(part)
  }
  const messages = []
  const tools = []
  let model
  for (const row of messageRows) {
    const data = parseJson(row.data)
    if (data === null || typeof data !== 'object') continue
    const timestamp = typeof data.time?.created === 'number' ? data.time.created : row.time_created
    const parts = partsByMessage.get(row.id) ?? []
    if (data.role === 'user') {
      const text = parts
        .filter((part) => parseJson(part.data)?.type === 'text')
        .map((part) => parseJson(part.data).text)
        .filter((value) => typeof value === 'string')
        .join('\n')
      if (text === '') continue
      messages.push({ role: 'user', content: [{ type: 'text', text }], timestamp })
      continue
    }
    if (data.role !== 'assistant') continue
    if (typeof data.providerID === 'string' && typeof data.modelID === 'string') {
      model = { provider: data.providerID, id: data.modelID }
    }
    const blocks = []
    let usage
    for (const part of parts) {
      const parsed = parseJson(part.data)
      if (parsed === null || typeof parsed !== 'object') continue
      if (parsed.type === 'step-finish') usage = usageFromTokens(parsed.tokens) ?? usage
      blocks.push(parsed)
    }
    const entry = assistantEntry({
      blocks,
      timestamp,
      provider: typeof data.providerID === 'string' ? data.providerID : undefined,
      modelId: typeof data.modelID === 'string' ? data.modelID : undefined,
      usage: usage ?? usageFromTokens(data.tokens),
      error: typeof data.error?.name === 'string' ? data.error.name : undefined,
    })
    if (entry === undefined) continue
    messages.push(entry.message, ...entry.results)
    tools.push(...entry.tools)
  }
  return { messages, tools, model }
}

/**
 * Normalize `GET /session/{id}/message` (`[{info, parts}]`) for the live
 * attachment. The HTTP shape is the v2 block vocabulary; the DB may lag the
 * API by a moment, so the attachment reads it through this shared converter.
 */
export function messagesFromApiEntries(entries) {
  const messages = []
  const tools = []
  let model
  for (const entry of Array.isArray(entries) ? entries : []) {
    const info = entry?.info
    if (info === null || typeof info !== 'object') continue
    const timestamp = typeof info.time?.created === 'number' ? info.time.created : undefined
    const parts = Array.isArray(entry.parts) ? entry.parts : []
    if (info.role === 'user') {
      const text = parts
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n')
      if (text === '') continue
      messages.push({ role: 'user', content: [{ type: 'text', text }], timestamp })
      continue
    }
    if (info.role !== 'assistant') continue
    if (typeof info.providerID === 'string' && typeof info.modelID === 'string') {
      model = { provider: info.providerID, id: info.modelID }
    }
    const stepFinish = parts.filter((part) => part?.type === 'step-finish').at(-1)
    const entryResult = assistantEntry({
      blocks: parts,
      timestamp,
      provider: typeof info.providerID === 'string' ? info.providerID : undefined,
      modelId: typeof info.modelID === 'string' ? info.modelID : undefined,
      usage: usageFromTokens(info.tokens) ?? usageFromTokens(stepFinish?.tokens),
      // Prefer the human-readable message: the name alone ("provider.error")
      // does not tell the user what went wrong. Older rows only carry a name.
      error: assistantErrorMessage(info.error),
    })
    if (entryResult === undefined) continue
    messages.push(entryResult.message, ...entryResult.results)
    tools.push(...entryResult.tools)
  }
  return { messages, tools, model }
}

/** Shape one session row (either generation) into the bridge summary. */
function summaryFromRow(row, extra) {
  return {
    key: row.id,
    nativeKey: row.id,
    id: row.id,
    name: sessionNameFrom(row.title),
    cwd: typeof row.directory === 'string' && row.directory !== '' ? row.directory : undefined,
    created: isoFrom(row.time_created),
    modified: isoFrom(row.time_updated),
    parentId: typeof row.parent_id === 'string' && row.parent_id !== '' ? row.parent_id : undefined,
    archived: typeof row.time_archived === 'number',
    model: modelFromColumn(row.model),
    agent: typeof row.agent === 'string' && row.agent !== '' ? row.agent : undefined,
    ...extra,
  }
}

/**
 * Shape a `GET /session` (or `POST /session`) response, which uses camelCase
 * and nested `time`, into the same summary `listSessions` returns. The create
 * path needs it so a freshly created session is immediately addressed by the
 * sidebar with the same fields as a listed one.
 */
export function summaryFromApiSession(info) {
  if (info === null || typeof info !== 'object' || typeof info.id !== 'string') {
    throw new Error('OpenCode returned an invalid session record')
  }
  const model = info.model !== null && typeof info.model === 'object'
    ? modelFromColumn({ providerID: info.model.providerID ?? info.model.provider, id: info.model.id ?? info.model.modelID })
    : undefined
  return {
    key: info.id,
    nativeKey: info.id,
    id: info.id,
    name: sessionNameFrom(info.title),
    cwd: typeof info.directory === 'string' && info.directory !== '' ? info.directory : undefined,
    created: isoFrom(info.time?.created),
    modified: isoFrom(info.time?.updated ?? info.time?.created),
    parentId: typeof info.parentID === 'string' && info.parentID !== '' ? info.parentID : undefined,
    archived: typeof info.time?.archived === 'number',
    model,
    agent: typeof info.agent === 'string' && info.agent !== '' ? info.agent : undefined,
    messageCount: 0,
    firstMessage: '',
    messages: [],
    tools: [],
  }
}

/**
 * List sessions from both generations, newest first.
 *
 * Each generation is asked for its own newest `limit` rows; the union's newest
 * `limit` must be contained in that pair, so this stays a bounded scan even on
 * a multi-gigabyte database.
 */
export async function listOpencodeSessions(config = {}, env = process.env, options = {}) {
  const limit = Math.max(1, Math.min(Number.isFinite(options.limit) ? options.limit : DEFAULT_LIMIT, MAX_LIMIT))
  const dataDir = opencodeDataDir(config, env)
  const dbPath = opencodeDatabasePath(config, env)
  return withDatabase(dbPath, (db) => {
    const hasLegacy = hasTable(db, 'session')
    const hasV2 = hasTable(db, 'session_v2')
    if (!hasLegacy && !hasV2) throw new Error(`not an OpenCode database (no session table): ${dbPath}`)

    // The newest `limit` ids come from a narrow projection of each generation;
    // the wide rows are then fetched by primary key. Sorting whole session rows
    // is noticeably slower on a multi-gigabyte database.
    const order = new Map()
    if (hasV2) {
      const rows = db.prepare(`select id from session_v2 order by time_updated desc limit ${limit}`).all()
      for (const row of rows) if (typeof row.id === 'string') order.set(row.id, 'v2')
    }
    if (hasLegacy) {
      const rows = db.prepare(`select id from session order by time_updated desc limit ${limit}`).all()
      // A session present in both tables is described by the v2 row: it is the
      // later schema and carries agent/model fields the legacy row stopped
      // maintaining. Listing prefers v2 for the same reason.
      for (const row of rows) if (typeof row.id === 'string' && !order.has(row.id)) order.set(row.id, 'legacy')
    }
    const ids = [...order.keys()]
    const rowsById = new Map()
    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(', ')
      if (hasV2) {
        const rows = db.prepare(`select ${sessionSelect(db, 'session_v2')} from session_v2 where id in (${placeholders})`).all(...ids)
        for (const row of rows) rowsById.set(row.id, { row, generation: 'v2' })
      }
      if (hasLegacy) {
        const rows = db.prepare(`select ${sessionSelect(db, 'session')} from session where id in (${placeholders})`).all(...ids)
        for (const row of rows) if (!rowsById.has(row.id)) rowsById.set(row.id, { row, generation: 'legacy' })
      }
    }

    const readers = createSummaryReaders(db)
    const sessions = []
    for (const [id, generationHint] of order) {
      const entry = rowsById.get(id)
      if (entry === undefined) continue
      const extra = {
        messageCount: readers.messageCount(id, generationHint),
        firstMessage: clip(readers.firstUserText(id, generationHint) ?? ''),
      }
      sessions.push(summaryFromRow(entry.row, extra))
    }
    sessions.sort((left, right) => timestampOf(right.modified) - timestampOf(left.modified))
    return { root: dataDir, sessions: sessions.slice(0, limit) }
  })
}

function timestampOf(iso) {
  if (typeof iso !== 'string') return 0
  const value = Date.parse(iso)
  return Number.isFinite(value) ? value : 0
}

/**
 * Cheap per-session side queries for the list, with the statements prepared
 * once per database open: the list touches a few hundred sessions, and
 * re-preparing the same two statements dominates the read at that size.
 */
function createSummaryReaders(db) {
  const hasV2Messages = hasTable(db, 'session_message')
  const hasLegacyMessages = hasTable(db, 'message')
  const hasLegacyParts = hasTable(db, 'part')
  const v2Count = hasV2Messages
    ? db.prepare('select count(*) as n from session_message where session_id = ?')
    : undefined
  const legacyCount = hasLegacyMessages
    ? db.prepare('select count(*) as n from message where session_id = ?')
    : undefined
  const v2FirstUser = hasV2Messages
    ? db.prepare("select data from session_message where session_id = ? and type = 'user' order by seq limit 1")
    : undefined
  const legacyFirstUser = hasLegacyMessages
    ? db.prepare("select id from message where session_id = ? and json_extract(data, '$.role') = 'user' order by time_created, id limit 1")
    : undefined
  const legacyFirstText = hasLegacyParts
    ? db.prepare("select data from part where message_id = ? and json_extract(data, '$.type') = 'text' order by time_created, id limit 1")
    : undefined

  return {
    messageCount(sessionId) {
      const v2 = v2Count?.get(sessionId).n ?? 0
      if (v2 > 0) return v2
      // Newer CLI versions write sessions into the legacy tables only, so a
      // missing v2 transcript is normal and not an empty session.
      return legacyCount?.get(sessionId).n ?? 0
    },
    /**
     * The list only needs the first user line of each session, so this reads
     * one row per generation instead of hydrating a transcript. Falls back to
     * the other generation because a session's metadata row and its messages
     * may have been written by different CLI versions.
     */
    firstUserText(sessionId, generation) {
      const order = generation === 'v2' ? ['v2', 'legacy'] : ['legacy', 'v2']
      for (const source of order) {
        if (source === 'v2') {
          if (v2FirstUser === undefined) continue
          const row = v2FirstUser.get(sessionId)
          if (row === undefined || row === null) continue
          const text = v2UserText(parseJson(row.data))
          if (text !== '') return text
          continue
        }
        if (legacyFirstUser === undefined || legacyFirstText === undefined) continue
        const message = legacyFirstUser.get(sessionId)
        if (message === undefined || message === null) continue
        const part = legacyFirstText.get(message.id)
        if (part === undefined || part === null) continue
        const text = parseJson(part.data)?.text
        if (typeof text === 'string' && text !== '') return text
      }
      return undefined
    },
  }
}

/**
 * Read one full transcript in the vocabulary the browser renders.
 *
 * Preference is v2 when that generation has message rows, legacy otherwise.
 * The session metadata itself is read from whichever table owns it, because a
 * session can be announced by one CLI version and continued by another.
 */
export async function readOpencodeSession(nativeKey, config = {}, env = process.env) {
  const sessionId = requireOpencodeSessionId(nativeKey)
  const dbPath = opencodeDatabasePath(config, env)
  return withDatabase(dbPath, (db) => {
    const row = readSessionRow(db, sessionId)
    if (row === undefined) {
      throw Object.assign(new Error(`OpenCode session was not found: ${sessionId}`), { status: 404 })
    }
    const sessionMessages = hasTable(db, 'session_message')
      ? db
        .prepare('select data, type, time_created from session_message where session_id = ? order by seq')
        .all(sessionId)
      : []
    const legacyMessages = sessionMessages.length === 0 && hasTable(db, 'message')
      ? db.prepare('select id, data, time_created from message where session_id = ? order by time_created, id').all(sessionId)
      : []
    const legacyParts = legacyMessages.length > 0 && hasTable(db, 'part')
      ? db.prepare('select message_id, data, time_created from part where session_id = ? order by time_created, id').all(sessionId)
      : []
    const transcript = sessionMessages.length > 0
      ? messagesFromSessionMessages(sessionMessages)
      : messagesFromLegacyParts(legacyMessages, legacyParts)
    const firstUser = transcript.messages.find((message) => message.role === 'user')
    return summaryFromRow(row, {
      messageCount: transcript.messages.length,
      firstMessage: clip(textOfBlocks(firstUser?.content)),
      model: modelFromColumn(row.model) ?? transcript.model,
      messages: transcript.messages,
      tools: transcript.tools,
    })
  })
}

/**
 * Read the session metadata row, preferring `session_v2` so a session whose
 * legacy row stopped being updated still reports its newest title/model.
 */
function readSessionRow(db, sessionId) {
  const tables = []
  if (hasTable(db, 'session_v2')) tables.push('session_v2')
  if (hasTable(db, 'session')) tables.push('session')
  for (const table of tables) {
    const row = db.prepare(`select ${sessionSelect(db, table)} from ${table} where id = ?`).get(sessionId)
    if (row !== undefined && row !== null) return row
  }
  return undefined
}
