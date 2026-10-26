/**
 * Durable, bridge-scoped imported-session state.
 *
 * Bridge is an import-first surface: sessions discovered under an engine's
 * session root are candidates, not sidebar rows. This module records which
 * native session keys the user explicitly imported, so external sessions can
 * be discovered in the import dialog without silently changing the sidebar.
 *
 * The store is presentation state only. It never moves, rewrites, or deletes
 * agent session files.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { bridgeHome } from './settings.js'

export const IMPORTS_VERSION = 1

export function importsPath(env = process.env) {
  return join(bridgeHome(env), 'bridge-imports.json')
}

export function defaultImportStore() {
  return { version: IMPORTS_VERSION, bridges: {} }
}

function cleanString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** Coerce a stored import document into the current schema. */
export function normalizeImportStore(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return defaultImportStore()
  const rawBridges = input.bridges !== null && typeof input.bridges === 'object' && !Array.isArray(input.bridges)
    ? input.bridges
    : {}
  const bridges = {}
  for (const [bridgeId, rawEntry] of Object.entries(rawBridges)) {
    const id = cleanString(bridgeId)
    if (id === null) continue
    const rawKeys = Array.isArray(rawEntry)
      ? rawEntry
      : Array.isArray(rawEntry?.sessionKeys) ? rawEntry.sessionKeys : []
    const seen = new Set()
    const sessionKeys = []
    for (const raw of rawKeys) {
      const key = cleanString(raw)
      if (key === null || seen.has(key)) continue
      seen.add(key)
      sessionKeys.push(key)
    }
    bridges[id] = { sessionKeys }
  }
  return { version: IMPORTS_VERSION, bridges }
}

export function readImportStore(env = process.env, logger) {
  const file = importsPath(env)
  if (!existsSync(file)) return defaultImportStore()
  try {
    return normalizeImportStore(JSON.parse(readFileSync(file, 'utf8')))
  } catch (error) {
    logger?.warn?.(`bridge: ignoring unreadable import store ${file}: ${error instanceof Error ? error.message : String(error)}`)
    return defaultImportStore()
  }
}

/** Replace the import store atomically; the browser never writes this file. */
export function writeImportStore(store, env = process.env) {
  const normalized = normalizeImportStore(store)
  const file = importsPath(env)
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(normalized, null, 2) + '\n', { mode: 0o600 })
  renameSync(temporary, file)
  return normalized
}

function bridgeKeys(store, bridgeId) {
  const entry = store?.bridges?.[bridgeId]
  return Array.isArray(entry?.sessionKeys) ? entry.sessionKeys : []
}

/** Native session keys imported for one bridge, in import order. */
export function listImportedSessionKeys(store, bridgeId) {
  return [...bridgeKeys(store, bridgeId)]
}

export function isSessionImported(store, bridgeId, nativeKey) {
  return bridgeKeys(store, bridgeId).includes(nativeKey)
}

/** Import one or more native session keys. The operation is idempotent. */
export function importSessions(store, bridgeId, nativeKeys) {
  const next = normalizeImportStore(store)
  const keys = bridgeKeys(next, bridgeId)
  const seen = new Set(keys)
  const added = []
  for (const raw of Array.isArray(nativeKeys) ? nativeKeys : []) {
    const key = cleanString(raw)
    if (key === null || seen.has(key)) continue
    seen.add(key)
    added.push(key)
  }
  if (added.length === 0) return { store: next, changed: false, importedKeys: [...keys], addedKeys: [] }
  const importedKeys = [...keys, ...added]
  next.bridges[bridgeId] = { sessionKeys: importedKeys }
  return { store: next, changed: true, importedKeys: [...importedKeys], addedKeys: [...added] }
}

/** Drop all import state for a deleted bridge. */
export function deleteBridgeImports(store, bridgeId) {
  const next = normalizeImportStore(store)
  if (next.bridges[bridgeId] === undefined) return { store: next, changed: false }
  delete next.bridges[bridgeId]
  return { store: next, changed: true }
}
