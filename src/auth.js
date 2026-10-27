/** Gateway password authentication and rolling browser sessions. */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback)
export const AUTH_COOKIE = 'dsh_bridge_session'
const SESSION_TTL_MS = 24 * 60 * 60 * 1000

async function atomicJson(path, value, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  const handle = await open(temp, 'w', mode)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

/** Password verifier stored outside the visible bridge config. */
export class PasswordStore {
  constructor(path) {
    this.path = path
    this.record = undefined
  }

  async init() {
    const raw = await readJson(this.path)
    if (raw === undefined) return
    if (raw?.version !== 1 || typeof raw.salt !== 'string' || typeof raw.hash !== 'string') {
      throw new Error(`invalid auth record: ${this.path}`)
    }
    this.record = raw
  }

  get configured() {
    return this.record !== undefined
  }

  async set(password) {
    if (typeof password !== 'string' || password.length === 0) throw new Error('password is required')
    const salt = randomBytes(16).toString('hex')
    const hash = (await scrypt(password, salt, 64)).toString('hex')
    this.record = { version: 1, salt, hash }
    await atomicJson(this.path, this.record)
  }

  async verify(password) {
    if (this.record === undefined || typeof password !== 'string') return false
    const actual = await scrypt(password, this.record.salt, 64)
    const expected = Buffer.from(this.record.hash, 'hex')
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }
}

/** Rolling bearer sessions. Tokens are persisted so a gateway restart does not log everyone out. */
export class SessionStore {
  constructor(path, ttlMs = SESSION_TTL_MS) {
    this.path = path
    this.ttlMs = ttlMs
    this.sessions = new Map()
    this.timer = null
  }

  async init() {
    const raw = await readJson(this.path)
    const now = Date.now()
    if (Array.isArray(raw?.sessions)) {
      for (const entry of raw.sessions) {
        if (typeof entry?.token !== 'string' || !Number.isFinite(entry.expiresAt)) continue
        if (entry.expiresAt > now) this.sessions.set(entry.token, entry)
      }
    }
    this.timer = setInterval(() => { void this.prune() }, 60_000)
    this.timer.unref?.()
  }

  async create() {
    const token = randomBytes(32).toString('base64url')
    const now = Date.now()
    this.sessions.set(token, { token, issuedAt: now, expiresAt: now + this.ttlMs })
    await this.persist()
    return token
  }

  get(token) {
    if (typeof token !== 'string' || token === '') return undefined
    const entry = this.sessions.get(token)
    if (entry === undefined) return undefined
    if (entry.expiresAt <= Date.now()) {
      this.sessions.delete(token)
      return undefined
    }
    return entry
  }

  async touch(token) {
    const entry = this.get(token)
    if (entry === undefined) return false
    entry.expiresAt = Date.now() + this.ttlMs
    await this.persist()
    return true
  }

  async delete(token) {
    if (this.sessions.delete(token)) await this.persist()
  }

  async deleteAll(except) {
    let revoked = 0
    for (const token of [...this.sessions.keys()]) {
      if (token === except) continue
      this.sessions.delete(token)
      revoked += 1
    }
    await this.persist()
    return revoked
  }

  async prune() {
    const now = Date.now()
    let changed = false
    for (const [token, entry] of this.sessions) {
      if (entry.expiresAt > now) continue
      this.sessions.delete(token)
      changed = true
    }
    if (changed) await this.persist()
  }

  async persist() {
    const sessions = [...this.sessions.values()]
    await atomicJson(this.path, { version: 1, sessions })
  }

  close() {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }
}

/** Parse the first occurrence of every request cookie. */
export function parseCookies(header) {
  const out = {}
  if (typeof header !== 'string') return out
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    const name = part.slice(0, index).trim()
    if (name !== '' && out[name] === undefined) out[name] = part.slice(index + 1).trim()
  }
  return out
}

/** Strip gateway and upstream dsh cookies, then append the server-held upstream cookie. */
export function proxyCookieHeader(header, upstreamCookie) {
  const kept = typeof header === 'string'
    ? header.split(';').map((part) => part.trim()).filter((part) => part !== ''
      && !part.startsWith(`${AUTH_COOKIE}=`)
      && !part.startsWith('dsh-auth-'))
    : []
  if (upstreamCookie !== undefined) kept.push(upstreamCookie)
  return kept.length === 0 ? undefined : kept.join('; ')
}

export function loginPage({ setup, next = '/', error }) {
  const title = setup ? 'Set gateway password' : 'dsh-bridge gateway'
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111318;color:#e8eaed;font:14px/1.5 system-ui,sans-serif}
main{width:min(360px,calc(100vw - 48px));padding:28px;border:1px solid #2b2f37;border-radius:14px;background:#191c22;box-shadow:0 16px 60px #0008}
h1{margin:0 0 8px;font-size:20px}p{margin:0 0 20px;color:#9aa0aa}label{display:grid;gap:6px;margin:14px 0;color:#c8ccd4}
input{box-sizing:border-box;width:100%;padding:10px 12px;border:1px solid #363b45;border-radius:8px;background:#0f1115;color:inherit;font:inherit}
button{width:100%;margin-top:12px;padding:11px;border:0;border-radius:8px;background:#4f7cff;color:#fff;font:inherit;font-weight:600;cursor:pointer}
.error{padding:9px 11px;border-radius:8px;background:#3a1d22;color:#ffb4bf}
</style></head><body><main>
<h1>${title}</h1><p>${setup ? 'The password is stored as a scrypt hash on the gateway host.' : 'Sign in to reach the bridge hosts.'}</p>
${error === undefined ? '' : `<div class="error">${escapeHtml(error)}</div>`}
<form method="post" action="/login">
<input type="hidden" name="next" value="${escapeHtml(next)}">
<label>Password<input name="password" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" autofocus required></label>
${setup ? '<label>Confirm password<input name="confirm" type="password" autocomplete="new-password" required></label>' : ''}
<button type="submit">${setup ? 'Set password' : 'Sign in'}</button>
</form></main></body></html>`
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char])
}

/** Only allow same-origin absolute paths as post-login destinations. */
export function safeNext(value) {
  if (typeof value !== 'string' || value === '' || !value.startsWith('/') || value.startsWith('//')) return '/'
  return value
}
