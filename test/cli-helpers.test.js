import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createLineDecoder,
  createStderrRing,
  executableOnPath,
  resolveCliCommand,
  runCommand,
} from '../src/backends/cli.js'

test('line decoder splits CRLF and keeps unicode separators', () => {
  const lines = []
  const decoder = createLineDecoder((line) => lines.push(line))
  decoder.push('{"a":1}\r\n{"b":"x\u2028y"}\n{"c"')
  decoder.push(':2}\n')
  decoder.flush()
  assert.deepEqual(lines, ['{"a":1}', '{"b":"x\u2028y"}', '{"c":2}'])
})

test('stderr ring keeps only the newest bytes', () => {
  const ring = createStderrRing(8)
  ring.push('abcdef')
  ring.push('ghij')
  assert.equal(ring.value, 'cdefghij')
  ring.clear()
  assert.equal(ring.value, '')
})

test('executableOnPath ignores directories and matches real files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-cli-'))
  try {
    const file = join(root, 'agent-bin')
    await writeFile(file, '#!/bin/sh\nexit 0\n', 'utf8')
    await chmod(file, 0o755)
    const data = join(root, 'not-executable-name')
    await writeFile(data, 'x', 'utf8')
    const env = { PATH: root }
    assert.equal(executableOnPath('agent-bin', env), true)
    assert.equal(executableOnPath('not-executable-name', env), true)
    // A directory with the same name is not an executable the child can launch.
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(root, 'agent-dir'))
    assert.equal(executableOnPath(join(root, 'agent-dir'), env), false)
    assert.equal(executableOnPath('missing-agent', env), false)
    assert.equal(executableOnPath('', env), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('resolveCliCommand prefers config, then env, then PATH', () => {
  const env = { PATH: '/nonexistent' }
  assert.deepEqual(
    resolveCliCommand({ configBin: '/opt/agent', envVar: 'AGENT_BIN', defaultNames: ['agent'], env: { ...env, AGENT_BIN: '/env/agent' } }),
    { command: '/opt/agent', prefixArgs: [], source: 'config' },
  )
  assert.deepEqual(
    resolveCliCommand({ configBin: null, envVar: 'AGENT_BIN', defaultNames: ['agent'], env: { ...env, AGENT_BIN: '/env/agent' } }),
    { command: '/env/agent', prefixArgs: [], source: 'env', envVar: 'AGENT_BIN' },
  )
  const missing = resolveCliCommand({ configBin: '   ', envVar: 'AGENT_BIN', defaultNames: ['agent'], env })
  assert.equal(missing.command, 'agent')
  assert.equal(missing.source, 'missing')
})

test('runCommand captures output and reports a non-zero exit', async () => {
  const ok = await runCommand(process.execPath, ['-e', 'process.stdout.write("hello")'])
  assert.equal(ok.code, 0)
  assert.equal(ok.stdout, 'hello')
  const failing = await runCommand(process.execPath, ['-e', 'process.stderr.write("bad");process.exit(3)'])
  assert.equal(failing.code, 3)
  assert.equal(failing.stderr, 'bad')
  const missing = await runCommand('/definitely/not/a/binary', [])
  assert.equal(missing.spawnError, true)
})
