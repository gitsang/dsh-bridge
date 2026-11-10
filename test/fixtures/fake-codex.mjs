#!/usr/bin/env node
/**
 * Minimal `codex app-server` stand-in for tests. Speaks newline-delimited
 * JSON-RPC 2.0 on stdio and replays a deterministic version of the real
 * notification sequence for one turn, plus one native approval round-trip.
 * No network, no model, no rollout writes.
 */
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)

if (args.includes('--version')) {
  process.stdout.write('codex-cli 0.0.0-fake\n')
  process.exit(0)
}

const silent = new Set((process.env.FAKE_CODEX_SILENT ?? '').split(',').filter(Boolean))
const write = (record) => process.stdout.write(`${JSON.stringify(record)}\n`)
let nextId = 1
/** Server-initiated request ids start high so they cannot collide with ours. */
let nextServerRequestId = 1000
const pendingApprovals = new Map()
const clients = new Map()
let threadId = 'thread-fake'
let turnSeq = 0
let activeTurn = undefined
let streaming = false
let answered = 0

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function respond(id, result) {
  write({ id, result })
}

function respondError(id, code, message) {
  write({ id, error: { code, message } })
}

function notify(method, params) {
  write({ method, params, emittedAtMs: Date.now() })
}

function serverRequest(method, params) {
  const id = nextServerRequestId
  nextServerRequestId += 1
  return new Promise((resolve) => {
    pendingApprovals.set(id, resolve)
    write({ id, method, params })
  })
}

function threadPayload() {
  return {
    thread: {
      id: threadId,
      cwd: clients.get(threadId) ?? '/tmp/fake-codex',
      model: 'fake-model',
      modelProvider: 'fake',
      cliVersion: '0.0.0-fake',
      createdAt: Math.floor(Date.now() / 1000),
      status: { type: streaming ? 'active' : 'idle' },
      path: `${clients.get(threadId) ?? '/tmp/fake-codex'}/rollout-fake.jsonl`,
    },
    approvalPolicy: 'never',
    cwd: clients.get(threadId) ?? '/tmp/fake-codex',
    model: 'fake-model',
    modelProvider: 'fake',
    reasoningEffort: null,
    sandbox: { type: 'workspace-write' },
  }
}

async function runTurn(text) {
  answered += 1
  const turnId = `turn-${turnSeq}`
  const token = turnId
  activeTurn = turnId
  streaming = true
  const isCurrent = () => activeTurn === token && streaming
  const messageId = `msg-${turnSeq}`
  const reasoningId = `reason-${turnSeq}`
  const finish = (status) => {
    notify('turn/completed', { threadId, turn: { id: turnId, status, items: [] } })
  }

  notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress', items: [] } })
  notify('item/started', {
    threadId,
    turnId,
    item: { id: `user-${turnSeq}`, type: 'userMessage', content: [{ type: 'text', text }] },
    startedAtMs: Date.now(),
  })
  notify('item/completed', {
    threadId,
    turnId,
    item: { id: `user-${turnSeq}`, type: 'userMessage', content: [{ type: 'text', text }] },
    completedAtMs: Date.now(),
  })
  if (!isCurrent()) return

  notify('item/started', { threadId, turnId, item: { id: reasoningId, type: 'reasoning', summary: [], content: [] }, startedAtMs: Date.now() })
  notify('item/reasoning/summaryTextDelta', { threadId, turnId, itemId: reasoningId, delta: 'Thinking', summaryIndex: 0 })
  notify('item/reasoning/summaryTextDelta', { threadId, turnId, itemId: reasoningId, delta: ' about it.', summaryIndex: 0 })
  notify('item/completed', {
    threadId,
    turnId,
    item: { id: reasoningId, type: 'reasoning', summary: ['Thinking about it.'], content: [] },
    completedAtMs: Date.now(),
  })
  if (!isCurrent()) return

  if (text.includes('approval')) {
    const itemId = `cmd-${turnSeq}`
    notify('item/started', {
      threadId,
      turnId,
      item: { id: itemId, type: 'commandExecution', command: 'rm -rf build', cwd: '/tmp/fake-codex', status: 'inProgress', commandActions: [] },
      startedAtMs: Date.now(),
    })
    const result = await serverRequest('item/commandExecution/requestApproval', {
      threadId,
      turnId,
      itemId,
      command: 'rm -rf build',
      cwd: '/tmp/fake-codex',
      reason: 'Fake test command',
      startedAtMs: Date.now(),
    })
    if (!isCurrent()) return
    const decision = result?.decision ?? 'decline'
    if (decision === 'accept') {
      notify('item/commandExecution/outputDelta', { threadId, turnId, itemId, delta: 'removing build\n' })
      notify('item/completed', {
        threadId,
        turnId,
        item: {
          id: itemId,
          type: 'commandExecution',
          command: 'rm -rf build',
          cwd: '/tmp/fake-codex',
          status: 'completed',
          exitCode: 0,
          aggregatedOutput: 'removing build\n',
          commandActions: [],
        },
        completedAtMs: Date.now(),
      })
    } else {
      notify('item/completed', {
        threadId,
        turnId,
        item: {
          id: itemId,
          type: 'commandExecution',
          command: 'rm -rf build',
          cwd: '/tmp/fake-codex',
          status: 'declined',
          aggregatedOutput: '',
          commandActions: [],
        },
        completedAtMs: Date.now(),
      })
    }
    if (!isCurrent()) return
  }

  notify('item/started', {
    threadId,
    turnId,
    item: { id: messageId, type: 'agentMessage', text: '' },
    startedAtMs: Date.now(),
  })
  const answer = `echo: ${text}`
  for (const chunk of [answer.slice(0, 4), answer.slice(4, 8), answer.slice(8)]) {
    await sleep(25)
    if (!isCurrent()) return
    notify('item/agentMessage/delta', { threadId, turnId, itemId: messageId, delta: chunk })
  }
  notify('item/completed', {
    threadId,
    turnId,
    item: { id: messageId, type: 'agentMessage', text: answer },
    completedAtMs: Date.now(),
  })
  if (!isCurrent()) return
  notify('thread/tokenUsage/updated', {
    threadId,
    turnId,
    tokenUsage: {
      last: { inputTokens: 12, cachedInputTokens: 30, outputTokens: 5, reasoningOutputTokens: 0, totalTokens: 47 },
      total: { inputTokens: 120, cachedInputTokens: 300, cacheWriteInputTokens: 0, outputTokens: 50, reasoningOutputTokens: 0, totalTokens: 470 },
      modelContextWindow: 200000,
    },
  })
  streaming = false
  activeTurn = undefined
  // FAKE_CODEX_SKIP_TURN_COMPLETED models a missed completion: only the status
  // flip arrives, so the attachment has to settle from that alone.
  if (process.env.FAKE_CODEX_SKIP_TURN_COMPLETED !== '1') finish('completed')
  notify('thread/status/changed', { threadId, status: { type: 'idle' } })
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  if (line.trim() === '') return
  let record
  try {
    record = JSON.parse(line)
  } catch {
    return
  }
  if (record === null || typeof record !== 'object') return

  // Reply to a server-initiated request we are waiting on.
  if (record.id !== undefined && typeof record.method !== 'string') {
    const resolve = pendingApprovals.get(record.id)
    if (resolve !== undefined) {
      pendingApprovals.delete(record.id)
      resolve(record.result)
    }
    return
  }
  if (typeof record.method !== 'string') return
  const id = record.id
  const params = record.params ?? {}
  if (silent.has(record.method)) return

  switch (record.method) {
    case 'initialize':
      respond(id, {
        userAgent: 'dsh-bridge-fake/0.0.0-fake (fake) fake',
        codexHome: '/tmp/fake-codex-home',
        platformFamily: 'unix',
        platformOs: 'linux',
      })
      return
    case 'thread/start':
    case 'thread/resume': {
      turnSeq = 0
      threadId = typeof params.threadId === 'string' && params.threadId !== '' ? params.threadId : `thread-${Date.now().toString(36)}`
      clients.set(threadId, typeof params.cwd === 'string' ? params.cwd : '/tmp/fake-codex')
      notify('thread/started', { thread: threadPayload().thread })
      respond(id, threadPayload())
      return
    }
    case 'turn/start': {
      if (streaming) {
        respondError(id, -32600, `turn/start is not allowed while turn ${activeTurn} is active`)
        return
      }
      turnSeq += 1
      respond(id, { turn: { id: `turn-${turnSeq}`, status: 'inProgress', items: [] } })
      const text = Array.isArray(params.input)
        ? params.input.filter((item) => item?.type === 'text').map((item) => item.text).join('\n')
        : ''
      void runTurn(text)
      return
    }
    case 'turn/steer': {
      respond(id, { turnId: activeTurn ?? `turn-${turnSeq}` })
      if (streaming) {
        notify('item/agentMessage/delta', {
          threadId,
          turnId: activeTurn,
          itemId: `msg-${turnSeq}`,
          delta: `\n(steered: ${(params.input ?? []).map((item) => item?.text ?? '').join(' ')})`,
        })
      }
      return
    }
    case 'turn/interrupt': {
      respond(id, {})
      if (streaming) {
        streaming = false
        const turnId = activeTurn
        activeTurn = undefined
        notify('item/completed', {
          threadId,
          turnId,
          item: { id: `msg-${turnSeq}`, type: 'agentMessage', text: 'echo: aborted' },
          completedAtMs: Date.now(),
        })
        notify('turn/completed', { threadId, turn: { id: turnId, status: 'interrupted', items: [] } })
      }
      return
    }
    case 'model/list':
      respond(id, {
        data: [
          {
            id: 'fake-model',
            model: 'fake-model',
            displayName: 'Fake Model',
            description: 'Deterministic test model',
            hidden: false,
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }],
          },
          {
            id: 'fake-model-hidden',
            model: 'fake-model-hidden',
            displayName: 'Hidden Model',
            description: 'Should never be listed',
            hidden: true,
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: [],
          },
        ],
      })
      return
    case 'thread/read':
      // Matches codex-cli 0.162.1, where includeTurns is not implemented; the
      // attachment is expected to fall back to the rollout file.
      respondError(id, -32601, 'list_turns is not supported yet')
      return
    default:
      respondError(id, -32601, `unsupported method: ${record.method}`)
  }
})

rl.on('close', () => process.exit(0))
process.stdin.on('end', () => process.exit(0))
