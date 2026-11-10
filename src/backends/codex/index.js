/**
 * Codex CLI backend adapter.
 *
 * Everything Codex-specific lives behind this module: launcher discovery,
 * rollout parsing, the app-server attachment, the settings fields Codex needs,
 * and the mapping from app-server notifications onto the backend-neutral event
 * vocabulary the browser consumes.
 */
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { executableOnPath, resolveCliCommand, runCommand } from '../cli.js'
import { CodexAttachment, queryCodexModels } from './attachment.js'
import {
  codexHome,
  codexModelProvider,
  codexModelId,
  createCodexSession,
  listCodexSessions,
  pathFromSessionKey,
  readCodexSession,
} from './session-store.js'

export const CODEX_ENGINE_ID = 'codex'

/** Codex's approval policy is the one setting a Bridge turn must override. */
export function approvalPolicyFor(config = {}) {
  return config.skipApprovals === false ? 'on-request' : 'never'
}

export function resolveCodexSessionsRoot(config = {}, env = process.env) {
  if (config.sessionsRoot) return resolve(config.sessionsRoot)
  return resolve(join(codexHome(env), 'sessions'))
}

/** Resolve the launcher without spawning: config wins, then CODEX_BIN, then PATH. */
export function resolveCodexCommand(config = {}, env = process.env) {
  return resolveCliCommand({
    configBin: config.binPath,
    envVar: 'CODEX_BIN',
    defaultNames: ['codex'],
    env,
  })
}

/**
 * Map one Codex tool name onto the small vocabulary the Bridge client styles.
 *
 * The client keys its icon, title, and argument-summary renderer off these
 * names, so an unmapped Codex name would render as a generic row.
 */
export function bridgeToolName(name) {
  const value = typeof name === 'string' ? name : ''
  const lower = value.toLowerCase()
  if (lower === 'apply_patch' || lower === 'filechange' || lower === 'edit' || lower === 'write') {
    return lower === 'apply_patch' || lower === 'filechange' ? 'edit' : lower
  }
  if (
    lower === 'shell'
    || lower === 'exec'
    || lower === 'exec_command'
    || lower === 'container.exec'
    || lower === 'local_shell'
    || lower === 'shell_command'
    || lower === 'commandexecution'
    || lower === 'bash'
  ) {
    return 'bash'
  }
  if (lower === 'read_file' || lower === 'view_file' || lower === 'read') return 'read'
  if (lower === 'read_image' || lower === 'imageview') return 'read'
  if (lower === 'grep' || lower === 'glob' || lower === 'web_search' || lower === 'websearch' || lower === 'search') return 'search'
  return 'others'
}

function decorateSession(session) {
  return { ...session, nativeKey: session.key }
}

/**
 * Bridge readiness probe. No process is spawned: the launcher must resolve and
 * the sessions root must be a readable directory. The host surfaces any thrown
 * message on the bridge's status dot.
 */
function probeCodex(config = {}, env = process.env) {
  const root = resolveCodexSessionsRoot(config, env)
  if (!existsSync(root)) throw new Error(`sessions root does not exist: ${root}`)
  const stats = statSync(root)
  if (!stats.isDirectory()) throw new Error(`sessions root is not a directory: ${root}`)
  try {
    accessSync(root, constants.R_OK)
  } catch {
    throw new Error(`sessions root is not readable: ${root}`)
  }
  const resolved = resolveCodexCommand(config, env)
  if (!executableOnPath(resolved.command, env)) {
    throw new Error(`Codex executable was not found: ${resolved.command}`)
  }
  return {
    sessionsRoot: root,
    command: resolved.command,
    prefixArgs: [...resolved.prefixArgs, 'app-server', '--stdio'],
  }
}

export const codexEngine = {
  id: CODEX_ENGINE_ID,
  label: 'Codex',
  mode: 'cli',
  description: 'Connect to OpenAI Codex CLI sessions through its app-server protocol.',
  kind: 'cli',
  available: true,
  capabilities: ['sessions', 'session-create', 'attach', 'stream', 'prompt', 'abort', 'models', 'approval-ui'],
  configFields: [
    {
      key: 'sessionsRoot',
      type: 'string',
      labelKey: 'sessionsRoot',
      hintKey: 'sessionsRootHint',
      placeholder: '~/.codex/sessions',
    },
    {
      key: 'binPath',
      type: 'string',
      labelKey: 'binPath',
      hintKey: 'binPathHint',
      placeholder: 'codex',
    },
    {
      // A Bridge turn has no native dialog to answer, so a prompt the app-server
      // blocks on would leave the session spinning forever. On by default.
      key: 'skipApprovals',
      type: 'boolean',
      labelKey: 'autoApprove',
      hintKey: 'autoApproveHint',
    },
  ],
  defaultConfig: () => ({
    sessionsRoot: null,
    binPath: null,
    skipApprovals: true,
  }),

  async listSessions(config, env) {
    const root = resolveCodexSessionsRoot(config, env)
    const sessions = (await listCodexSessions(root)).map(decorateSession)
    const byCwd = new Map()
    for (const session of sessions) {
      const id = typeof session.cwd === 'string' && session.cwd !== '' ? session.cwd : ''
      if (!byCwd.has(id)) {
        const name = id === '' ? '' : (basename(id) || id)
        byCwd.set(id, { id, name, path: id || null, sessionCount: 0 })
      }
      byCwd.get(id).sessionCount += 1
    }
    return { root, sessions, workspaces: [...byCwd.values()] }
  },

  async readSession(nativeKey, config, env) {
    const root = resolveCodexSessionsRoot(config, env)
    const file = pathFromSessionKey(nativeKey, root)
    return decorateSession(await readCodexSession(file))
  },

  /**
   * Create a fresh, resumable Codex session in a workspace.
   *
   * Codex defers the rollout until the first turn, so the Bridge writes the
   * single `session_meta` line itself and lets app-server take over the file
   * via `thread/resume` on attach. The header records the local provider and a
   * cli_version because app-server refuses a rollout without them.
   */
  async createSession({ cwd, config, env }) {
    const root = resolveCodexSessionsRoot(config, env)
    const resolved = resolveCodexCommand(config, env)
    const childEnv = { ...env, ...(config.binPath === null || config.binPath === undefined ? {} : { CODEX_BIN: config.binPath }) }
    const cliVersion = executableOnPath(resolved.command, env) ? await probeCliVersion(resolved, childEnv) : undefined
    return decorateSession(await createCodexSession(cwd, root, {
      cliVersion,
      modelProvider: codexModelProvider(env),
      env,
    }))
  },

  async createAttachment({ session, config, env, logger }) {
    const root = resolveCodexSessionsRoot(config, env)
    const file = pathFromSessionKey(session.nativeKey, root)
    const childEnv = {
      ...env,
      ...(config.binPath === null || config.binPath === undefined ? {} : { CODEX_BIN: config.binPath }),
    }
    const attachment = new CodexAttachment({
      file,
      threadId: typeof session.id === 'string' ? session.id : undefined,
      cwd: session.cwd,
      env: childEnv,
      approvalPolicy: approvalPolicyFor(config),
      sandbox: 'workspace-write',
    })
    attachment.on('exit', (info) => {
      if (info?.stderr) logger?.warn?.(`bridge: Codex exited for ${file}: ${info.stderr.trim()}`)
    })
    return attachment
  },

  probe(config, env) {
    return probeCodex(config, env)
  },

  /**
   * Read-only model catalog for a bridge with no live agent. The live query
   * needs a short-lived app-server; if it fails (offline, logged out, wedged)
   * fall back to the model named in the user's own config so the picker still
   * has an honest single entry.
   */
  async listModels(config, env) {
    const childEnv = {
      ...env,
      ...(config.binPath === null || config.binPath === undefined ? {} : { CODEX_BIN: config.binPath }),
    }
    try {
      return await queryCodexModels(childEnv)
    } catch {
      const provider = codexModelProvider(env)
      const id = codexModelId(env)
      return id === undefined ? [] : [{ id, provider, name: id, reasoning: false }]
    }
  },

  /** Map app-server notifications onto the backend-neutral bridge vocabulary. */
  normalizeEvent(record) {
    if (record === null || typeof record !== 'object') return null
    switch (record.type) {
      case 'agent_start':
        return { type: 'agent-start' }
      case 'agent_end':
        return { type: 'agent-end' }
      case 'agent_settled':
        return { type: 'agent-settled', aborted: record.aborted === true }
      case 'message_start':
        return { type: 'message-start', message: record.message }
      case 'message_update':
        return { type: 'message-update', message: record.message }
      case 'message_end':
        return { type: 'message-end', message: record.message }
      case 'tool_start':
        return {
          type: 'tool-start',
          toolCallId: record.toolCallId,
          name: bridgeToolName(record.name),
          arguments: record.arguments ?? {},
        }
      case 'tool_update':
        return { type: 'tool-update', toolCallId: record.toolCallId, partialResult: record.partialResult }
      case 'tool_end':
        return { type: 'tool-end', toolCallId: record.toolCallId, result: record.result, isError: record.isError === true }
      default:
        return { type: 'backend-event', event: record }
    }
  },
}

/** `codex --version` is optional metadata; a failure must not block creation. */
async function probeCliVersion(resolved, env) {
  try {
    const result = await runCommand(resolved.command, [...resolved.prefixArgs, '--version'], { env, timeoutMs: 5000 })
    const match = /(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/.exec(result.stdout ?? '')
    return match === null ? undefined : match[1]
  } catch {
    return undefined
  }
}

export { CodexAttachment, queryCodexModels }
