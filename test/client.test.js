import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
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

test('registers the Bridge panel, brand bridge switcher, shell settings overlay, and sidebar', () => {
  const exports = moduleExports()
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots', 'locale', 'layout'])

  const registered = []
  const dictionaries = []
  let panelId = 'bridge'
  const panelListeners = new Set()
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
    layout: {
      selectPanel(id) { panelId = id },
      panelInfo: {
        getSnapshot: () => ({ activePanelId: panelId }),
        subscribe(listener) {
          panelListeners.add(listener)
          return () => panelListeners.delete(listener)
        },
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
  assert.equal(bySlot['sidebar.panellist'], undefined)
  assert.equal(bySlot['sidebar.brand.mark'].name, 'sidebar.brand.mark')
  assert.equal(bySlot['sidebar.workspaces'].name, 'sidebar.workspaces')
  assert.equal(bySlot['shell.overlay'].id, 'bridge-settings')
  assert.equal(registered.length, 4)
})

test('bridge dictionaries describe bridges as saved instances, not engines', () => {
  const exports = moduleExports()
  const dictionaries = []
  exports.apply({
    effect: (factory) => factory(),
    layout: {
      selectPanel() {},
      panelInfo: { getSnapshot: () => ({ activePanelId: null }), subscribe: () => () => {} },
    },
    locale: { register: (namespace, dict) => dictionaries.push(dict), bind: () => (key) => key },
    slots: { inject: () => {}, register: () => () => {} },
  })
  assert.equal(dictionaries[0].zh.panel, 'Bridge')
  assert.equal(dictionaries[0].en.panel, 'Bridge')
  assert.equal(dictionaries[0].zh.manageBridges, '管理桥接')
  assert.equal(dictionaries[0].zh.local, '本机')
  assert.equal(dictionaries[0].zh.addBridge, '新增桥接')
  assert.equal(dictionaries[0].zh.bridgeMode, '桥接模式')
  assert.equal(dictionaries[0].en.bridgeEngine, 'Engine')
  assert.equal(dictionaries[0].zh.backendPi, undefined)
  assert.doesNotMatch(dictionaries[0].en.emptyHint, /\bpi\b/i)
})

test('browser bundle has no Pi-specific route, env, or runtime coupling', async () => {
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /\/api\/pi-bridge/)
  assert.doesNotMatch(source, /PI_OFFLINE|PI_CODING_AGENT|PI_BIN/)
  assert.doesNotMatch(source, /pi --mode rpc/)
  assert.doesNotMatch(source, /new PiAttachment|PiAttachment/)
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
