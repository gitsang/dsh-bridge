import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * The browser half ships as a ModuleLoader bundle. This harness provides the
 * React and primitive surface it consumes so registration and helpers can be
 * exercised without a browser.
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

/** Stand-in for every dsh primitive the bundle imports. */
const fakePrimitives = new Proxy(
  {},
  {
    get: (_target, name) => {
      if (name === '__esModule') return undefined
      return () => null
    },
  },
)

let loaded
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      loaded = definition
    },
  },
}
globalThis.document = undefined

await import('../src/client.js')

function moduleExports() {
  return loaded.factory((id) => {
    if (id === 'react') return fakeReact
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return fakePrimitives
    throw new Error(`unexpected require ${id}`)
  })
}

test('registers the Bridge panel and sidebar entry', () => {
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
  assert.equal(dictionaries[0].namespace, 'bridge')

  const bySlot = Object.fromEntries(registered.map((entry) => [entry.options.name, entry.options]))
  assert.equal(bySlot.main.key, 'bridge')
  assert.equal(bySlot['sidebar.panellist'].id, 'bridge')
  assert.equal(bySlot['sidebar.panellist'].label(), 'panel')
  // Settings live in the page header, so no shell overlay entry is registered.
  assert.equal(bySlot['shell.overlay'], undefined)
  assert.equal(registered.length, 2)
})

test('bridge dictionaries keep the panel named Bridge in both locales', () => {
  const exports = moduleExports()
  const dictionaries = []
  exports.apply({
    effect: (factory) => factory(),
    locale: { register: (namespace, dict) => dictionaries.push(dict), bind: () => (key) => key },
    slots: { inject: () => {}, register: () => () => {} },
  })
  assert.equal(dictionaries[0].zh.panel, 'Bridge')
  assert.equal(dictionaries[0].en.panel, 'Bridge')
  assert.equal(dictionaries[0].zh.settings.includes('桥接'), true)
})

test('helper text extraction and formatting are safe', () => {
  const exports = moduleExports()
  const { textOf, formatTime, formatBytes, safeJson } = exports.__test
  assert.equal(textOf([{ type: 'text', text: 'a' }, { type: 'image', data: 'x' }, { type: 'text', text: 'b' }]), 'ab')
  assert.equal(textOf('plain'), 'plain')
  assert.equal(formatTime(undefined), '')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(2 * 1024 * 1024), '2.0 MB')
  const cyclic = {}
  cyclic.self = cyclic
  assert.match(safeJson(cyclic), /circular/i)
  assert.equal(safeJson({ a: 1 }), '{\n  "a": 1\n}')
})
