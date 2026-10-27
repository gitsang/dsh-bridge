import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  PasswordStore, SessionStore, loginPage, parseCookies, proxyCookieHeader, safeNext,
} from '../src/auth.js'

test('password store hashes, verifies and never stores plaintext', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-v2-auth-'))
  try {
    const path = join(root, 'auth.json')
    const store = new PasswordStore(path)
    await store.init()
    assert.equal(store.configured, false)
    assert.equal(await store.verify('secret'), false)
    await store.set('secret')
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    assert.equal(await store.verify('secret'), true)
    assert.equal(await store.verify('wrong'), false)
    const reloaded = new PasswordStore(path)
    await reloaded.init()
    assert.equal(await reloaded.verify('secret'), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('sessions roll their expiry and persist across reload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-v2-sessions-'))
  try {
    const path = join(root, 'session.json')
    const store = new SessionStore(path, 1000)
    await store.init()
    const token = await store.create()
    assert.ok(store.get(token))
    await store.touch(token)
    const reloaded = new SessionStore(path, 1000)
    await reloaded.init()
    assert.ok(reloaded.get(token))
    await reloaded.delete(token)
    assert.equal(reloaded.get(token), undefined)
    assert.equal(await reloaded.deleteAll(), 0)
    reloaded.close()
    store.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('session ids exclude gateway and upstream cookies', () => {
  assert.deepEqual(parseCookies('a=1; b=2; a=3'), { a: '1', b: '2' })
  assert.equal(proxyCookieHeader('dsh_bridge_session=x; theme=dark; dsh-auth-h=old', 'dsh-auth-h=new'), 'theme=dark; dsh-auth-h=new')
  assert.equal(proxyCookieHeader(undefined, undefined), undefined)
})

test('login page escapes copy and next destinations stay local', () => {
  const html = loginPage({ setup: false, next: '/b/pi/', error: '<script>' })
  assert.match(html, /&lt;script&gt;/)
  assert.match(html, /name="next" value="\/b\/pi\/"/)
  assert.equal(safeNext('https://evil.example/'), '/')
  assert.equal(safeNext('//evil.example/'), '/')
  assert.equal(safeNext('/b/pi/'), '/b/pi/')
})
