/** Bridge backend definitions, process supervision, and health state. */
import { spawn } from 'node:child_process'
import { request as plainHttpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { UpstreamAuth } from './upstream-auth.js'

const URL_PATTERN = /https?:\/\/[^\s"'<>]+/g

function parseTarget(url) {
  const parsed = new URL(url)
  const defaultPort = parsed.protocol === 'https:' ? 443 : 80
  return {
    protocol: parsed.protocol,
    host: parsed.hostname,
    port: Number(parsed.port || defaultPort),
  }
}

function tokenUrlFromOutput(text) {
  for (const match of text.matchAll(URL_PATTERN)) {
    try {
      const url = new URL(match[0].replace(/[),.;]+$/, ''))
      if (url.searchParams.has('token')) return url.href
    } catch {
      // Ignore log fragments that merely resemble URLs.
    }
  }
  return undefined
}

function firstUrl(text) {
  for (const match of text.matchAll(URL_PATTERN)) {
    try {
      return new URL(match[0].replace(/[),.;]+$/, '')).href
    } catch {
      // Ignore malformed log URLs.
    }
  }
  return undefined
}

/** One bridge Host plus its process and upstream-auth state. */
class Backend {
  constructor(definition, options) {
    this.definition = definition
    this.options = options
    this.status = 'stopped'
    this.error = undefined
    this.child = undefined
    this.target = undefined
    this.tokenizedUrl = undefined
    this.output = ''
    this.restartTimer = undefined
    this.restartDelay = 1000
    this.auth = undefined
    this.compat = 'unknown'
    this.remoteVersion = undefined
    this.stopped = false
  }

  get id() { return this.definition.id }
  get name() { return this.definition.name }
  get autostart() { return this.definition.autostart }

  publicState() {
    return {
      id: this.id,
      name: this.name,
      engine: this.definition.engine,
      autostart: this.autostart,
      status: this.status,
      compat: this.compat,
      version: this.remoteVersion,
      error: this.error,
      mount: `/b/${this.id}/`,
      upstream: publicUpstream(this.definition.upstream),
    }
  }

  async start() {
    this.stopped = false
    if (this.status === 'ready' || this.status === 'starting') return
    this.status = 'starting'
    this.error = undefined
    try {
      await this.resolveTarget()
      const info = await this.probe()
      this.remoteVersion = info.version
      const expected = this.definition.health?.version
      this.compat = expected === undefined || info.version === undefined
        ? 'unknown'
        : expected === info.version ? 'compatible' : 'incompatible'
      if (this.compat === 'incompatible') {
        const error = new Error(`incompatible dsh version: expected ${expected}, got ${info.version}`)
        error.code = 'INCOMPATIBLE'
        throw error
      }
      this.status = 'ready'
      this.restartDelay = 1000
    } catch (error) {
      await this.killChild()
      this.fail(error)
      if (error?.code !== 'INCOMPATIBLE') this.scheduleRestart()
    }
  }

  async resolveTarget() {
    const upstream = this.definition.upstream
    if (upstream.self) {
      const port = this.options.webServerPort()
      if (!Number.isInteger(port) || port <= 0) throw new Error('gateway has no dsh web server port')
      this.target = { protocol: 'http:', host: '127.0.0.1', port }
      this.tokenizedUrl = await this.options.selfTokenizedUrl?.(this.target)
    } else if (upstream.url !== undefined) {
      this.target = parseTarget(upstream.url)
      this.tokenizedUrl = upstream.token === undefined
        ? (new URL(upstream.url).searchParams.has('token') ? upstream.url : undefined)
        : withToken(upstream.url, upstream.token)
    } else {
      await this.spawnChild(upstream)
      if (this.target === undefined) throw new Error('backend process did not announce a URL')
    }
    this.auth = new UpstreamAuth(this.target, () => this.tokenizedUrl, this.options.logger)
  }

  async spawnChild(upstream) {
    this.output = ''
    const child = spawn(upstream.command, upstream.args ?? [], {
      cwd: upstream.cwd,
      env: { ...process.env, ...(upstream.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    const onData = (chunk) => {
      const text = chunk.toString('utf8')
      this.output += text
      if (this.output.length > 64 * 1024) this.output = this.output.slice(-32 * 1024)
      const tokenUrl = tokenUrlFromOutput(text) ?? tokenUrlFromOutput(this.output)
      const anyUrl = firstUrl(text) ?? firstUrl(this.output)
      const candidate = tokenUrl ?? anyUrl
      if (candidate !== undefined) {
        this.tokenizedUrl = tokenUrl
        this.target = parseTarget(candidate)
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('error', (error) => this.fail(error))
    child.once('exit', (code, signal) => {
      if (this.child === child) this.child = undefined
      if (this.stopped) return
      this.fail(new Error(`backend exited (code ${String(code)}, signal ${String(signal)})`))
      this.scheduleRestart()
    })
    const deadline = Date.now() + 20_000
    while (this.target === undefined && Date.now() < deadline) {
      if (this.stopped) throw new Error('backend start cancelled')
      if (this.child === undefined && this.status !== 'starting') break
      await delay(50)
    }
    if (this.target === undefined) throw new Error('backend process did not announce an HTTP URL')
  }

  async probe() {
    if (this.target === undefined) throw new Error('backend target is not resolved')
    const timeoutMs = this.definition.health?.timeoutMs ?? 15_000
    const deadline = Date.now() + timeoutMs
    let lastError
    while (Date.now() < deadline) {
      if (this.stopped) throw new Error('backend start cancelled')
      try {
        return await new Promise((resolve, reject) => {
          const request = (this.target.protocol === 'https:' ? httpsRequest : plainHttpRequest)({
            hostname: this.target.host,
            port: this.target.port,
            path: '/',
            method: 'GET',
            headers: { host: `${this.target.host}:${this.target.port}`, connection: 'close' },
            timeout: 2000,
            agent: false,
          }, (response) => {
            response.resume()
            resolve({
              version: typeof response.headers['x-dsh-version'] === 'string'
                ? response.headers['x-dsh-version']
                : undefined,
            })
          })
          request.on('timeout', () => request.destroy(new Error('health check timed out')))
          request.on('error', reject)
          request.end()
        })
      } catch (error) {
        lastError = error
        await delay(100)
      }
    }
    throw lastError ?? new Error('backend health check failed')
  }

  fail(error) {
    this.status = 'failed'
    this.error = error instanceof Error ? error.message : String(error)
    this.options.logger?.warn?.('bridge-gateway: backend %s failed: %s', this.id, this.error)
  }

  scheduleRestart() {
    if (this.stopped || this.restartTimer !== undefined || !this.autostart) return
    const delayMs = this.restartDelay
    this.restartDelay = Math.min(this.restartDelay * 2, 30_000)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      void this.start()
    }, delayMs)
    this.restartTimer.unref?.()
  }

  async stop() {
    this.stopped = true
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer)
      this.restartTimer = undefined
    }
    await this.killChild()
    this.status = 'stopped'
    this.error = undefined
    this.target = undefined
    this.auth = undefined
  }

  async restart() {
    await this.stop()
    await this.start()
  }

  async killChild() {
    const child = this.child
    this.child = undefined
    if (child === undefined) return
    child.kill('SIGTERM')
    await new Promise((resolve) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
      timer.unref?.()
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}

function publicUpstream(upstream) {
  if (upstream.self) return { self: true }
  if (upstream.command !== undefined) {
    return {
      command: upstream.command,
      args: [...(upstream.args ?? [])],
      ...(upstream.cwd === undefined ? {} : { cwd: upstream.cwd }),
    }
  }
  const url = new URL(upstream.url)
  const redacted = url.searchParams.has('token')
  if (redacted) url.searchParams.set('token', '***')
  return { url: url.href, ...(redacted ? { token: true } : {}) }
}

function withToken(rawUrl, token) {
  const url = new URL(rawUrl)
  url.searchParams.set('token', token)
  return url.href
}

function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** Owns every configured backend and exposes the HTTP proxy's resolution surface. */
export class BackendManager {
  constructor({ config, webServerPort, selfTokenizedUrl, logger }) {
    this.config = config
    this.webServerPort = webServerPort
    this.selfTokenizedUrl = selfTokenizedUrl
    this.logger = logger
    this.byId = new Map()
    for (const definition of config.bridges) {
      this.byId.set(definition.id, new Backend(definition, {
        webServerPort,
        selfTokenizedUrl,
        logger,
      }))
    }
  }

  get(id) {
    return this.byId.get(id)
  }

  list() {
    return [...this.byId.values()]
  }

  states() {
    return this.list().map((backend) => backend.publicState())
  }

  async startAll() {
    await Promise.all(this.list().filter((backend) => backend.autostart).map((backend) => backend.start()))
  }

  async stopAll() {
    await Promise.all(this.list().map((backend) => backend.stop()))
  }

  /** Stop every old backend and rebuild the roster from a new config. */
  async replaceConfig(config) {
    await this.stopAll()
    this.config = config
    this.byId.clear()
    for (const definition of config.bridges) {
      this.byId.set(definition.id, new Backend(definition, {
        webServerPort: this.webServerPort,
        selfTokenizedUrl: this.selfTokenizedUrl,
        logger: this.logger,
      }))
    }
  }

  async restart(id) {
    const backend = this.get(id)
    if (backend === undefined) throw new Error(`unknown bridge: ${id}`)
    await backend.restart()
    return backend.publicState()
  }
}
