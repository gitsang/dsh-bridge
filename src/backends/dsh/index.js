/**
 * DeepSeek Harness (DSH) engine adapter: a remote DeepSeek Harness Web instance.
 *
 * Unlike the CLI engines this one owns no process and no local session store.
 * It is a client of another dsh: it lists that instance's sessions, reads their
 * durable logs, admits prompts into them, and observes the log while a turn
 * runs. "Native key" is that instance's Session id, and it only ever travels
 * back to the same bridge.
 *
 * Two authentication shapes are supported, and they are not interchangeable:
 * - a **launch token** copied from the remote `dsh web` URL, which works
 *   directly against a dsh web server and rotates with every remote restart;
 * - a **dsh-gateway password**, for an instance published through
 *   `@gitsang/dsh-gateway`. A launch token cannot traverse a gateway, so a
 *   bridge behind one must use the password.
 */
import { basename } from 'node:path'
import { DshAttachment, clientFromConfig, valuesOf } from './attachment.js'
import { DshAuthError, DshError, DshRpcError } from './http.js'
import {
  eventsFromPage,
  historyFromEvents,
  modelsFromCatalog,
  sessionFromRow,
  statsFromProjections,
  neutralEventsFromDsh,
} from './session-store.js'

export const DSH_ENGINE_ID = 'dsh'

/** One page is enough for a read-only history view; the browser pages its own. */
const HISTORY_PAGE_MESSAGES = 200

function describe(error, action) {
  if (error instanceof DshRpcError) {
    return Object.assign(new Error(`The remote DSH refused ${action}: ${error.message}`), { status: 502 })
  }
  if (error instanceof DshAuthError) return error
  if (error instanceof DshError) return Object.assign(new Error(error.message), { status: 502 })
  return error
}

function clientFor(config, logger) {
  // A probe must not hang the startup path for a full request timeout.
  return clientFromConfig(config, { logger, timeoutMs: 15_000 })
}

function requireConfig(config) {
  const baseUrl = typeof config?.baseUrl === 'string' ? config.baseUrl.trim() : ''
  if (baseUrl === '') {
    throw Object.assign(new Error('the DSH bridge needs a base URL'), { status: 400 })
  }
  return config
}

/**
 * Read a whole session log through the paged history endpoint.
 *
 * A log can be longer than one page, so this walks the earlier `beforeSeq`
 * windows until the page that starts at the log's beginning. `throughSeq: -1`
 * is only valid for an empty log, so callers pass the projection's `asOfSeq`.
 */
async function readHistory(client, sessionId, throughSeq) {
  if (typeof throughSeq !== 'number' || throughSeq < 0) return []
  const bySeq = new Map()
  let beforeSeq
  let previousFirst = Number.POSITIVE_INFINITY
  for (let page = 0; page < 60; page += 1) {
    const request = {
      address: { kind: 'session', sessionId },
      throughSeq,
      maxMessages: HISTORY_PAGE_MESSAGES,
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
    }
    const result = await client.call('session/page', { request })
    for (const event of eventsFromPage(result)) bySeq.set(event.seq, event)
    if (result?.hasMore !== true) break
    const first = Array.isArray(result.records) ? result.records[0]?.event?.seq : undefined
    if (typeof first !== 'number' || first >= previousFirst) break
    previousFirst = first
    beforeSeq = first
  }
  return [...bySeq.values()].sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0))
}

/** Group remote sessions by their recorded working directory, like Pi does. */
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

/** Read the live projection block for one remote session. */
async function readProjections(client, sessionId) {
  const result = await client.call('session/projections', { request: { sessionId } })
  return {
    asOfSeq: typeof result?.asOfSeq === 'number' ? result.asOfSeq : undefined,
    values: valuesOf(result),
  }
}

export const dshEngine = {
  id: DSH_ENGINE_ID,
  label: 'DSH',
  description: 'Connect to another DeepSeek Harness Web instance over HTTP.',
  available: true,
  capabilities: ['sessions', 'attach', 'stream', 'prompt', 'abort', 'models'],
  configFields: [
    {
      key: 'baseUrl',
      type: 'string',
      labelKey: 'baseUrl',
      hintKey: 'baseUrlHint',
      placeholder: 'https://dsh.example.com',
    },
    {
      key: 'token',
      type: 'secret',
      labelKey: 'accessToken',
      hintKey: 'accessTokenHint',
      placeholder: 'launch token from the remote dsh web URL',
    },
    {
      key: 'password',
      type: 'secret',
      labelKey: 'gatewayPassword',
      hintKey: 'gatewayPasswordHint',
      placeholder: 'dsh-gateway password (instead of a token)',
    },
    {
      key: 'allowInsecureTls',
      type: 'boolean',
      labelKey: 'allowInsecureTls',
      hintKey: 'allowInsecureTlsHint',
    },
  ],
  defaultConfig: () => ({
    baseUrl: null,
    token: null,
    password: null,
    allowInsecureTls: false,
  }),

  /**
   * Every session the remote instance reports, newest activity first.
   *
   * Blank sessions (created there and never prompted) are dropped: their rows
   * have no title and no turn to read, and the import-first gate would only
   * hand the user empty rows.
   */
  async listSessions(config, env) {
    requireConfig(config)
    const client = clientFor(config)
    const result = await client.call('session/list', { _request: {} })
    const rows = Array.isArray(result?.items) ? result.items : []
    const sessions = rows
      .filter((row) => row?.blank !== true)
      .map((row) => sessionFromRow(row))
      .sort((left, right) => String(right.modified).localeCompare(String(left.modified)))
    return { root: client.baseUrl, sessions, workspaces: groupWorkspaces(sessions) }
  },

  /** Full normalized history for one remote session. */
  async readSession(nativeKey, config) {
    requireConfig(config)
    const client = clientFor(config)
    const { asOfSeq, values } = await readProjections(client, nativeKey)
    const events = await readHistory(client, nativeKey, asOfSeq ?? -1)
    const history = historyFromEvents(events)
    const summary = sessionFromRow({
      sessionId: nativeKey,
      updatedAt: Date.now(),
      blank: false,
      projections: { kind: 'sequenced', asOfSeq: asOfSeq ?? -1, values },
    })
    const stats = statsFromProjections(values)
    // Projections omit a tool-call total, but the history read above counted it.
    const withTools = stats === null ? null : { ...stats, toolCalls: history.tools.length }
    const model = history.model
      ?? (summary.model === null ? null : summary.model)
    return {
      ...summary,
      nativeKey,
      // The log's latest title is the same fact the list row reports; prefer
      // the log so a title changed after the row was cached still wins.
      name: history.title ?? summary.name,
      model,
      messages: history.messages,
      tools: history.tools,
      messageCount: history.messages.length,
      asOfSeq: asOfSeq ?? -1,
      ...(withTools === null ? {} : { stats: withTools }),
    }
  },

  /**
   * Create a session on the remote instance in one workspace directory.
   *
   * The remote owns creation (its own preset, workspace bookkeeping, and log),
   * so this asks it rather than fabricating a session id the bridge could not
   * open afterwards.
   */
  async createSession({ cwd, config, env, logger }) {
    requireConfig(config)
    const client = clientFor(config, logger)
    const result = await client.call('session/create', { request: { cwd } })
    const sessionId = typeof result?.sessionId === 'string' ? result.sessionId : undefined
    if (sessionId === undefined) {
      throw Object.assign(new Error('the remote DSH created a session but returned no id'), { status: 502 })
    }
    const { asOfSeq, values } = await readProjections(client, sessionId)
    return {
      ...sessionFromRow({
        sessionId,
        updatedAt: Date.now(),
        blank: true,
        cwd,
        projections: { kind: 'sequenced', asOfSeq: asOfSeq ?? 0, values },
      }),
      nativeKey: sessionId,
    }
  },

  /**
   * Read-only readiness probe: authenticate and ask one cheap global question.
   *
   * `session/modelCatalog` takes no arguments, so the probe proves three things
   * at once — reachability, credentials, and a working RPC channel — without
   * touching any session or waking an Agent.
   */
  async probe(config, env) {
    requireConfig(config)
    const client = clientFor(config)
    await client.connect()
    const catalog = await client.call('session/modelCatalog', {})
    const models = modelsFromCatalog(catalog)
    return {
      baseUrl: client.baseUrl,
      authMode: client.authMode,
      models: models.length,
      default: catalog?.default ?? null,
    }
  },

  async createAttachment({ session, config, env, logger }) {
    requireConfig(config)
    return new DshAttachment({ session, config, env, logger })
  },

  /** The remote catalog is host-global. */
  async listModels(config, env) {
    requireConfig(config)
    const client = clientFor(config)
    const catalog = await client.call('session/modelCatalog', {})
    return modelsFromCatalog(catalog)
  },

  /**
   * Map one remote log record onto the bridge's neutral live events.
   *
   * A remote log has no token deltas, so every message is already complete;
   * `turn/start` and `turn/end` are the turn brackets the host keys activity on.
   */
  normalizeEvent(record) {
    return neutralEventsFromDsh(record)
  },
}

export { describe }
