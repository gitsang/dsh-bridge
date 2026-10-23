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
  assert.equal(dictionaries[0].zh.groupByWorkspaceTree, '按工作区树')
  assert.equal(dictionaries[0].zh.groupByFlat, '单列表')
  assert.equal(dictionaries[0].zh.orderByManual, '手动排序')
  assert.equal(dictionaries[0].zh.orderByUpdated, '最近更新')
  assert.equal(dictionaries[0].zh.filterBy, '筛选会话')
  assert.equal(dictionaries[0].zh.folderNew, '新建文件夹')
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

test('workspace helpers mirror dsh labels, tree parents, and ordering', () => {
  const exports = moduleExports()
  const {
    workspaceLabel,
    owningParentFolder,
    compareSessionsByUpdated,
    reconcileSessionOrder,
    pathCrumbs,
  } = exports.__test

  assert.equal(workspaceLabel('/home/sang/src/dsh-bridge/'), 'dsh-bridge')
  assert.equal(workspaceLabel('C:\\work\\dsh-bridge'), 'dsh-bridge')
  assert.equal(owningParentFolder('/work/app/packages/ui', ['/work', '/work/app']), '/work/app')
  assert.equal(owningParentFolder('/work', ['/work']), undefined)

  const sessions = [
    { key: 'old', modified: '2026-10-20T00:00:00.000Z' },
    { key: 'new', modified: '2026-10-21T00:00:00.000Z' },
    { key: 'middle', modified: '2026-10-20T12:00:00.000Z' },
  ]
  assert.deepEqual(sessions.slice().sort(compareSessionsByUpdated).map((session) => session.key), ['new', 'middle', 'old'])
  assert.deepEqual(reconcileSessionOrder(sessions, ['old', 'missing'], new Map()), ['old', 'new', 'middle'])

  assert.deepEqual(pathCrumbs('/home/sang/src/dsh-bridge', '/home/sang', 'Home').map((crumb) => crumb.name), ['Home', 'src', 'dsh-bridge'])
  assert.deepEqual(pathCrumbs('/tmp/work', '/home/sang', 'Home').map((crumb) => crumb.name), ['/', 'tmp', 'work'])
})

test('relative time uses dsh-style compact labels', () => {
  const exports = moduleExports()
  const labels = {
    timeNow: 'now',
    timeAgo: '{t} ago',
    timeMinutes: '{n}min',
    timeHours: '{n}h',
    timeDays: '{n}d',
    timeMonths: '{n}mo',
    timeYears: '{n}y',
  }
  const t = (key) => labels[key]
  const now = Date.parse('2026-10-21T12:00:00.000Z')
  assert.equal(exports.__test.relativeTime('2026-10-21T11:59:30.000Z', now, t), 'now')
  assert.equal(exports.__test.relativeTime('2026-10-21T11:30:00.000Z', now, t), '30min ago')
  assert.equal(exports.__test.relativeTime('2026-10-20T12:00:00.000Z', now, t), '1d ago')
  assert.equal(exports.__test.relativeTime('invalid', now, t), '')
})

test('statusline helpers normalize Pi statistics and stay projection-free', () => {
  const exports = moduleExports()
  const {
    compactTokens,
    exactTokens,
    normalizeBridgeStats,
    deriveBridgeStats,
    bridgeCacheHitPercent,
    statsVisible,
  } = exports.__test

  assert.equal(compactTokens(517), '517')
  assert.equal(compactTokens(12_250), '12.3K')
  assert.equal(compactTokens(1_250_000), '1.3M')
  assert.equal(exactTokens(1234567), '1,234,567')

  const stats = normalizeBridgeStats({
    userMessages: 3,
    assistantMessages: 5,
    toolCalls: 2,
    totalMessages: 10,
    tokens: { input: 100, output: 40, cacheRead: 300, cacheWrite: 0, total: 440 },
    contextUsage: { tokens: 23_000, contextWindow: 1_000_000, percent: 2.3 },
  })
  assert.deepEqual(stats, {
    turns: 3,
    steps: 5,
    toolCalls: 2,
    totalMessages: 10,
    tokens: { uncachedInput: 100, cacheRead: 300, cacheWrite: 0, output: 40, total: 440 },
    context: { used: 23_000, window: 1_000_000, percent: 2.3 },
  })
  assert.equal(bridgeCacheHitPercent(stats.tokens), '75')
  assert.equal(statsVisible(stats), true)
  assert.equal(statsVisible(normalizeBridgeStats(null)), false)

  const derived = deriveBridgeStats([
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'toolCall', id: 't1' }], usage: { input: 10, output: 3, cacheRead: 20, cacheWrite: 0 } },
  ])
  assert.equal(derived.turns, 1)
  assert.equal(derived.steps, 1)
  assert.equal(derived.toolCalls, 1)
  assert.equal(derived.tokens.total, 33)
  assert.equal(derived.context, null)
})

test('model catalog helpers keep provider and id pairs stable', () => {
  const exports = moduleExports()
  const { normalizeModelCatalog, modelIdOf } = exports.__test
  const models = normalizeModelCatalog({
    models: [
      { id: 'alpha', provider: 'p', name: 'Alpha', reasoning: true },
      { model: 'beta', provider: 'q' },
      { id: '', provider: 'p' },
    ],
  })
  assert.equal(models.length, 2)
  assert.deepEqual(models[0], { id: 'alpha', provider: 'p', name: 'Alpha', contextWindow: 0, reasoning: true })
  assert.equal(modelIdOf(models[1]), 'q/beta')
})

test('browser bundle wires the model seat and statusline into the composer', async () => {
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
  assert.match(source, /BridgeModelSelect/)
  assert.match(source, /BridgeStatusline/)
  assert.match(source, /data-composer-stats/)
  assert.match(source, /models\?key=/)
  assert.match(source, /stats\?key=/)
  assert.match(source, /dshBridge_contextRing/)
})

test('Bridge settings modal overrides the primitive dialog width', async () => {
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
  assert.match(source, /className: 'dshBridge_settingsModal'/)
  assert.match(source, /\.dshBridge_settingsModal\.dshBridge_settingsModal\{width:min\(880px,100%\)\}/)
  assert.match(source, /\.dshBridge_settingsShell\{[^}]*width:100%;max-width:100%/)
})

test('Bridge menu puts the status dot where the menu check sits', async () => {
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
  const menu = source.slice(source.indexOf('const toggleOpen = () => {'), source.indexOf('if (bridges.length === 0'))
  assert.doesNotMatch(menu, /engineLabel|modeCli|modeWeb/)
  assert.match(source, /\.dshBridge_statusDotSlot\{[^}]*width:14px;height:14px/)
  assert.match(source, /\.dshBridge_statusDot\{[^}]*width:7px;height:7px/)
  assert.match(source, /\[role="menuitem"\]:has\(\.dshBridge_statusDotSlot\) > svg\{display:none\}/)
})
