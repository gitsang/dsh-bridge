import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DshAuthError,
  DshError,
  DshHttpError,
  DshRpcError,
  createDshClient,
  normalizeBaseUrl,
} from '../src/backends/dsh/http.js'
import { startFakeDsh } from './fixtures/fake-dsh.mjs'

const TOKEN = 'fake-launch-token'

function authError(kind, pattern) {
  return (error) => {
    assert.ok(error instanceof DshAuthError, `expected DshAuthError, got ${error?.name}: ${error?.message}`)
    assert.equal(error.kind, kind)
    if (pattern) assert.match(error.message, pattern)
    return true
  }
}

test('normalizeBaseUrl accepts http(s) URLs and preserves a path prefix', () => {
  assert.equal(normalizeBaseUrl('http://example.com').href, 'http://example.com/')
  assert.equal(normalizeBaseUrl('http://example.com/').href, 'http://example.com/')
  assert.equal(normalizeBaseUrl(' https://example.com ').href, 'https://example.com/')

  const prefixed = normalizeBaseUrl('https://example.com/dsh/')
  assert.equal(prefixed.origin, 'https://example.com')
  assert.equal(prefixed.pathname, '/dsh')
  assert.equal(normalizeBaseUrl('https://example.com/a/b/').pathname, '/a/b')
})

test('normalizeBaseUrl rejects empty, non-http(s) and unparseable URLs', () => {
  for (const raw of ['', '   ', 'ftp://example.com', 'not a url', null, undefined, 42]) {
    assert.throws(
      () => normalizeBaseUrl(raw),
      (error) => error instanceof DshAuthError && error.kind === 'invalid-url',
      `expected invalid-url for ${String(raw)}`,
    )
  }
})

test('token auth mints a cookie that session/list reuses', async (t) => {
  const fake = await startFakeDsh({ sessions: [{ id: 'sess-1', title: 'Alpha' }] })
  t.after(() => fake.close())

  const client = createDshClient({ baseUrl: `${fake.url}/`, token: TOKEN })
  assert.equal(client.authMode, 'token')
  await client.connect()
  assert.equal(fake.state.tokenAuthRequests, 1)

  const value = await client.call('session/list', { _request: {} })
  assert.deepEqual(value.items.map((row) => row.sessionId), ['sess-1'])
  assert.equal(fake.calls.length, 1)
  assert.equal(fake.calls[0].method, 'session/list')
  assert.deepEqual(fake.calls[0].args, { _request: {} })
  assert.match(fake.state.lastCookieHeader, /dsh-auth-fake=/)

  await assert.rejects(client.call('session/list', {}), (error) => {
    assert.ok(error instanceof DshRpcError, `expected DshRpcError, got ${error?.name}`)
    assert.equal(error.code, 'gateway/arguments-invalid')
    assert.equal(error.method, 'session/list')
    return true
  })
})

test('password auth logs in and reuses the gateway cookie', async (t) => {
  const fake = await startFakeDsh({ password: 's3cret', sessions: [{ id: 'sess-pw' }] })
  t.after(() => fake.close())

  const client = createDshClient({ baseUrl: fake.url, password: 's3cret' })
  assert.equal(client.authMode, 'password')
  await client.connect()
  assert.equal(fake.state.loginRequests, 1)

  const value = await client.call('session/list', { _request: {} })
  assert.deepEqual(value.items.map((row) => row.sessionId), ['sess-pw'])
  assert.match(fake.state.lastCookieHeader, /dsh_gateway_session=fake-gateway-session/)

  const wrongPassword = createDshClient({ baseUrl: fake.url, password: 'nope' })
  await assert.rejects(wrongPassword.connect(), authError('bad-password', /password/i))
})

test('password auth against a gateway with no password yet reports setup', async (t) => {
  const fake = await startFakeDsh({})
  t.after(() => fake.close())

  const client = createDshClient({ baseUrl: fake.url, password: 'anything' })
  await assert.rejects(
    client.connect(),
    authError('no-password', /no password yet; open it in a browser to set one/),
  )
})

test('token mode against dsh-gateway tells the user to configure a password', async (t) => {
  const fake = await startFakeDsh({ gateway: true, password: 'gateway-pw' })
  t.after(() => fake.close())

  const client = createDshClient({ baseUrl: fake.url, token: TOKEN })
  await assert.rejects(client.connect(), (error) => {
    assert.ok(error instanceof DshAuthError, `expected DshAuthError, got ${error?.name}`)
    assert.equal(error.kind, 'unauthenticated')
    assert.match(error.message, /gateway/i)
    assert.match(error.message, /password/i)
    return true
  })
})

test('403 untrusted host and 401 bad token map to actionable auth errors', async (t) => {
  const untrusted = await startFakeDsh({ requireTrustedHost: 'trusted.example' })
  t.after(() => untrusted.close())
  const blocked = createDshClient({ baseUrl: untrusted.url, token: TOKEN })
  await assert.rejects(blocked.connect(), authError('untrusted-host', /--trusted-host/))

  const stale = await startFakeDsh({ token: 'server-side-token' })
  t.after(() => stale.close())
  const wrongToken = createDshClient({ baseUrl: stale.url, token: 'not-the-token' })
  await assert.rejects(wrongToken.connect(), authError('bad-token', /ephemeral/))
})

test('RPC errors carry code and method and are not retried', async (t) => {
  const fake = await startFakeDsh({ sessions: [{ id: 'sess-1' }] })
  t.after(() => fake.close())

  const client = createDshClient({ baseUrl: fake.url, token: TOKEN })
  await client.connect()
  await assert.rejects(
    client.call('session/projections', { request: { sessionId: 'missing' } }),
    (error) => {
      assert.ok(error instanceof DshRpcError, `expected DshRpcError, got ${error?.name}`)
      assert.equal(error.code, 'session/not-found')
      assert.equal(error.method, 'session/projections')
      assert.match(error.message, /not found/i)
      return true
    },
  )
  assert.equal(fake.state.apiRequests, 1)
  assert.equal(fake.calls.filter((call) => call.method === 'session/projections').length, 1)
})

test('malformed RPC envelopes surface as DshError without leaking credentials', async (t) => {
  const mangled = await startFakeDsh({ mangleRpcId: true })
  t.after(() => mangled.close())
  const client = createDshClient({ baseUrl: mangled.url, token: TOKEN })
  await client.connect()
  await assert.rejects(client.call('session/list', { _request: {} }), (error) => {
    assert.ok(error instanceof DshError, `expected DshError, got ${error?.name}`)
    assert.match(error.message, /malformed RPC envelope/)
    assert.match(error.message, /session\/list/)
    assert.doesNotMatch(error.message, /fake-launch-token|dsh-auth|server-response/)
    return true
  })

  const nonJson = await startFakeDsh({ nonJsonBody: true })
  t.after(() => nonJson.close())
  const other = createDshClient({ baseUrl: nonJson.url, token: TOKEN })
  await other.connect()
  await assert.rejects(other.call('session/list', { _request: {} }), (error) => {
    assert.ok(error instanceof DshError, `expected DshError, got ${error?.name}`)
    assert.match(error.message, /malformed RPC envelope/)
    assert.match(error.message, /session\/list/)
    return true
  })

  const nonJsonRequest = await other.request('POST', '/api/session/list', {
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  })
  assert.equal(nonJsonRequest.status, 400)
})

test('unexpected HTTP statuses become DshHttpError with status and method', async (t) => {
  const fake = await startFakeDsh()
  t.after(() => fake.close())

  const client = createDshClient({ baseUrl: fake.url, token: TOKEN })
  await client.connect()
  await assert.rejects(client.call('does/not/exist', {}), (error) => {
    assert.ok(error instanceof DshHttpError, `expected DshHttpError, got ${error?.name}`)
    assert.equal(error.status, 404)
    assert.equal(error.method, 'does/not/exist')
    assert.match(error.message, /404/)
    return true
  })

  const wrongType = await client.request('POST', '/api/session/list', {
    headers: { 'content-type': 'text/plain' },
    body: 'nope',
  })
  assert.equal(wrongType.status, 415)
})

test('a 401 during a call re-authenticates and retries exactly once', async (t) => {
  const fake = await startFakeDsh({ sessions: [{ id: 'sess-1' }] })
  t.after(() => fake.close())

  const client = createDshClient({ baseUrl: fake.url, token: TOKEN })
  await client.connect()
  assert.equal(fake.state.tokenAuthRequests, 1)

  fake.expireAuth()
  const value = await client.call('session/list', { _request: {} })
  assert.equal(value.items[0].sessionId, 'sess-1')
  assert.equal(fake.state.apiRequests, 2)
  assert.equal(fake.state.tokenAuthRequests, 2)
  assert.equal(fake.calls.filter((call) => call.method === 'session/list').length, 1)
})

test('when re-authentication fails after a 401 the call rejects', async (t) => {
  const fake = await startFakeDsh({ sessions: [{ id: 'sess-1' }] })
  t.after(() => fake.close())

  const client = createDshClient({ baseUrl: fake.url, token: TOKEN })
  await client.connect()
  fake.dropAuth()
  await assert.rejects(client.call('session/list', { _request: {} }), (error) => {
    assert.ok(error instanceof DshAuthError, `expected DshAuthError, got ${error?.name}`)
    assert.equal(error.kind, 'bad-token')
    return true
  })
  assert.equal(fake.state.apiRequests, 1)
})

test('a never-answering route rejects with a timeout that mentions it', async (t) => {
  const fake = await startFakeDsh()
  t.after(() => fake.close())

  const client = createDshClient({ baseUrl: fake.url, timeoutMs: 150 })
  await assert.rejects(client.request('GET', '/__hang'), (error) => {
    assert.ok(error instanceof DshError, `expected DshError, got ${error?.name}`)
    assert.match(error.message, /timed out after 150ms/)
    return true
  })
})

test('concurrent connect() and call() share one auth exchange', async (t) => {
  const fake = await startFakeDsh({ sessions: [{ id: 'sess-1' }] })
  t.after(() => fake.close())

  const client = createDshClient({ baseUrl: fake.url, token: TOKEN })
  const [, value] = await Promise.all([client.connect(), client.call('session/list', { _request: {} })])
  assert.equal(fake.state.tokenAuthRequests, 1)
  assert.equal(value.items[0].sessionId, 'sess-1')
  assert.equal(fake.calls.length, 1)
})

test('two clients keep independent cookie jars and close() is harmless', async (t) => {
  const fake = await startFakeDsh({ password: 'pw', sessions: [{ id: 'sess-1' }] })
  t.after(() => fake.close())

  const tokenClient = createDshClient({ baseUrl: fake.url, token: TOKEN })
  const passwordClient = createDshClient({ baseUrl: fake.url, password: 'pw' })
  await Promise.all([tokenClient.connect(), passwordClient.connect()])

  await tokenClient.call('session/list', { _request: {} })
  assert.match(fake.state.lastCookieHeader, /dsh-auth-fake=/)
  assert.doesNotMatch(fake.state.lastCookieHeader, /dsh_gateway_session=/)

  await passwordClient.call('session/list', { _request: {} })
  assert.match(fake.state.lastCookieHeader, /dsh_gateway_session=/)
  assert.doesNotMatch(fake.state.lastCookieHeader, /dsh-auth-fake=/)

  tokenClient.close()
  fake.expireAuth()
  const afterExpiry = await passwordClient.call('session/list', { _request: {} })
  assert.equal(afterExpiry.items.length, 1)
  const tokenAfterExpiry = await tokenClient.call('session/list', { _request: {} })
  assert.equal(tokenAfterExpiry.items.length, 1)
})

test('session/page slices records and session/prompt advances the cursor', async (t) => {
  const fake = await startFakeDsh({
    sessions: [{ id: 'sess-1' }],
    pageRecords: {
      'sess-1': [
        { type: 'message', data: { text: 'one' } },
        { type: 'message', data: { text: 'two' } },
        { type: 'message', data: { text: 'three' } },
      ],
    },
    promptEvents: [{ type: 'message', data: { text: 'queued' } }],
  })
  t.after(() => fake.close())

  const client = createDshClient({ baseUrl: fake.url, token: TOKEN })
  await client.connect()

  const page = await client.call('session/page', {
    request: { address: { kind: 'session', sessionId: 'sess-1' }, throughSeq: 3, maxMessages: 2 },
  })
  assert.equal(page.records.length, 2)
  assert.equal(page.records[1].event.seq, 3)
  assert.equal(page.hasMore, true)

  await assert.rejects(
    client.call('session/page', {
      request: { address: { kind: 'session', sessionId: 'sess-1' }, throughSeq: 99 },
    }),
    (error) => {
      assert.ok(error instanceof DshRpcError, `expected DshRpcError, got ${error?.name}`)
      assert.equal(error.code, 'gateway/bad-request')
      return true
    },
  )

  const prompt = await client.call('session/prompt', {
    request: {
      requestId: 'req-1',
      sessionId: 'sess-1',
      mode: 'queue',
      content: [{ type: 'text', text: 'hello' }],
    },
  })
  assert.equal(prompt.accepted, true)

  const projection = await client.call('session/projections', { request: { sessionId: 'sess-1' } })
  assert.equal(projection.asOfSeq, 4)
  assert.equal(projection.values.sessionListMetadata.blank, false)
})
