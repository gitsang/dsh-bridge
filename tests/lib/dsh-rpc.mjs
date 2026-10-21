/**
 * TEST-ONLY helper: call dsh Remote endpoints over the authenticated `/api`
 * channel from a Node process.
 *
 * The browser cookie is minted from the local signing secret just for the
 * lifetime of this process. Nothing is written to disk, and the secret never
 * appears in output.
 */
import { localCookie } from './browser-cookie.mjs'

/**
 * @param {object} options
 * @param {number} options.port dsh web port
 * @param {string} [options.cookie] reuse an already-minted cookie header
 * @param {string} [options.authority]
 */
export function createClient({ port, cookie, authority = `127.0.0.1:${port}`, credentialsFile }) {
  const header = cookie ?? localCookie(port, { authority, credentialsFile }).header
  const base = `http://${authority}`

  /** Call one Remote method with its `{ args }` payload envelope. */
  async function remote(method, args = {}, { timeoutMs = 120_000 } = {}) {
    const rpcId = crypto.randomUUID()
    const body = JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } })
    const response = await fetch(`${base}/api/${method}`, {
      method: 'POST',
      headers: { cookie: header, 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await response.text()
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      throw new Error(`${method}: HTTP ${response.status}: ${text.slice(0, 200)}`)
    }
    if (payload.type !== 'server-response' || payload.rpcId !== rpcId) {
      throw new Error(`${method}: malformed RPC envelope`)
    }
    return payload.result
  }

  /** Call one exact Fetch route registered by the bridge. */
  async function route(path, init = {}) {
    const response = await fetch(`${base}/api/bridge/${path}`, {
      ...init,
      headers: {
        cookie: header,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(init.headers ?? {}),
      },
      signal: init.signal ?? AbortSignal.timeout(120_000),
    })
    const text = await response.text()
    let data
    try {
      data = text === '' ? {} : JSON.parse(text)
    } catch {
      data = { error: text }
    }
    return { status: response.status, data }
  }

  return { remote, route, cookie: header, base }
}
