#!/usr/bin/env node
/**
 * Minimal Pi RPC stand-in for tests. Reads JSONL commands on stdin and emits
 * deterministic responses/events on stdout. It also exercises the extension UI
 * sub-protocol so the bridge's dialog forwarding can be tested without a model.
 */
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
const sessionIndex = args.indexOf('--session')
const sessionFile = sessionIndex === -1 ? undefined : args[sessionIndex + 1]
let streaming = false
let model = { id: 'fake-model', provider: 'fake', name: 'Fake' }
const messages = []

const write = (record) => process.stdout.write(`${JSON.stringify(record)}\n`)
const respond = (id, command, data) => write({ id, type: 'response', command, success: true, data })

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  if (line.trim() === '') return
  let command
  try {
    command = JSON.parse(line)
  } catch {
    return
  }
  const id = command.id
  if (command.type === 'prompt') {
    if (streaming) {
      if (command.streamingBehavior === undefined) {
        write({ id, type: 'response', command: 'prompt', success: false, error: 'agent is streaming' })
        return
      }
      respond(id, 'prompt', { queued: command.streamingBehavior })
      return
    }
    respond(id, 'prompt', { accepted: true })
    streaming = true
    const user = { role: 'user', content: [{ type: 'text', text: command.message }], timestamp: Date.now() }
    messages.push(user)
    write({ type: 'agent_start' })
    write({ type: 'turn_start' })
    write({ type: 'message_start', message: user })
    write({ type: 'message_end', message: user })
    const assistant = { role: 'assistant', content: [], api: 'fake', provider: 'fake', model: 'fake-model', usage: { input: 12, output: 5, cacheRead: 30, cacheWrite: 0, total: 47 }, stopReason: 'pending', timestamp: Date.now() }
    write({ type: 'message_start', message: assistant })
    const text = `echo: ${command.message}`
    for (const char of text) {
      write({ type: 'message_update', message: { ...assistant, content: [{ type: 'text', text }] }, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: char } })
    }
    const done = { ...assistant, content: [{ type: 'text', text }], stopReason: 'stop' }
    messages.push(done)
    write({ type: 'message_end', message: done })
    write({ type: 'turn_end', message: done, toolResults: [] })
    write({ type: 'agent_end', messages })
    write({ type: 'agent_settled' })
    streaming = false
    return
  }
  if (command.type === 'get_state') {
    respond(id, 'get_state', {
      model,
      thinkingLevel: 'medium',
      isStreaming: streaming,
      isCompacting: false,
      sessionFile,
      sessionId: 'fake-session',
      sessionName: 'Fake session',
      autoCompactionEnabled: true,
      messageCount: messages.length,
      pendingMessageCount: 0,
    })
    return
  }
  if (command.type === 'get_messages') {
    respond(id, 'get_messages', { messages })
    return
  }
  if (command.type === 'get_available_models') {
    respond(id, 'get_available_models', {
      models: [
        model,
        { id: 'fake-model-2', provider: 'fake', name: 'Fake Two', contextWindow: 200000, reasoning: true },
      ],
    })
    return
  }
  if (command.type === 'get_session_stats') {
    const usage = messages
      .filter((entry) => entry.role === 'assistant')
      .reduce((sum, entry) => ({
        input: sum.input + (entry.usage?.input ?? 0),
        output: sum.output + (entry.usage?.output ?? 0),
        cacheRead: sum.cacheRead + (entry.usage?.cacheRead ?? 0),
        cacheWrite: sum.cacheWrite + (entry.usage?.cacheWrite ?? 0),
      }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    respond(id, 'get_session_stats', {
      sessionId: 'fake-session',
      userMessages: messages.filter((entry) => entry.role === 'user').length,
      assistantMessages: messages.filter((entry) => entry.role === 'assistant').length,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: messages.length,
      tokens: { ...usage, total: usage.input + usage.output + usage.cacheRead + usage.cacheWrite },
      cost: 0,
    })
    return
  }
  if (command.type === 'abort') {
    const assistant = { role: 'assistant', content: [], api: 'fake', provider: 'fake', model: 'fake-model', usage: {}, stopReason: 'aborted', errorMessage: 'Request aborted', timestamp: Date.now() }
    write({ type: 'message_start', message: assistant })
    write({ type: 'message_end', message: assistant })
    write({ type: 'turn_end', message: assistant, toolResults: [] })
    write({ type: 'agent_end', messages })
    write({ type: 'agent_settled' })
    streaming = false
    respond(id, 'abort', { aborted: true })
    return
  }
  if (command.type === 'set_model') {
    model = { id: command.modelId, provider: command.provider, name: command.modelId }
    respond(id, 'set_model', model)
    return
  }
  if (command.type === 'set_thinking_level') {
    respond(id, 'set_thinking_level', { level: command.level })
    return
  }
  if (command.type === 'set_session_name') {
    respond(id, 'set_session_name', { name: command.name })
    return
  }
  if (command.type === 'extension_ui_response') {
    write({ type: 'agent_start' })
    write({ type: 'extension_ui_resolved', id: command.id, response: command })
    write({ type: 'agent_settled' })
    return
  }
  write({ id, type: 'response', command: command.type, success: false, error: `unsupported: ${command.type}` })
})

// Emit one blocking dialog shortly after startup, mirroring an extension's
// ctx.ui.confirm() during session_start.
setTimeout(() => {
  write({ type: 'extension_ui_request', id: 'ui-1', method: 'confirm', title: 'Allow?', message: 'Proceed?', timeout: 10000 })
}, 30)

process.stdin.on('end', () => process.exit(0))
