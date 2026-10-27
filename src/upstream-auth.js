/** Server-side custodian of one dsh Host's authority-bound browser cookie. */
import { request as httpRequest } from 'node:http'

/** `host:port`, bracketing IPv6 literals. */
export function authorityOf(target) {
  const host = String(target.host)
  return `${host.includes(':') ? `[${host}]` : host}:${String(target.port)}`
}

/** Exchange a dsh launch token for its signed browser-session cookie. */
export function exchangeLaunchToken(target, tokenizedUrl) {
  const url = new URL(tokenizedUrl)
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: target.host,
      port: target.port,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      agent: false,
      headers: {
        host: authorityOf(target),
        accept: 'text/html',
        connection: 'close',
      },
    }, (response) => {
      response.resume()
      const raw = response.headers['set-cookie']
      const cookies = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]
      for (const cookie of cookies) {
        const pair = String(cookie).split(';', 1)[0]?.trim()
        if (pair?.startsWith('dsh-auth-')) {
          resolve(pair)
          return
        }
      }
      reject(new Error(`upstream dsh did not set a browser-session cookie (HTTP ${response.statusCode ?? 'unknown'})`))
    })
    request.on('error', reject)
    request.end()
  })
}

const REFRESH_MARGIN_MS = 60 * 60 * 1000

export class UpstreamAuth {
  constructor(target, resolveTokenizedUrl, logger) {
    this.target = target
    this.resolveTokenizedUrl = resolveTokenizedUrl
    this.logger = logger
    this.cached = undefined
    this.pending = undefined
    this.lastError = undefined
  }

  async cookieFor() {
    if (this.cached !== undefined && Date.now() - this.cached.at < REFRESH_MARGIN_MS) return this.cached.pair
    return this.refresh()
  }

  refresh() {
    if (this.pending !== undefined) return this.pending
    this.pending = this.exchange().finally(() => { this.pending = undefined })
    return this.pending
  }

  async exchange() {
    const tokenizedUrl = await this.resolveTokenizedUrl?.()
    if (typeof tokenizedUrl !== 'string' || tokenizedUrl === '') return undefined
    try {
      const pair = await exchangeLaunchToken(this.target, tokenizedUrl)
      this.cached = { pair, at: Date.now() }
      if (this.lastError !== undefined) {
        this.logger?.info?.('bridge-gateway: recovered upstream dsh session for %s', authorityOf(this.target))
        this.lastError = undefined
      }
      return pair
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message !== this.lastError) {
        this.lastError = message
        this.logger?.warn?.('bridge-gateway: cannot obtain upstream dsh session for %s: %s', authorityOf(this.target), message)
      }
      return undefined
    }
  }

  forget() {
    this.cached = undefined
  }
}
