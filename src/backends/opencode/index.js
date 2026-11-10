/**
 * OpenCode CLI backend adapter.
 *
 * Everything OpenCode-specific lives behind this module: data directory and
 * launcher discovery, the SQLite session reader, the HTTP/SSE attachment, and
 * the settings fields OpenCode needs. The generic bridge host only sees the
 * BackendAdapter contract, so the browser and the routes never learn that this
 * engine stores sessions in a database instead of a file tree.
 */
import { basename } from 'node:path'
import { executableOnPath } from '../cli.js'
import {
  OpencodeAttachment,
  createOpencodeSession,
  queryOpencodeModels,
  resolveOpencodeCommand,
} from './attachment.js'
import {
  assertOpencodeDatabase,
  bridgeToolName,
  listOpencodeSessions,
  opencodeDataDir,
  opencodeDatabasePath,
  readOpencodeSession,
  requireOpencodeSessionId,
} from './session-store.js'

export const OPENCODE_ENGINE_ID = 'opencode'

/**
 * The client styles a tool row from its name, and that table is narrow. The
 * translation lives beside the transcript reader so the history path and the
 * live-stream path can never disagree about a tool's name.
 */
export { bridgeToolName }

/** Convert an OpenCode session record into the generic session shape. */
function decorateSession(session) {
  return { ...session, nativeKey: session.key }
}

/**
 * Bridge readiness probe. No process is spawned: the launcher must resolve and
 * the data directory must hold a readable `opencode.db`. The host shows the
 * thrown message on the bridge's status dot, so it names exactly what is wrong.
 */
function probeOpencode(config = {}, env = process.env) {
  const resolved = resolveOpencodeCommand(config, env)
  if (!executableOnPath(resolved.command, env)) {
    throw new Error(`OpenCode executable was not found: ${resolved.command}`)
  }
  const dataDir = opencodeDataDir(config, env)
  const dbPath = opencodeDatabasePath(config, env)
  assertOpencodeDatabase(dbPath)
  return {
    dataDir,
    dbPath,
    command: resolved.command,
    prefixArgs: resolved.prefixArgs,
  }
}

export const opencodeEngine = {
  id: OPENCODE_ENGINE_ID,
  label: 'OpenCode',
  mode: 'cli',
  description: 'Connect to OpenCode sessions through its local HTTP server.',
  kind: 'cli',
  available: true,
  capabilities: ['sessions', 'session-create', 'attach', 'stream', 'prompt', 'abort', 'models', 'permission-ui'],
  configFields: [
    {
      key: 'sessionsRoot',
      type: 'string',
      labelKey: 'sessionsRoot',
      hintKey: 'sessionsRootHint',
      placeholder: '~/.local/share/opencode',
    },
    {
      key: 'binPath',
      type: 'string',
      labelKey: 'binPath',
      hintKey: 'binPathHint',
      placeholder: 'opencode',
    },
    {
      key: 'autoApprove',
      type: 'boolean',
      labelKey: 'autoApprove',
      hintKey: 'autoApproveHint',
    },
  ],
  defaultConfig: () => ({
    sessionsRoot: null,
    binPath: null,
    // A Bridge turn has no attached TUI: a native permission prompt that waits
    // for a human would hang the turn forever, so approval defaults to on.
    autoApprove: true,
  }),

  async listSessions(config, env) {
    const result = await listOpencodeSessions(config, env)
    const sessions = result.sessions.map(decorateSession)
    return { root: result.root, sessions, workspaces: groupWorkspaces(sessions) }
  },

  async readSession(nativeKey, config, env) {
    return decorateSession(await readOpencodeSession(requireOpencodeSessionId(nativeKey), config, env))
  },

  /**
   * Create a session through OpenCode's own service. Direct SQLite insertion
   * would have to reproduce the project/workspace bookkeeping, so the adapter
   * pays one short-lived `opencode serve` instead (see createOpencodeSession).
   */
  async createSession({ cwd, config, env, logger }) {
    return decorateSession(await createOpencodeSession({ cwd, config, env, logger }))
  },

  async createAttachment({ session, config, env, logger }) {
    const attachment = new OpencodeAttachment({
      sessionId: requireOpencodeSessionId(session.nativeKey ?? session.key),
      cwd: session.cwd,
      config,
      env,
    })
    attachment.on('exit', (info) => {
      if (info?.stderr) logger?.warn?.(`bridge: OpenCode exited for ${session.nativeKey ?? session.key}: ${info.stderr.trim()}`)
    })
    return attachment
  },

  probe(config, env) {
    return probeOpencode(config, env)
  },

  /**
   * Read-only model catalog for a bridge with no live attachment. OpenCode
   * only exposes its catalog through a server, so this spawns a short-lived one
   * and the host caches the result per bridge for ten minutes.
   */
  async listModels(config, env) {
    return queryOpencodeModels(config, env)
  },

  /**
   * Map the attachment's native records onto the backend-neutral vocabulary.
   *
   * The attachment emits records that already carry Pi-shaped payloads, so this
   * is a pure rename layer except for tool-name translation: keeping it pure
   * makes the mapping unit-testable without a child process.
   */
  normalizeEvent(record) {
    if (record === null || typeof record !== 'object') return null
    switch (record.type) {
      case 'agent-start':
        return { type: 'agent-start' }
      case 'agent-end':
        return { type: 'agent-end' }
      case 'agent-settled':
        return { type: 'agent-settled', aborted: record.aborted === true }
      case 'message-start':
        return { type: 'message-start', message: normalizeMessage(record.message) }
      case 'message-update':
        return { type: 'message-update', message: normalizeMessage(record.message) }
      case 'message-end':
        return { type: 'message-end', message: normalizeMessage(record.message, { end: true }) }
      case 'tool-start':
        return {
          type: 'tool-start',
          toolCallId: record.toolCallId,
          name: bridgeToolName(record.name ?? record.toolName),
          arguments: record.arguments ?? record.args ?? {},
        }
      case 'tool-update':
        return { type: 'tool-update', toolCallId: record.toolCallId, partialResult: record.partialResult }
      case 'tool-end':
        return {
          type: 'tool-end',
          toolCallId: record.toolCallId,
          result: record.result,
          isError: record.isError === true,
        }
      case 'session-name':
        return { type: 'session-name', name: record.name }
      // Turn lifecycle. The host keys turn state on `agent-start` and
      // `agent-settled`, so the attachment only reports OpenCode's own
      // busy/idle status and the mapping decides which neutral events (and in
      // which order) the browser needs.
      case 'session-status':
        if (record.status === 'busy') return { type: 'agent-start' }
        if (record.status === 'idle') {
          return [
            { type: 'agent-end' },
            { type: 'agent-settled', aborted: record.aborted === true },
          ]
        }
        return null
      case 'session-error':
        return { type: 'backend-event', event: record }
      default:
        return { type: 'backend-event', event: record }
    }
  },
}

/**
 * Rewrite tool calls inside one normalized message into the client vocabulary.
 *
 * Tool names live inside the message blocks as well as in `tool-start` events,
 * and the history transcript uses the same block shape, so both paths must agree
 * on the name the client keys its row styling off.
 */
function normalizeMessage(message, options = {}) {
  if (message === null || typeof message !== 'object') return message
  if (!Array.isArray(message.content)) return message
  const content = message.content.map((block) => {
    if (block === null || typeof block !== 'object' || block.type !== 'toolCall') return block
    return { ...block, name: bridgeToolName(block.name) }
  })
  const normalized = { ...message, content }
  // The browser marks an aborted answer from `stopReason`; OpenCode reports the
  // abort as a message error, so translate it once here instead of in the view.
  if (options.end === true && message.errorMessage === 'MessageAbortedError' && normalized.stopReason === undefined) {
    normalized.stopReason = 'aborted'
  }
  return normalized
}

/** Group sessions by workspace directory exactly like the Pi engine does. */
function groupWorkspaces(sessions) {
  const byCwd = new Map()
  for (const session of sessions) {
    const id = typeof session.cwd === 'string' && session.cwd !== '' ? session.cwd : ''
    if (!byCwd.has(id)) {
      const name = id === '' ? '' : (basename(id) || id)
      byCwd.set(id, { id, name, path: id || null, sessionCount: 0 })
    }
    byCwd.get(id).sessionCount += 1
  }
  return [...byCwd.values()]
}
