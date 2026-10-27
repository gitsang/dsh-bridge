import assert from 'node:assert/strict'
import test from 'node:test'
import { browserResponseHeaders, injectHostMode, mountLocation, parseMount, upstreamHeaders } from '../src/proxy.js'

const target = { protocol: 'http:', host: '127.0.0.1', port: 3090 }

test('mount parsing keeps the upstream path and query', () => {
  assert.deepEqual(parseMount('/b/pi/'), { id: 'pi', path: '/' })
  assert.deepEqual(parseMount('/b/pi/api/session/list'), { id: 'pi', path: '/api/session/list' })
  assert.deepEqual(parseMount('/b/pi'), { id: 'pi', path: '/' })
  assert.equal(parseMount('/api/session/list'), undefined)
  assert.equal(parseMount('/b/Pi/'), undefined)
  assert.equal(parseMount('/b/pi-evil/../../x'), undefined)
})

test('upstream headers rewrite authority while preserving the mount path in Referer', () => {
  const headers = upstreamHeaders({
    host: 'gateway.example:8080',
    origin: 'https://gateway.example:8080',
    referer: 'https://gateway.example:8080/b/pi/api/session/list?x=1',
    'x-forwarded-for': '203.0.113.9',
  }, target, 'pi')
  assert.equal(headers.host, '127.0.0.1:3090')
  assert.equal(headers.origin, 'http://127.0.0.1:3090')
  assert.equal(headers.referer, 'http://127.0.0.1:3090/api/session/list?x=1')
  assert.equal(headers['x-forwarded-for'], '127.0.0.1')
})

test('response locations and cookies stay inside the mount', () => {
  const headers = browserResponseHeaders({
    location: '/api/remote.mux',
    'set-cookie': [
      'theme=dark; Path=/; HttpOnly',
      'dsh-auth-abc=secret; Path=/; HttpOnly',
    ],
  }, 'pi', target)
  assert.equal(headers.location, '/b/pi/api/remote.mux')
  assert.deepEqual(headers['set-cookie'], ['theme=dark; Path=/b/pi/; HttpOnly'])
  assert.equal(mountLocation('http://127.0.0.1:3090/api/x?y=1', 'pi', target), '/b/pi/api/x?y=1')
  assert.equal(mountLocation('https://example.com/x', 'pi', target), 'https://example.com/x')
})

test('served dsh pages receive the host-owning transport flag', () => {
  const html = injectHostMode('<!doctype html><html><head><base href="./"></head><body></body></html>')
  assert.ok(html.indexOf('ownsHost: true') < html.indexOf('<base'))
})
