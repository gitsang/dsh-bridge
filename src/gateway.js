/** Multi-Host path-prefix gateway for dsh Web. */
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  AUTH_COOKIE, PasswordStore, SessionStore, escapeHtml, loginPage, parseCookies, safeNext,
} from './auth.js'
import { BackendManager } from './backends.js'
import { configPath, normalizeConfig, readConfig, removeBridge, upsertBridge, writeConfig } from './config.js'
import { parseMount, proxyHttp, proxyUpgrade } from './proxy.js'
import { renderShell } from './shell.js'
import { authorityOf } from './upstream-auth.js'

const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const GATEWAY_API = '/__bridge'
const FORM_LIMIT = 64 * 1024

function envValue(name) {
  const value = process.env[name]
  return value === undefined || value === '' ? undefined : value
}

function oneShotBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size <= limit) chunks.push(chunk)
    })
    request.on('end', () => resolve(size <= limit ? Buffer.concat(chunks).toString('utf8') : undefined))
    request.on('error', reject)
  })
}

function json(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(value))
}

export class BridgeGateway {
  /**
   * @param {object} ctx - Cordis context carrying webServer and optional connection.
   * @param {object} config - host, port, dataDir, configPath, auth.
   */
  constructor(ctx, config = {}) {
    this.ctx = ctx
    this.config = {
      host: config.host ?? envValue('DSH_BRIDGE_HOST') ?? '127.0.0.1',
      port: config.port ?? Number(envValue('DSH_BRIDGE_PORT') ?? 0),
      dataDir: config.dataDir ?? envValue('DSH_BRIDGE_DATA_DIR') ?? join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', 'bridge-v2'),
      configPath: config.configPath ?? envValue('DSH_BRIDGE_CONFIG') ?? configPath(),
      auth: config.auth !== false && envValue('DSH_BRIDGE_AUTH') !== '0',
    }
    this.server = undefined
    this.port = undefined
    this.sockets = new Set()
    this.backends = undefined
    this.backendsReady = Promise.resolve()
    this.mutation = Promise.resolve()
    this.passwords = undefined
    this.sessions = undefined
  }

  async start() {
    this.passwords = new PasswordStore(join(this.config.dataDir, 'auth.json'))
    this.sessions = new SessionStore(join(this.config.dataDir, 'session.json'))
    await Promise.all([this.passwords.init(), this.sessions.init()])
    this.currentConfig = await readConfig(this.config.configPath)

    const webServerPort = Number(this.ctx.get?.('webServer')?.port ?? this.ctx.webServer?.port ?? 0)
    if (!Number.isInteger(this.config.port) || this.config.port < 0 || this.config.port > 65535) {
      throw new Error('DSH_BRIDGE_PORT must be an integer from 0 through 65535')
    }
    if (this.config.port === 0 && Number.isInteger(webServerPort) && webServerPort > 0 && webServerPort < 65535) {
      this.config.port = webServerPort + 1
    }
    this.backends = new BackendManager({
      config: this.currentConfig,
      webServerPort: () => Number(this.ctx.get?.('webServer')?.port ?? this.ctx.webServer?.port ?? webServerPort),
      selfTokenizedUrl: async (target) => {
        const connection = this.ctx.get?.('connection') ?? this.ctx.connection
        return connection?.authenticatedUrl?.(`http://${authorityOf(target)}/`)
      },
      logger: this.ctx.logger,
    })

    this.server = createServer((request, response) => {
      this.handle(request, response).catch((error) => {
        this.ctx.logger?.error?.(error)
        if (response.headersSent) response.destroy()
        else json(response, 500, { error: error instanceof Error ? error.message : String(error) })
      })
    })
    this.server.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
    })
    this.server.on('upgrade', (request, socket, head) => {
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
      this.handleUpgrade(request, socket, head).catch((error) => {
        this.ctx.logger?.error?.(error)
        socket.destroy()
      })
    })

    await new Promise((resolve, reject) => {
      const failed = (error) => reject(error)
      this.server.once('error', failed)
      this.server.listen(this.config.port, this.config.host, () => {
        this.server.off('error', failed)
        this.server.on('error', (error) => this.ctx.logger?.error?.(error))
        const address = this.server.address()
        this.port = typeof address === 'object' && address !== null ? address.port : this.config.port
        resolve()
      })
    })
    this.backendsReady = this.backends.startAll()
    return this
  }

  /** Public gateway state for the shell and tests. */
  state() {
    return {
      name: '@gitsang/dsh-bridge',
      version: PACKAGE_VERSION,
      listen: { host: this.config.host, port: this.port },
      auth: this.config.auth,
      requiresSetup: this.passwords?.configured === false,
      bridges: this.backends?.states() ?? [],
    }
  }

  async handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://bridge.invalid')
    const pathname = url.pathname

    if (pathname === '/favicon.svg') {
      response.writeHead(204, { 'cache-control': 'public, max-age=86400' })
      response.end()
      return
    }
    if (pathname === '/login') {
      if (request.method === 'GET') return this.serveLogin(request, response, url)
      if (request.method === 'POST') return this.login(request, response)
      response.writeHead(405, { allow: 'GET, POST' })
      response.end()
      return
    }
    if (pathname === '/logout') return this.logout(request, response)

    const session = this.sessionFor(request)
    if (this.config.auth && session === undefined) {
      if (pathname === GATEWAY_API || pathname.startsWith(`${GATEWAY_API}/`) || pathname === '/api' || pathname.startsWith('/api/')) {
        json(response, 401, { error: 'unauthorized' })
      } else {
        response.writeHead(302, { location: `/login?next=${encodeURIComponent(request.url ?? '/')}` })
        response.end()
      }
      return
    }
    if (session !== undefined) void this.sessions.touch(session.token).catch(() => {})

    if (pathname === GATEWAY_API || pathname.startsWith(`${GATEWAY_API}/`)) {
      await this.handleApi(request, response, url)
      return
    }
    if (pathname === '/') {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'private, no-cache',
        vary: 'Cookie',
      })
      response.end(renderShell({ version: PACKAGE_VERSION }))
      return
    }

    const exact = /^\/b\/([a-z0-9][a-z0-9-]*)$/.exec(pathname)
    if (exact !== null) {
      response.writeHead(301, { location: `/b/${exact[1]}/${url.search}` })
      response.end()
      return
    }
    const mount = parseMount(pathname)
    if (mount === undefined) {
      json(response, 404, { error: 'not found' })
      return
    }
    const backend = this.backends.get(mount.id)
    if (backend === undefined) {
      json(response, 404, { error: `unknown bridge: ${mount.id}` })
      return
    }
    if (backend.status !== 'ready' || backend.target === undefined) {
      response.writeHead(503, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'retry-after': '2',
      })
      response.end(`<!doctype html><meta charset="utf-8"><title>Bridge unavailable</title><body style="font:14px system-ui;padding:32px;background:#0e1014;color:#e7e9ee"><h1 style="font-size:18px">${escapeHtml(backend.name)} is ${escapeHtml(backend.status)}</h1><p style="color:#9299a6">${escapeHtml(backend.error ?? 'Waiting for the dsh Host to become ready.')}</p><p><a style="color:#7da2ff" href="/">Back to bridges</a></p></body>`)
      return
    }
    await proxyHttp({
      req: request,
      res: response,
      mount,
      target: backend.target,
      cookieFor: () => backend.auth.cookieFor(),
      refreshCookie: async () => {
        backend.auth.forget()
        return backend.auth.refresh()
      },
    })
  }

  async handleUpgrade(request, socket, head) {
    const url = new URL(request.url ?? '/', 'http://bridge.invalid')
    if (this.config.auth && this.sessionFor(request) === undefined) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 12\r\n\r\nunauthorized')
      return
    }
    const mount = parseMount(url.pathname)
    const backend = mount === undefined ? undefined : this.backends.get(mount.id)
    if (mount === undefined || backend === undefined) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 9\r\n\r\nnot found')
      return
    }
    if (backend.status !== 'ready' || backend.target === undefined) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 19\r\n\r\nbackend unavailable')
      return
    }
    let cookie = await backend.auth.cookieFor()
    if (cookie === undefined) cookie = await backend.auth.refresh()
    await proxyUpgrade({
      req: request,
      socket,
      head,
      mount,
      target: backend.target,
      cookieFor: async () => cookie ?? backend.auth.cookieFor(),
      refreshCookie: async () => {
        backend.auth.forget()
        return backend.auth.refresh()
      },
    })
  }

  sessionFor(request) {
    if (!this.config.auth) return undefined
    const token = parseCookies(request.headers.cookie)[AUTH_COOKIE]
    return this.sessions.get(token)
  }

  serveLogin(request, response, url) {
    const setup = !this.passwords.configured
    const next = safeNext(url.searchParams.get('next') ?? '/')
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    })
    response.end(loginPage({ setup, next }))
  }

  async login(request, response) {
    const raw = await oneShotBody(request, FORM_LIMIT)
    if (raw === undefined) {
      response.writeHead(413)
      response.end()
      return
    }
    const params = new URLSearchParams(raw)
    const password = params.get('password') ?? ''
    const next = safeNext(params.get('next') ?? '/')
    const setup = !this.passwords.configured
    if (setup) {
      if (password === '' || password !== (params.get('confirm') ?? '')) {
        response.writeHead(400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        response.end(loginPage({ setup, next, error: 'Passwords must match.' }))
        return
      }
      await this.passwords.set(password)
    } else if (!(await this.passwords.verify(password))) {
      response.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(loginPage({ setup, next, error: 'Wrong password.' }))
      return
    }
    const token = await this.sessions.create()
    response.writeHead(302, {
      location: next,
      'cache-control': 'no-store',
      'set-cookie': `${AUTH_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
    })
    response.end()
  }

  async logout(request, response) {
    const token = parseCookies(request.headers.cookie)[AUTH_COOKIE]
    if (token !== undefined) await this.sessions.delete(token)
    response.writeHead(302, {
      location: '/login',
      'set-cookie': `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
    })
    response.end()
  }

  trustedMutation(request) {
    if (request.headers['x-bridge-gateway'] !== '1') return false
    const site = request.headers['sec-fetch-site']
    return site === undefined || site === 'same-origin' || site === 'none'
  }

  async handleApi(request, response, url) {
    const pathname = url.pathname
    if (pathname === `${GATEWAY_API}/state` && request.method === 'GET') {
      json(response, 200, this.state())
      return
    }
    if (request.method !== 'POST' && request.method !== 'PUT' && request.method !== 'DELETE') {
      json(response, 405, { error: 'method not allowed' })
      return
    }
    if (!this.trustedMutation(request)) {
      json(response, 403, { error: 'forbidden' })
      return
    }
    let body
    if ((pathname === `${GATEWAY_API}/bridges` && request.method === 'POST') || request.method === 'PUT') {
      body = await awaitJson(request)
    }
    this.mutation = this.mutation.then(async () => {
      if (pathname === `${GATEWAY_API}/bridges` && request.method === 'POST') {
        await this.mutate((config) => upsertBridge(config, body))
        json(response, 200, this.state())
        return
      }
      const match = /^\/__bridge\/bridges\/([a-z0-9][a-z0-9-]*)(\/restart)?$/.exec(pathname)
      if (match === null) {
        json(response, 404, { error: 'not found' })
        return
      }
      const id = match[1]
      if (match[2] === '/restart' && request.method === 'POST') {
        await this.backends.restart(id)
        json(response, 200, this.state())
        return
      }
      if (request.method === 'PUT') {
        await this.mutate((config) => upsertBridge(config, { ...body, id }))
        json(response, 200, this.state())
        return
      }
      if (request.method === 'DELETE') {
        await this.mutate((config) => removeBridge(config, id))
        json(response, 200, this.state())
        return
      }
      json(response, 405, { error: 'method not allowed' })
    }).catch((error) => {
      json(response, 400, { error: error instanceof Error ? error.message : String(error) })
    })
    await this.mutation
  }

  async mutate(update) {
    const next = await update(this.currentConfig)
    this.currentConfig = await writeConfig(next, this.config.configPath)
    await this.backends.replaceConfig(this.currentConfig)
    this.backendsReady = this.backends.startAll()
  }

  async close() {
    if (this.closed === true) return
    this.closed = true
    this.sessions?.close()
    await this.backends?.stopAll()
    if (this.server !== undefined) {
      this.server.closeAllConnections?.()
      for (const socket of this.sockets) socket.destroy()
      this.sockets.clear()
      await new Promise((resolve) => this.server.close(() => resolve()))
    }
  }
}

async function awaitJson(request) {
  const raw = await oneShotBody(request, FORM_LIMIT)
  if (raw === undefined) throw new Error('request body too large')
  if (raw.trim() === '') return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error('invalid JSON body')
  }
}

export { normalizeConfig }
