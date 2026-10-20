/**
 * One live Pi Coding Agent attachment over its documented RPC mode.
 *
 * Pi speaks JSONL in both directions: commands on stdin, correlated responses
 * and asynchronous agent events on stdout. The bridge never opens the session
 * file for writing. Only this child owns the write handle, so dsh cannot race
 * Pi's append-only branch structure.
 */
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const DEFAULT_RESPONSE_TIMEOUT_MS = 60_000
const STDERR_RING_BYTES = 16 * 1024

/** Fire-and-forget extension UI methods that must not receive a response. */
const FIRE_AND_FORGET_UI = new Set([
  'notify',
  'setStatus',
  'setWidget',
  'setTitle',
  'set_editor_text',
])

/**
 * Resolve a runnable Pi CLI.
 *
 * Preference order: an explicit `PI_BIN`, a globally installed `pi`, then the
 * `@earendil-works/pi-coding-agent` package visible from the dsh profile. The
 * last path is how a profile that installs Pi as a normal dependency runs the
 * exact audited version without depending on the shell PATH.
 */
export function resolvePiCommand(env = process.env) {
  if (typeof env.PI_BIN === 'string' && env.PI_BIN !== '') {
    return { command: env.PI_BIN, prefixArgs: [] }
  }
  // The supported Pi installation keeps a stable launcher beside the agent
  // state directory. Prefer it over any copy bundled into another package:
  // a managed launcher knows its own runtime and tolerates a read-only agent
  // directory, while an older bundled copy may exit on a settings lock.
  const agentDir = env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent')
  for (const candidate of [join(agentDir, 'bin', 'pi'), join(homedir(), '.pi', 'agent', 'bin', 'pi')]) {
    if (existsSync(candidate)) return { command: candidate, prefixArgs: [] }
  }
  try {
    const packageFile = require.resolve('@earendil-works/pi-coding-agent/package.json')
    const cli = join(dirname(packageFile), 'dist', 'cli.js')
    if (existsSync(cli)) return { command: process.execPath, prefixArgs: [cli] }
  } catch {
    // Not installed in this profile; fall through to PATH.
  }
  return { command: 'pi', prefixArgs: [] }
}

/** Split one buffered stdout chunk into complete JSONL records. */
export function createLineDecoder(onLine) {
  let buffer = ''
  return {
    push(chunk) {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        let line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (line !== '') onLine(line)
        newline = buffer.indexOf('\n')
      }
    },
    flush() {
      if (buffer !== '') {
        const line = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer
        buffer = ''
        if (line !== '') onLine(line)
      }
    },
  }
}

/** Concatenate the text blocks of a Pi message. */
export function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

export class PiAttachment extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.file absolute session JSONL path
   * @param {string} [options.cwd] working directory for Pi and its tools
   * @param {NodeJS.ProcessEnv} [options.env]
   * @param {string[]} [options.extraArgs] extra CLI arguments before `--mode rpc`
   * @param {number} [options.responseTimeoutMs]
   */
  constructor(options) {
    super()
    this.file = options.file
    this.cwd = options.cwd && existsSync(options.cwd) ? options.cwd : homedir()
    const baseEnv = options.env ?? process.env
    // A bridge child must not mutate the user's Pi installation or block on
    // startup package installs. Offline startup still loads installed
    // extensions, models, and credentials; callers can opt out explicitly.
    this.env = baseEnv.PI_BRIDGE_OFFLINE === '0'
      ? { ...baseEnv }
      : { ...baseEnv, PI_OFFLINE: baseEnv.PI_OFFLINE ?? '1' }
    this.extraArgs = options.extraArgs ?? []
    this.responseTimeoutMs = options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS
    this.pending = new Map()
    this.uiPending = new Map()
    this.stderr = ''
    this.child = undefined
    this.exited = false
    this.startedAt = Date.now()
    this.lastEventAt = undefined
    this.lastEventType = undefined
  }

  get pid() {
    return this.child?.pid
  }

  get running() {
    return this.child !== undefined && !this.exited
  }

  /** Spawn Pi and wait until the child process is live. */
  async start() {
    if (this.child !== undefined) return this
    const resolved = resolvePiCommand(this.env)
    const args = [
      ...resolved.prefixArgs,
      ...this.extraArgs,
      '--mode',
      'rpc',
      '--session',
      this.file,
    ]
    this.child = spawn(resolved.command, args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    const decoder = createLineDecoder((line) => this.handleLine(line))
    this.child.stdout.on('data', (chunk) => decoder.push(chunk))
    this.child.stdout.on('end', () => decoder.flush())
    this.child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_RING_BYTES)
    })
    this.child.on('error', (error) => this.handleExit(undefined, error))
    this.child.on('exit', (code, signal) => this.handleExit({ code, signal }))
    this.emit('spawn', { pid: this.child.pid, command: resolved.command, args })
    return this
  }

  handleLine(line) {
    let record
    try {
      record = JSON.parse(line)
    } catch {
      this.emit('protocol-error', { line })
      return
    }
    if (record === null || typeof record !== 'object') return

    if (record.type === 'response' && typeof record.id === 'string') {
      const entry = this.pending.get(record.id)
      if (entry !== undefined) {
        this.pending.delete(record.id)
        clearTimeout(entry.timer)
        if (record.success === false) {
          const error = new Error(record.error ?? `Pi command ${record.command ?? ''} failed`)
          error.command = record.command
          entry.reject(error)
        } else {
          entry.resolve(record.data)
        }
      }
      return
    }

    this.lastEventAt = Date.now()
    this.lastEventType = record.type
    if (record.type === 'extension_ui_request') {
      if (FIRE_AND_FORGET_UI.has(record.method)) {
        this.emit('ui-notification', record)
      } else {
        this.uiPending.set(record.id, record)
        this.emit('ui-request', record)
      }
      return
    }
    if (record.type === 'extension_error') {
      this.emit('extension-error', record)
      return
    }
    this.emit('event', record)
    if (typeof record.type === 'string') this.emit(record.type, record)
  }

  handleExit(info, error) {
    if (this.exited) return
    this.exited = true
    const reason = error ?? info ?? {}
    const detail = this.stderr.trim()
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      const failure = new Error(
        detail === ''
          ? 'Pi process exited before responding'
          : `Pi process exited before responding: ${detail}`,
      )
      failure.cause = reason
      entry.reject(failure)
    }
    this.pending.clear()
    this.uiPending.clear()
    this.emit('exit', { ...reason, stderr: this.stderr })
  }

  /** Send one RPC command and wait for its correlated response. */
  request(command, payload = {}, timeoutMs = this.responseTimeoutMs) {
    if (!this.running || this.child?.stdin.destroyed) {
      return Promise.reject(new Error('Pi attachment is not running'))
    }
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    const record = { id, type: command, ...payload }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Pi command timed out: ${command}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer, command })
      try {
        this.child.stdin.write(`${JSON.stringify(record)}\n`)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  getState() {
    return this.request('get_state')
  }

  getMessages() {
    return this.request('get_messages')
  }

  getAvailableModels() {
    return this.request('get_available_models')
  }

  prompt(message, options = {}) {
    const payload = { message }
    if (Array.isArray(options.images) && options.images.length > 0) payload.images = options.images
    if (options.streamingBehavior !== undefined) payload.streamingBehavior = options.streamingBehavior
    return this.request('prompt', payload)
  }

  steer(message, options = {}) {
    const payload = { message }
    if (Array.isArray(options.images) && options.images.length > 0) payload.images = options.images
    return this.request('steer', payload)
  }

  followUp(message, options = {}) {
    const payload = { message }
    if (Array.isArray(options.images) && options.images.length > 0) payload.images = options.images
    return this.request('follow_up', payload)
  }

  abort() {
    return this.request('abort')
  }

  setModel(provider, modelId) {
    return this.request('set_model', { provider, modelId })
  }

  setThinkingLevel(level) {
    return this.request('set_thinking_level', { level })
  }

  setSessionName(name) {
    return this.request('set_session_name', { name })
  }

  newSession(parentSession) {
    const payload = {}
    if (typeof parentSession === 'string') payload.parentSession = parentSession
    return this.request('new_session', payload)
  }

  switchSession(sessionPath) {
    return this.request('switch_session', { sessionPath })
  }

  /** Answer one blocking extension dialog. */
  respondUi(id, response) {
    if (!this.uiPending.has(id)) throw new Error('unknown extension UI request')
    if (!this.running) throw new Error('Pi attachment is not running')
    this.uiPending.delete(id)
    this.child.stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id, ...response })}\n`)
  }

  /** Snapshot used by the HTTP state route. */
  async snapshot() {
    const state = await this.getState()
    return { ...state, pid: this.pid, lastEventAt: this.lastEventAt, lastEventType: this.lastEventType }
  }

  /** Stop the child; stdin EOF is the graceful shutdown signal. */
  async dispose() {
    if (this.child === undefined || this.exited) return
    const child = this.child
    try {
      child.stdin.end()
    } catch {
      // The child may already have closed stdin.
    }
    const exited = await new Promise((resolve) => {
      if (this.exited) {
        resolve(true)
        return
      }
      const timer = setTimeout(() => resolve(false), 1500)
      this.once('exit', () => {
        clearTimeout(timer)
        resolve(true)
      })
    })
    if (!exited) {
      child.kill('SIGTERM')
      await new Promise((resolve) => {
        if (this.exited) {
          resolve()
          return
        }
        const timer = setTimeout(resolve, 1000)
        this.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
    if (!this.exited) child.kill('SIGKILL')
  }
}
