/** Gateway shell: one persistent iframe per bridge Host. */
export function renderShell({ version }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>dsh bridge</title>
<style>
:root{color-scheme:dark;--bg:#0e1014;--side:#15181e;--line:#272b33;--text:#e7e9ee;--muted:#9299a6;--accent:#4f7cff;--ok:#34c98b;--bad:#ef5c6c;--warn:#e7a54a}
*{box-sizing:border-box}html,body{height:100%}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,sans-serif}
#app{display:flex;height:100vh;min-width:0}.sidebar{width:260px;flex:none;display:flex;flex-direction:column;background:var(--side);border-right:1px solid var(--line)}
.brand{padding:18px 16px 14px;font-size:13px;font-weight:650;letter-spacing:.02em}.brand span{color:var(--muted);font-weight:400}
.list{flex:1;overflow:auto;padding:4px 8px}.row{display:flex;align-items:center;gap:9px;width:100%;padding:8px 9px;border:0;border-radius:8px;background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer}
.row:hover{background:#1d212a}.row[data-active=true]{background:#222838}.dot{width:7px;height:7px;flex:none;border-radius:50%;background:var(--muted)}.dot[data-status=ready]{background:var(--ok)}.dot[data-status=starting]{background:var(--warn)}.dot[data-status=failed]{background:var(--bad)}
.meta{display:flex;flex-direction:column;min-width:0}.name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sub{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font-size:12px}
.footer{padding:10px;border-top:1px solid var(--line)}.footer button+button{margin-top:6px}.footer button,.form button{width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:#1d222b;color:inherit;font:inherit;cursor:pointer}.footer button:hover,.form button:hover{background:#252b36}
.main{flex:1;min-width:0;position:relative;background:#0b0d11}.empty{height:100%;display:grid;place-items:center;color:var(--muted);text-align:center;padding:24px}
iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:#0b0d11;display:none}iframe[data-active=true]{display:block}
.panel{position:absolute;z-index:5;right:16px;top:16px;width:min(420px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;padding:18px;border:1px solid var(--line);border-radius:14px;background:#171b22;box-shadow:0 20px 70px #000a}
.panel[hidden]{display:none}.panel h2{margin:0 0 12px;font-size:16px}.form{display:grid;gap:10px}.field{display:grid;gap:5px}.field label{color:var(--muted);font-size:12px}.field input,.field select{padding:8px 10px;border:1px solid var(--line);border-radius:7px;background:#0f1217;color:inherit;font:inherit}
.managed{display:grid;gap:6px;margin-bottom:10px}.managed-row{display:flex;align-items:center;gap:8px;padding:8px 9px;border:1px solid var(--line);border-radius:8px}.managed-row .meta{flex:1}.managed-row button{width:auto;padding:5px 8px;border:1px solid var(--line);border-radius:6px;background:#1d222b;color:inherit;font:inherit;cursor:pointer}.actions{display:flex;gap:8px}.actions button{flex:1}.error{color:#ffb4bf;font-size:12px}.hint{color:var(--muted);font-size:12px;word-break:break-all}
</style></head><body>
<div id="app">
  <aside class="sidebar">
    <div class="brand">dsh bridge <span>· v${version}</span></div>
    <div class="list" id="list"></div>
    <div class="footer"><button type="button" id="manage">Manage bridges</button><button type="button" id="logout" hidden>Sign out</button></div>
  </aside>
  <main class="main" id="main"><div class="empty" id="empty">Select a bridge.</div></main>
</div>
<section class="panel" id="panel" hidden>
  <h2>Manage bridges</h2>
  <div class="managed" id="managed"></div>
  <button type="button" id="add">Add bridge</button>
  <h2 id="form-title" hidden>Add bridge</h2>
  <form class="form" id="form" hidden>
    <input type="hidden" name="editing" value="">
    <div class="field"><label for="id">ID</label><input id="id" name="id" required pattern="[a-z0-9][a-z0-9-]*" placeholder="pi"></div>
    <div class="field"><label for="name">Name</label><input id="name" name="name" required placeholder="Work Pi"></div>
    <div class="field"><label for="engine">Engine</label><select id="engine" name="engine"><option>native</option><option>dsh</option><option>pi</option><option>codex</option><option>opencode</option></select></div>
    <div class="field"><label for="url">Upstream URL</label><input id="url" name="url" placeholder="http://127.0.0.1:3090/?token=..."></div>
    <div class="field"><label for="command">Or command to spawn</label><input id="command" name="command" placeholder="dsh web --profile pi"></div>
    <div class="field"><label for="args">Arguments (space separated)</label><input id="args" name="args" placeholder="--port 3090"></div>
    <label><input type="checkbox" name="autostart" checked> Start automatically</label>
    <div class="error" id="form-error"></div>
    <div class="actions"><button type="submit">Save</button><button type="button" id="cancel">Cancel</button></div>
  </form>
</section>
<script>
const $ = (id) => document.getElementById(id)
let state = { bridges: [] }
let active = null
const frames = new Map()
let editor = null

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) }
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  if (options.method && options.method !== 'GET') headers['x-bridge-gateway'] = '1'
  const response = await fetch(path, { ...options, headers, cache: 'no-store' })
  if (response.status === 401) {
    location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search + location.hash)
    throw new Error('sign in required')
  }
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error || ('HTTP ' + response.status))
  return body
}

function mountId() {
  const match = /^#\\/b\\/([a-z0-9][a-z0-9-]*)$/.exec(location.hash)
  return match ? match[1] : null
}

function ensureFrame(bridge) {
  let frame = frames.get(bridge.id)
  if (frame) return frame
  frame = document.createElement('iframe')
  frame.dataset.bridge = bridge.id
  frame.dataset.active = 'false'
  frame.src = bridge.mount
  frame.title = bridge.name
  $('main').appendChild(frame)
  frames.set(bridge.id, frame)
  return frame
}

function select(id, updateHash = true) {
  const bridge = state.bridges.find((entry) => entry.id === id)
  if (!bridge) return
  active = id
  for (const [frameId, frame] of frames) frame.dataset.active = String(frameId === id && bridge.status === 'ready')
  if (bridge.status !== 'ready' || bridge.compat === 'incompatible') {
    $('empty').style.display = ''
    $('empty').textContent = bridge.name + ' is ' + bridge.status + (bridge.error ? ': ' + bridge.error : '')
    renderList()
    return
  }
  let frame = ensureFrame(bridge)
  frame.dataset.active = 'true'
  $('empty').style.display = 'none'
  if (updateHash && location.hash !== '#/b/' + id) history.replaceState(null, '', '#/b/' + id)
  renderList()
}

function renderList() {
  const list = $('list')
  list.textContent = ''
  for (const bridge of state.bridges) {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'row'
    row.dataset.active = String(bridge.id === active)
    row.onclick = () => select(bridge.id)
    const dot = document.createElement('span')
    dot.className = 'dot'
    dot.dataset.status = bridge.status
    const meta = document.createElement('span')
    meta.className = 'meta'
    const name = document.createElement('span')
    name.className = 'name'
    name.textContent = bridge.name
    const sub = document.createElement('span')
    sub.className = 'sub'
    sub.textContent = bridge.engine + ' · ' + bridge.status
    if (bridge.error) sub.title = bridge.error
    meta.append(name, sub)
    row.append(dot, meta)
    list.appendChild(row)
  }
  if (state.bridges.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'hint'
    empty.textContent = 'No bridges configured.'
    list.appendChild(empty)
  }
}

function showForm(bridge) {
  editor = bridge ? bridge.id : null
  $('form-title').textContent = bridge ? 'Edit bridge' : 'Add bridge'
  $('form-error').textContent = ''
  $('form').reset()
  $('form').elements.editing.value = editor || ''
  $('id').disabled = Boolean(bridge)
  if (bridge) {
    $('id').value = bridge.id
    $('name').value = bridge.name
    $('engine').value = bridge.engine
    $('autostart').checked = bridge.autostart
    const upstream = bridge.upstream || {}
    $('url').value = upstream.url || ''
    $('command').value = upstream.command || ''
    $('args').value = (upstream.args || []).join(' ')
  }
  $('panel').hidden = false
  $('form').hidden = false
  $('form-title').hidden = false
  renderManaged()
}

function payload() {
  const form = $('form').elements
  const url = form.url.value.trim()
  const command = form.command.value.trim()
  const upstream = url
    ? { url }
    : command
      ? { command, args: form.args.value.trim() === '' ? [] : form.args.value.trim().split(/\\s+/) }
      : { self: true }
  return {
    id: editor || form.id.value.trim(),
    name: form.name.value.trim(),
    engine: form.engine.value,
    autostart: form.autostart.checked,
    upstream,
  }
}

async function refresh() {
  const next = await request('/__bridge/state')
  $('logout').hidden = next.auth !== true
  const previous = new Map(state.bridges.map((bridge) => [bridge.id, bridge.status]))
  state = next
  for (const bridge of state.bridges) {
    if ((previous.get(bridge.id) !== bridge.status && bridge.status !== 'ready') || bridge.compat === 'incompatible') {
      frames.get(bridge.id)?.remove()
      frames.delete(bridge.id)
    }
  }
  renderList()
  if (active !== null && state.bridges.some((bridge) => bridge.id === active && bridge.status === 'ready')) {
    select(active, false)
  }
  if (active === null) {
    const restored = mountId()
    if (restored && state.bridges.some((bridge) => bridge.id === restored)) select(restored, false)
  }
}

function renderManaged() {
  const box = $('managed')
  box.textContent = ''
  for (const bridge of state.bridges) {
    const row = document.createElement('div')
    row.className = 'managed-row'
    const dot = document.createElement('span')
    dot.className = 'dot'
    dot.dataset.status = bridge.status
    const meta = document.createElement('span')
    meta.className = 'meta'
    const name = document.createElement('span')
    name.className = 'name'
    name.textContent = bridge.name
    const sub = document.createElement('span')
    sub.className = 'sub'
    sub.textContent = bridge.id + ' · ' + bridge.engine + ' · ' + bridge.status
    meta.append(name, sub)
    row.append(dot, meta)
    for (const [label, action] of [
      ['Edit', () => showForm(bridge)],
      ['Restart', () => mutate('/__bridge/bridges/' + bridge.id + '/restart', { method: 'POST' })],
      ...(bridge.id === 'native' ? [] : [['Delete', () => { if (confirm('Delete ' + bridge.name + '?')) mutate('/__bridge/bridges/' + bridge.id, { method: 'DELETE' }) }]])
    ]) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = label
      button.onclick = action
      row.appendChild(button)
    }
    box.appendChild(row)
  }
}

async function mutate(path, options) {
  try {
    await request(path, options)
    await refresh()
    $('panel').hidden = true
  } catch (error) {
    $('form-error').textContent = error.message
  }
}

$('manage').onclick = () => {
  renderManaged()
  $('panel').hidden = !$('panel').hidden
  $('form').hidden = true
  $('form-title').hidden = true
}
$('add').onclick = () => showForm(null)
$('cancel').onclick = () => {
  $('form').hidden = true
  $('form-title').hidden = true
  renderManaged()
}
$('form').onsubmit = async (event) => {
  event.preventDefault()
  try {
    const body = payload()
    if (editor) await request('/__bridge/bridges/' + encodeURIComponent(editor), { method: 'PUT', body: JSON.stringify(body) })
    else await request('/__bridge/bridges', { method: 'POST', body: JSON.stringify(body) })
    $('panel').hidden = true
    $('form').hidden = true
    $('form-title').hidden = true
    await refresh()
  } catch (error) {
    $('form-error').textContent = error.message
  }
}
$('logout').onclick = () => { location.href = '/logout' }
window.addEventListener('hashchange', () => { const id = mountId(); if (id) select(id, false) })
refresh().catch((error) => {
  $('empty').textContent = error.message
})
setInterval(() => { refresh().catch(() => {}) }, 2000)
</script></body></html>`
}
