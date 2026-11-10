/**
 * One `opencode serve` child, whichever server generation it speaks.
 *
 * Two npm packages ship an OpenCode CLI and both answer the same `serve`
 * command with a different server API:
 *
 * - 1.x (`opencode-ai`, verified on 1.19.5) prints
 *   `opencode server listening on http://…`, serves unprefixed routes, and only
 *   requires auth when `OPENCODE_SERVER_PASSWORD` is set;
 * - 2.x (`@opencode/cli`, verified on 2.2.6) prints `server listening on http://…`
 *   (no prefix), serves everything under `/api`, and *always* requires HTTP
 *   Basic auth with username `opencode`. It derives the password from
 *   `OPENCODE_PASSWORD` when that is set, otherwise generates one and prints it
 *   as `server password <secret>`.
 *
 * The generated-password path is the only deterministic one: this launcher mints
 * the secret itself, passes it as `OPENCODE_PASSWORD`, and authenticates every
 * request, so nothing has to scrape the password banner and both generations
 * work with the same code. A `OPENCODE_SERVER_PASSWORD` inherited from the
 * user's environment is dropped: 1.x would otherwise demand a secret this
 * process never learns.
 *
 * Both generations ignore plain stdin EOF and SIGTERM on some paths, so shutdown
 * is a bounded escalation ending in SIGKILL.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { createStderrRing, resolveCliCommand } from '../cli.js'

const DEFAULT_READY_TIMEOUT_MS = 30_000
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const STDERR_RING_BYTES = 16 * 1024

/**
 * The readiness banner. 2.x dropped the `opencode ` prefix the 1.x line carried,
 * and `serve --port 0` picks the port randomly, so this line is the only way to
 * learn where the server listens.
 */
const LISTEN_LINE = /(?:opencode )?server listening on (https?:\/\/[^\s]+)/

/** 2.x hardcodes this Basic-auth username (`username: "opencode"` in the server). */
const BASIC_AUTH_USER = 'opencode'

const DEFAULT_SERVE_ARGS = ['serve', '--port', '0', '--hostname', '127.0.0.1']

/** Resolve the launcher without spawning: config wins, then OPENCODE_BIN, then PATH. */
export function resolveOpencodeCommand(config = {}, env = process.env) {
  return resolveCliCommand({
    configBin: config.binPath,
    envVar: 'OPENCODE_BIN',
    defaultNames: ['opencode'],
    env,
  })
}

/**
 * Extract the server URL from the CLI's stdout.
 *
 * The banner line is plain text on stdout, not JSON, and the URL is followed by
 * a newline: tolerate trailing punctuation so a future "listening on …)." form
 * still parses. Both generation prefixes are accepted here because the
 * generation is only known after the server answers a route.
 */
export function parseServerUrl(text) {
  if (typeof text !== 'string') return undefined
  const match = LISTEN_LINE.exec(text)
  if (match === null) return undefined
  return match[1].replace(/[),.;]+$/, '')
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Give every transport failure the 502 shape the host reports to the browser. */
export function transportError(message, cause) {
  return Object.assign(new Error(message), { status: 502, cause })
}

/** True when a fetch failed at the socket level rather than with an HTTP status. */
function isNetworkFailure(error) {
  if (error === null || typeof error !== 'object') return false
  if (error.name === 'TypeError' && error.message === 'fetch failed') return true
  const code = error.cause?.code ?? error.code
  return code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'EPIPE' || code === 'UND_ERR_SOCKET'
}

export function parseJsonBody(text) {
  if (typeof text !== 'string' || text === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function basicAuthHeader(password) {
  return `Basic ${Buffer.from(`${BASIC_AUTH_USER}:${password}`).toString('base64')}`
}

/**
 * One `opencode serve` child plus bounded JSON/SSE requests to it.
 *
 * The owner is responsible for exactly one server (cwd = session directory);
 * the session-create helper and the model catalog spawn their own short-lived
 * copies and reap them. Requests are tracked so a disposed owner aborts every
 * in-flight fetch instead of leaving a socket to keep the event loop alive.
 */
export class OpencodeServer extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} [options.cwd] directory the server binds (its own cwd)
   * @param {NodeJS.ProcessEnv} [options.env]
   * @param {{command: string, prefixArgs?: string[]}} [options.resolved]
   * @param {number} [options.readyTimeoutMs]
   * @param {number} [options.requestTimeoutMs]
   * @param {string} [options.password] server secret; generated when omitted
   * @param {string[]} [options.serveArgs] extra/override `serve` arguments
   */
  constructor(options = {}) {
    super()
    this.cwd = typeof options.cwd === 'string' && options.cwd !== '' && existsSync(options.cwd)
      ? options.cwd
      : homedir()
    this.env = options.env ?? process.env
    this.resolved = options.resolved ?? resolveOpencodeCommand({}, this.env)
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
    this.requestTimeoutMs = options.requestTimeoutMs ?? options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.password = options.password ?? randomBytes(24).toString('base64url')
    this.authorization = basicAuthHeader(this.password)
    this.serveArgs = options.serveArgs ?? DEFAULT_SERVE_ARGS
    this.child = undefined
    this.exited = false
    this.baseUrl = undefined
    this.stdout = ''
    this.stderrRing = createStderrRing(STDERR_RING_BYTES)
    this.inflight = new Set()
    this.urls = []
    this.exitInfo = undefined
    this.generation = undefined
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

  /**
   * The child environment. 2.x uses `OPENCODE_PASSWORD` verbatim; 1.x only knows
   * `OPENCODE_SERVER_PASSWORD`, so leaving an inherited one would make 1.x
   * require a secret this process cannot know.
   */
  childEnv() {
    const env = { ...this.env, OPENCODE_PASSWORD: this.password }
    delete env.OPENCODE_SERVER_PASSWORD
    return env
  }

  /** Spawn the server and resolve once it reports a listening URL. */
  async start() {
    if (this.child !== undefined) return this
    const args = [...(this.resolved.prefixArgs ?? []), ...this.serveArgs]
    let child
    try {
      child = spawn(this.resolved.command, args, {
        cwd: this.cwd,
        env: this.childEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      throw transportError(`could not start the OpenCode server: ${errorMessage(error)}`, error)
    }
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      // Keep only a bounded prefix: the listening line is printed once, before
      // any other stdout traffic, so a long-running server cannot grow this.
      if (this.baseUrl === undefined) this.stdout = (this.stdout + chunk).slice(-64 * 1024)
      this.checkForServerUrl()
    })
    child.stderr.on('data', (chunk) => this.stderrRing.push(chunk))
    child.on('error', (error) => this.handleExit(undefined, error))
    child.on('exit', (code, signal) => this.handleExit({ code, signal }))
    this.emit('spawn', { pid: child.pid, command: this.resolved.command, args, cwd: this.cwd })
    try {
      await this.waitForServerUrl()
    } catch (error) {
      // A failed start must not leave the child running: the caller's only
      // handle to it is this object, which it will not start again.
      await this.stop()
      throw error
    }
    return this
  }

  /**
   * Decide which server API generation the child speaks.
   *
   * The signal is the 2.x session collection: `GET /api/session` answers
   * `{data:[…]}` there, while 1.x does not serve that route and still answers
   * the unprefixed `/global/health` probe. Detection is cached because every
   * request in a v2 conversation needs the answer and a 1.x conversation must
   * not pay for a second failed probe.
   */
  async detectGeneration() {
    if (this.generation !== undefined) return this.generation
    const probeTimeoutMs = Math.min(this.requestTimeoutMs, 5_000)
    const sessions = await this.request('/api/session?limit=1', { timeoutMs: probeTimeoutMs }).catch(() => undefined)
    if (sessions !== null && typeof sessions === 'object' && Array.isArray(sessions.data)) {
      this.generation = 'v2'
      return this.generation
    }
    try {
      await this.request('/global/health', { timeoutMs: probeTimeoutMs })
      this.generation = 'v1'
      return this.generation
    } catch (error) {
      throw transportError(
        `could not determine the OpenCode server generation${this.stderrSuffix()}: ${errorMessage(error)}`,
        error,
      )
    }
  }

  checkForServerUrl() {
    if (this.baseUrl !== undefined) return
    const url = parseServerUrl(this.stdout)
    if (url === undefined) return
    this.baseUrl = url.replace(/\/+$/, '')
    const waiters = this.urls
    this.urls = []
    for (const resolve of waiters) resolve(this.baseUrl)
  }

  waitForServerUrl() {
    if (this.baseUrl !== undefined) return Promise.resolve(this.baseUrl)
    if (this.exited) {
      return Promise.reject(transportError(`OpenCode server exited before it was ready${this.failureSuffix()}`))
    }
    return new Promise((resolve, reject) => {
      const onExit = () => {
        clearTimeout(timer)
        cleanup()
        reject(transportError(`OpenCode server exited before it was ready${this.failureSuffix()}`))
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(transportError(
          `OpenCode server did not report a listening URL within ${this.readyTimeoutMs}ms${this.stderrSuffix()}`,
        ))
      }, this.readyTimeoutMs)
      timer.unref?.()
      const onReady = (url) => {
        clearTimeout(timer)
        cleanup()
        resolve(url)
      }
      const cleanup = () => {
        this.urls = this.urls.filter((entry) => entry !== onReady)
        this.off('exit', onExit)
      }
      this.urls.push(onReady)
      this.once('exit', onExit)
    })
  }

  stderrSuffix() {
    const detail = this.stderr.trim()
    return detail === '' ? '' : `: ${detail}`
  }

  /**
   * Failure detail for a start that never became ready. A spawn error (ENOENT,
   * EACCES) has no stderr, so its message is the only useful diagnostic.
   */
  failureSuffix() {
    const spawnError = this.exitInfo?.error
    if (spawnError !== undefined && spawnError !== null) {
      const message = errorMessage(spawnError)
      if (message !== '') return `: ${message}`
    }
    return this.stderrSuffix()
  }

  handleExit(info, error) {
    if (this.exited) return
    this.exited = true
    this.exitInfo = error === undefined ? info : { error }
    this.urls = []
    this.abortInflight(transportError(`OpenCode server exited before responding${this.stderrSuffix()}`, error))
    this.emit('exit', { ...(info ?? {}), ...(error === undefined ? {} : { error }), stderr: this.stderr })
  }

  /**
   * One bounded JSON request. `timeoutMs: 0` disables the timeout.
   *
   * Every request is aborted when the child exits or the server is stopped, so
   * a caller never waits forever on a socket the process no longer owns.
   */
  async request(pathname, options = {}) {
    if (!this.running || this.baseUrl === undefined) {
      throw transportError('OpenCode server is not running')
    }
    const url = new URL(pathname, this.baseUrl)
    const controller = new AbortController()
    const entry = { controller, failure: undefined }
    this.inflight.add(entry)
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs
    const timer = timeoutMs > 0
      ? setTimeout(() => controller.abort(), timeoutMs)
      : undefined
    timer?.unref?.()
    const method = options.method ?? 'GET'
    try {
      const response = await fetch(url, {
        method,
        headers: {
          authorization: this.authorization,
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(options.headers ?? {}),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      })
      const text = await response.text()
      if (!response.ok) {
        throw transportError(
          `OpenCode ${method} ${pathname} failed with ${response.status}${text === '' ? '' : `: ${text.slice(0, 500)}`}`,
        )
      }
      return parseJsonBody(text)
    } catch (error) {
      if (entry.failure !== undefined) throw entry.failure
      if (error?.name === 'AbortError') {
        throw transportError(`OpenCode ${method} ${pathname} timed out after ${timeoutMs}ms`)
      }
      // A killed server resets the socket before the process exit is delivered,
      // so a network-level failure has to give the exit event a moment before it
      // can be reported as a plain connection error. Callers (and the host's
      // error copy) need to tell a dead child from a network fault.
      if (error?.status !== 502 && isNetworkFailure(error) && !this.exited) {
        await this.waitForExit(250)
      }
      if (this.exited) {
        throw transportError(`OpenCode server exited before responding${this.stderrSuffix()}`, error)
      }
      if (error?.status === 502) throw error
      throw transportError(`OpenCode ${method} ${pathname} failed: ${errorMessage(error)}`, error)
    } finally {
      clearTimeout(timer)
      this.inflight.delete(entry)
    }
  }

  /**
   * Abort every open socket. The owner's own event stream is not tracked here:
   * it is a long-lived read that only its owner can cancel.
   */
  abortInflight(failure) {
    for (const entry of this.inflight) {
      entry.failure = failure
      entry.controller.abort()
    }
    this.inflight.clear()
  }

  /**
   * Streamed GET (the SSE `/event` feed). The response body is pumped by the
   * caller; `signal` lets the owner cancel the read during dispose.
   */
  async streamRequest(pathname, signal) {
    if (!this.running || this.baseUrl === undefined) {
      throw transportError('OpenCode server is not running')
    }
    try {
      const response = await fetch(new URL(pathname, this.baseUrl), {
        headers: { authorization: this.authorization },
        signal,
      })
      if (!response.ok) {
        throw transportError(`OpenCode GET ${pathname} failed with ${response.status}`)
      }
      return response
    } catch (error) {
      if (error?.name === 'AbortError') throw error
      if (error?.status === 502) throw error
      throw transportError(`OpenCode GET ${pathname} failed: ${errorMessage(error)}`, error)
    }
  }

  /**
   * Shut the server down. Both generations ignore stdin EOF and SIGTERM on some
   * paths (verified on 1.19.5 and 2.2.6), so this is a bounded escalation and
   * only SIGKILL is guaranteed: leaving the child alive would keep the host's
   * event loop busy forever.
   */
  async stop() {
    if (this.child === undefined || this.exited) return
    this.abortInflight(transportError('OpenCode server was disposed'))
    const child = this.child
    try {
      child.stdin.end()
    } catch {
      // The child may already have closed stdin.
    }
    if (await this.waitForExit(300)) return
    try {
      child.kill('SIGTERM')
    } catch {
      // Already gone.
    }
    if (await this.waitForExit(250)) return
    try {
      child.kill('SIGKILL')
    } catch {
      // Already gone.
    }
    await this.waitForExit(1000)
  }

  waitForExit(timeoutMs) {
    if (this.exited) return Promise.resolve(true)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.off('exit', onExit)
        resolve(false)
      }, timeoutMs)
      timer.unref?.()
      const onExit = () => {
        clearTimeout(timer)
        resolve(true)
      }
      this.once('exit', onExit)
    })
  }
}
