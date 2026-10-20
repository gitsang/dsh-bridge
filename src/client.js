/**
 * Browser half of dsh-bridge: a Pi Sessions panel.
 *
 * The panel does not reuse dsh's Conversation controller. Pi sessions have
 * their own message and event model, so this page renders Pi messages directly
 * and talks to the host bridge over same-origin, cookie-authenticated routes.
 */
window.__ModuleLoader__.load({
  id: '@gitsang/dsh-bridge',
  factory: (require) => {
    const React = require('react')
    const module = { exports: {} }
    const exports = module.exports
    const { useCallback, useEffect, useMemo, useRef, useState } = React
    const h = React.createElement

    const NS = 'piBridge'
    const PANEL_ID = 'pi-bridge'

    const zh = {
      panel: 'Pi 会话',
      title: 'Pi 会话',
      subtitle: '浏览 Pi Coding Agent 会话，附加到 Pi 进程并继续对话。',
      refresh: '刷新',
      loading: '正在加载 Pi 会话…',
      loadFailed: '无法加载 Pi 会话',
      empty: '还没有 Pi 会话',
      emptyHint: '先在终端运行一次 pi，或确认 PI_CODING_AGENT_SESSION_DIR 指向正确的目录。',
      search: '搜索会话',
      searchPlaceholder: '按名称、路径或首条消息搜索',
      noMatches: '没有匹配的会话',
      selectHint: '从左侧选择一个 Pi 会话',
      messages: '{count} 条消息',
      attach: '附加并继续',
      attaching: '正在附加…',
      detach: '断开',
      attached: '已附加',
      notAttached: '未附加',
      running: '运行中',
      idle: '空闲',
      send: '发送',
      sending: '发送中…',
      placeholder: '给这个 Pi 会话发送消息…',
      stop: '停止',
      stopped: '已停止',
      copy: '复制',
      copied: '已复制',
      refreshHistory: '刷新历史',
      sessionFile: '会话文件',
      cwd: '工作目录',
      model: '模型',
      thinking: '思考等级',
      attachFailed: '附加失败',
      promptFailed: '发送失败',
      abortFailed: '停止失败',
      detachFailed: '断开失败',
      historyLoadFailed: '无法加载会话历史',
      eventsDisconnected: '事件流已断开，正在重连…',
      eventsConnected: '事件流已连接',
      toolRunning: '运行中',
      toolDone: '完成',
      toolFailed: '失败',
      dialogConfirm: '确认',
      dialogCancel: '取消',
      dialogSubmit: '提交',
      dialogSelect: '请选择',
      dialogInput: '请输入',
      dialogEditor: '编辑内容',
      notification: 'Pi 通知',
      user: '用户',
      assistant: 'Pi',
      tool: '工具',
      system: '系统',
      expand: '展开',
      collapse: '收起',
      emptyMessage: '（空消息）',
      detachedNotice: '已断开 Pi 进程；会话文件保持不变。',
      attachNotice: '已附加到 Pi 进程。',
      noSessionKey: '会话缺少标识',
      cancelDialog: '取消',
    }

    const en = {
      panel: 'Pi Sessions',
      title: 'Pi Sessions',
      subtitle: 'Browse Pi Coding Agent sessions, attach to a Pi process, and continue the conversation.',
      refresh: 'Refresh',
      loading: 'Loading Pi sessions…',
      loadFailed: 'Could not load Pi sessions',
      empty: 'No Pi sessions yet',
      emptyHint: 'Run pi once in a terminal, or check that PI_CODING_AGENT_SESSION_DIR points at the right directory.',
      search: 'Search sessions',
      searchPlaceholder: 'Search by name, path, or first message',
      noMatches: 'No matching sessions',
      selectHint: 'Select a Pi session on the left',
      messages: '{count} messages',
      attach: 'Attach & continue',
      attaching: 'Attaching…',
      detach: 'Detach',
      attached: 'Attached',
      notAttached: 'Not attached',
      running: 'Running',
      idle: 'Idle',
      send: 'Send',
      sending: 'Sending…',
      placeholder: 'Message this Pi session…',
      stop: 'Stop',
      stopped: 'Stopped',
      copy: 'Copy',
      copied: 'Copied',
      refreshHistory: 'Refresh history',
      sessionFile: 'Session file',
      cwd: 'Working directory',
      model: 'Model',
      thinking: 'Thinking level',
      attachFailed: 'Attach failed',
      promptFailed: 'Send failed',
      abortFailed: 'Stop failed',
      detachFailed: 'Detach failed',
      historyLoadFailed: 'Could not load session history',
      eventsDisconnected: 'Event stream disconnected; reconnecting…',
      eventsConnected: 'Event stream connected',
      toolRunning: 'running',
      toolDone: 'done',
      toolFailed: 'failed',
      dialogConfirm: 'Confirm',
      dialogCancel: 'Cancel',
      dialogSubmit: 'Submit',
      dialogSelect: 'Select an option',
      dialogInput: 'Enter a value',
      dialogEditor: 'Edit text',
      notification: 'Pi notification',
      user: 'User',
      assistant: 'Pi',
      tool: 'Tool',
      system: 'System',
      expand: 'Expand',
      collapse: 'Collapse',
      emptyMessage: '(empty message)',
      detachedNotice: 'Detached from the Pi process; the session file is unchanged.',
      attachNotice: 'Attached to the Pi process.',
      noSessionKey: 'Session is missing its key',
      cancelDialog: 'Cancel',
    }

    const CSS_ID = '@gitsang/dsh-bridge/PiBridge.css'
    const CSS = [
      '.dshPi_page{box-sizing:border-box;display:grid;grid-template-columns:280px minmax(0,1fr);width:100%;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit}',
      '.dshPi_sidebar{box-sizing:border-box;display:flex;flex-direction:column;min-height:0;border-right:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-l1)}',
      '.dshPi_sidebarHead{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:16px 14px 10px}',
      '.dshPi_sidebarTitle{font-size:14px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshPi_iconButton{border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;border-radius:var(--dsw-radius-sm);width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;font:inherit;flex:none}',
      '.dshPi_iconButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshPi_iconButton:disabled{opacity:.45;cursor:default}',
      '.dshPi_searchWrap{padding:0 14px 8px}',
      '.dshPi_search{box-sizing:border-box;width:100%;padding:6px 9px;border-radius:var(--dsw-radius-sm);border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:inherit;font:inherit;font-size:12px}',
      '.dshPi_list{flex:1;min-height:0;overflow:auto;padding:0 8px 12px}',
      '.dshPi_row{box-sizing:border-box;display:block;width:100%;text-align:left;border:0;background:transparent;color:inherit;cursor:pointer;border-radius:var(--dsw-radius-md);padding:9px 10px;font:inherit;margin:1px 0}',
      '.dshPi_row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshPi_row[aria-current="true"]{background:var(--dsw-alias-interactive-bg-selected,var(--dsw-alias-interactive-bg-hover))}',
      '.dshPi_rowTitle{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:500;min-width:0}',
      '.dshPi_rowTitleText{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshPi_rowMeta{display:flex;gap:6px;margin-top:3px;color:var(--dsw-alias-label-tertiary);font-size:11px;min-width:0}',
      '.dshPi_rowPreview{margin-top:4px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}',
      '.dshPi_dot{display:inline-block;width:6px;height:6px;border-radius:999px;background:var(--dsw-alias-label-tertiary);flex:none}',
      '.dshPi_dot[data-running="true"]{background:var(--dsw-alias-state-business-primary,#2a7)}',
      '.dshPi_main{display:flex;flex-direction:column;min-width:0;min-height:0}',
      '.dshPi_head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:16px 22px 12px;border-bottom:.5px solid var(--dsw-alias-border-l2)}',
      '.dshPi_headText{min-width:0}',
      '.dshPi_headTitle{margin:0;font-size:16px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshPi_headSub{margin-top:3px;color:var(--dsw-alias-label-tertiary);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshPi_headActions{display:flex;align-items:center;gap:8px;flex:none}',
      '.dshPi_badge{display:inline-flex;align-items:center;gap:5px;padding:3px 8px;border-radius:999px;background:var(--dsw-alias-bg-l2);color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap}',
      '.dshPi_button{border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);cursor:pointer;border-radius:var(--dsw-radius-sm);padding:5px 11px;font:inherit;font-size:12px;line-height:18px;white-space:nowrap}',
      '.dshPi_button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshPi_button:disabled{opacity:.5;cursor:default}',
      '.dshPi_button[data-variant="primary"]{background:var(--dsw-alias-state-business-primary,#2563eb);border-color:transparent;color:#fff}',
      '.dshPi_button[data-variant="danger"]{color:var(--dsw-alias-state-error-primary,#d00);border-color:currentColor}',
      '.dshPi_notice{padding:7px 22px;font-size:12px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-l2);border-bottom:.5px solid var(--dsw-alias-border-l2)}',
      '.dshPi_notice[data-error="true"]{color:var(--dsw-alias-state-error-primary,#c00)}',
      '.dshPi_scroll{flex:1;min-height:0;overflow:auto;padding:18px 22px 26px}',
      '.dshPi_empty{max-width:520px;margin:12vh auto 0;text-align:center;color:var(--dsw-alias-label-tertiary)}',
      '.dshPi_emptyTitle{color:var(--dsw-alias-label-primary);font-size:16px;font-weight:600;margin-bottom:8px}',
      '.dshPi_emptyHint{font-size:12px;line-height:20px}',
      '.dshPi_msg{display:flex;flex-direction:column;gap:6px;margin-bottom:18px}',
      '.dshPi_msgHead{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-tertiary);font-size:11px}',
      '.dshPi_role{font-weight:600;color:var(--dsw-alias-label-secondary)}',
      '.dshPi_bubble{white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:21px;color:var(--dsw-alias-label-primary)}',
      '.dshPi_msg[data-role="user"] .dshPi_bubble{padding:9px 12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-l2)}',
      '.dshPi_msg[data-role="toolResult"] .dshPi_bubble{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);padding-left:10px;border-left:2px solid var(--dsw-alias-border-l2)}',
      '.dshPi_block{margin:2px 0}',
      '.dshPi_thinking{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:19px;white-space:pre-wrap;border-left:2px solid var(--dsw-alias-border-l2);padding-left:9px}',
      '.dshPi_toolCard{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-l1);padding:8px 10px;margin:4px 0}',
      '.dshPi_toolHead{display:flex;align-items:center;gap:8px;font-size:12px}',
      '.dshPi_toolName{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dshPi_toolStatus{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.dshPi_toolBody{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11px;line-height:17px;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary);margin-top:5px;max-height:320px;overflow:auto}',
      '.dshPi_streaming .dshPi_bubble:after{content:"▍";margin-left:1px;color:var(--dsw-alias-label-tertiary);animation:dshPiBlink 1s steps(1) infinite}',
      '@keyframes dshPiBlink{50%{opacity:0}}',
      '.dshPi_composer{border-top:.5px solid var(--dsw-alias-border-l2);padding:12px 18px 16px;background:var(--dsw-alias-bg-base)}',
      '.dshPi_composerBox{display:flex;align-items:flex-end;gap:8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-l1);padding:8px}',
      '.dshPi_textarea{flex:1;min-height:44px;max-height:200px;resize:vertical;border:0;outline:none;background:transparent;color:inherit;font:inherit;font-size:13px;line-height:20px;padding:3px 4px}',
      '.dshPi_composerFoot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:6px;color:var(--dsw-alias-label-tertiary);font-size:11px}',
      '.dshPi_dialogBackdrop{position:fixed;inset:0;z-index:1200;background:rgba(0,0,0,.32);display:flex;align-items:center;justify-content:center;padding:24px}',
      '.dshPi_dialog{width:min(520px,100%);box-sizing:border-box;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-base);box-shadow:var(--dsw-elevation-prominent);padding:18px}',
      '.dshPi_dialogTitle{font-size:14px;font-weight:600;margin-bottom:8px}',
      '.dshPi_dialogText{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;margin-bottom:12px}',
      '.dshPi_dialogInput{box-sizing:border-box;width:100%;min-height:38px;padding:7px 9px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-l1);color:inherit;font:inherit;font-size:13px}',
      '.dshPi_dialogActions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px;flex-wrap:wrap}',
      '.dshPi_toast{position:fixed;right:22px;bottom:22px;z-index:1300;max-width:360px;padding:9px 12px;border-radius:var(--dsw-radius-md);background:var(--dsw-specific-menu,var(--dsw-alias-bg-l2));box-shadow:var(--dsw-elevation-prominent);font-size:12px;line-height:18px}',
      '.dshPi_mono{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11px}',
      '@media (max-width:760px){.dshPi_page{grid-template-columns:1fr}.dshPi_sidebar{display:none}}',
    ].join('')

    function installStyles() {
      if (typeof document === 'undefined') return () => {}
      if (document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_ID) + ']') !== null) return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = '@gitsang/dsh-bridge'
      tag.dataset.pluginCss = CSS_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => tag.remove()
    }

    function apiUrl(path) {
      return `api/pi-bridge/${path}`
    }

    async function api(path, init) {
      const response = await fetch(apiUrl(path), {
        credentials: 'same-origin',
        ...init,
        headers: {
          ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(init?.headers ?? {}),
        },
      })
      const text = await response.text()
      let body
      try {
        body = text === '' ? {} : JSON.parse(text)
      } catch {
        body = { error: text }
      }
      if (!response.ok || body?.ok === false) {
        throw new Error(body?.error ?? `HTTP ${response.status}`)
      }
      return body
    }

    function shortPath(path) {
      if (typeof path !== 'string') return ''
      const home = typeof window !== 'undefined' ? window.__DSH_HOME__ : undefined
      if (typeof home === 'string' && home !== '' && path.startsWith(home)) return `~${path.slice(home.length)}`
      return path
    }

    function formatTime(value) {
      if (typeof value !== 'string' && typeof value !== 'number') return ''
      const time = new Date(value)
      if (Number.isNaN(time.getTime())) return ''
      return time.toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    }

    function textOf(content) {
      if (typeof content === 'string') return content
      if (!Array.isArray(content)) return ''
      return content
        .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('')
    }

    function imageBlocks(content) {
      if (!Array.isArray(content)) return []
      return content.filter((block) => block && block.type === 'image')
    }

    function ToolCard({ item, t }) {
      const [open, setOpen] = useState(false)
      const status = item.status === 'running' ? t('toolRunning') : item.status === 'error' ? t('toolFailed') : t('toolDone')
      return h(
        'div',
        { className: 'dshPi_toolCard' },
        h(
          'div',
          { className: 'dshPi_toolHead' },
          h('span', { className: 'dshPi_toolName' }, item.name ?? t('tool')),
          h('span', { className: 'dshPi_toolStatus' }, status),
          h(
            'button',
            {
              type: 'button',
              className: 'dshPi_iconButton',
              style: { marginLeft: 'auto', width: 22, height: 22 },
              title: open ? t('collapse') : t('expand'),
              'aria-label': open ? t('collapse') : t('expand'),
              onClick: () => setOpen(!open),
            },
            open ? '−' : '+',
          ),
        ),
        open && item.arguments !== undefined
          ? h('div', { className: 'dshPi_toolBody' }, safeJson(item.arguments))
          : null,
        open && item.output
          ? h('div', { className: 'dshPi_toolBody' }, item.output)
          : null,
      )
    }

    function safeJson(value) {
      const seen = new WeakSet()
      try {
        return JSON.stringify(value, (key, item) => {
          if (item !== null && typeof item === 'object') {
            if (seen.has(item)) return '[circular]'
            seen.add(item)
          }
          return item
        }, 2)
      } catch {
        return String(value)
      }
    }

    function renderContent(content, t, keyPrefix) {
      const nodes = []
      if (typeof content === 'string') {
        if (content !== '') nodes.push(h('div', { key: `${keyPrefix}-text`, className: 'dshPi_bubble' }, content))
        return nodes
      }
      if (!Array.isArray(content)) return nodes
      content.forEach((block, index) => {
        if (block === null || typeof block !== 'object') return
        const key = `${keyPrefix}-${index}`
        if (block.type === 'text') {
          nodes.push(h('div', { key, className: 'dshPi_block dshPi_bubble' }, block.text ?? ''))
        } else if (block.type === 'thinking') {
          nodes.push(h('div', { key, className: 'dshPi_block dshPi_thinking' }, block.thinking ?? ''))
        } else if (block.type === 'toolCall') {
          nodes.push(
            h(
              'div',
              { key, className: 'dshPi_toolCard' },
              h(
                'div',
                { className: 'dshPi_toolHead' },
                h('span', { className: 'dshPi_toolName' }, block.name ?? t('tool')),
                h('span', { className: 'dshPi_toolStatus' }, t('toolDone')),
              ),
              h('div', { className: 'dshPi_toolBody' }, safeJson(block.arguments)),
            ),
          )
        } else if (block.type === 'image') {
          const source = block.source ?? {}
          const src = typeof source.data === 'string' ? `data:${source.mediaType ?? 'image/png'};base64,${source.data}` : block.data
          if (typeof src === 'string') {
            nodes.push(h('img', { key, src, alt: '', style: { maxWidth: '100%', borderRadius: 8, marginTop: 4 } }))
          }
        }
      })
      return nodes
    }

    function MessageRow({ item, t }) {
      if (item.kind === 'tool') return h(ToolCard, { item, t })
      const message = item.message ?? item
      const role = message.role ?? 'unknown'
      const roleLabel = role === 'user' ? t('user') : role === 'assistant' ? t('assistant') : role === 'toolResult' ? t('tool') : role === 'custom' ? t('system') : role
      const blocks = renderContent(message.content, t, String(item.id ?? message.timestamp ?? Math.random()))
      return h(
        'div',
        { className: 'dshPi_msg', 'data-role': role, 'data-streaming': item.streaming === true ? 'true' : undefined },
        h(
          'div',
          { className: 'dshPi_msgHead' },
          h('span', { className: 'dshPi_role' }, roleLabel),
          message.toolName ? h('span', { className: 'dshPi_mono' }, message.toolName) : null,
          message.model ? h('span', null, message.model) : null,
        ),
        blocks.length > 0 ? blocks : h('div', { className: 'dshPi_bubble' }, t('emptyMessage')),
      )
    }

    function ExtensionDialog({ request, t, onRespond }) {
      const initial = request !== null && request.method === 'editor' ? request.prefill ?? '' : ''
      const [value, setValue] = useState(initial)
      useEffect(() => {
        setValue(request !== null && request.method === 'editor' ? request.prefill ?? '' : '')
      }, [request])
      if (request === null) return null
      const title = request.title ?? request.message ?? t('dialogConfirm')
      const cancel = () => onRespond({ cancelled: true })
      let body
      if (request.method === 'select') {
        body = h(
          'div',
          { className: 'dshPi_dialogActions', style: { justifyContent: 'flex-start' } },
          ...(Array.isArray(request.options) ? request.options : []).map((option) =>
            h('button', { key: option, type: 'button', className: 'dshPi_button', onClick: () => onRespond({ value: option }) }, option),
          ),
          h('button', { type: 'button', className: 'dshPi_button', onClick: cancel }, t('dialogCancel')),
        )
      } else if (request.method === 'input' || request.method === 'editor') {
        body = h(
          React.Fragment,
          null,
          h(
            request.method === 'editor' ? 'textarea' : 'input',
            {
              className: 'dshPi_dialogInput',
              style: request.method === 'editor' ? { minHeight: 140, resize: 'vertical', fontFamily: 'inherit' } : undefined,
              value,
              placeholder: request.placeholder,
              onChange: (event) => setValue(event.target.value),
              autoFocus: true,
            },
          ),
          h(
            'div',
            { className: 'dshPi_dialogActions' },
            h('button', { type: 'button', className: 'dshPi_button', onClick: cancel }, t('dialogCancel')),
            h('button', { type: 'button', className: 'dshPi_button', 'data-variant': 'primary', onClick: () => onRespond({ value }) }, t('dialogSubmit')),
          ),
        )
      } else {
        body = h(
          React.Fragment,
          null,
          request.message && request.message !== title ? h('div', { className: 'dshPi_dialogText' }, request.message) : null,
          h(
            'div',
            { className: 'dshPi_dialogActions' },
            h('button', { type: 'button', className: 'dshPi_button', onClick: cancel }, t('dialogCancel')),
            h('button', { type: 'button', className: 'dshPi_button', 'data-variant': 'primary', onClick: () => onRespond({ confirmed: true }) }, t('dialogConfirm')),
          ),
        )
      }
      return h(
        'div',
        { className: 'dshPi_dialogBackdrop', role: 'presentation' },
        h(
          'div',
          { className: 'dshPi_dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
          h('div', { className: 'dshPi_dialogTitle' }, title),
          typeof request.timeout === 'number'
            ? h('div', { className: 'dshPi_dialogText', style: { fontSize: 11 } }, `timeout ${Math.round(request.timeout / 1000)}s`)
            : null,
          body,
        ),
      )
    }

    function PiBridgeIcon({ size }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('path', {
          d: 'M7 7h10v10H7zM4 12h3M17 12h3M12 4v3M12 17v3',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    function PiBridgePage(props) {
      const { t } = props
      const [sessions, setSessions] = useState([])
      const [loading, setLoading] = useState(true)
      const [loadError, setLoadError] = useState(null)
      const [search, setSearch] = useState('')
      const [selectedKey, setSelectedKey] = useState(null)
      const [detail, setDetail] = useState(null)
      const [detailLoading, setDetailLoading] = useState(false)
      const [detailError, setDetailError] = useState(null)
      const [attached, setAttached] = useState(false)
      const [attaching, setAttaching] = useState(false)
      const [state, setState] = useState(null)
      const [transcript, setTranscript] = useState([])
      const [streamingMessage, setStreamingMessage] = useState(null)
      const [draft, setDraft] = useState('')
      const [sending, setSending] = useState(false)
      const [notice, setNotice] = useState(null)
      const [noticeError, setNoticeError] = useState(false)
      const [dialog, setDialog] = useState(null)
      const [streamState, setStreamState] = useState('idle')
      const sourceRef = useRef(null)
      const firstSnapshotRef = useRef(true)
      const lastSeqRef = useRef(0)
      const scrollRef = useRef(null)
      const selectedKeyRef = useRef(null)

      const showNotice = useCallback((text, error = false) => {
        setNotice(text)
        setNoticeError(error)
      }, [])

      useEffect(() => {
        if (notice === null) return undefined
        const timer = setTimeout(() => setNotice(null), 6000)
        return () => clearTimeout(timer)
      }, [notice])

      const loadSessions = useCallback(async () => {
        setLoading(true)
        setLoadError(null)
        try {
          const body = await api('sessions')
          setSessions(Array.isArray(body.sessions) ? body.sessions : [])
        } catch (error) {
          setLoadError(error instanceof Error ? error.message : String(error))
        } finally {
          setLoading(false)
        }
      }, [])

      useEffect(() => {
        loadSessions()
      }, [loadSessions])

      const historyItems = useCallback((session) => {
        const messages = Array.isArray(session?.messages) ? session.messages : []
        return messages.map((message, index) => ({ kind: 'message', id: `history-${index}-${message.timestamp ?? ''}`, message }))
      }, [])

      const openSession = useCallback(
        async (key) => {
          if (sourceRef.current !== null) {
            sourceRef.current.close()
            sourceRef.current = null
          }
          selectedKeyRef.current = key
          firstSnapshotRef.current = true
          lastSeqRef.current = 0
          setSelectedKey(key)
          setAttached(false)
          setState(null)
          setStreamingMessage(null)
          setDialog(null)
          setTranscript([])
          setDetail(null)
          setDetailError(null)
          setDetailLoading(true)
          try {
            const body = await api(`session?key=${encodeURIComponent(key)}`)
            if (selectedKeyRef.current !== key) return
            setDetail(body.session)
            setTranscript(historyItems(body.session))
          } catch (error) {
            if (selectedKeyRef.current !== key) return
            setDetailError(error instanceof Error ? error.message : String(error))
          } finally {
            if (selectedKeyRef.current === key) setDetailLoading(false)
          }
        },
        [historyItems],
      )

      const refreshHistory = useCallback(async () => {
        if (selectedKey === null) return
        try {
          const body = await api(`session?key=${encodeURIComponent(selectedKey)}`)
          setDetail(body.session)
          if (!attached) setTranscript(historyItems(body.session))
        } catch (error) {
          showNotice(error instanceof Error ? error.message : String(error), true)
        }
      }, [attached, historyItems, selectedKey, showNotice])

      const applyPiEvent = useCallback((record) => {
        const event = record?.type
        if (event === 'agent_start') {
          setState((current) => current === null ? current : { ...current, isStreaming: true })
        } else if (event === 'agent_settled') {
          setState((current) => current === null ? current : { ...current, isStreaming: false })
        } else if (event === 'message_start') {
          if (record.message?.role === 'assistant') setStreamingMessage({ ...record.message })
        } else if (event === 'message_update') {
          if (record.message?.role === 'assistant') setStreamingMessage({ ...record.message })
        } else if (event === 'message_end') {
          const message = record.message
          if (message === undefined) return
          if (message.role === 'assistant') setStreamingMessage(null)
          setTranscript((current) => [...current, { kind: 'message', id: `${message.role}-${message.timestamp ?? Date.now()}-${current.length}`, message }])
        } else if (event === 'tool_execution_start') {
          setTranscript((current) => [
            ...current,
            { kind: 'tool', id: record.toolCallId ?? `tool-${Date.now()}`, name: record.toolName, arguments: record.args ?? record.arguments, output: '', status: 'running' },
          ])
        } else if (event === 'tool_execution_update') {
          setTranscript((current) =>
            current.map((item) => item.kind === 'tool' && item.id === record.toolCallId ? { ...item, output: typeof record.delta === 'string' ? (item.output ?? '') + record.delta : safeJson(record) } : item),
          )
        } else if (event === 'tool_execution_end') {
          setTranscript((current) =>
            current.map((item) => item.kind === 'tool' && item.id === record.toolCallId ? { ...item, status: record.isError === true ? 'error' : 'done', output: typeof record.result === 'string' ? record.result : item.output } : item),
          )
        } else if (event === 'session_info_changed') {
          setState((current) => current === null ? current : { ...current, sessionName: record.name })
        } else if (event === 'agent_end') {
          setState((current) => current === null ? current : { ...current, isStreaming: false })
        }
      }, [])

      const connectEvents = useCallback(
        (key) => {
          if (sourceRef.current !== null) sourceRef.current.close()
          const source = new EventSource(apiUrl(`events?key=${encodeURIComponent(key)}`))
          sourceRef.current = source
          setStreamState('connecting')
          source.addEventListener('open', () => setStreamState('connected'))
          source.addEventListener('error', () => setStreamState('disconnected'))
          source.addEventListener('ping', () => setStreamState('connected'))
          source.addEventListener('snapshot', (message) => {
            setStreamState('connected')
            let payload
            try {
              payload = JSON.parse(message.data)
            } catch {
              return
            }
            if (payload?.running === false) setAttached(false)
            if (firstSnapshotRef.current) {
              firstSnapshotRef.current = false
              lastSeqRef.current = payload?.sequence ?? 0
              return
            }
            const recent = Array.isArray(payload?.recentEvents) ? payload.recentEvents : []
            for (const record of recent) {
              if (typeof record?.seq === 'number' && record.seq > lastSeqRef.current) {
                lastSeqRef.current = record.seq
                if (record.event === 'pi-event') applyPiEvent(record.data)
              }
            }
          })
          source.addEventListener('pi-event', (message) => {
            let payload
            try {
              payload = JSON.parse(message.data)
            } catch {
              return
            }
            applyPiEvent(payload)
          })
          source.addEventListener('pi-ui-request', (message) => {
            try {
              setDialog(JSON.parse(message.data))
            } catch {
              // Ignore malformed extension requests.
            }
          })
          source.addEventListener('pi-ui-notification', (message) => {
            try {
              const payload = JSON.parse(message.data)
              if (typeof payload?.message === 'string') showNotice(`${t('notification')}: ${payload.message}`, payload.notifyType === 'error')
            } catch {
              // Ignore malformed notifications.
            }
          })
          source.addEventListener('pi-exit', (message) => {
            setAttached(false)
            setStreamingMessage(null)
            try {
              const payload = JSON.parse(message.data)
              if (typeof payload?.stderr === 'string' && payload.stderr.trim() !== '') showNotice(payload.stderr.trim(), true)
            } catch {
              // Ignore malformed exit events.
            }
          })
        },
        [applyPiEvent, showNotice, t],
      )

      const attach = useCallback(async () => {
        if (selectedKey === null) return
        setAttaching(true)
        setNotice(null)
        try {
          const body = await api('attach', { method: 'POST', body: JSON.stringify({ key: selectedKey }) })
          setState(body.state ?? null)
          setAttached(true)
          setTranscript(historyItems(detail))
          firstSnapshotRef.current = true
          connectEvents(selectedKey)
          showNotice(t('attachNotice'))
        } catch (error) {
          showNotice(`${t('attachFailed')}: ${error instanceof Error ? error.message : String(error)}`, true)
        } finally {
          setAttaching(false)
        }
      }, [connectEvents, detail, historyItems, selectedKey, showNotice, t])

      const detach = useCallback(async () => {
        if (selectedKey === null) return
        try {
          await api('detach', { method: 'POST', body: JSON.stringify({ key: selectedKey }) })
          if (sourceRef.current !== null) {
            sourceRef.current.close()
            sourceRef.current = null
          }
          setAttached(false)
          setStreamingMessage(null)
          showNotice(t('detachedNotice'))
        } catch (error) {
          showNotice(`${t('detachFailed')}: ${error instanceof Error ? error.message : String(error)}`, true)
        }
      }, [selectedKey, showNotice, t])

      const send = useCallback(async () => {
        const message = draft.trim()
        if (message === '' || selectedKey === null || sending) return
        setSending(true)
        try {
          await api('prompt', { method: 'POST', body: JSON.stringify({ key: selectedKey, message, mode: 'auto' }) })
          setDraft('')
        } catch (error) {
          showNotice(`${t('promptFailed')}: ${error instanceof Error ? error.message : String(error)}`, true)
        } finally {
          setSending(false)
        }
      }, [draft, selectedKey, sending, showNotice, t])

      const abort = useCallback(async () => {
        if (selectedKey === null) return
        try {
          await api('abort', { method: 'POST', body: JSON.stringify({ key: selectedKey }) })
          showNotice(t('stopped'))
        } catch (error) {
          showNotice(`${t('abortFailed')}: ${error instanceof Error ? error.message : String(error)}`, true)
        }
      }, [selectedKey, showNotice, t])

      const respondDialog = useCallback(
        async (response) => {
          if (dialog === null || selectedKey === null) return
          const request = dialog
          setDialog(null)
          try {
            await api('ui-response', { method: 'POST', body: JSON.stringify({ key: selectedKey, id: request.id, response }) })
          } catch (error) {
            showNotice(error instanceof Error ? error.message : String(error), true)
          }
        },
        [dialog, selectedKey, showNotice],
      )

      useEffect(
        () => () => {
          if (sourceRef.current !== null) {
            sourceRef.current.close()
            sourceRef.current = null
          }
        },
        [],
      )

      useEffect(() => {
        const node = scrollRef.current
        if (node !== null) node.scrollTop = node.scrollHeight
      }, [transcript, streamingMessage])

      const filtered = useMemo(() => {
        const query = search.trim().toLowerCase()
        if (query === '') return sessions
        return sessions.filter((session) => {
          const haystack = [session.name, session.cwd, session.firstMessage, session.id].filter(Boolean).join('\n').toLowerCase()
          return haystack.includes(query)
        })
      }, [search, sessions])

      const isStreaming = state?.isStreaming === true || streamingMessage !== null
      const selectedSession = detail ?? sessions.find((session) => session.key === selectedKey)
      const title = selectedSession?.name ?? selectedSession?.firstMessage ?? t('title')

      return h(
        'section',
        { className: 'dshPi_page', 'aria-label': t('title') },
        h(
          'aside',
          { className: 'dshPi_sidebar', 'aria-label': t('panel') },
          h(
            'div',
            { className: 'dshPi_sidebarHead' },
            h('div', { className: 'dshPi_sidebarTitle' }, t('panel')),
            h(
              'button',
              { type: 'button', className: 'dshPi_iconButton', title: t('refresh'), 'aria-label': t('refresh'), onClick: loadSessions, disabled: loading },
              '↻',
            ),
          ),
          h(
            'div',
            { className: 'dshPi_searchWrap' },
            h('input', {
              className: 'dshPi_search',
              type: 'search',
              value: search,
              placeholder: t('searchPlaceholder'),
              'aria-label': t('search'),
              onChange: (event) => setSearch(event.target.value),
            }),
          ),
          h(
            'div',
            { className: 'dshPi_list' },
            loading
              ? h('div', { className: 'dshPi_rowMeta', style: { padding: '8px 10px' } }, t('loading'))
              : loadError !== null
                ? h('div', { className: 'dshPi_rowMeta', style: { padding: '8px 10px', color: 'var(--dsw-alias-state-error-primary,#c00)' } }, `${t('loadFailed')}: ${loadError}`)
                : filtered.length === 0
                  ? h('div', { className: 'dshPi_rowMeta', style: { padding: '8px 10px' } }, sessions.length === 0 ? t('empty') : t('noMatches'))
                  : filtered.map((session) =>
                      h(
                        'button',
                        {
                          key: session.key,
                          type: 'button',
                          className: 'dshPi_row',
                          'aria-current': session.key === selectedKey ? 'true' : undefined,
                          onClick: () => openSession(session.key),
                        },
                        h(
                          'div',
                          { className: 'dshPi_rowTitle' },
                          h('span', { className: 'dshPi_dot' }),
                          h('span', { className: 'dshPi_rowTitleText' }, session.name ?? session.firstMessage ?? session.id ?? t('panel')),
                        ),
                        h(
                          'div',
                          { className: 'dshPi_rowMeta' },
                          h('span', null, t('messages', { count: session.messageCount ?? 0 })),
                          session.modified ? h('span', null, formatTime(session.modified)) : null,
                        ),
                        session.firstMessage ? h('div', { className: 'dshPi_rowPreview' }, session.firstMessage) : null,
                      ),
                    ),
          ),
        ),
        h(
          'div',
          { className: 'dshPi_main' },
          h(
            'header',
            { className: 'dshPi_head' },
            h(
              'div',
              { className: 'dshPi_headText' },
              h('h1', { className: 'dshPi_headTitle' }, selectedKey === null ? t('title') : title),
              h(
                'div',
                { className: 'dshPi_headSub' },
                selectedKey === null
                  ? t('subtitle')
                  : [selectedSession?.cwd ? shortPath(selectedSession.cwd) : null, selectedSession?.modified ? formatTime(selectedSession.modified) : null].filter(Boolean).join(' · '),
              ),
            ),
            selectedKey === null
              ? null
              : h(
                  'div',
                  { className: 'dshPi_headActions' },
                  h(
                    'span',
                    { className: 'dshPi_badge' },
                    h('span', { className: 'dshPi_dot', 'data-running': isStreaming ? 'true' : undefined }),
                    attached ? (isStreaming ? t('running') : t('idle')) : t('notAttached'),
                  ),
                  attached
                    ? h(
                        React.Fragment,
                        null,
                        h('button', { type: 'button', className: 'dshPi_button', onClick: refreshHistory }, t('refreshHistory')),
                        h('button', { type: 'button', className: 'dshPi_button', 'data-variant': 'danger', onClick: detach }, t('detach')),
                      )
                    : h(
                        'button',
                        { type: 'button', className: 'dshPi_button', 'data-variant': 'primary', onClick: attach, disabled: attaching || detailLoading || detail === null },
                        attaching ? t('attaching') : t('attach'),
                      ),
                ),
          ),
          notice !== null ? h('div', { className: 'dshPi_notice', 'data-error': noticeError ? 'true' : undefined }, notice) : null,
          streamState === 'disconnected' ? h('div', { className: 'dshPi_notice' }, t('eventsDisconnected')) : null,
          h(
            'div',
            { className: 'dshPi_scroll', ref: scrollRef },
            selectedKey === null
              ? h(
                  'div',
                  { className: 'dshPi_empty' },
                  h('div', { className: 'dshPi_emptyTitle' }, sessions.length === 0 ? t('empty') : t('selectHint')),
                  h('div', { className: 'dshPi_emptyHint' }, t('emptyHint')),
                )
              : detailLoading
                ? h('div', { className: 'dshPi_empty' }, t('loading'))
                : detailError !== null
                  ? h('div', { className: 'dshPi_empty' }, `${t('historyLoadFailed')}: ${detailError}`)
                  : h(
                      React.Fragment,
                      null,
                      ...transcript.map((item) => h(MessageRow, { key: item.id, item, t })),
                      streamingMessage !== null
                        ? h(
                            'div',
                            { className: 'dshPi_msg dshPi_streaming', 'data-role': 'assistant' },
                            h('div', { className: 'dshPi_msgHead' }, h('span', { className: 'dshPi_role' }, t('assistant')), h('span', null, streamingMessage.model ?? '')),
                            renderContent(streamingMessage.content, t, 'streaming'),
                          )
                        : null,
                      transcript.length === 0 && streamingMessage === null ? h('div', { className: 'dshPi_emptyHint' }, t('emptyMessage')) : null,
                    ),
          ),
          attached
            ? h(
                'div',
                { className: 'dshPi_composer' },
                h(
                  'div',
                  { className: 'dshPi_composerBox' },
                  h('textarea', {
                    className: 'dshPi_textarea',
                    value: draft,
                    placeholder: t('placeholder'),
                    'aria-label': t('placeholder'),
                    onChange: (event) => setDraft(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                        event.preventDefault()
                        send()
                      }
                    },
                  }),
                  isStreaming
                    ? h('button', { type: 'button', className: 'dshPi_button', 'data-variant': 'danger', onClick: abort }, t('stop'))
                    : h('button', { type: 'button', className: 'dshPi_button', 'data-variant': 'primary', onClick: send, disabled: sending || draft.trim() === '' }, sending ? t('sending') : t('send')),
                ),
                h(
                  'div',
                  { className: 'dshPi_composerFoot' },
                  h('span', null, isStreaming ? t('running') : t('idle')),
                  state?.model ? h('span', null, `${t('model')}: ${state.model.id ?? ''}`) : null,
                  state?.thinkingLevel ? h('span', null, `${t('thinking')}: ${state.thinkingLevel}`) : null,
                ),
              )
            : null,
        ),
        h(ExtensionDialog, { request: dialog, t, onRespond: respondDialog }),
      )
    }

    function apply(ctx) {
      ctx.effect(installStyles, 'pi-bridge: styles')
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'pi-bridge: dictionaries')
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, PiBridgePage))
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 20,
            locale: NS,
            label: () => ctx.locale.bind(NS)('panel'),
          },
          PiBridgeIcon,
        ),
      )
    }

    exports.apply = apply
    exports.inject = ['slots', 'locale']
    exports.__test = { textOf, shortPath, formatTime, safeJson }
    return module.exports
  },
})
