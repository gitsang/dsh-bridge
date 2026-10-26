/**
 * Durable, bridge-scoped archive state.
 *
 * Pi session files have no archive flag, and a browser-local set vanishes
 * across devices and profiles. This module keeps the archive decision on the
 * host instead: one set of native session keys per saved bridge, stored apart
 * from settings and from the agent's JSONL data.
 *
 * Archiving is presentation state plus an admission gate. It never moves or
 * rewrites Pi sessions; the session keeps its workspace/order slot so
 * unarchiving restores the previous view.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { bridgeHome } from './settings.js'

export const ARCHIVES_VERSION = 1

export function archivesPath(env = process.env) {
  return join(bridgeHome(env), 'bridge-archives.json')
}

export function defaultArchiveStore() {
  return { version: ARCHIVES_VERSION, bridges: {} }
}

function cleanString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * Coerce a stored archive document into the current schema. Duplicate keys are
 * removed while preserving archive order, and unknown fields are dropped so a
 * hand-edited file can never inject a different bridge's keys.
 */
export function normalizeArchiveStore(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return defaultArchiveStore()
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
  return { version: ARCHIVES_VERSION, bridges }
}

export function readArchiveStore(env = process.env, logger) {
  const file = archivesPath(env)
  if (!existsSync(file)) return defaultArchiveStore()
  try {
    return normalizeArchiveStore(JSON.parse(readFileSync(file, 'utf8')))
  } catch (error) {
    logger?.warn?.(`bridge: ignoring unreadable archive store ${file}: ${error instanceof Error ? error.message : String(error)}`)
    return defaultArchiveStore()
  }
}

/** Replace the archive store atomically; the browser never writes this file. */
export function writeArchiveStore(store, env = process.env) {
  const normalized = normalizeArchiveStore(store)
  const file = archivesPath(env)
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

/** Native session keys archived for one bridge, in archive order. */
export function listArchivedSessionKeys(store, bridgeId) {
  return [...bridgeKeys(store, bridgeId)]
}

export function isSessionArchived(store, bridgeId, nativeKey) {
  return bridgeKeys(store, bridgeId).includes(nativeKey)
}

/** Archive one native session key. The operation is idempotent. */
export function archiveSession(store, bridgeId, nativeKey) {
  const next = normalizeArchiveStore(store)
  const keys = bridgeKeys(next, bridgeId)
  if (keys.includes(nativeKey)) return { store: next, changed: false, archivedKeys: [...keys] }
  const archivedKeys = [...keys, nativeKey]
  next.bridges[bridgeId] = { sessionKeys: archivedKeys }
  return { store: next, changed: true, archivedKeys: [...archivedKeys] }
}

/**
 * Drop one native session key. Unknown bridge ids and keys resolve as a no-op,
 * so a lost race with another browser cannot make unarchiving fail.
 */
export function unarchiveSession(store, bridgeId, nativeKey) {
  const next = normalizeArchiveStore(store)
  const keys = bridgeKeys(next, bridgeId)
  if (!keys.includes(nativeKey)) return { store: next, changed: false, archivedKeys: [...keys] }
  const archivedKeys = keys.filter((key) => key !== nativeKey)
  next.bridges[bridgeId] = { sessionKeys: archivedKeys }
  return { store: next, changed: true, archivedKeys: [...archivedKeys] }
}

/** Drop all archive state for a deleted bridge. */
export function deleteBridgeArchives(store, bridgeId) {
  const next = normalizeArchiveStore(store)
  if (next.bridges[bridgeId] === undefined) return { store: next, changed: false }
  delete next.bridges[bridgeId]
  return { store: next, changed: true }
}
