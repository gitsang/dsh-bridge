/**
 * Pi CLI backend adapter.
 *
 * Everything Pi-specific lives behind this module: command discovery, session
 * file parsing, the RPC attachment, and the settings fields Pi needs. The
 * generic bridge host only sees the BackendAdapter contract.
 */
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { PiAttachment, resolvePiCommand } from './attachment.js'
import {
  listPiSessions,
  pathFromSessionKey,
  readPiSession,
} from './session-store.js'

export const PI_ENGINE_ID = 'pi'

export function piAgentDir(env = process.env) {
  return env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent')
}

export function resolvePiSessionsRoot(config = {}, env = process.env) {
  if (config.sessionsRoot) return resolve(config.sessionsRoot)
  if (env.PI_CODING_AGENT_SESSION_DIR) return resolve(env.PI_CODING_AGENT_SESSION_DIR)
  return resolve(join(piAgentDir(env), 'sessions'))
}

function fileFromNativeKey(nativeKey, root) {
  return pathFromSessionKey(nativeKey, root)
}

/** Convert Pi's file-shaped session record into the generic session shape. */
function decorateSession(session) {
  return {
    ...session,
    nativeKey: session.key,
  }
}

/** Find an executable on PATH without launching a process. */
function executableOnPath(command, env) {
  if (command.includes('/') || isAbsolute(command)) return existsSync(command)
  const pathValue = env.PATH ?? env.Path ?? ''
  for (const directory of pathValue.split(delimiter)) {
    if (directory === '') continue
    const candidate = join(directory, command)
    if (existsSync(candidate)) return true
    if (process.platform === 'win32' && existsSync(`${candidate}.exe`)) return true
  }
  return false
}

/**
 * Bridge-level readiness probe. It answers "would an attach for this bridge
 * be able to start?" without spawning a Pi process: the launcher must resolve
 * and the session root must be a readable directory.
 */
function probePi(config, env) {
  const root = resolvePiSessionsRoot(config, env)
  if (!existsSync(root)) {
    throw new Error(`sessions root does not exist: ${root}`)
  }
  const stats = statSync(root)
  if (!stats.isDirectory()) throw new Error(`sessions root is not a directory: ${root}`)
  const childEnv = {
    ...env,
    ...(config.binPath === null || config.binPath === undefined ? {} : { PI_BIN: config.binPath }),
  }
  const resolved = resolvePiCommand(childEnv)
  if (!executableOnPath(resolved.command, childEnv)) {
    throw new Error(`Pi executable was not found: ${resolved.command}`)
  }
  return {
    sessionsRoot: root,
    command: resolved.command,
    prefixArgs: resolved.prefixArgs,
  }
}

export const piEngine = {
  id: PI_ENGINE_ID,
  label: 'Pi',
  mode: 'cli',
  description: 'Connect to Pi Coding Agent sessions through its RPC mode.',
  kind: 'cli',
  available: true,
  capabilities: ['sessions', 'attach', 'stream', 'prompt', 'abort', 'models', 'extension-ui'],
  configFields: [
    {
      key: 'sessionsRoot',
      type: 'string',
      labelKey: 'sessionsRoot',
      hintKey: 'sessionsRootHint',
      placeholder: '~/.pi/agent/sessions',
    },
    {
      key: 'binPath',
      type: 'string',
      labelKey: 'binPath',
      hintKey: 'binPathHint',
      placeholder: '~/.pi/agent/bin/pi',
    },
    {
      key: 'offline',
      type: 'boolean',
      labelKey: 'offline',
      hintKey: 'offlineHint',
    },
  ],
  defaultConfig: () => ({
    sessionsRoot: null,
    binPath: null,
    offline: true,
  }),

  async listSessions(config, env) {
    const root = resolvePiSessionsRoot(config, env)
    const sessions = (await listPiSessions(root)).map(decorateSession)
    const byCwd = new Map()
    for (const session of sessions) {
      const id = typeof session.cwd === 'string' && session.cwd !== '' ? session.cwd : ''
      if (!byCwd.has(id)) byCwd.set(id, { id, name: id, path: id || null, sessionCount: 0 })
      byCwd.get(id).sessionCount += 1
    }
    return { root, sessions, workspaces: [...byCwd.values()] }
  },

  async readSession(nativeKey, config, env) {
    const root = resolvePiSessionsRoot(config, env)
    const file = fileFromNativeKey(nativeKey, root)
    return decorateSession(await readPiSession(file))
  },

  async createAttachment({ session, config, env, logger }) {
    const root = resolvePiSessionsRoot(config, env)
    const file = pathFromSessionKey(session.nativeKey, root)
    const childEnv = {
      ...env,
      ...(config.binPath === null ? {} : { PI_BIN: config.binPath }),
      ...(config.offline ? { PI_OFFLINE: env.PI_OFFLINE ?? '1' } : {}),
    }
    const attachment = new PiAttachment({ file, cwd: session.cwd, env: childEnv })
    attachment.on('exit', (info) => {
      if (info?.stderr) logger?.warn?.(`bridge: Pi exited for ${file}: ${info.stderr.trim()}`)
    })
    return attachment
  },

  probe(config, env) {
    return probePi(config, env)
  },

  /** Map Pi's wire events onto the backend-neutral bridge event vocabulary. */
  normalizeEvent(record) {
    if (record === null || typeof record !== 'object') return null
    switch (record.type) {
      case 'agent_start':
        return { type: 'agent-start' }
      case 'agent_end':
      case 'agent_settled':
        return { type: 'agent-end' }
      case 'message_start':
        return { type: 'message-start', message: record.message }
      case 'message_update':
        return { type: 'message-update', message: record.message }
      case 'message_end':
        return { type: 'message-end', message: record.message }
      case 'tool_execution_start':
        return {
          type: 'tool-start',
          toolCallId: record.toolCallId,
          name: record.toolName,
          arguments: record.args ?? record.arguments,
        }
      case 'tool_execution_update':
        return { type: 'tool-update', toolCallId: record.toolCallId, partialResult: record.partialResult }
      case 'tool_execution_end':
        return { type: 'tool-end', toolCallId: record.toolCallId, result: record.result, isError: record.isError }
      case 'session_info_changed':
        return { type: 'session-name', name: record.name }
      default:
        return { type: 'backend-event', event: record }
    }
  },

}
