import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * The browser half is shipped as a ModuleLoader bundle, not an ES module.
 * This harness provides just enough React and window plumbing to load it and
 * exercise the plugin registration without a browser.
 */
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
  Fragment: Symbol('Fragment'),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useCallback: (fn) => fn,
  useRef: (value) => ({ current: value }),
}

let loaded
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      loaded = definition
    },
  },
}

await import('../src/client.js')

function moduleExports() {
  return loaded.factory((id) => {
    if (id === 'react') return fakeReact
    throw new Error(`unexpected require ${id}`)
  })
}

test('registers a Pi panel and sidebar entry', () => {
  const exports = moduleExports()
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots', 'locale'])

  const registered = []
  const dictionaries = []
  const ctx = {
    effect(factory) {
      return factory()
    },
    locale: {
      register(namespace, dict) {
        dictionaries.push({ namespace, dict })
      },
      bind() {
        return (key) => key
      },
    },
    slots: {
      inject(name, factory) {
        factory()
      },
      register(options, component) {
        registered.push({ options, component })
        return () => {}
      },
    },
  }
  exports.apply(ctx)
  assert.equal(dictionaries.length, 1)
  assert.equal(dictionaries[0].namespace, 'piBridge')
  assert.equal(registered.length, 2)
  assert.equal(registered[0].options.name, 'main')
  assert.equal(registered[0].options.key, 'pi-bridge')
  assert.equal(registered[1].options.name, 'sidebar.panellist')
  assert.equal(registered[1].options.id, 'pi-bridge')
  assert.equal(registered[1].options.order, 20)
  assert.equal(registered[1].options.label(), 'panel')
})

test('helper text extraction and JSON formatting are safe', () => {
  const exports = moduleExports()
  const { textOf, shortPath, formatTime, safeJson } = exports.__test
  assert.equal(textOf([{ type: 'text', text: 'a' }, { type: 'image', data: 'x' }, { type: 'text', text: 'b' }]), 'ab')
  assert.equal(textOf('plain'), 'plain')
  assert.equal(shortPath('/home/sang/src/x'), '/home/sang/src/x')
  assert.equal(formatTime(undefined), '')
  const cyclic = {}
  cyclic.self = cyclic
  assert.match(safeJson(cyclic), /circular/i)
  assert.equal(safeJson({ a: 1 }), '{\n  "a": 1\n}')
})
