/**
 * Mint a dsh browser-session cookie for local verification.
 *
 * This is TEST-ONLY tooling. It reads the signing secret that dsh keeps in
 * `$DSH_HOME/.credentials.yaml`, in order to drive authenticated `/api`
 * routes and the Web UI without going through the login page.
 *
 * Rules:
 * - the secret is read at runtime and never printed, logged, or written to disk;
 * - the minted cookie stays in process memory (or is passed via a pipe/env to
 *   one child process), never committed;
 * - `tests/check-secrets.sh` scans tracked files for leaks.
 */
import { createHmac, createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function credentialsPath(env = process.env) {
  return join(env.DSH_HOME || join(homedir(), '.dsh'), '.credentials.yaml')
}

/**
 * Minimal reader for the one record this tooling needs. The file is a small
 * YAML document written by dsh; a full YAML parser is not worth a dependency
 * for tests.
 * @param {string} file
 * @returns {string} base64url signing secret
 */
export function readBrowserSecret(file = credentialsPath()) {
  const text = readFileSync(file, 'utf8')
  const line = text.split('\n').find((entry) => /^\s*secret:\s*\S+/.test(entry))
  if (line === undefined) throw new Error(`no browser-session secret found in ${file}`)
  const secret = line.slice(line.indexOf('secret:') + 'secret:'.length).trim()
  if (secret === '') throw new Error(`empty browser-session secret in ${file}`)
  return secret
}

function b64url(buffer) {
  return Buffer.from(buffer).toString('base64url')
}

/**
 * Build the cookie name/value dsh expects for one authority.
 * @param {string} authority host[:port] exactly as the browser sends it
 * @param {string} secretB64 base64url signing secret
 * @param {number} [ttlMs]
 * @returns {{ name: string, value: string, header: string }}
 */
export function mintBrowserCookie(authority, secretB64, ttlMs = 30 * 24 * 3600 * 1000) {
  const secret = Buffer.from(secretB64, 'base64url')
  if (secret.byteLength !== 32) throw new Error('browser-session secret must decode to 32 bytes')
  const now = Date.now()
  const payload = { version: 1, authority, issuedAt: now, expiresAt: now + ttlMs }
  const body = b64url(JSON.stringify(payload))
  const signature = b64url(createHmac('sha256', secret).update(body).digest())
  const name = `dsh-auth-${b64url(createHash('sha256').update(authority).digest())}`
  const value = `v1.${body}.${signature}`
  return { name, value, header: `${name}=${value}` }
}

/** Convenience: read the local secret and mint for one host:port. */
export function localCookie(port, options = {}) {
  const authority = options.authority ?? `127.0.0.1:${port}`
  return mintBrowserCookie(authority, readBrowserSecret(options.credentialsFile), options.ttlMs)
}
