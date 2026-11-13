/**
 * Shared helpers for CLI-backed engine adapters.
 *
 * Pi, Codex, and OpenCode all follow the same shape: a launcher that may be
 * configured explicitly, resolved from an environment variable, or discovered
 * on PATH, plus a newline-delimited wire protocol on stdio. Keeping the
 * resolution order in one place means a bridge behaves the same way whichever
 * engine it points at, and an adapter never needs to know about `PATH`
 * splitting on Windows.
 */
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'

/**
 * True when `command` names an executable the child could actually launch.
 * A path that merely exists is not enough: a directory or a data file with the
 * same name must not pass a readiness probe.
 */
export function executableOnPath(command, env = process.env) {
  if (typeof command !== 'string' || command === '') return false
  const candidates = command.includes('/') || isAbsolute(command)
    ? [command]
    : (env.PATH ?? env.Path ?? '')
      .split(delimiter)
      .filter((directory) => directory !== '')
      .flatMap((directory) => (process.platform === 'win32'
        ? [join(directory, command), join(directory, `${command}.exe`)]
        : [join(directory, command)]))
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return true
    } catch {
      // An unreadable directory entry is simply not a match.
    }
  }
  return false
}

/**
 * Well-known install directories a service manager will not put on PATH.
 *
 * dsh normally runs as a background service, and launchd/systemd hand a process
 * a fraction of the login shell's environment — typically not the directories a
 * version manager or Homebrew adds. A CLI the user plainly has installed then
 * looks missing to the Bridge. These are the standard locations for each
 * platform; PATH still wins, so an existing setup is unaffected.
 */
export function defaultCliSearchDirs(env = process.env) {
  const dirs = [
    join(homedir(), '.local', 'bin'),
    join(homedir(), '.bun', 'bin'),
  ]
  if (process.platform === 'darwin') {
    dirs.push('/opt/homebrew/bin', '/usr/local/bin')
  } else if (process.platform === 'linux') {
    dirs.push('/home/linuxbrew/.linuxbrew/bin', '/usr/local/bin')
  }
  if (typeof env.HOME === 'string' && env.HOME !== '') {
    // Honour an explicit HOME (a test or a container may not match homedir()).
    const home = env.HOME
    dirs.unshift(join(home, '.local', 'bin'), join(home, '.bun', 'bin'))
  }
  return [...new Set(dirs)]
}

/**
 * Resolve the launcher for one engine.
 *
 * Order: an explicit bridge config value, then the engine's environment
 * override, then the first default name found on PATH, then the same name in a
 * well-known install directory. The resolved command is returned even when it
 * does not exist so callers can report the name they tried instead of a generic
 * failure.
 */
export function resolveCliCommand({ configBin, envVar, defaultNames, searchDirs, env = process.env }) {
  if (typeof configBin === 'string' && configBin.trim() !== '') {
    return { command: configBin.trim(), prefixArgs: [], source: 'config' }
  }
  if (typeof envVar === 'string' && envVar !== '') {
    const value = env[envVar]
    if (typeof value === 'string' && value.trim() !== '') {
      return { command: value.trim(), prefixArgs: [], source: 'env', envVar }
    }
  }
  for (const name of defaultNames ?? []) {
    if (executableOnPath(name, env)) return { command: name, prefixArgs: [], source: 'path' }
  }
  for (const directory of searchDirs ?? []) {
    for (const name of defaultNames ?? []) {
      const candidate = join(directory, name)
      if (executableOnPath(candidate, env)) {
        return { command: candidate, prefixArgs: [], source: 'fallback' }
      }
      if (process.platform === 'win32' && executableOnPath(`${candidate}.exe`, env)) {
        return { command: `${candidate}.exe`, prefixArgs: [], source: 'fallback' }
      }
    }
  }
  return {
    command: (defaultNames ?? [''])[0] ?? '',
    prefixArgs: [],
    source: 'missing',
  }
}

/** Split one buffered stdout chunk into complete newline-delimited records. */
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

/** Keep the last `limit` characters of a stderr stream for failure reports. */
export function createStderrRing(limit = 16 * 1024) {
  let text = ''
  return {
    push(chunk) {
      text = (text + chunk).slice(-limit)
    },
    get value() {
      return text
    },
    clear() {
      text = ''
    },
  }
}

/** A bounded, fire-and-forget command used for probes and version checks. */
export function runCommand(command, args = [], options = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000
  return new Promise((resolve) => {
    let settled = false
    let child
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (child !== undefined) {
        try {
          child.kill('SIGKILL')
        } catch {
          // The child may already be gone.
        }
      }
      resolve(result)
    }
    const timer = setTimeout(() => finish({ code: null, stdout: '', stderr: 'timed out', timedOut: true }), timeoutMs)
    timer.unref?.()
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      finish({ code: null, stdout: '', stderr: error instanceof Error ? error.message : String(error), spawnError: true })
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      stdout = (stdout + chunk).slice(-64 * 1024)
    })
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-16 * 1024)
    })
    child.on('error', (error) => finish({ code: null, stdout, stderr, spawnError: true, error }))
    child.on('exit', (code, signal) => finish({ code, signal, stdout, stderr }))
  })
}
