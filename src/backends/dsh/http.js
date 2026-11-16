/**
 * HTTP transport for the remote DSH engine backend.
 *
 * The remote DeepSeek Harness web server speaks a small RPC protocol: a
 * `client-request` JSON envelope POSTed to `<base>/api/<method>` is answered by
 * a `server-response` envelope whose `result` is either `{ ok: true, value }` or
 * `{ ok: false, error }`. This module owns only the wire concerns (auth cookies,
 * envelopes, timeouts, retries); mapping results onto sessions is the adapter's
 * job.
 *
 * Auth has two shapes, selected by what the bridge configures:
 * - `token`: `GET /?token=<launch token>` mints a session cookie;
 * - `password`: `POST /login` against a dsh-gateway mints a gateway cookie.
 * Both cookies are reused for every `/api` call. A launch token cannot be used
 * through a gateway: the gateway answers with a redirect to its login page.
 *
 * Only node:http / node:https are used (no global fetch) so TLS options stay
 * controllable and no dependency is added.
 */
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import { URL } from 'node:url'

const DEFAULT_TIMEOUT_MS = 30_000
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 5

const GATEWAY_TOKEN_HINT =
  'This DSH is behind dsh-gateway, where launch tokens are not supported. Configure the dsh-gateway password in the bridge settings instead.'

/** Base class for every error this module throws. */
export class DshError extends Error {
  constructor(message, { kind, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'DshError'
    this.kind = kind ?? 'unknown'
  }
}

/**
 * Authentication / URL-configuration failure. See `.kind`.
 *
 * `status` is the HTTP status the bridge host should answer the browser with: a
 * malformed base URL is the caller's own request (400), while a remote refusal
 * is the upstream's answer relayed to us (502).
 */
export class DshAuthError extends DshError {
  constructor(message, kind, options = {}) {
    super(message, { ...options, kind })
    this.name = 'DshAuthError'
    this.status = kind === 'invalid-url' ? 400 : 502
  }
}

/** RPC-level failure (`result.ok === false`). */
export class DshRpcError extends DshError {
  constructor(message, { method, code, details, cause } = {}) {
    super(message, { cause })
    this.name = 'DshRpcError'
    this.method = method
    this.code = code
    this.details = details
  }
}

/** Unexpected HTTP status or transport failure. */
export class DshHttpError extends DshError {
  constructor(message, { status, method, body, cause } = {}) {
    super(message, { cause })
    this.name = 'DshHttpError'
    this.status = status
    this.method = method
    this.body = body
  }
}

/**
 * Validate and canonicalize a remote DSH base URL.
 * Preserves any path prefix and strips a trailing slash (except for the root).
 */
export function normalizeBaseUrl(raw) {
  const invalid = (detail) =>
    new DshAuthError(`Invalid DSH base URL (${detail}): expected an http:// or https:// URL.`, 'invalid-url')
  if (typeof raw !== 'string' || raw.trim() === '') throw invalid('empty')
  let url
  try {
    url = new URL(raw.trim())
  } catch {
    throw invalid('not parseable')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw invalid('unsupported scheme')
  if (!url.hostname) throw invalid('missing host')
  url.search = ''
  url.hash = ''
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '')
  }
  return url
}

const clipText = (value, max = 400) => {
  const text = String(value ?? '')
  return text.length > max ? `${text.slice(0, max)}...` : text
}

const headerValue = (headers, name) => {
  if (!headers) return undefined
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value
  }
  return undefined
}

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

function isLoginRedirect(response) {
  if (!REDIRECT_STATUSES.has(response.status)) return false
  const location = String(headerValue(response.headers, 'location') ?? '')
  return /(^|\/)login(\b|[?#/])/.test(location) || /[?&]login(=|&|$)/.test(location)
}

/**
 * Create a client for one remote DSH web instance.
 *
 * @returns {{ baseUrl: string, authMode: 'token'|'password'|'none', call: Function,
 *   connect: Function, request: Function, close: Function }}
 */
export function createDshClient({
  baseUrl,
  token = null,
  password = null,
  allowInsecureTls = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  logger = null,
} = {}) {
  const base = normalizeBaseUrl(baseUrl)
  const authMode =
    typeof token === 'string' && token.length > 0
      ? 'token'
      : typeof password === 'string' && password.length > 0
        ? 'password'
        : 'none'
  const requestTimeoutMs =
    typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS

  /** name -> value; one map per client so two clients stay independent. */
  const cookies = new Map()
  let connectPromise = null
  let authDone = false
  let reauthPromise = null

  const cookieHeader = () => [...cookies].map(([name, value]) => `${name}=${value}`).join('; ')

  function mergeCookies(headers) {
    const raw = headers?.['set-cookie']
    if (!raw) return
    for (const line of Array.isArray(raw) ? raw : [raw]) {
      const pair = String(line).split(';', 1)[0].trim()
      const eq = pair.indexOf('=')
      if (eq <= 0) continue
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      if (value === '') cookies.delete(name)
      else cookies.set(name, value)
    }
  }

  function resolveUrl(path) {
    if (/^https?:\/\//i.test(path)) return new URL(path)
    const prefix = base.pathname === '/' ? '' : base.pathname.replace(/\/+$/, '')
    const suffix = path.startsWith('/') ? path : `/${path}`
    return new URL(`${prefix}${suffix}`, base.origin)
  }

  function rawRequest(method, url, headers, body) {
    return new Promise((resolve, reject) => {
      const outgoing = { ...headers }
      if (
        body !== undefined &&
        body !== null &&
        headerValue(outgoing, 'content-length') === undefined &&
        headerValue(outgoing, 'transfer-encoding') === undefined
      ) {
        outgoing['content-length'] = Buffer.byteLength(body)
      }
      if (headerValue(outgoing, 'cookie') === undefined && cookies.size > 0) {
        outgoing.cookie = cookieHeader()
      }
      const transport = url.protocol === 'https:' ? https : http
      const options = {
        method,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        headers: outgoing,
      }
      if (url.protocol === 'https:' && allowInsecureTls) options.rejectUnauthorized = false

      let settled = false
      let timer
      const finish = (error, value) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (error) reject(error)
        else resolve(value)
      }
      const label = `${method} ${url.pathname}`
      let req
      try {
        req = transport.request(options, (res) => {
          mergeCookies(res.headers)
          const chunks = []
          res.on('data', (chunk) => chunks.push(chunk))
          res.on('end', () => {
            finish(undefined, {
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            })
          })
          res.on('error', (error) => {
            finish(new DshError(`DSH ${label} failed while reading the response: ${error.message}`, { cause: error }))
          })
        })
      } catch (error) {
        finish(new DshError(`DSH ${label} failed: ${error.message}`, { cause: error }))
        return
      }
      timer = setTimeout(() => {
        if (settled) return
        req.destroy()
        finish(new DshError(`DSH request timed out after ${requestTimeoutMs}ms (${label})`))
      }, requestTimeoutMs)
      req.on('error', (error) => {
        finish(
          error instanceof DshError
            ? error
            : new DshError(`DSH ${label} failed: ${error.message}`, { cause: error }),
        )
      })
      if (body !== undefined && body !== null) req.write(body)
      req.end()
    })
  }

  async function request(method, path, { headers, body, redirect } = {}) {
    return requestWithRedirects(method, path, { headers, body, redirect }, 0)
  }

  async function requestWithRedirects(method, path, options, depth) {
    const url = resolveUrl(path)
    const headers = options.headers ?? {}
    const response = await rawRequest(method, url, headers, options.body)
    if (
      options.redirect &&
      REDIRECT_STATUSES.has(response.status) &&
      response.headers.location &&
      depth < MAX_REDIRECTS
    ) {
      const nextUrl = new URL(response.headers.location, url)
      const switchToGet =
        response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')
      return requestWithRedirects(
        switchToGet ? 'GET' : method,
        nextUrl.href,
        { ...options, body: switchToGet ? undefined : options.body },
        depth + 1,
      )
    }
    return response
  }

  async function connectWithToken() {
    const response = await request('GET', `/?token=${encodeURIComponent(token)}`, {
      headers: { accept: 'text/html' },
    })
    if (isLoginRedirect(response)) throw new DshAuthError(GATEWAY_TOKEN_HINT, 'unauthenticated')
    if (response.status === 401) {
      throw new DshAuthError(
        'The remote DSH rejected the launch token (HTTP 401). Launch tokens are ephemeral: dsh prints a new one for every process, so copy the current token from the running remote DSH web URL and try again.',
        'bad-token',
      )
    }
    if (response.status === 403) {
      throw new DshAuthError(
        'The remote DSH refused this request because its Host header is not trusted (HTTP 403). Start the remote dsh web with `--trusted-host <host>` matching the configured URL host, then retry.',
        'untrusted-host',
      )
    }
    if (response.status === 400) {
      throw new DshAuthError(
        'The remote DSH rejected the launch-token URL as malformed (HTTP 400). Copy the token exactly from the running remote DSH web URL; it is ephemeral per dsh process.',
        'bad-token',
      )
    }
    if (response.status >= 400) {
      throw new DshAuthError(
        `Launch-token authentication against the remote DSH failed with HTTP ${response.status}. Re-open the URL printed by dsh web and copy a fresh token.`,
        'unauthenticated',
      )
    }
    if (cookies.size === 0) {
      throw new DshAuthError(
        'The remote DSH answered the launch-token request but did not set a session cookie. Re-open the URL printed by dsh web and copy the current token; launch tokens are ephemeral.',
        'unauthenticated',
      )
    }
  }

  async function connectWithPassword() {
    const body = new URLSearchParams({ password, next: '/' }).toString()
    const response = await request('POST', '/login', {
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
      body,
    })
    const hasSession = cookies.has('dsh_gateway_session')
    if (hasSession && response.status < 400) return
    if (response.status === 400) {
      throw new DshAuthError(
        'The dsh-gateway has no password yet; open it in a browser to set one, then configure that password in the bridge settings.',
        'no-password',
      )
    }
    if (response.status === 403) {
      throw new DshAuthError(
        'The dsh-gateway refused this request because its Host header is not trusted (HTTP 403). Start it with `--trusted-host <host>` matching the configured URL host, then retry.',
        'untrusted-host',
      )
    }
    if (response.status === 401 || isLoginRedirect(response)) {
      throw new DshAuthError(
        'The dsh-gateway rejected the password (HTTP 401). Check the dsh-gateway password configured in the bridge settings.',
        'bad-password',
      )
    }
    throw new DshAuthError(
      `dsh-gateway login failed with HTTP ${response.status} and no session cookie; check the gateway URL and password.`,
      'unauthenticated',
    )
  }

  function connect() {
    if (authDone) return Promise.resolve()
    if (connectPromise) return connectPromise
    const flow =
      authMode === 'token' ? connectWithToken() : authMode === 'password' ? connectWithPassword() : Promise.resolve()
    const promise = flow
      .then(() => {
        authDone = true
        connectPromise = null
      })
      .catch((error) => {
        connectPromise = null
        throw error
      })
    connectPromise = promise
    return promise
  }

  function reauthenticate() {
    if (reauthPromise) return reauthPromise
    authDone = false
    connectPromise = null
    cookies.clear()
    reauthPromise = connect().finally(() => {
      reauthPromise = null
    })
    return reauthPromise
  }

  function parseRpcResponse(response, method, rpcId) {
    if (response.status !== 200) {
      throw new DshHttpError(`DSH ${method} failed with HTTP ${response.status}`, {
        status: response.status,
        method,
        body: clipText(response.body),
      })
    }
    let envelope
    try {
      envelope = JSON.parse(response.body)
    } catch {
      throw new DshError(`malformed RPC envelope for ${method}: response body was not valid JSON`)
    }
    if (!isPlainObject(envelope) || envelope.type !== 'server-response') {
      throw new DshError(`malformed RPC envelope for ${method}: expected a server-response`)
    }
    if (envelope.rpcId !== rpcId) {
      throw new DshError(`malformed RPC envelope for ${method}: rpcId did not match the request`)
    }
    const result = envelope.result
    if (!isPlainObject(result)) {
      throw new DshError(`malformed RPC envelope for ${method}: missing result`)
    }
    if (result.ok === true) return result.value
    if (result.ok === false) {
      const error = isPlainObject(result.error) ? result.error : {}
      const code = typeof error.code === 'string' ? error.code : 'unknown'
      const message = typeof error.message === 'string' ? error.message : 'no error message'
      throw new DshRpcError(`DSH ${method} failed: ${code}: ${message}`, {
        method,
        code,
        details: error.details,
      })
    }
    throw new DshError(`malformed RPC envelope for ${method}: result.ok was not a boolean`)
  }

  async function callOnce(method, args) {
    const rpcId = randomUUID()
    const body = JSON.stringify({
      type: 'client-request',
      rpcId,
      method,
      payload: { args: args ?? {} },
    })
    const response = await request('POST', `/api/${method}`, {
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body,
    })
    if (isLoginRedirect(response)) throw new DshAuthError(GATEWAY_TOKEN_HINT, 'unauthenticated')
    // The index route has no trust fence: it mints a cookie even for an
    // untrusted Host. The fence answers here, on the first `/api` call, and it
    // is a deployment problem rather than a transport one.
    if (response.status === 403) {
      throw new DshAuthError(
        `The remote DSH refused ${method} because this Host is not trusted (HTTP 403). Start the remote dsh web with \`--trusted-host ${base.host}\` (or proxy it through dsh-gateway, which presents a loopback host).`,
        'untrusted-host',
      )
    }
    return parseRpcResponse(response, method, rpcId)
  }

  async function call(method, args) {
    await connect()
    try {
      return await callOnce(method, args)
    } catch (error) {
      if (!(error instanceof DshHttpError) || error.status !== 401) throw error
      logger?.warn?.(`dsh: authentication for ${base.href} expired; re-authenticating once`)
      await reauthenticate()
      try {
        return await callOnce(method, args)
      } catch (retryError) {
        if (authMode === 'none' && retryError instanceof DshHttpError && retryError.status === 401) {
          throw new DshAuthError(
            'The remote DSH requires authentication; configure a launch token or a dsh-gateway password in the bridge settings.',
            'unauthenticated',
          )
        }
        throw retryError
      }
    }
  }

  return {
    baseUrl: base.href,
    authMode,
    call,
    connect,
    request,
    close: () => {},
  }
}
