/** Path-prefix HTTP and WebSocket proxy for mounted dsh Hosts. */
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { AUTH_COOKIE, proxyCookieHeader } from './auth.js'
import { authorityOf } from './upstream-auth.js'

export const MOUNT_PREFIX = '/b/'
const MOUNT_PATTERN = /^\/b\/([a-z0-9][a-z0-9-]*)(\/.*)?$/
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])
const BODY_LIMIT = 2 * 1024 * 1024

/** Parse `/b/<id>/...`, returning the mount id and the upstream path. */
export function parseMount(pathname) {
  const match = MOUNT_PATTERN.exec(pathname)
  if (match === null) return undefined
  const suffix = match[2] ?? '/'
  const path = suffix.startsWith('/') ? suffix : `/${suffix}`
  if (path.split('/').some((segment) => segment === '..' || segment === '.')) return undefined
  return { id: match[1], path }
}

/** Rewrite one absolute upstream redirect or cookie path into the mount namespace. */
export function mountLocation(location, id, target) {
  if (typeof location !== 'string' || location === '') return location
  const mount = `${MOUNT_PREFIX}${id}`
  if (location.startsWith('//')) return location
  if (location.startsWith('/')) return `${mount}${location}`
  try {
    const url = new URL(location)
    const upstream = new URL(`${target.protocol ?? 'http:'}//${authorityOf(target)}`)
    if (url.origin !== upstream.origin) return location
    return `${mount}${url.pathname}${url.search}${url.hash}`
  } catch {
    return location
  }
}

/** Filter hop-by-hop request headers, including tokens named by `Connection`. */
export function filterHopByHop(headers) {
  const named = typeof headers.connection === 'string'
    ? headers.connection.split(',').map((token) => token.trim().toLowerCase())
    : []
  const out = {}
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (value === undefined || HOP_BY_HOP.has(lower) || named.includes(lower)) continue
    out[lower] = value
  }
  return out
}

/** Convert browser identity headers to the upstream loopback authority. */
export function upstreamHeaders(headers, target, id) {
  const authority = authorityOf(target)
  const protocol = target.protocol ?? 'http:'
  const origin = `${protocol}//${authority}`
  const out = { ...headers, host: authority, origin }
  if (typeof out.referer === 'string' && out.referer !== '') {
    try {
      const referer = new URL(out.referer)
      const mount = `${MOUNT_PREFIX}${id}`
      const path = referer.pathname.startsWith(mount) ? referer.pathname.slice(mount.length) || '/' : referer.pathname
      out.referer = `${origin}${path}${referer.search}${referer.hash}`
    } catch {
      out.referer = `${origin}/`
    }
  }
  for (const name of ['x-forwarded-for', 'x-real-ip']) {
    if (out[name] !== undefined) out[name] = '127.0.0.1'
  }
  for (const name of ['x-forwarded-host']) {
    if (out[name] !== undefined) out[name] = authority
  }
  for (const name of ['x-forwarded-port']) {
    if (out[name] !== undefined) out[name] = String(target.port)
  }
  for (const name of ['x-forwarded-proto']) {
    if (out[name] !== undefined) out[name] = protocol.slice(0, -1)
  }
  if (out.forwarded !== undefined) out.forwarded = `for=127.0.0.1;host="${authority}";proto=${protocol.slice(0, -1)}`
  return out
}

/** Drop upstream dsh credentials before headers reach the browser. */
export function browserResponseHeaders(headers, id, target) {
  const out = { ...headers }
  if (out.location !== undefined) out.location = mountLocation(out.location, id, target)
  const raw = out['set-cookie']
  const cookies = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]
  const kept = cookies
    .map((cookie) => String(cookie))
    .filter((cookie) => !cookie.split(';', 1)[0]?.trim().startsWith('dsh-auth-'))
    .map((cookie) => cookie.replace(/;\s*Path=\/(?=;|$)/i, `; Path=${MOUNT_PREFIX}${id}/`))
  if (raw !== undefined) {
    if (kept.length === 0) delete out['set-cookie']
    else out['set-cookie'] = Array.isArray(raw) ? kept : kept[0]
  }
  return out
}

function requestFactory(target) {
  return target.protocol === 'https:' ? httpsRequest : httpRequest
}

function sendRequest(target, path, method, headers, body) {
  return new Promise((resolve, reject) => {
    const request = requestFactory(target)({
      hostname: target.host,
      port: target.port,
      path,
      method,
      headers,
      agent: false,
      ...(target.protocol === 'https:' ? { rejectUnauthorized: target.rejectUnauthorized !== false } : {}),
    }, resolve)
    request.on('error', reject)
    if (body === undefined) request.end()
    else request.end(body)
  })
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size <= BODY_LIMIT) chunks.push(chunk)
    })
    request.on('end', () => resolve({
      complete: size <= BODY_LIMIT,
      body: size <= BODY_LIMIT ? Buffer.concat(chunks) : undefined,
    }))
    request.on('error', reject)
  })
}

function sendStreaming(target, path, method, headers, request) {
  return new Promise((resolve, reject) => {
    const upstream = requestFactory(target)({
      hostname: target.host,
      port: target.port,
      path,
      method,
      headers,
      agent: false,
      ...(target.protocol === 'https:' ? { rejectUnauthorized: target.rejectUnauthorized !== false } : {}),
    }, resolve)
    upstream.on('error', reject)
    request.pipe(upstream)
  })
}

function collectResponse(response) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    response.on('data', (chunk) => {
      size += chunk.length
      if (size <= BODY_LIMIT) chunks.push(chunk)
    })
    response.on('end', () => resolve({
      complete: size <= BODY_LIMIT,
      body: size <= BODY_LIMIT ? Buffer.concat(chunks) : undefined,
    }))
    response.on('error', reject)
  })
}

function isDshAuthRejection(response, body) {
  return response.statusCode === 401
    && String(response.headers['content-type'] ?? '').includes('text/plain')
    && body !== undefined
    && body.toString('utf8').includes('dsh web authentication required')
}

const HOST_MODE_TAG = '<script>Object.assign(globalThis.__DSH_TRANSPORT__ ??= {}, { ownsHost: true })</script>'

/** Put the gateway-authenticated page into dsh's Host-owning mode. */
export function injectHostMode(html) {
  const open = /<head(?:\s[^>]*)?>/i.exec(html)
  if (open === null) return `${HOST_MODE_TAG}${html}`
  const at = open.index + open[0].length
  return `${html.slice(0, at)}${HOST_MODE_TAG}${html.slice(at)}`
}

function injectableHtml(response) {
  return response.statusCode === 200
    && String(response.headers['content-type'] ?? '').includes('text/html')
    && response.headers['content-encoding'] === undefined
}

async function relay(request, response, res, id, target, body) {
  if (body === undefined && injectableHtml(response)) {
    const collected = await collectResponse(response)
    if (collected.complete) {
      const html = injectHostMode(collected.body.toString('utf8'))
      const headers = browserResponseHeaders(response.headers, id, target)
      delete headers['transfer-encoding']
      headers['content-length'] = String(Buffer.byteLength(html))
      res.writeHead(response.statusCode ?? 200, response.statusMessage, headers)
      res.end(html)
      return
    }
  }
  const headers = browserResponseHeaders(response.headers, id, target)
  res.writeHead(response.statusCode ?? 502, response.statusMessage, headers)
  if (body !== undefined) res.end(body)
  else response.pipe(res)
}

/**
 * Proxy one HTTP request under `/b/<id>/` to its Host.
 * @param {object} options
 * @param {import('node:http').IncomingMessage} options.req
 * @param {import('node:http').ServerResponse} options.res
 * @param {{id:string,path:string}} options.mount
 * @param {{host:string,port:number,protocol?:string}} options.target
 * @param {() => Promise<string|undefined>} options.cookieFor
 * @param {() => Promise<string|undefined>} options.refreshCookie
 */
export async function proxyHttp({ req, res, mount, target, cookieFor, refreshCookie }) {
  const read = req.method === 'GET' || req.method === 'HEAD' ? { complete: true, body: undefined } : await readBody(req)
  const body = read.body
  const headersFor = (cookie) => {
    const headers = upstreamHeaders(filterHopByHop(req.headers), target, mount.id)
    const cookieHeader = proxyCookieHeader(req.headers.cookie, cookie)
    if (cookieHeader === undefined) delete headers.cookie
    else headers.cookie = cookieHeader
    if (body !== undefined) headers['content-length'] = String(body.length)
    return headers
  }
  const path = `${mount.path}${new URL(req.url ?? '/', 'http://bridge.invalid').search}`
  let cookie = await cookieFor()
  if (!read.complete) {
    // Oversized bodies are streamed without an auth-retry replay.
    const response = await sendStreaming(target, path, req.method ?? 'POST', headersFor(cookie), req)
    await relay(req, response, res, mount.id, target)
    return
  }
  let response = await sendRequest(target, path, req.method ?? 'GET', headersFor(cookie), body)
  if (response.statusCode === 401) {
    const collected = await collectResponse(response)
    if (collected.complete && isDshAuthRejection(response, collected.body)) {
      cookie = await refreshCookie()
      response = await sendRequest(target, path, req.method ?? 'GET', headersFor(cookie), body)
      if (response.statusCode === 401) {
        const retried = await collectResponse(response)
        if (retried.complete) {
          await relay(req, response, res, mount.id, target, retried.body)
          return
        }
      }
      await relay(req, response, res, mount.id, target)
      return
    }
    await relay(req, response, res, mount.id, target, collected.body)
    return
  }
  await relay(req, response, res, mount.id, target)
}

/**
 * Proxy one WebSocket upgrade under `/b/<id>/`.
 *
 * The upstream handshake is inspected before the socket is handed to the
 * client, which lets an expired upstream auth cookie be refreshed once and
 * replayed. A 101 response is tunneled byte-for-byte.
 */
export async function proxyUpgrade({ req, socket, head, mount, target, cookieFor, refreshCookie }) {
  const path = `${mount.path}${new URL(req.url ?? '/', 'http://bridge.invalid').search}`
  let cookie = await cookieFor()
  let attempt = await handshake({ req, head, target, mount, path, cookie })
  if (attempt.unauthorized) {
    attempt.upstream?.destroy()
    cookie = await refreshCookie()
    attempt = await handshake({ req, head, target, mount, path, cookie })
  }
  if (attempt.error !== undefined) {
    attempt.upstream?.destroy()
    if (!socket.destroyed) {
      const message = attempt.error instanceof Error ? attempt.error.message : String(attempt.error)
      socket.end(`HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`)
    }
    return
  }
  socket.write(attempt.header)
  if (attempt.rest.length > 0) socket.write(attempt.rest)
  if (attempt.status !== 101) {
    attempt.upstream?.destroy()
    socket.end()
    return
  }
  const upstream = attempt.upstream
  upstream.pipe(socket)
  socket.pipe(upstream)
  upstream.on('close', () => socket.destroy())
  socket.on('close', () => upstream.destroy())
}

/** Open one upstream WebSocket handshake and read its response headers. */
function handshake({ req, head, target, mount, path, cookie }) {
  return new Promise((resolve) => {
    const headers = upstreamHeaders(filterHopByHopUpgrade(req.headers), target, mount.id)
    const cookieHeader = proxyCookieHeader(req.headers.cookie, cookie)
    if (cookieHeader === undefined) delete headers.cookie
    else headers.cookie = cookieHeader
    const upstream = target.protocol === 'https:'
      ? tlsConnect({ host: target.host, port: target.port, rejectUnauthorized: target.rejectUnauthorized !== false })
      : netConnect({ host: target.host, port: target.port })
    let settled = false
    let buffer = Buffer.alloc(0)
    const finish = (value) => {
      if (settled) return
      settled = true
      upstream.off('data', onData)
      upstream.off('error', onError)
      upstream.off('close', onClose)
      resolve({ ...value, upstream })
    }
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      const marker = buffer.indexOf('\r\n\r\n')
      if (marker < 0) {
        if (buffer.length > 64 * 1024) finish({ error: new Error('upstream handshake header too large') })
        return
      }
      const header = buffer.subarray(0, marker + 4)
      const rest = buffer.subarray(marker + 4)
      const statusLine = header.subarray(0, header.indexOf('\r\n')).toString('latin1')
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(statusLine)?.[1] ?? 0)
      finish({
        status,
        header,
        rest: Buffer.concat([rest, head === undefined ? Buffer.alloc(0) : head]),
        unauthorized: status === 401,
      })
    }
    const onError = (error) => finish({ error })
    const onClose = () => finish({ error: new Error('upstream closed during WebSocket handshake') })
    upstream.on('data', onData)
    upstream.on('error', onError)
    upstream.on('close', onClose)
    const lines = [`GET ${path} HTTP/1.1`]
    for (const [name, value] of Object.entries(headers)) {
      if (Array.isArray(value)) {
        for (const item of value) lines.push(`${name}: ${item}`)
      } else {
        lines.push(`${name}: ${value}`)
      }
    }
    lines.push('', '')
    upstream.write(lines.join('\r\n'))
  })
}

function filterHopByHopUpgrade(headers) {
  const out = {}
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (['proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding'].includes(lower)) continue
    if (lower === 'host' || lower === 'cookie' || lower === 'origin' || lower === 'referer') continue
    out[lower] = value
  }
  return out
}

export { AUTH_COOKIE }
