/**
 * Durable workspace metadata for Bridge sessions.
 *
 * Pi session files carry only a `cwd`; they do not carry the user's chosen
 * workspace title, nor whether a workspace was removed from the sidebar.
 * This module keeps that presentation state separate from the agent's session
 * data so rename/delete never touches Pi JSONL files.
 *
 * Deletion is intentionally a soft delete: the record remains in the store
 * with `deletedAt` set, which prevents a later filesystem scan from silently
 * re-adding the workspace. Its sessions remain visible under "Ungrouped".
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { bridgeHome } from './settings.js'

export const WORKSPACES_VERSION = 1

export function workspacesPath(env = process.env) {
  return join(bridgeHome(env), 'bridge-workspaces.json')
}

export function defaultWorkspaceStore() {
  return { version: WORKSPACES_VERSION, bridges: {} }
}

function cleanString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function cleanTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null
}

/**
 * Default display name for a workspace: the final folder segment, never the
 * whole path. Handles POSIX and Windows separators regardless of host platform.
 */
export function defaultWorkspaceName(path) {
  if (typeof path !== 'string' || path === '') return ''
  const trimmed = path.replace(/[/\\]+$/, '')
  if (trimmed === '') return path
  const parts = trimmed.split(/[/\\]+/).filter(Boolean)
  return parts.length === 0 ? path : parts[parts.length - 1]
}

/** Treat an old auto-generated path title as missing when coercing records. */
function workspaceName(value, path) {
  const name = cleanString(value)
  if (name === null) return defaultWorkspaceName(path)
  const withoutTrailing = typeof path === 'string' ? path.replace(/[/\\]+$/, '') : path
  return name === path || name === withoutTrailing ? defaultWorkspaceName(path) : name
}

function normalizeWorkspace(input, now) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null
  const path = cleanString(input.path)
  if (path === null) return null
  const createdAt = cleanTimestamp(input.createdAt) ?? now
  return {
    id: cleanString(input.id) ?? path,
    path,
    name: workspaceName(input.name, path),
    createdAt,
    updatedAt: cleanTimestamp(input.updatedAt) ?? createdAt,
    deletedAt: cleanTimestamp(input.deletedAt),
  }
}

/** Coerce a stored or submitted workspace store into the current schema. */
export function normalizeWorkspaceStore(input) {
  const now = new Date().toISOString()
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return defaultWorkspaceStore()
  const rawBridges = input.bridges !== null && typeof input.bridges === 'object' && !Array.isArray(input.bridges)
    ? input.bridges
    : {}
  const bridges = {}
  for (const [bridgeId, rawEntry] of Object.entries(rawBridges)) {
    if (cleanString(bridgeId) === null) continue
    const rawWorkspaces = Array.isArray(rawEntry)
      ? rawEntry
      : Array.isArray(rawEntry?.workspaces) ? rawEntry.workspaces : []
    const seenPaths = new Set()
    const workspaces = []
    for (const raw of rawWorkspaces) {
      const workspace = normalizeWorkspace(raw, now)
      if (workspace === null || seenPaths.has(workspace.path)) continue
      seenPaths.add(workspace.path)
      workspaces.push(workspace)
    }
    bridges[bridgeId] = { workspaces }
  }
  return { version: WORKSPACES_VERSION, bridges }
}

/** Read workspace metadata, falling back to an empty store on corruption. */
export function readWorkspaceStore(env = process.env, logger) {
  const file = workspacesPath(env)
  if (!existsSync(file)) return defaultWorkspaceStore()
  try {
    return normalizeWorkspaceStore(JSON.parse(readFileSync(file, 'utf8')))
  } catch (error) {
    logger?.warn?.(`bridge: ignoring unreadable workspace store ${file}: ${error instanceof Error ? error.message : String(error)}`)
    return defaultWorkspaceStore()
  }
}

/** Replace the workspace store atomically. */
export function writeWorkspaceStore(store, env = process.env) {
  const normalized = normalizeWorkspaceStore(store)
  const file = workspacesPath(env)
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(normalized, null, 2) + '\n', { mode: 0o600 })
  renameSync(temporary, file)
  return normalized
}

function recordList(store, bridgeId) {
  const entry = store.bridges?.[bridgeId]
  return Array.isArray(entry?.workspaces) ? entry.workspaces : []
}

/** Active (non-deleted) workspace records for one bridge. */
export function listWorkspaces(store, bridgeId) {
  return recordList(store, bridgeId)
    .filter((workspace) => workspace.deletedAt === null)
    .map((workspace) => ({ ...workspace }))
}

/**
 * Paths whose workspace registrations were soft-deleted. The sidebar uses these
 * to keep sessions from resurrecting a removed group when it derives groups
 * from the current session list.
 */
export function removedWorkspacePaths(store, bridgeId) {
  return recordList(store, bridgeId)
    .filter((workspace) => workspace.deletedAt !== null)
    .map((workspace) => workspace.path)
}

/**
 * Merge the workspaces discovered from the engine's current session list into
 * the durable metadata. Existing titles and tombstones win; only genuinely new
 * paths get a fresh record. This is what makes a terminal-created Pi session
 * appear under its workspace on the next session query.
 */
export function reconcileWorkspaces(store, bridgeId, discovered, now = new Date().toISOString()) {
  const next = normalizeWorkspaceStore(store)
  const entry = next.bridges[bridgeId] ?? { workspaces: [] }
  const records = [...entry.workspaces]
  const byPath = new Map(records.map((workspace) => [workspace.path, workspace]))
  let changed = false
  for (const item of Array.isArray(discovered) ? discovered : []) {
    const path = cleanString(item?.path ?? item?.id)
    if (path === null || byPath.has(path)) continue
    const workspace = {
      id: randomUUID(),
      path,
      name: workspaceName(item?.name, path),
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }
    records.push(workspace)
    byPath.set(path, workspace)
    changed = true
  }
  next.bridges[bridgeId] = { workspaces: records }
  return { store: next, changed }
}

/** Add a manually selected workspace, or revive a soft-deleted one. */
export function createWorkspace(store, bridgeId, input, now = new Date().toISOString()) {
  const path = cleanString(input?.path)
  if (path === null) throw Object.assign(new Error('workspace path is required'), { status: 400 })
  const name = cleanString(input?.name)
  const next = normalizeWorkspaceStore(store)
  const entry = next.bridges[bridgeId] ?? { workspaces: [] }
  const records = [...entry.workspaces]
  const existing = records.find((workspace) => workspace.path === path)
  let workspace
  if (existing !== undefined) {
    workspace = {
      ...existing,
      name: name ?? (existing.deletedAt === null ? existing.name : defaultWorkspaceName(path)),
      updatedAt: now,
      deletedAt: null,
    }
    const index = records.indexOf(existing)
    records[index] = workspace
  } else {
    workspace = {
      id: randomUUID(),
      path,
      name: name ?? defaultWorkspaceName(path),
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }
    records.push(workspace)
  }
  next.bridges[bridgeId] = { workspaces: records }
  return { store: next, workspace: { ...workspace } }
}

/** Rename a workspace without changing its path or the sessions on disk. */
export function renameWorkspace(store, bridgeId, id, nameValue, now = new Date().toISOString()) {
  const idValue = cleanString(id)
  const name = cleanString(nameValue)
  if (idValue === null) throw Object.assign(new Error('workspace id is required'), { status: 400 })
  if (name === null) throw Object.assign(new Error('workspace name is required'), { status: 400 })
  const next = normalizeWorkspaceStore(store)
  const records = recordList(next, bridgeId).map((workspace) => (
    workspace.id === idValue
      ? { ...workspace, name, updatedAt: now }
      : workspace
  ))
  const workspace = records.find((entry) => entry.id === idValue)
  if (workspace === undefined) throw Object.assign(new Error(`unknown workspace: ${idValue}`), { status: 404 })
  next.bridges[bridgeId] = { workspaces: records }
  return { store: next, workspace: { ...workspace } }
}

/** Soft-delete a workspace. Sessions and folders are never touched. */
export function deleteWorkspace(store, bridgeId, id, now = new Date().toISOString()) {
  const idValue = cleanString(id)
  if (idValue === null) throw Object.assign(new Error('workspace id is required'), { status: 400 })
  const next = normalizeWorkspaceStore(store)
  const records = recordList(next, bridgeId).map((workspace) => (
    workspace.id === idValue && workspace.deletedAt === null
      ? { ...workspace, deletedAt: now, updatedAt: now }
      : workspace
  ))
  const workspace = records.find((entry) => entry.id === idValue)
  if (workspace === undefined) throw Object.assign(new Error(`unknown workspace: ${idValue}`), { status: 404 })
  next.bridges[bridgeId] = { workspaces: records }
  return { store: next, workspace: { ...workspace } }
}

/** Public browser shape, with the live session count attached by the host. */
export function publicWorkspace(workspace, sessionCount = 0) {
  return {
    id: workspace.id,
    path: workspace.path,
    name: workspace.name,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    sessionCount,
  }
}
