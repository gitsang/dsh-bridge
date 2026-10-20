/**
 * Browser half of dsh-bridge: the Bridge panel.
 *
 * The panel deliberately borrows dsh's own visual vocabulary instead of
 * inventing one: content column width, typography, Markdown rendering, card
 * elevation, and controls all come from `dsh-client-ui-primitives` and the
 * `--dsw-*` tokens the shipped Web shell paints, so the page reads as part of
 * the same product.
 *
 * It does not reuse dsh's Conversation controller. Pi sessions carry their own
 * event and message model; the Host bridge translates them, and this component
 * renders the translated stream with dsh's presentational primitives.
 */
window.__ModuleLoader__.load({
  id: '@gitsang/dsh-bridge',
  factory: (require) => {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const module = { exports: {} }
    const exports = module.exports
    const { useCallback, useEffect, useMemo, useRef, useState } = React
    const h = React.createElement

    const {
      Button,
      DisclosureRow,
      IconApiOutlineRegular,
      IconChevronDownOutlineRegular,
      IconCodeOutlineRegular,
      IconPauseOutlineRegular,
      IconRefreshOutlineRegular,
      IconSendOutlineRegular,
      IconSettingsOutlineRegular,
      MarkdownText,
      Menu,
      Modal,
      TextShimmer,
      Tooltip,
      writeClipboard,
    } = primitives

    const NS = 'bridge'
    const PANEL_ID = 'bridge'
    const SETTINGS_ANCHOR_ID = 'bridge.settings'

    const zh = {
      panel: 'Bridge',
      title: 'Bridge',
      subtitle: '把外部 agent 会话接进 dsh。',
      settings: '桥接设置',
      settingsTitle: '桥接设置',
      settingsClose: '关闭',
      settingsSave: '保存',
      settingsSaving: '保存中…',
      settingsSaved: '已保存',
      settingsFailed: '保存失败',
      backend: '后端',
      backendHint: '选择 Bridge 面板当前连接的后端。',
      backendPi: 'Pi Coding Agent',
      backendPiHint: '通过 `pi --mode rpc` 附加到 Pi 会话。',
      backendOnlyOne: '目前仅支持 Pi 后端。',
      sessionsRoot: '会话根目录',
      sessionsRootHint: '留空则使用 PI_CODING_AGENT_SESSION_DIR 或 ~/.pi/agent/sessions。',
      binary: 'Pi 可执行文件',
      binaryHint: '留空则自动探测（优先 $PI_CODING_AGENT_DIR/bin/pi）。',
      offline: '离线启动',
      offlineHint: '附加时以 PI_OFFLINE=1 启动，避免安装包或写入 agent 目录。',
      detachFirst: '请先断开所有已附加的会话，再修改后端或会话根目录。',
      refresh: '刷新',
      loading: '正在加载…',
      loadFailed: '无法加载会话',
      empty: '还没有会话',
      emptyHint: '先在终端运行一次 pi，或在桥接设置里指定正确的会话根目录。',
      search: '搜索会话',
      searchPlaceholder: '搜索名称、路径或首条消息',
      noMatches: '没有匹配的会话',
      selectHint: '从左侧选择一个会话',
      attach: '附加并继续',
      attaching: '正在附加…',
      detach: '断开',
      attached: '已连接',
      notAttached: '未连接',
      running: '运行中',
      idle: '空闲',
      send: '发送',
      placeholder: '给这个会话发送消息…',
      stop: '停止',
      stopped: '已停止',
      copy: '复制',
      copied: '已复制',
      attachFailed: '附加失败',
      promptFailed: '发送失败',
      abortFailed: '停止失败',
      detachFailed: '断开失败',
      historyLoadFailed: '无法加载会话历史',
      eventsDisconnected: '事件流已断开，正在重连…',
      dialogCancel: '取消',
      dialogSubmit: '提交',
      dialogConfirm: '确认',
      toolRunning: '运行中',
      toolDone: '完成',
      toolFailed: '失败',
      toolArguments: '参数',
      toolResult: '结果',
      emptyMessage: '（空消息）',
      attachNotice: '已附加到 Pi 进程。',
      detachedNotice: '已断开；会话文件保持不变。',
      turnCompleted: '已完成',
      thinking: '思考',
      metrics: '{size} · {time}',
      notification: 'Bridge 通知',
      userRole: '我',
      assistantRole: 'Agent',
      noBackend: 'Bridge 尚未配置后端。',
    }

    const en = {
      panel: 'Bridge',
      title: 'Bridge',
      subtitle: 'Bring external agent sessions into dsh.',
      settings: 'Bridge settings',
      settingsTitle: 'Bridge settings',
      settingsClose: 'Close',
      settingsSave: 'Save',
      settingsSaving: 'Saving…',
      settingsSaved: 'Saved',
      settingsFailed: 'Could not save',
      backend: 'Backend',
      backendHint: 'Choose which backend the Bridge panel talks to.',
      backendPi: 'Pi Coding Agent',
      backendPiHint: 'Attach to Pi sessions through `pi --mode rpc`.',
      backendOnlyOne: 'Only the Pi backend is available for now.',
      sessionsRoot: 'Sessions root',
      sessionsRootHint: 'Leave empty to use PI_CODING_AGENT_SESSION_DIR or ~/.pi/agent/sessions.',
      binary: 'Pi executable',
      binaryHint: 'Leave empty for auto-detection ($PI_CODING_AGENT_DIR/bin/pi first).',
      offline: 'Offline startup',
      offlineHint: 'Start attached Pi with PI_OFFLINE=1 so it never installs packages or writes the agent directory.',
      detachFirst: 'Detach every attached session before changing the backend or sessions root.',
      refresh: 'Refresh',
      loading: 'Loading…',
      loadFailed: 'Could not load sessions',
      empty: 'No sessions yet',
      emptyHint: 'Run pi once in a terminal, or point the sessions root at the right directory in Bridge settings.',
      search: 'Search sessions',
      searchPlaceholder: 'Search name, path, or first message',
      noMatches: 'No matching sessions',
      selectHint: 'Select a session on the left',
      attach: 'Attach & continue',
      attaching: 'Attaching…',
      detach: 'Detach',
      attached: 'Connected',
      notAttached: 'Not connected',
      running: 'Running',
      idle: 'Idle',
      send: 'Send',
      placeholder: 'Message this session…',
      stop: 'Stop',
      stopped: 'Stopped',
      copy: 'Copy',
      copied: 'Copied',
      attachFailed: 'Attach failed',
      promptFailed: 'Send failed',
      abortFailed: 'Stop failed',
      detachFailed: 'Detach failed',
      historyLoadFailed: 'Could not load session history',
      eventsDisconnected: 'Event stream disconnected; reconnecting…',
      dialogCancel: 'Cancel',
      dialogSubmit: 'Submit',
      dialogConfirm: 'Confirm',
      toolRunning: 'running',
      toolDone: 'done',
      toolFailed: 'failed',
      toolArguments: 'Arguments',
      toolResult: 'Result',
      emptyMessage: '(empty message)',
      attachNotice: 'Attached to the Pi process.',
      detachedNotice: 'Detached; the session file is unchanged.',
      turnCompleted: 'Completed',
      thinking: 'Thinking',
      metrics: '{size} · {time}',
      notification: 'Bridge notification',
      userRole: 'You',
      assistantRole: 'Agent',
      noBackend: 'The Bridge has no backend configured yet.',
    }

    const CSS_ID = '@gitsang/dsh-bridge/Bridge.css'
    const CSS = [
      /* Page frame: the same centred column dsh uses for a conversation. */
      '.dshBridge_page{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,currentColor)}',
      '.dshBridge_head{display:flex;align-items:center;gap:10px;padding:10px 20px;min-height:44px;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08))}',
      '.dshBridge_headTitle{display:flex;align-items:center;gap:8px;min-width:0;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,currentColor)}',
      '.dshBridge_headTitleText{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshBridge_headMeta{display:flex;align-items:center;gap:8px;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,currentColor);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshBridge_headSpacer{flex:1;min-width:8px}',
      '.dshBridge_body{display:flex;flex:1;min-height:0}',
      '.dshBridge_listPane{display:flex;flex-direction:column;flex:none;width:248px;min-height:0;border-right:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));background:var(--dsw-alias-bg-layer-1,transparent)}',
      '.dshBridge_searchWrap{padding:8px 10px 4px}',
      '.dshBridge_search{box-sizing:border-box;width:100%;height:28px;padding:0 9px;border-radius:var(--dsw-radius-sm,8px);border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:var(--dsw-alias-bg-base,transparent);color:inherit;font:inherit;font-size:12px;outline:none}',
      '.dshBridge_search:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#3b82f6))}',
      '.dshBridge_list{flex:1;min-height:0;overflow:auto;padding:4px 6px 12px}',
      '.dshBridge_row{box-sizing:border-box;display:flex;flex-direction:column;gap:2px;width:100%;text-align:left;border:0;background:transparent;color:inherit;cursor:pointer;border-radius:var(--dsw-radius-md,12px);padding:7px 9px;font:inherit}',
      '.dshBridge_row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      '.dshBridge_row[aria-current="true"]{background:var(--dsw-alias-interactive-bg-active,rgba(0,0,0,.07))}',
      '.dshBridge_rowLine{display:flex;align-items:center;gap:6px;min-width:0;font-size:13px;line-height:20px;font-weight:500}',
      '.dshBridge_rowName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshBridge_rowMeta{display:flex;align-items:center;gap:6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,currentColor);min-width:0}',
      '.dshBridge_rowPreview{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,currentColor);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word}',
      '.dshBridge_dot{flex:none;width:6px;height:6px;border-radius:999px;background:var(--dsw-alias-label-dimmed,rgba(0,0,0,.2))}',
      '.dshBridge_dot[data-running="true"]{background:var(--dsw-alias-state-business-primary,#3b82f6)}',
      '.dshBridge_centre{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0}',
      '.dshBridge_scroll{flex:1;min-height:0;overflow:auto;scroll-behavior:auto}',
      '.dshBridge_column{box-sizing:border-box;max-width:712px;margin:0 auto;padding:20px 24px 8px}',
      '.dshBridge_turn{display:flex;flex-direction:column;gap:6px;margin-bottom:20px}',
      '.dshBridge_turnHead{display:flex;align-items:center;gap:8px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,currentColor)}',
      '.dshBridge_turnRole{font-weight:600;color:var(--dsw-alias-label-secondary,currentColor)}',
      '.dshBridge_userText{font-size:14px;line-height:24px;color:var(--dsw-alias-label-primary,currentColor);white-space:pre-wrap;word-break:break-word}',
      '.dshBridge_assistantBody{font-size:14px;line-height:24px;color:var(--dsw-alias-label-primary,currentColor);word-break:break-word}',
      '.dshBridge_turnFoot{display:flex;align-items:center;gap:8px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,currentColor)}',
      '.dshBridge_toolGroup{display:flex;flex-direction:column;gap:2px;margin:2px 0}',
      '.dshBridge_toolBody{margin:2px 0 4px;padding-left:10px;border-left:2px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}',
      '.dshBridge_toolLabel{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,currentColor);margin:4px 0 2px}',
      '.dshBridge_pre{margin:0;padding:8px 10px;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-markdown-code-block,rgba(0,0,0,.04));font-family:var(--dsw-font-markdown-code-font-family,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word;max-height:320px;overflow:auto}',
      '.dshBridge_streaming{min-height:24px}',
      '.dshBridge_blank{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;height:100%;padding:24px;text-align:center;color:var(--dsw-alias-label-tertiary,currentColor)}',
      '.dshBridge_blankTitle{font-size:15px;line-height:22px;font-weight:600;color:var(--dsw-alias-label-primary,currentColor)}',
      '.dshBridge_blankHint{font-size:12px;line-height:20px;max-width:420px}',
      '.dshBridge_notice{margin:0 auto;max-width:712px;padding:0 24px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,currentColor)}',
      '.dshBridge_notice[data-error="true"]{color:var(--dsw-alias-state-error-primary,#d33)}',
      '.dshBridge_composerSeat{flex:none;padding:0 0 18px}',
      '.dshBridge_composerStack{box-sizing:border-box;max-width:744px;margin:0 auto;padding:0 16px;display:flex;flex-direction:column;gap:6px}',
      '.dshBridge_card{display:flex;flex-direction:column;gap:0;border-radius:var(--dsw-radius-panel,28px);background:var(--dsw-alias-bg-base,Canvas);box-shadow:var(--dsw-elevation-prominent,0 0 0 .5px rgba(0,0,0,.1),0 4px 16px rgba(0,0,0,.03));padding:8px 0 0}',
      '.dshBridge_textarea{box-sizing:border-box;display:block;width:100%;min-height:48px;max-height:220px;padding:6px 20px 2px;border:0;outline:none;resize:none;background:transparent;color:inherit;font:inherit;font-size:14px;line-height:24px}',
      '.dshBridge_textarea::placeholder{color:var(--dsw-alias-label-dimmed,currentColor)}',
      '.dshBridge_toolbar{display:flex;align-items:center;gap:6px;padding:2px 12px 10px 12px;min-height:36px}',
      '.dshBridge_toolbarSpacer{flex:1;min-width:4px}',
      '.dshBridge_hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,currentColor);white-space:nowrap}',
      '.dshBridge_iconButton{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-secondary,currentColor);cursor:pointer;font:inherit}',
      '.dshBridge_iconButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      '.dshBridge_iconButton:disabled{opacity:.4;cursor:default}',
      '.dshBridge_send{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:0;border-radius:999px;background:var(--dsw-alias-button-primary-fill,#0f1115);color:var(--dsw-alias-label-primary-foreground,#fff);cursor:pointer}',
      '.dshBridge_send:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#333)}',
      '.dshBridge_send:disabled{opacity:.35;cursor:default}',
      '.dshBridge_send[data-stop="true"]{background:var(--dsw-alias-state-error-primary,#d33)}',
      '.dshBridge_gear{position:fixed;z-index:900;pointer-events:auto;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-tertiary,currentColor);cursor:pointer}',
      '.dshBridge_gear:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.08));color:var(--dsw-alias-label-primary,currentColor)}',
      '.dshBridge_gear:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#3b82f6));outline-offset:1px}',
      '.dshBridge_form{display:flex;flex-direction:column;gap:16px;min-width:0}',
      '.dshBridge_field{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.dshBridge_label{font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary,currentColor)}',
      '.dshBridge_desc{font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary,currentColor)}',
      '.dshBridge_input{box-sizing:border-box;width:100%;height:34px;padding:0 10px;border-radius:var(--dsw-radius-sm,8px);border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:var(--dsw-alias-bg-layer-1,transparent);color:inherit;font:inherit;font-size:13px;outline:none}',
      '.dshBridge_input:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#3b82f6))}',
      '.dshBridge_picker{display:flex;align-items:center;gap:8px;box-sizing:border-box;width:100%;height:34px;padding:0 10px;border-radius:var(--dsw-radius-sm,8px);border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:var(--dsw-alias-bg-layer-1,transparent);color:inherit;font:inherit;font-size:13px;cursor:pointer;text-align:left}',
      '.dshBridge_picker:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      '.dshBridge_pickerValue{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshBridge_switchRow{display:flex;align-items:flex-start;gap:10px}',
      '.dshBridge_switchText{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}',
      '.dshBridge_switch{position:relative;flex:none;width:36px;height:20px;margin-top:1px;border:0;border-radius:999px;background:var(--dsw-alias-border-l3,rgba(0,0,0,.2));cursor:pointer;transition:background .15s ease}',
      '.dshBridge_switch[data-on="true"]{background:var(--dsw-alias-state-business-primary,#3b82f6)}',
      '.dshBridge_switchKnob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:999px;background:var(--dsw-switch-thumb,#fff);transition:transform .15s ease}',
      '.dshBridge_switch[data-on="true"] .dshBridge_switchKnob{transform:translateX(16px)}',
      '.dshBridge_error{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,#d33)}',
      '.dshBridge_toast{position:fixed;right:20px;bottom:20px;z-index:1400;max-width:360px;padding:9px 12px;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-toast-bg,var(--dsw-alias-bg-layer-2,#fff));color:var(--dsw-alias-toast-label,inherit);box-shadow:var(--dsw-elevation-prominent,0 6px 24px rgba(0,0,0,.12));font-size:12px;line-height:18px}',
      '@media (max-width:820px){.dshBridge_listPane{display:none}}',
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
      if (!response.ok || body?.ok === false) throw new Error(body?.error ?? `HTTP ${response.status}`)
      return body
    }

    function textOf(content) {
      if (typeof content === 'string') return content
      if (!Array.isArray(content)) return ''
      return content
        .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('')
    }

    function formatTime(value) {
      if (typeof value !== 'string' && typeof value !== 'number') return ''
      const time = new Date(value)
      if (Number.isNaN(time.getTime())) return ''
      return time.toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    }

    function formatBytes(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return ''
      if (value < 1024) return `${value} B`
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`
      return `${(value / (1024 * 1024)).toFixed(1)} MB`
    }

    function safeJson(value) {
      const seen = new WeakSet()
      try {
        return JSON.stringify(
          value,
          (key, item) => {
            if (item !== null && typeof item === 'object') {
              if (seen.has(item)) return '[circular]'
              seen.add(item)
            }
            return item
          },
          2,
        )
      } catch {
        return String(value)
      }
    }

    function useMarkdownLabels(t) {
      return useMemo(
        () => ({
          code: { copyLabel: t('copy'), copiedLabel: t('copied') },
          footnotes: 'Footnotes',
        }),
        [t],
      )
    }

    function Markdown({ text, streaming, t, variant }) {
      const labels = useMarkdownLabels(t)
      return h(MarkdownText, { text, streaming, labels, variant })
    }

    function CopyButton({ text, t }) {
      const [copied, setCopied] = useState(false)
      useEffect(() => {
        if (!copied) return undefined
        const timer = setTimeout(() => setCopied(false), 1500)
        return () => clearTimeout(timer)
      }, [copied])
      return h(
        Tooltip,
        { label: copied ? t('copied') : t('copy') },
        h(
          'button',
          {
            type: 'button',
            className: 'dshBridge_iconButton',
            'aria-label': t('copy'),
            onClick: async () => {
              try {
                await writeClipboard(text)
                setCopied(true)
              } catch {
                setCopied(false)
              }
            },
          },
          copied ? h(IconCheckSmall) : h(IconCopySmall),
        ),
      )
    }

    function IconCopySmall() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('rect', { x: 5.5, y: 5.5, width: 8, height: 8, rx: 2, stroke: 'currentColor', strokeWidth: 1.2 }),
        h('path', { d: 'M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5', stroke: 'currentColor', strokeWidth: 1.2 }),
      )
    }

    function IconCheckSmall() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('path', { d: 'm3.5 8.5 3 3 6-6.5', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      )
    }

    /** One tool call and its result, folded into dsh's shared disclosure row. */
    function ToolRow({ item, t }) {
      const [open, setOpen] = useState(false)
      const status = item.status === 'running' ? t('toolRunning') : item.status === 'error' ? t('toolFailed') : t('toolDone')
      const output = typeof item.output === 'string' && item.output !== '' ? item.output : null
      return h(
        'div',
        null,
        h(DisclosureRow, {
          icon: h(IconCodeOutlineRegular, { size: 16 }),
          title: `${item.name ?? 'tool'} · ${status}`,
          open,
          expandable: true,
          onToggle: () => setOpen(!open),
          expandOnRowClick: true,
          running: item.status === 'running',
        }, open
          ? h(
              'div',
              { className: 'dshBridge_toolBody' },
              item.arguments !== undefined ? h('div', { className: 'dshBridge_toolLabel' }, t('toolArguments')) : null,
              item.arguments !== undefined ? h('pre', { className: 'dshBridge_pre' }, safeJson(item.arguments)) : null,
              output !== null ? h('div', { className: 'dshBridge_toolLabel' }, t('toolResult')) : null,
              output !== null ? h('pre', { className: 'dshBridge_pre' }, output) : null,
            )
          : null),
      )
    }

    function ThinkingRow({ text, running, t }) {
      const [open, setOpen] = useState(false)
      return h(DisclosureRow, {
        icon: h(IconApiOutlineRegular, { size: 14 }),
        title: running ? h(TextShimmer, { active: true }, t('thinking')) : t('thinking'),
        open,
        expandable: true,
        onToggle: () => setOpen(!open),
        expandOnRowClick: true,
        running,
      }, open ? h('div', { className: 'dshBridge_toolBody' }, h(Markdown, { text, streaming: running, t, variant: 'compact' })) : null)
    }

    /** Render one durable or streaming assistant message body. */
    function AssistantContent({ message, streaming, t }) {
      const blocks = Array.isArray(message?.content) ? message.content : []
      if (blocks.length === 0 && typeof message?.content === 'string') {
        return message.content === '' ? null : h(Markdown, { text: message.content, streaming, t })
      }
      const nodes = []
      blocks.forEach((block, index) => {
        if (!block || typeof block !== 'object') return
        if (block.type === 'text') {
          nodes.push(h('div', { key: `t${index}`, className: 'dshBridge_assistantBody' }, h(Markdown, { text: block.text ?? '', streaming, t })))
        } else if (block.type === 'thinking') {
          nodes.push(h(ThinkingRow, { key: `k${index}`, text: block.thinking ?? '', running: streaming, t }))
        } else if (block.type === 'image') {
          const source = block.source ?? {}
          const src = typeof source.data === 'string' ? `data:${source.mediaType ?? 'image/png'};base64,${source.data}` : block.data
          if (typeof src === 'string') {
            nodes.push(h('img', { key: `i${index}`, src, alt: '', style: { maxWidth: '100%', borderRadius: 12, marginTop: 6 } }))
          }
        }
      })
      return nodes.length === 0 ? null : h(React.Fragment, null, ...nodes)
    }

    function UserTurn({ message, t }) {
      const text = textOf(message.content)
      const images = Array.isArray(message.content) ? message.content.filter((block) => block && block.type === 'image') : []
      return h(
        'div',
        { className: 'dshBridge_turn', 'data-role': 'user' },
        h(
          'div',
          { className: 'dshBridge_turnHead' },
          h('span', { className: 'dshBridge_turnRole' }, t('userRole')),
          message.timestamp ? h('span', null, formatTime(message.timestamp)) : null,
        ),
        text !== '' ? h('div', { className: 'dshBridge_userText' }, text) : null,
        ...images.map((block, index) => {
          const source = block.source ?? {}
          const src = typeof source.data === 'string' ? `data:${source.mediaType ?? 'image/png'};base64,${source.data}` : block.data
          return typeof src === 'string' ? h('img', { key: `img${index}`, src, alt: '', style: { maxWidth: '100%', borderRadius: 12 } }) : null
        }),
      )
    }

    function hasRenderableContent(message) {
      const content = message?.content
      if (typeof content === 'string') return content.trim() !== ''
      if (!Array.isArray(content)) return false
      return content.some((block) => block && (block.type === 'text' || block.type === 'thinking' || block.type === 'image'))
    }

    function AssistantTurn({ message, streaming, t }) {
      // An assistant message that only carries tool calls is presented by the
      // tool rows, not as an empty agent turn.
      if (!streaming && !hasRenderableContent(message)) return null
      const body = h(AssistantContent, { message, streaming, t })
      const text = textOf(message?.content)
      return h(
        'div',
        { className: 'dshBridge_turn', 'data-role': 'assistant' },
        h(
          'div',
          { className: 'dshBridge_turnHead' },
          h('span', { className: 'dshBridge_turnRole' }, t('assistantRole')),
          message?.model ? h('span', null, message.model) : null,
        ),
        body === null && streaming ? h('div', { className: 'dshBridge_assistantBody dshBridge_streaming' }, h(TextShimmer, { active: true }, '…')) : body,
        !streaming && message?.stopReason === 'aborted'
          ? h('div', { className: 'dshBridge_turnFoot' }, t('stopped'))
          : null,
        !streaming && text !== ''
          ? h('div', { className: 'dshBridge_turnFoot' },
              h('span', null, t('turnCompleted')),
              h(CopyButton, { text, t }))
          : null,
      )
    }

    function ToolItem({ item, t }) {
      return h('div', { className: 'dshBridge_toolGroup' }, h(ToolRow, { item, t }))
    }

    function SettingsModal({ open, onClose, t, initial, onSaved, disabled }) {
      const [backend, setBackend] = useState(initial?.settings?.backend ?? 'pi')
      const [backends, setBackends] = useState(initial?.backends ?? [])
      const [sessionsRoot, setSessionsRoot] = useState(initial?.settings?.pi?.sessionsRoot ?? '')
      const [binary, setBinary] = useState(initial?.settings?.pi?.binary ?? '')
      const [offline, setOffline] = useState(initial?.settings?.pi?.offline !== false)
      const [saving, setSaving] = useState(false)
      const [error, setError] = useState(null)
      const [pickerOpen, setPickerOpen] = useState(false)

      useEffect(() => {
        if (!open) return
        setBackend(initial?.settings?.backend ?? 'pi')
        setBackends(initial?.backends ?? [])
        setSessionsRoot(initial?.settings?.pi?.sessionsRoot ?? '')
        setBinary(initial?.settings?.pi?.binary ?? '')
        setOffline(initial?.settings?.pi?.offline !== false)
        setError(null)
      }, [open, initial])

      const selected = backends.find((entry) => entry.id === backend)

      const save = async () => {
        setSaving(true)
        setError(null)
        try {
          const body = await api('settings', {
            method: 'PUT',
            body: JSON.stringify({
              backend,
              pi: {
                sessionsRoot: sessionsRoot.trim() === '' ? null : sessionsRoot.trim(),
                binary: binary.trim() === '' ? null : binary.trim(),
                offline,
              },
            }),
          })
          onSaved(body)
          onClose()
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setSaving(false)
        }
      }

      return h(
        Modal,
        {
          open,
          onClose,
          title: t('settingsTitle'),
          closeLabel: t('settingsClose'),
          footer: h(
            React.Fragment,
            null,
            h(Button, { variant: 'ghost', size: 'sm', onClick: onClose }, t('settingsClose')),
            h(Button, { variant: 'primary', size: 'sm', onClick: save, disabled: saving || disabled }, saving ? t('settingsSaving') : t('settingsSave')),
          ),
        },
        h(
          'div',
          { className: 'dshBridge_form' },
          disabled ? h('div', { className: 'dshBridge_error' }, t('detachFirst')) : null,
          h(
            'div',
            { className: 'dshBridge_field' },
            h('div', { className: 'dshBridge_label' }, t('backend')),
            h(
              Menu,
              {
                open: pickerOpen,
                onClose: () => setPickerOpen(false),
                selectedId: backend,
                items: backends.map((entry) => ({
                  id: entry.id,
                  label: entry.label,
                  disabled: entry.available === false,
                })),
                onSelect: (id) => {
                  setBackend(id)
                  setPickerOpen(false)
                },
                portal: true,
                anchor: h(
                  'button',
                  {
                    type: 'button',
                    className: 'dshBridge_picker',
                    'aria-haspopup': 'menu',
                    'aria-expanded': pickerOpen,
                    onClick: () => setPickerOpen((value) => !value),
                  },
                  h(IconApiOutlineRegular, { size: 16 }),
                  h('span', { className: 'dshBridge_pickerValue' }, selected?.label ?? backend),
                  h(IconChevronDownOutlineRegular, { size: 14 }),
                ),
              },
            ),
            h('div', { className: 'dshBridge_desc' }, selected?.description ?? t('backendOnlyOne')),
          ),
          h(
            'div',
            { className: 'dshBridge_field' },
            h('div', { className: 'dshBridge_label' }, t('sessionsRoot')),
            h('input', {
              className: 'dshBridge_input',
              value: sessionsRoot,
              placeholder: '~/.pi/agent/sessions',
              onChange: (event) => setSessionsRoot(event.target.value),
            }),
            h('div', { className: 'dshBridge_desc' }, t('sessionsRootHint')),
          ),
          h(
            'div',
            { className: 'dshBridge_field' },
            h('div', { className: 'dshBridge_label' }, t('binary')),
            h('input', {
              className: 'dshBridge_input',
              value: binary,
              placeholder: '~/.pi/agent/bin/pi',
              onChange: (event) => setBinary(event.target.value),
            }),
            h('div', { className: 'dshBridge_desc' }, t('binaryHint')),
          ),
          h(
            'div',
            { className: 'dshBridge_switchRow' },
            h(
              'div',
              { className: 'dshBridge_switchText' },
              h('div', { className: 'dshBridge_label' }, t('offline')),
              h('div', { className: 'dshBridge_desc' }, t('offlineHint')),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dshBridge_switch',
                'data-on': offline ? 'true' : 'false',
                role: 'switch',
                'aria-checked': offline,
                'aria-label': t('offline'),
                onClick: () => setOffline(!offline),
              },
              h('span', { className: 'dshBridge_switchKnob' }),
            ),
          ),
          error !== null ? h('div', { className: 'dshBridge_error' }, `${t('settingsFailed')}: ${error}`) : null,
        ),
      )
    }

    /**
     * The gear beside the sidebar's Bridge row.
     *
     * The sidebar shell owns that row and exposes no trailing-action slot, so
     * this overlay entry measures the row and pins itself to the row's right
     * edge. It renders nothing while the row is absent (collapsed rail, other
     * panel, or a page without that row).
     */
    function SettingsAnchor({ onOpen, t }) {
      const [rect, setRect] = useState(null)
      useEffect(() => {
        let frame = 0
        let last = null
        const measure = () => {
          frame = 0
          const rows = [...document.querySelectorAll('nav button[aria-label]')]
          const row = rows.find((button) => button.getAttribute('aria-label') === t('panel') && button.getBoundingClientRect().width > 96)
          if (row === undefined) {
            if (last !== null) {
              last = null
              setRect(null)
            }
            return
          }
          const box = row.getBoundingClientRect()
          const next = { top: box.top + box.height / 2 - 12, left: box.right - 26 }
          if (last === null || Math.abs(last.top - next.top) > 0.5 || Math.abs(last.left - next.left) > 0.5) {
            last = next
            setRect(next)
          }
        }
        const schedule = () => {
          if (frame !== 0) return
          frame = requestAnimationFrame(measure)
        }
        measure()
        const observer = new ResizeObserver(schedule)
        observer.observe(document.body)
        window.addEventListener('resize', schedule)
        window.addEventListener('scroll', schedule, true)
        const timer = setInterval(schedule, 500)
        return () => {
          if (frame !== 0) cancelAnimationFrame(frame)
          observer.disconnect()
          window.removeEventListener('resize', schedule)
          window.removeEventListener('scroll', schedule, true)
          clearInterval(timer)
        }
      }, [t])
      if (rect === null) return null
      return h(
        Tooltip,
        { label: t('settings') },
        h(
          'button',
          {
            type: 'button',
            className: 'dshBridge_gear',
            style: { top: `${rect.top}px`, left: `${rect.left}px` },
            'aria-label': t('settings'),
            onClick: onOpen,
          },
          h(IconSettingsOutlineRegular, { size: 14 }),
        ),
      )
    }

    function BridgePage(props) {
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
      const selectedKeyRef = useRef(null)
      const scrollRef = useRef(null)
      const textareaRef = useRef(null)
      const stickToBottomRef = useRef(true)

      const showNotice = useCallback((text, error = false) => {
        setNotice(text)
        setNoticeError(error)
      }, [])

      useEffect(() => {
        if (notice === null) return undefined
        const timer = setTimeout(() => setNotice(null), 5000)
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

      useEffect(() => {
        const onChange = () => loadSessions()
        window.addEventListener('dsh-bridge:settings-changed', onChange)
        return () => window.removeEventListener('dsh-bridge:settings-changed', onChange)
      }, [loadSessions])

      const historyItems = useCallback((session) => {
        const messages = Array.isArray(session?.messages) ? session.messages : []
        // Tool results are not conversation turns: fold each into the matching
        // tool call so the transcript has one row per call, as the shipped chat
        // surface does.
        const results = new Map()
        for (const message of messages) {
          if (message?.role === 'toolResult' && typeof message.toolCallId === 'string') {
            results.set(message.toolCallId, message)
          }
        }
        const items = []
        messages.forEach((message, index) => {
          if (message?.role === 'toolResult') return
          const id = `history-${index}-${message.timestamp ?? ''}`
          items.push({ kind: 'message', id, message })
          if (message?.role !== 'assistant' || !Array.isArray(message.content)) return
          message.content.forEach((block, blockIndex) => {
            if (!block || block.type !== 'toolCall') return
            const result = results.get(block.id)
            items.push({
              kind: 'tool',
              id: `history-tool-${index}-${blockIndex}-${block.id ?? ''}`,
              toolCallId: block.id,
              name: block.name,
              arguments: block.arguments,
              output: result === undefined ? null : textOf(result.content),
              status: result === undefined ? 'done' : result.isError === true ? 'error' : 'done',
            })
          })
        })
        return items
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

      const applyPiEvent = useCallback((record) => {
        const event = record?.type
        if (event === 'agent_start') {
          setState((current) => (current === null ? current : { ...current, isStreaming: true }))
        } else if (event === 'agent_settled' || event === 'agent_end') {
          setState((current) => (current === null ? current : { ...current, isStreaming: false }))
        } else if (event === 'message_start') {
          if (record.message?.role === 'assistant') setStreamingMessage({ ...record.message })
        } else if (event === 'message_update') {
          if (record.message?.role === 'assistant') setStreamingMessage({ ...record.message })
        } else if (event === 'message_end') {
          const message = record.message
          if (message === undefined) return
          if (message.role === 'assistant') setStreamingMessage(null)
          // The system prompt is harness plumbing, never part of the transcript.
          if (message.role === 'system') return
          if (message.role === 'toolResult') {
            const output = textOf(message.content)
            setTranscript((current) =>
              current.map((item) =>
                item.kind === 'tool' && item.toolCallId === message.toolCallId
                  ? { ...item, status: message.isError === true ? 'error' : 'done', output }
                  : item,
              ),
            )
            return
          }
          setTranscript((current) => [
            ...current,
            { kind: 'message', id: `${message.role}-${message.timestamp ?? Date.now()}-${current.length}`, message },
          ])
        } else if (event === 'tool_execution_start') {
          setTranscript((current) => [
            ...current,
            { kind: 'tool', id: record.toolCallId ?? `tool-${Date.now()}`, toolCallId: record.toolCallId, name: record.toolName, arguments: record.args ?? record.arguments, output: '', status: 'running' },
          ])
        } else if (event === 'tool_execution_update') {
          const partial = typeof record.partialResult === 'string' ? record.partialResult : textOf(record.partialResult?.content)
          setTranscript((current) =>
            current.map((item) =>
              item.kind === 'tool' && item.toolCallId === record.toolCallId
                ? { ...item, output: partial !== '' ? partial : item.output }
                : item,
            ),
          )
        } else if (event === 'tool_execution_end') {
          const output = typeof record.result === 'string' ? record.result : textOf(record.result?.content)
          setTranscript((current) =>
            current.map((item) =>
              item.kind === 'tool' && item.toolCallId === record.toolCallId
                ? { ...item, status: record.isError === true ? 'error' : 'done', output: output !== '' ? output : item.output }
                : item,
            ),
          )
        } else if (event === 'session_info_changed') {
          setState((current) => (current === null ? current : { ...current, sessionName: record.name }))
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
            try {
              applyPiEvent(JSON.parse(message.data))
            } catch {
              // Ignore a malformed frame; the next event repairs the view.
            }
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
              if (typeof payload?.message === 'string') {
                showNotice(`${t('notification')}: ${payload.message}`, payload.notifyType === 'error')
              }
            } catch {
              // Ignore malformed notifications.
            }
          })
          source.addEventListener('pi-exit', () => {
            setAttached(false)
            setStreamingMessage(null)
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
          stickToBottomRef.current = true
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
        stickToBottomRef.current = true
        try {
          await api('prompt', { method: 'POST', body: JSON.stringify({ key: selectedKey, message, mode: 'auto' }) })
          setDraft('')
          if (textareaRef.current !== null) textareaRef.current.style.height = 'auto'
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

      // Auto-scroll only while the reader is already at the bottom, matching
      // the transcript behaviour of the shipped chat surface.
      useEffect(() => {
        const node = scrollRef.current
        if (node === null || !stickToBottomRef.current) return
        node.scrollTop = node.scrollHeight
      }, [transcript, streamingMessage])

      const onScroll = useCallback(() => {
        const node = scrollRef.current
        if (node === null) return
        stickToBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 64
      }, [])

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
        { className: 'dshBridge_page', 'aria-label': t('title') },
        h(
          'header',
          { className: 'dshBridge_head' },
          h(
            'div',
            { className: 'dshBridge_headTitle' },
            h(IconApiOutlineRegular, { size: 16 }),
            h('span', { className: 'dshBridge_headTitleText' }, selectedKey === null ? t('panel') : title),
          ),
          h('span', { className: 'dshBridge_headMeta' },
            selectedKey === null
              ? t('subtitle')
              : [selectedSession?.cwd, attached ? (isStreaming ? t('running') : t('idle')) : t('notAttached')].filter(Boolean).join(' · ')),
          h('span', { className: 'dshBridge_headSpacer' }),
          selectedKey === null ? null : attached
            ? [
                h(Button, { key: 'detach', variant: 'ghost', size: 'sm', onClick: detach }, t('detach')),
              ]
            : h(Button, { key: 'attach', variant: 'primary', size: 'sm', onClick: attach, disabled: attaching || detailLoading || detail === null }, attaching ? t('attaching') : t('attach')),
          h(
            Tooltip,
            { label: t('refresh') },
            h('button', { type: 'button', className: 'dshBridge_iconButton', 'aria-label': t('refresh'), onClick: loadSessions, disabled: loading }, h(IconRefreshOutlineRegular, { size: 16 })),
          ),
        ),
        notice !== null ? h('div', { className: 'dshBridge_notice', 'data-error': noticeError ? 'true' : undefined }, notice) : null,
        streamState === 'disconnected' ? h('div', { className: 'dshBridge_notice' }, t('eventsDisconnected')) : null,
        h(
          'div',
          { className: 'dshBridge_body' },
          h(
            'aside',
            { className: 'dshBridge_listPane', 'aria-label': t('panel') },
            h('div', { className: 'dshBridge_searchWrap' },
              h('input', {
                className: 'dshBridge_search',
                type: 'search',
                value: search,
                placeholder: t('searchPlaceholder'),
                'aria-label': t('search'),
                onChange: (event) => setSearch(event.target.value),
              })),
            h(
              'div',
              { className: 'dshBridge_list' },
              loading
                ? h('div', { className: 'dshBridge_rowMeta', style: { padding: '8px 9px' } }, t('loading'))
                : loadError !== null
                  ? h('div', { className: 'dshBridge_rowMeta', style: { padding: '8px 9px' } }, `${t('loadFailed')}: ${loadError}`)
                  : filtered.length === 0
                    ? h('div', { className: 'dshBridge_rowMeta', style: { padding: '8px 9px' } }, sessions.length === 0 ? t('empty') : t('noMatches'))
                    : filtered.map((session) =>
                        h(
                          'button',
                          {
                            key: session.key,
                            type: 'button',
                            className: 'dshBridge_row',
                            'aria-current': session.key === selectedKey ? 'true' : undefined,
                            onClick: () => openSession(session.key),
                          },
                          h('div', { className: 'dshBridge_rowLine' },
                            h('span', { className: 'dshBridge_dot' }),
                            h('span', { className: 'dshBridge_rowName' }, session.name ?? session.firstMessage ?? session.id ?? t('panel'))),
                          h('div', { className: 'dshBridge_rowMeta' },
                            h('span', null, formatBytes(session.bytes)),
                            session.modified ? h('span', null, formatTime(session.modified)) : null),
                          session.firstMessage ? h('div', { className: 'dshBridge_rowPreview' }, session.firstMessage) : null,
                        ),
                      ),
            ),
          ),
          h(
            'div',
            { className: 'dshBridge_centre' },
            h(
              'div',
              { className: 'dshBridge_scroll', ref: scrollRef, onScroll },
              selectedKey === null
                ? h('div', { className: 'dshBridge_blank' },
                    h('div', { className: 'dshBridge_blankTitle' }, sessions.length === 0 ? t('empty') : t('selectHint')),
                    h('div', { className: 'dshBridge_blankHint' }, t('emptyHint')))
                : detailLoading
                  ? h('div', { className: 'dshBridge_blank' }, t('loading'))
                  : detailError !== null
                    ? h('div', { className: 'dshBridge_blank' }, `${t('historyLoadFailed')}: ${detailError}`)
                    : h(
                        'div',
                        { className: 'dshBridge_column' },
                        ...transcript.map((item) => {
                          if (item.kind === 'tool') return h(ToolItem, { key: item.id, item, t })
                          if (item.message?.role === 'user') return h(UserTurn, { key: item.id, message: item.message, t })
                          if (item.message?.role === 'assistant') return h(AssistantTurn, { key: item.id, message: item.message, t })
                          return null
                        }),
                        streamingMessage !== null ? h(AssistantTurn, { key: 'streaming', message: streamingMessage, streaming: true, t }) : null,
                      ),
            ),
            attached
              ? h(
                  'div',
                  { className: 'dshBridge_composerSeat' },
                  h(
                    'div',
                    { className: 'dshBridge_composerStack' },
                    h(
                      'div',
                      { className: 'dshBridge_card' },
                      h('textarea', {
                        ref: textareaRef,
                        className: 'dshBridge_textarea',
                        rows: 1,
                        value: draft,
                        placeholder: t('placeholder'),
                        'aria-label': t('placeholder'),
                        onChange: (event) => {
                          setDraft(event.target.value)
                          const node = event.target
                          node.style.height = 'auto'
                          node.style.height = `${Math.min(node.scrollHeight, 220)}px`
                        },
                        onKeyDown: (event) => {
                          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                            event.preventDefault()
                            send()
                          }
                        },
                      }),
                      h(
                        'div',
                        { className: 'dshBridge_toolbar' },
                        h('span', { className: 'dshBridge_hint' }, state?.model?.id ?? ''),
                        h('span', { className: 'dshBridge_toolbarSpacer' }),
                        isStreaming
                          ? h(
                              Tooltip,
                              { label: t('stop') },
                              h(
                                'button',
                                { type: 'button', className: 'dshBridge_send', 'data-stop': 'true', 'aria-label': t('stop'), onClick: abort },
                                h(IconPauseOutlineRegular, { size: 16 }),
                              ),
                            )
                          : h(
                              Tooltip,
                              { label: t('send') },
                              h(
                                'button',
                                {
                                  type: 'button',
                                  className: 'dshBridge_send',
                                  'aria-label': t('send'),
                                  disabled: sending || draft.trim() === '',
                                  onClick: send,
                                },
                                h(IconSendOutlineRegular, { size: 16 }),
                              ),
                            ),
                      ),
                    ),
                  ),
                )
              : null,
          ),
        ),
        h(ExtensionDialog, { request: dialog, t, onRespond: respondDialog }),
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
      let body
      if (request.method === 'select') {
        body = h(
          'div',
          { className: 'dshBridge_form' },
          h(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
            ...(Array.isArray(request.options) ? request.options : []).map((option) =>
              h(Button, { key: option, variant: 'outline', size: 'sm', onClick: () => onRespond({ value: option }) }, option),
            ),
          ),
        )
      } else if (request.method === 'input' || request.method === 'editor') {
        body = h(
          'div',
          { className: 'dshBridge_form' },
          request.method === 'editor'
            ? h('textarea', {
                className: 'dshBridge_input',
                style: { height: 140, padding: 10, resize: 'vertical', lineHeight: '20px' },
                value,
                placeholder: request.placeholder,
                onChange: (event) => setValue(event.target.value),
                'data-modal-autofocus': true,
              })
            : h('input', {
                className: 'dshBridge_input',
                value,
                placeholder: request.placeholder,
                onChange: (event) => setValue(event.target.value),
                'data-modal-autofocus': true,
              }),
        )
      } else {
        body = request.message !== undefined && request.message !== title
          ? h('div', { className: 'dshBridge_desc' }, request.message)
          : null
      }
      const footer = request.method === 'select'
        ? h(Button, { variant: 'ghost', size: 'sm', onClick: () => onRespond({ cancelled: true }) }, t('dialogCancel'))
        : h(
            React.Fragment,
            null,
            h(Button, { variant: 'ghost', size: 'sm', onClick: () => onRespond({ cancelled: true }) }, t('dialogCancel')),
            h(
              Button,
              {
                variant: 'primary',
                size: 'sm',
                onClick: () => onRespond(request.method === 'confirm' ? { confirmed: true } : { value }),
              },
              request.method === 'confirm' ? t('dialogConfirm') : t('dialogSubmit'),
            ),
          )
      return h(Modal, { open: true, onClose: () => onRespond({ cancelled: true }), title, closeLabel: t('dialogCancel'), footer }, body)
    }

    function apply(ctx) {
      ctx.effect(installStyles, 'bridge: styles')
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'bridge: dictionaries')
      const t = ctx.locale.bind(NS)
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, BridgePage))
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 20, locale: NS, label: () => t('panel') },
          function BridgePanelIcon({ size }) {
            return h(IconApiOutlineRegular, { size })
          },
        ),
      )
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          { name: 'shell.overlay', id: SETTINGS_ANCHOR_ID, locale: NS },
          function BridgeSettingsAnchor() {
            const [open, setOpen] = useState(false)
            const [config, setConfig] = useState(null)
            const openSettings = useCallback(async () => {
              try {
                setConfig(await api('settings'))
              } catch {
                setConfig(null)
              }
              setOpen(true)
            }, [])
            return h(
              React.Fragment,
              null,
              h(SettingsAnchor, { onOpen: openSettings, t }),
              h(SettingsModal, {
                open,
                onClose: () => setOpen(false),
                t,
                initial: config,
                disabled: false,
                onSaved: (body) => {
                  setConfig(body)
                  // The sessions list and the attach roster read the same
                  // settings; tell the page to re-read instead of duplicating
                  // settings state in both entries.
                  window.dispatchEvent(new CustomEvent('dsh-bridge:settings-changed'))
                },
              }),
            )
          },
        ),
      )
    }

    exports.apply = apply
    exports.inject = ['slots', 'locale']
    exports.__test = { textOf, formatTime, formatBytes, safeJson }
    return module.exports
  },
})
