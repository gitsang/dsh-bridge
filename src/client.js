/**
 * Browser half of dsh-bridge: the Bridge panel.
 *
 * The panel deliberately borrows dsh's own visual vocabulary instead of
 * inventing one: content column width, typography, Markdown rendering, card
 * elevation, and controls all come from `dsh-client-ui-primitives` and the
 * `--dsw-*` tokens the shipped Web shell paints, so the page reads as part of
 * the same product.
 *
 * It does not reuse dsh's Conversation controller. External agent sessions carry
 * their own native event model; the Host bridge normalizes it, and this component
 * renders the normalized stream with dsh's presentational primitives.
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
      IconEditOutlineRegular,
      IconPlusOutlineRegular,
      IconTrashOutlineRegular,
      IconPauseOutlineRegular,
      IconRefreshOutlineRegular,
      IconSendOutlineRegular,
      IconSettingsOutlineRegular,
      FishLogo,
      MarkdownText,
      Menu,
      Modal,
      TextShimmer,
      Tooltip,
      writeClipboard,
    } = primitives

    const NS = 'bridge'
    const PANEL_ID = 'bridge'
    const SETTINGS_EVENT = 'bridge:open-settings'
    const CONFIG_CHANGED_EVENT = 'bridge:config-changed'

    /**
     * Shared navigation state between the shell sidebar occupant and the main
     * Bridge panel. Both are separate slot registrations, so they communicate
     * through this tiny external store instead of owning duplicate lists.
     */
    const bridgeUi = {
      state: {
        bridge: null,
        sessions: [],
        workspaces: [],
        loading: false,
        loadError: null,
        selectedKey: null,
        search: '',
      },
      listeners: new Set(),
      selectHandler: null,
      refreshHandler: null,
      set(patch) {
        this.state = { ...this.state, ...patch }
        for (const listener of this.listeners) listener()
      },
      subscribe(listener) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      },
      selectSession(key) {
        this.set({ selectedKey: key })
        this.selectHandler?.(key)
      },
      refresh() {
        this.refreshHandler?.()
      },
    }

    function openBridgeSettings() {
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(SETTINGS_EVENT))
    }

    function notifyBridgeConfigChanged(payload) {
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(CONFIG_CHANGED_EVENT, { detail: payload }))
    }

    function useBridgeUi() {
      const [state, setState] = useState(bridgeUi.state)
      useEffect(() => bridgeUi.subscribe(() => setState(bridgeUi.state)), [])
      return state
    }

    const zh = {
      panel: 'Bridge',
      title: 'Bridge',
      subtitle: '把外部 agent 会话接进 dsh。',
      settings: '桥接设置',
      settingsTitle: '桥接设置',
      settingsClose: '关闭',
      bridgeSettingsGeneral: '管理桥接',
      bridgeSettingsGeneralHint: '创建、编辑和删除 Bridge 配置。',
      settingsSave: '保存',
      settingsSaving: '保存中…',
      settingsSaved: '已保存',
      settingsFailed: '保存失败',
      local: '本机',
      bridgeMenu: '选择桥接',
      manageBridges: '管理桥接',
      bridgeSettingsTitle: 'Bridge 设置',
      bridgeSettingsHint: '选择一个已配置的桥接，或新增一个 Bridge。',
      addBridge: '新增桥接',
      editBridge: '编辑',
      deleteBridge: '删除',
      deleteBridgeConfirm: '确定删除这个桥接吗？',
      bridgeName: '名称',
      bridgeNamePlaceholder: '例如：本机 Pi、公司 Codex',
      bridgeMode: '桥接模式',
      bridgeEngine: '引擎',
      bridgeList: '已配置的桥接',
      noBridges: '还没有配置桥接',
      noBridgesHint: '点击“新增桥接”开始配置第一个 Bridge。',
      saveBridge: '保存桥接',
      savingBridge: '保存中…',
      bridgeCreated: '桥接已创建',
      bridgeUpdated: '桥接已更新',
      bridgeDeleted: '桥接已删除',
      bridgeUnavailable: '尚未支持',
      bridgeUnavailableHint: '引擎已经出现在新增表单里，但适配器还未接入。',
      modeCli: 'CLI',
      modeWeb: 'Web',
      binPath: 'Bin 地址',
      binPathHint: '留空则使用 PATH 或引擎默认安装位置。',
      sessionsRoot: '会话根目录',
      sessionsRootHint: '留空则使用该引擎的默认会话目录。',
      baseUrl: '服务地址',
      baseUrlHint: '远程实例的地址，例如 https://dsh.example.com。',
      accessToken: '访问令牌',
      accessTokenHint: '可选。仅保存在本机的 0600 权限设置文件中。',
      secretConfigured: '已保存；留空保持不变。',
      offline: '离线启动',
      offlineHint: '在支持时以离线模式启动外部 agent，避免安装包或写入 agent 目录。',
      workspaces: '工作区',
      noWorkspace: '未归类',
      sessions: '会话',
      sessionCount: '{count} 个会话',
      openSettings: '打开 Bridge 设置',
      refresh: '刷新',
      loading: '正在加载…',
      loadFailed: '无法加载会话',
      empty: '还没有会话',
      emptyHint: '先在终端运行一次对应 agent，或在 Bridge 设置里指定正确的会话目录。',
      search: '搜索会话',
      searchPlaceholder: '搜索名称、路径或首条消息',
      noMatches: '没有匹配的会话',
      selectHint: '从左侧选择一个会话',
      attach: '连接会话',
      attaching: '正在连接…',
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
      attachFailed: '连接失败',
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
      attachNotice: '已连接会话。',
      detachedNotice: '已断开；会话文件保持不变。',
      turnCompleted: '已完成',
      thinking: '思考',
      metrics: '{size} · {time}',
      notification: 'Bridge 通知',
      userRole: '我',
      assistantRole: 'Agent',
    }

    const en = {
      panel: 'Bridge',
      title: 'Bridge',
      subtitle: 'Bring external agent sessions into dsh.',
      settings: 'Bridge settings',
      settingsTitle: 'Bridge settings',
      settingsClose: 'Close',
      bridgeSettingsGeneral: 'Manage bridges',
      bridgeSettingsGeneralHint: 'Create, edit, and delete Bridge configurations.',
      settingsSave: 'Save',
      settingsSaving: 'Saving…',
      settingsSaved: 'Saved',
      settingsFailed: 'Could not save',
      local: 'Local',
      bridgeMenu: 'Choose a bridge',
      manageBridges: 'Manage bridges',
      bridgeSettingsTitle: 'Bridge settings',
      bridgeSettingsHint: 'Pick a configured bridge, or add another Bridge.',
      addBridge: 'Add bridge',
      editBridge: 'Edit',
      deleteBridge: 'Delete',
      deleteBridgeConfirm: 'Delete this bridge?',
      bridgeName: 'Name',
      bridgeNamePlaceholder: 'e.g. Local Pi, Work Codex',
      bridgeMode: 'Bridge mode',
      bridgeEngine: 'Engine',
      bridgeList: 'Configured bridges',
      noBridges: 'No bridges configured yet',
      noBridgesHint: 'Choose “Add bridge” to configure the first Bridge.',
      saveBridge: 'Save bridge',
      savingBridge: 'Saving…',
      bridgeCreated: 'Bridge created',
      bridgeUpdated: 'Bridge updated',
      bridgeDeleted: 'Bridge deleted',
      bridgeUnavailable: 'Adapter pending',
      bridgeUnavailableHint: 'The engine appears in the add form, but its adapter is not connected yet.',
      modeCli: 'CLI',
      modeWeb: 'Web',
      binPath: 'Bin path',
      binPathHint: 'Leave empty to use PATH or the engine default install.',
      sessionsRoot: 'Sessions root',
      sessionsRootHint: 'Leave empty to use the engine default.',
      baseUrl: 'Base URL',
      baseUrlHint: 'Address of the remote instance, for example https://dsh.example.com.',
      accessToken: 'Access token',
      accessTokenHint: 'Optional. Stored only in the local 0600 settings file.',
      secretConfigured: 'Saved; leave blank to keep it.',
      offline: 'Offline startup',
      offlineHint: 'Start the external agent in offline mode when supported, avoiding installs or agent-directory writes.',
      workspaces: 'Workspaces',
      noWorkspace: 'Ungrouped',
      sessions: 'Sessions',
      sessionCount: '{count} sessions',
      openSettings: 'Open Bridge settings',
      refresh: 'Refresh',
      loading: 'Loading…',
      loadFailed: 'Could not load sessions',
      empty: 'No sessions yet',
      emptyHint: 'Run the selected agent once in a terminal, or point its sessions directory at the right place in Bridge settings.',
      search: 'Search sessions',
      searchPlaceholder: 'Search name, path, or first message',
      noMatches: 'No matching sessions',
      selectHint: 'Select a session on the left',
      attach: 'Connect session',
      attaching: 'Connecting…',
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
      attachFailed: 'Could not connect',
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
      attachNotice: 'Session connected.',
      detachedNotice: 'Detached; the session file is unchanged.',
      turnCompleted: 'Completed',
      thinking: 'Thinking',
      metrics: '{size} · {time}',
      notification: 'Bridge notification',
      userRole: 'You',
      assistantRole: 'Agent',
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
      '.dshBridge_form{display:flex;flex-direction:column;gap:16px;min-width:0}',
      '.dshBridge_field{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.dshBridge_label{font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary,currentColor)}',
      '.dshBridge_desc{font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary,currentColor)}',
      '.dshBridge_input{box-sizing:border-box;width:100%;height:34px;padding:0 10px;border-radius:var(--dsw-radius-sm,8px);border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:var(--dsw-alias-bg-layer-1,transparent);color:inherit;font:inherit;font-size:13px;outline:none}',
      '.dshBridge_input:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#3b82f6))}',
      '.dshBridge_switchRow{display:flex;align-items:flex-start;gap:10px}',
      '.dshBridge_switchText{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}',
      '.dshBridge_switch{position:relative;flex:none;width:36px;height:20px;margin-top:1px;border:0;border-radius:999px;background:var(--dsw-alias-border-l3,rgba(0,0,0,.2));cursor:pointer;transition:background .15s ease}',
      '.dshBridge_switch[data-on="true"]{background:var(--dsw-alias-state-business-primary,#3b82f6)}',
      '.dshBridge_switchKnob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:999px;background:var(--dsw-switch-thumb,#fff);transition:transform .15s ease}',
      '.dshBridge_switch[data-on="true"] .dshBridge_switchKnob{transform:translateX(16px)}',
      '.dshBridge_error{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,#d33)}',
      '.dshBridge_toast{position:fixed;right:20px;bottom:20px;z-index:1400;max-width:360px;padding:9px 12px;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-toast-bg,var(--dsw-alias-bg-layer-2,#fff));color:var(--dsw-alias-toast-label,inherit);box-shadow:var(--dsw-elevation-prominent,0 6px 24px rgba(0,0,0,.12));font-size:12px;line-height:18px}',
      '.dshBridge_brandSwitcher{position:relative;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:6px;cursor:pointer;outline:none}',
      '.dshBridge_brandSwitcher:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
      '.dshBridge_brandSwitcher:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#3b82f6))}',
      '.dshBridge_brandChevron{position:absolute;right:-2px;bottom:-1px;display:inline-flex;align-items:center;justify-content:center;width:11px;height:11px;border-radius:999px;background:var(--dsw-alias-bg-layer-1,Canvas);color:var(--dsw-alias-label-tertiary,currentColor)}',
      '.dshBridge_menuLabel{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;min-width:0}',
      '.dshBridge_menuName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshBridge_menuMeta{flex:none;margin-left:auto;font-size:10px;line-height:14px;white-space:nowrap;color:var(--dsw-alias-label-tertiary,currentColor)}',
      '.dshBridge_tag{flex:none;padding:1px 7px;border-radius:999px;background:var(--dsw-alias-interactive-bg-active,rgba(0,0,0,.07));font-size:10px;line-height:16px;color:var(--dsw-alias-label-secondary,currentColor)}',
      '.dshBridge_tag[data-active="true"]{background:var(--dsw-alias-state-business-primary,#3b82f6);color:var(--dsw-alias-label-primary-foreground,#fff)}',
      '.dshBridge_sideWorkspace{flex:1;min-height:0;display:flex;flex-direction:column;padding:0 4px 8px;box-sizing:border-box;color:var(--dsw-alias-label-primary,currentColor)}',
      '.dshBridge_sideHead{flex:none;display:flex;align-items:center;gap:6px;height:32px;padding:0 4px 0 6px;color:var(--dsw-alias-label-tertiary,currentColor)}',
      '.dshBridge_sideHeadTitle{font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-secondary,currentColor)}',
      '.dshBridge_sideHeadBackend{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,currentColor);text-align:right}',
      '.dshBridge_sideIconButton{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:var(--dsw-radius-sm,7px);background:transparent;color:var(--dsw-alias-label-tertiary,currentColor);cursor:pointer}',
      '.dshBridge_sideIconButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));color:var(--dsw-alias-label-primary,currentColor)}',
      '.dshBridge_sideIconButton:disabled{opacity:.4;cursor:default}',
      '.dshBridge_sideSearchWrap{flex:none;padding:2px 4px 6px}',
      '.dshBridge_sideSearch{box-sizing:border-box;width:100%;height:30px;padding:0 10px;border-radius:var(--dsw-radius-md,10px);border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:var(--dsw-alias-bg-base,transparent);color:inherit;font:inherit;font-size:12px;outline:none}',
      '.dshBridge_sideSearch:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#3b82f6))}',
      '.dshBridge_sideList{flex:1;min-height:0;overflow:auto;padding:0 2px}',
      '.dshBridge_sideGroup{margin:0 0 8px}',
      '.dshBridge_sideGroupHead{display:flex;align-items:center;gap:6px;padding:5px 8px;font-size:11px;line-height:16px;font-weight:600;color:var(--dsw-alias-label-tertiary,currentColor)}',
      '.dshBridge_sideGroupName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshBridge_sideGroupCount{flex:none;font-weight:400;color:var(--dsw-alias-label-dimmed,currentColor)}',
      '.dshBridge_sideRow{box-sizing:border-box;display:flex;flex-direction:column;gap:2px;width:100%;padding:6px 8px;border:0;border-radius:var(--dsw-radius-md,10px);background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}',
      '.dshBridge_sideRow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      '.dshBridge_sideRow[aria-current="true"]{background:var(--dsw-alias-interactive-bg-active,rgba(0,0,0,.07))}',
      '.dshBridge_sideRowTop{display:flex;align-items:center;gap:6px;min-width:0;font-size:12px;line-height:18px;font-weight:500}',
      '.dshBridge_sideRowTitle{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshBridge_sideRowTime{flex:none;font-size:10px;line-height:15px;color:var(--dsw-alias-label-tertiary,currentColor)}',
      '.dshBridge_sideRowPreview{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,currentColor);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word}',
      '.dshBridge_sideNote{padding:8px 9px;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary,currentColor);display:flex;flex-direction:column;gap:4px}',
      '.dshBridge_sideNoteTitle{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,currentColor)}',
      '.dshBridge_errorText{color:var(--dsw-alias-state-error-primary,#d33)}',
      '.dshBridge_sideSettings{flex:none;display:flex;align-items:center;gap:8px;margin:6px 4px 0;padding:7px 9px;border:0;border-radius:var(--dsw-radius-md,10px);background:transparent;color:var(--dsw-alias-label-secondary,currentColor);font:inherit;font-size:12px;text-align:left;cursor:pointer}',
      '.dshBridge_sideSettings:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));color:var(--dsw-alias-label-primary,currentColor)}',
      '.dshBridge_railWorkspace{display:flex;justify-content:center;padding:6px 0}',
      '.dshBridge_railButton{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:0;border-radius:var(--dsw-radius-md,10px);background:transparent;color:var(--dsw-alias-label-secondary,currentColor);cursor:pointer}',
      '.dshBridge_railButton:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      '.dshBridge_settingsShell{display:flex;width:760px;max-width:78vw;min-height:440px;max-height:68vh;border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:var(--dsw-radius-md,12px);overflow:hidden;background:var(--dsw-alias-bg-layer-1,Canvas)}',
      '.dshBridge_settingsNav{flex:none;display:flex;flex-direction:column;gap:4px;width:190px;padding:12px 8px;box-sizing:border-box;border-right:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));background:var(--dsw-alias-bg-layer-2,transparent)}',
      '.dshBridge_settingsNavTitle{padding:2px 8px 8px;font-size:11px;line-height:16px;font-weight:600;color:var(--dsw-alias-label-tertiary,currentColor)}',
      '.dshBridge_settingsNavItem{display:flex;align-items:center;gap:8px;width:100%;padding:8px 9px;border:0;border-radius:var(--dsw-radius-md,10px);background:transparent;color:var(--dsw-alias-label-secondary,currentColor);font:inherit;font-size:12px;text-align:left;cursor:pointer}',
      '.dshBridge_settingsNavItem[data-selected="true"]{background:var(--dsw-alias-interactive-bg-active,rgba(0,0,0,.07));color:var(--dsw-alias-label-primary,currentColor)}',
      '.dshBridge_settingsNavHint{padding:6px 9px;font-size:10px;line-height:16px;color:var(--dsw-alias-label-tertiary,currentColor)}',
      '.dshBridge_settingsMain{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;padding:14px 16px;box-sizing:border-box;overflow:auto}',
      '.dshBridge_settingsEmpty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:36px 16px;text-align:center;color:var(--dsw-alias-label-tertiary,currentColor)}',
      '.dshBridge_bridgeForm{display:flex;flex-direction:column;gap:14px;min-width:0;padding:2px 2px 8px}',
      '.dshBridge_formHead{display:flex;align-items:center;gap:10px;min-height:34px}',
      '.dshBridge_formTitle{flex:1;min-width:0;font-size:14px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary,currentColor)}',
      '.dshBridge_linkButton{padding:4px 6px;border:0;border-radius:var(--dsw-radius-sm,7px);background:transparent;color:var(--dsw-alias-label-tertiary,currentColor);font:inherit;font-size:12px;cursor:pointer}',
      '.dshBridge_linkButton:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));color:var(--dsw-alias-label-primary,currentColor)}',
      '.dshBridge_chipRow{display:flex;flex-wrap:wrap;gap:6px}',
      '.dshBridge_chip{display:inline-flex;align-items:center;gap:6px;padding:6px 11px;border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,currentColor);font:inherit;font-size:12px;cursor:pointer}',
      '.dshBridge_chip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      '.dshBridge_chip[data-selected="true"]{border-color:var(--dsw-alias-state-business-primary,#3b82f6);background:var(--dsw-alias-interactive-bg-active,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,currentColor)}',
      '.dshBridge_chipMeta{font-size:9px;line-height:12px;color:var(--dsw-alias-label-tertiary,currentColor)}',
      '.dshBridge_warning{color:var(--dsw-alias-state-warning-primary,#b45309)}',
      '.dshBridge_formActions{display:flex;justify-content:flex-end;gap:8px;padding-top:4px}',
      '.dshBridge_primaryButton{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:30px;padding:0 12px;border:0;border-radius:var(--dsw-radius-md,10px);background:var(--dsw-alias-button-primary-fill,#0f1115);color:var(--dsw-alias-label-primary-foreground,#fff);font:inherit;font-size:12px;cursor:pointer}',
      '.dshBridge_primaryButton:disabled{opacity:.4;cursor:default}',
      '.dshBridge_secondaryButton{min-height:30px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:var(--dsw-radius-md,10px);background:transparent;color:var(--dsw-alias-label-secondary,currentColor);font:inherit;font-size:12px;cursor:pointer}',
      '.dshBridge_secondaryButton:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      '.dshBridge_bridgeListPane{display:flex;flex-direction:column;gap:10px;min-height:0;flex:1}',
      '.dshBridge_bridgeCards{display:flex;flex-direction:column;gap:8px;overflow:auto;padding-bottom:6px}',
      '.dshBridge_bridgeCard{display:flex;align-items:flex-start;gap:12px;padding:12px;border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-base,transparent)}',
      '.dshBridge_bridgeCardMain{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}',
      '.dshBridge_bridgeCardTitleRow{display:flex;align-items:center;gap:8px;min-width:0}',
      '.dshBridge_bridgeCardTitle{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary,currentColor)}',
      '.dshBridge_bridgeConfigSummary{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,currentColor);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshBridge_bridgeCardActions{flex:none;display:flex;align-items:center;gap:2px}',
      '.dshBridge_dangerButton:hover:not(:disabled){color:var(--dsw-alias-state-error-primary,#d33)!important}',
      '.dshBridge_settingsNotice{margin-top:8px;padding:6px 9px;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04));font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary,currentColor)}',
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
      return `api/bridge/${path}`
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

    function IconSearchSmall() {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('circle', { cx: 7, cy: 7, r: 4.5, stroke: 'currentColor', strokeWidth: 1.3 }),
        h('path', { d: 'm10.5 10.5 3 3', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
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

    function ConfigField({ field, value, configured, disabled, onChange, t }) {
      const label = t(field.labelKey ?? field.key)
      const hint = field.hintKey ? t(field.hintKey) : ''
      const shownHint = field.type === 'secret' && configured ? `${t('secretConfigured')} ${hint}` : hint
      if (field.type === 'boolean') {
        return h(
          'div',
          { className: 'dshBridge_switchRow' },
          h(
            'div',
            { className: 'dshBridge_switchText' },
            h('div', { className: 'dshBridge_label' }, label),
            hint === '' ? null : h('div', { className: 'dshBridge_desc' }, hint),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dshBridge_switch',
              'data-on': value !== false ? 'true' : 'false',
              role: 'switch',
              'aria-checked': value !== false,
              'aria-label': label,
              disabled,
              onClick: () => onChange(value === false),
            },
            h('span', { className: 'dshBridge_switchKnob' }),
          ),
        )
      }
      return h(
        'div',
        { className: 'dshBridge_field' },
        h('div', { className: 'dshBridge_label' }, label),
        h('input', {
          className: 'dshBridge_input',
          type: field.type === 'secret' ? 'password' : 'text',
          value: value ?? '',
          placeholder: field.placeholder ?? '',
          disabled,
          onChange: (event) => onChange(event.target.value),
        }),
        shownHint === '' ? null : h('div', { className: 'dshBridge_desc' }, shownHint),
      )
    }

    function configSummary(bridge, t) {
      const fields = bridge.configFields ?? []
      const parts = []
      for (const field of fields) {
        if (field.type === 'boolean') continue
        const value = bridge.config?.[field.key]
        if (typeof value === 'string' && value !== '') parts.push(`${t(field.labelKey ?? field.key)}: ${value}`)
      }
      return parts.join(' · ')
    }

    /**
     * Settings live in a shell overlay, not a main-panel route. Opening them
     * never changes the current conversation; closing returns to exactly the
     * previous page.
     */
    function BridgeSettingsOverlay({ t }) {
      const [open, setOpen] = useState(false)
      const [data, setData] = useState(null)
      const [loading, setLoading] = useState(false)
      const [view, setView] = useState('list')
      const [editingId, setEditingId] = useState(null)
      const [name, setName] = useState('')
      const [mode, setMode] = useState('cli')
      const [engineId, setEngineId] = useState('pi')
      const [config, setConfig] = useState({})
      const [saving, setSaving] = useState(false)
      const [error, setError] = useState(null)
      const [notice, setNotice] = useState(null)

      const load = useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
          setData(await api('settings'))
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setLoading(false)
        }
      }, [])

      useEffect(() => {
        const onOpen = () => {
          setOpen(true)
          setView('list')
          setError(null)
          setNotice(null)
          load()
        }
        window.addEventListener(SETTINGS_EVENT, onOpen)
        return () => window.removeEventListener(SETTINGS_EVENT, onOpen)
      }, [load])

      const engines = Array.isArray(data?.engines) ? data.engines : []
      const bridges = Array.isArray(data?.bridges) ? data.bridges : []
      const modes = Array.isArray(data?.modes) ? data.modes : []
      const selectedEngine = engines.find((engine) => engine.id === engineId)

      const startCreate = () => {
        const firstMode = 'cli'
        const firstEngine = engines.find((engine) => engine.mode === firstMode) ?? engines[0]
        setEditingId(null)
        setName('')
        setMode(firstEngine?.mode ?? firstMode)
        setEngineId(firstEngine?.id ?? '')
        setConfig({ ...(firstEngine?.defaultConfig ?? {}) })
        setView('form')
        setError(null)
        setNotice(null)
      }

      const startEdit = (bridge) => {
        setEditingId(bridge.id)
        setName(bridge.name)
        setMode(bridge.mode)
        setEngineId(bridge.engine)
        setConfig({ ...(bridge.config ?? {}) })
        setView('form')
        setError(null)
        setNotice(null)
      }

      const chooseMode = (nextMode) => {
        const nextEngine = engines.find((engine) => engine.mode === nextMode)
        setMode(nextMode)
        setEngineId(nextEngine?.id ?? '')
        setConfig({ ...(nextEngine?.defaultConfig ?? {}) })
      }

      const chooseEngine = (id) => {
        const engine = engines.find((candidate) => candidate.id === id)
        setEngineId(id)
        if (engine !== undefined) setConfig({ ...engine.defaultConfig })
      }

      const save = async () => {
        if (selectedEngine === undefined) return
        setSaving(true)
        setError(null)
        setNotice(null)
        try {
          const payload = { name, mode, engine: engineId, config }
          if (editingId !== null) payload.id = editingId
          const body = await api('bridges', {
            method: editingId === null ? 'POST' : 'PUT',
            body: JSON.stringify(payload),
          })
          setData(body)
          setView('list')
          setNotice(editingId === null ? t('bridgeCreated') : t('bridgeUpdated'))
          notifyBridgeConfigChanged(body)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setSaving(false)
        }
      }

      const remove = async (bridge) => {
        if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(t('deleteBridgeConfirm'))) return
        setError(null)
        setNotice(null)
        try {
          const body = await api('bridges', {
            method: 'DELETE',
            body: JSON.stringify({ id: bridge.id }),
          })
          setData(body)
          setNotice(t('bridgeDeleted'))
          notifyBridgeConfigChanged(body)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }

      let right
      if (view === 'form') {
        if (selectedEngine === undefined) {
          right = h('div', { className: 'dshBridge_settingsEmpty' }, t('loading'))
        } else {
          const engineOptions = engines.filter((engine) => engine.mode === mode)
          right = h(
            'div',
            { className: 'dshBridge_bridgeForm' },
            h(
              'div',
              { className: 'dshBridge_formHead' },
              h('div', { className: 'dshBridge_formTitle' }, editingId === null ? t('addBridge') : t('editBridge')),
              h('button', { type: 'button', className: 'dshBridge_linkButton', onClick: () => setView('list') }, t('dialogCancel')),
            ),
            h(
              'div',
              { className: 'dshBridge_field' },
              h('div', { className: 'dshBridge_label' }, t('bridgeName')),
              h('input', {
                className: 'dshBridge_input',
                value: name,
                placeholder: t('bridgeNamePlaceholder'),
                onChange: (event) => setName(event.target.value),
              }),
            ),
            h(
              'div',
              { className: 'dshBridge_field' },
              h('div', { className: 'dshBridge_label' }, t('bridgeMode')),
              h(
                'div',
                { className: 'dshBridge_chipRow' },
                ...modes.map((entry) =>
                  h(
                    'button',
                    {
                      key: entry.id,
                      type: 'button',
                      className: 'dshBridge_chip',
                      'data-selected': mode === entry.id ? 'true' : undefined,
                      onClick: () => chooseMode(entry.id),
                    },
                    entry.id === 'cli' ? t('modeCli') : t('modeWeb'),
                  ),
                ),
              ),
            ),
            h(
              'div',
              { className: 'dshBridge_field' },
              h('div', { className: 'dshBridge_label' }, t('bridgeEngine')),
              h(
                'div',
                { className: 'dshBridge_chipRow' },
                ...engineOptions.map((engine) =>
                  h(
                    'button',
                    {
                      key: engine.id,
                      type: 'button',
                      className: 'dshBridge_chip',
                      'data-selected': engineId === engine.id ? 'true' : undefined,
                      onClick: () => chooseEngine(engine.id),
                    },
                    engine.label,
                    engine.available === false ? h('span', { className: 'dshBridge_chipMeta' }, t('bridgeUnavailable')) : null,
                  ),
                ),
              ),
            ),
            selectedEngine.available === false
              ? h('div', { className: 'dshBridge_desc dshBridge_warning' }, `${t('bridgeUnavailableHint')} ${selectedEngine.unavailableReason ?? ''}`)
              : null,
            ...(selectedEngine.configFields ?? []).map((field) =>
              h(ConfigField, {
                key: field.key,
                field,
                value: config[field.key],
                configured: editingId !== null && bridges.find((bridge) => bridge.id === editingId)?.configured?.[field.key] === true,
                disabled: saving,
                onChange: (value) => setConfig((current) => ({ ...current, [field.key]: value })),
                t,
              }),
            ),
            h(
              'div',
              { className: 'dshBridge_formActions' },
              h('button', { type: 'button', className: 'dshBridge_secondaryButton', onClick: () => setView('list') }, t('dialogCancel')),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshBridge_primaryButton',
                  disabled: saving || name.trim() === '',
                  onClick: save,
                },
                saving ? t('savingBridge') : t('saveBridge'),
              ),
            ),
          )
        }
      } else {
        right = h(
          'div',
          { className: 'dshBridge_bridgeListPane' },
          h(
            'div',
            { className: 'dshBridge_formHead' },
            h('div', { className: 'dshBridge_formTitle' }, `${t('bridgeList')} · ${bridges.length}`),
            h(
              'button',
              { type: 'button', className: 'dshBridge_primaryButton', onClick: startCreate },
              h(IconPlusOutlineRegular, { size: 14 }),
              h('span', null, t('addBridge')),
            ),
          ),
          loading
            ? h('div', { className: 'dshBridge_settingsEmpty' }, t('loading'))
            : bridges.length === 0
              ? h(
                  'div',
                  { className: 'dshBridge_settingsEmpty' },
                  h('div', { className: 'dshBridge_blankTitle' }, t('noBridges')),
                  h('div', { className: 'dshBridge_blankHint' }, t('noBridgesHint')),
                )
              : h(
                  'div',
                  { className: 'dshBridge_bridgeCards' },
                  ...bridges.map((bridge) =>
                    h(
                      'article',
                      { key: bridge.id, className: 'dshBridge_bridgeCard' },
                      h(
                        'div',
                        { className: 'dshBridge_bridgeCardMain' },
                        h('div', { className: 'dshBridge_bridgeCardTitleRow' },
                          h('span', { className: 'dshBridge_bridgeCardTitle' }, bridge.name),
                          h('span', { className: 'dshBridge_tag', 'data-active': bridge.available ? 'true' : undefined },
                            bridge.available ? `${bridge.mode === 'cli' ? t('modeCli') : t('modeWeb')} · ${bridge.engineLabel}` : t('bridgeUnavailable'))),
                        h('div', { className: 'dshBridge_desc' }, bridge.description ?? ''),
                        configSummary(bridge, t) !== ''
                          ? h('div', { className: 'dshBridge_bridgeConfigSummary' }, configSummary(bridge, t))
                          : null,
                      ),
                      h(
                        'div',
                        { className: 'dshBridge_bridgeCardActions' },
                        h(
                          Tooltip,
                          { label: t('editBridge') },
                          h('button', {
                            type: 'button',
                            className: 'dshBridge_iconButton',
                            'aria-label': t('editBridge'),
                            onClick: () => startEdit(bridge),
                          }, h(IconEditOutlineRegular, { size: 14 })),
                        ),
                        h(
                          Tooltip,
                          { label: t('deleteBridge') },
                          h('button', {
                            type: 'button',
                            className: 'dshBridge_iconButton dshBridge_dangerButton',
                            'aria-label': t('deleteBridge'),
                            onClick: () => remove(bridge),
                          }, h(IconTrashOutlineRegular, { size: 14 })),
                        ),
                      ),
                    ),
                  ),
                ),
          error !== null ? h('div', { className: 'dshBridge_error' }, `${t('settingsFailed')}: ${error}`) : null,
          notice !== null ? h('div', { className: 'dshBridge_settingsNotice' }, notice) : null,
        )
      }

      return h(
        Modal,
        {
          open,
          onClose: () => setOpen(false),
          title: t('bridgeSettingsTitle'),
          closeLabel: t('settingsClose'),
        },
        h(
          'div',
          { className: 'dshBridge_settingsShell' },
          h(
            'aside',
            { className: 'dshBridge_settingsNav' },
            h('div', { className: 'dshBridge_settingsNavTitle' }, t('settingsTitle')),
            h(
              'button',
              { type: 'button', className: 'dshBridge_settingsNavItem', 'data-selected': 'true' },
              h(IconSettingsOutlineRegular, { size: 15 }),
              h('span', null, t('bridgeSettingsGeneral')),
            ),
            h('div', { className: 'dshBridge_settingsNavHint' }, t('bridgeSettingsGeneralHint')),
          ),
          h('div', { className: 'dshBridge_settingsMain' }, right),
        ),
      )
    }

    /**
     * Brand-mark switcher. "Local" is always the first row and returns to the
     * dsh conversation; below it are user-configured bridge instances.
     */
    function BridgeBrandSwitcher({ size, t, onSelectBridge, onSelectLocal }) {
      const ui = useBridgeUi()
      const [open, setOpen] = useState(false)
      const [data, setData] = useState(null)
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState(null)

      const load = useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
          setData(await api('settings'))
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setLoading(false)
        }
      }, [])

      useEffect(() => {
        const onChanged = () => load()
        window.addEventListener(CONFIG_CHANGED_EVENT, onChanged)
        return () => window.removeEventListener(CONFIG_CHANGED_EVENT, onChanged)
      }, [load])

      const toggleOpen = () => {
        const next = !open
        setOpen(next)
        if (next) load()
      }

      const bridges = Array.isArray(data?.bridges) ? data.bridges : []
      const items = [
        {
          id: '__local__',
          icon: h(FishLogo, { size: 15 }),
          label: h('span', { className: 'dshBridge_menuLabel' }, t('local')),
        },
        { type: 'separator', id: '__local-separator__' },
        ...bridges.map((bridge) => ({
          id: bridge.id,
          icon: h(IconApiOutlineRegular, { size: 15 }),
          disabled: bridge.available === false,
          label: h(
            'span',
            { className: 'dshBridge_menuLabel' },
            h('span', { className: 'dshBridge_menuName' }, bridge.name),
            h('span', { className: 'dshBridge_menuMeta' },
              bridge.available === false ? t('bridgeUnavailable') : `${bridge.mode === 'cli' ? t('modeCli') : t('modeWeb')} · ${bridge.engineLabel}`),
          ),
        })),
      ]
      if (bridges.length === 0 && !loading) {
        items.push({ type: 'label', id: '__empty__', text: t('noBridges') })
      }

      const select = (id) => {
        if (id === '__settings__') {
          setOpen(false)
          openBridgeSettings()
          return
        }
        setOpen(false)
        if (id === '__local__') {
          bridgeUi.set({ bridge: null, sessions: [], workspaces: [], selectedKey: null, search: '', loadError: null, loading: false })
          onSelectLocal()
          return
        }
        const bridge = bridges.find((entry) => entry.id === id)
        if (bridge === undefined || bridge.available === false) return
        bridgeUi.set({ bridge, sessions: [], workspaces: [], selectedKey: null, search: '', loadError: null, loading: true })
        onSelectBridge(bridge)
      }

      const anchor = h(
        'span',
        {
          className: 'dshBridge_brandSwitcher',
          role: 'button',
          tabIndex: 0,
          'aria-label': t('bridgeMenu'),
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          title: error ?? t('bridgeMenu'),
          onClick: (event) => {
            event.preventDefault()
            event.stopPropagation()
            toggleOpen()
          },
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              event.stopPropagation()
              toggleOpen()
            }
          },
        },
        h(FishLogo, { size }),
        h('span', { className: 'dshBridge_brandChevron' }, h(IconChevronDownOutlineRegular, { size: 9 })),
      )

      return h(Menu, {
        open,
        onClose: () => setOpen(false),
        selectedId: ui.bridge?.id ?? '__local__',
        items,
        onSelect: select,
        portal: true,
        align: 'start',
        className: 'dshBridge_brandMenuAnchor',
        footer: [
          {
            id: '__settings__',
            label: t('bridgeSettingsTitle'),
            icon: h(IconSettingsOutlineRegular, { size: 15 }),
          },
        ],
        anchor,
      })
    }

    /**
     * The `sidebar.workspaces` occupant while the Bridge panel is active.
     * It reuses dsh's sidebar geometry and tokens, and reads the same external
     * store as the BridgePage so selecting a row opens its conversation.
     */
    function BridgeWorkspaceList({ wide, expandSidebar, t }) {
      const ui = useBridgeUi()
      const groups = useMemo(() => {
        const known = new Map(ui.workspaces.map((workspace) => [workspace.id, workspace]))
        const query = ui.search.trim().toLowerCase()
        const matches = ui.sessions.filter((session) => {
          if (query === '') return true
          const haystack = [session.name, session.cwd, session.firstMessage, session.id].filter(Boolean).join('\n').toLowerCase()
          return haystack.includes(query)
        })
        const byKey = new Map()
        for (const session of matches) {
          const key = session.workspaceId ?? session.workspaceName ?? session.cwd ?? ''
          if (!byKey.has(key)) {
            byKey.set(key, {
              id: key,
              name: known.get(key)?.name ?? key,
              sessions: [],
            })
          }
          byKey.get(key).sessions.push(session)
        }
        return [...byKey.values()].sort((left, right) => left.name.localeCompare(right.name))
      }, [ui.search, ui.sessions, ui.workspaces])

      if (!wide) {
        return h(
          'div',
          { className: 'dshBridge_railWorkspace' },
          h(
            Tooltip,
            { label: t('search') },
            h(
              'button',
              {
                type: 'button',
                className: 'dshBridge_railButton',
                'aria-label': t('openSettings'),
                onClick: expandSidebar,
              },
              h(IconSearchSmall),
            ),
          ),
        )
      }

      let body
      if (ui.bridge === null) {
        body = h(
          'div',
          { className: 'dshBridge_sideNote' },
          h('div', { className: 'dshBridge_sideNoteTitle' }, t('bridgeMenu')),
          h('div', null, t('bridgeSettingsHint')),
        )
      } else if (ui.loading) {
        body = h('div', { className: 'dshBridge_sideNote' }, t('loading'))
      } else if (ui.loadError !== null) {
        body = h('div', { className: 'dshBridge_sideNote dshBridge_errorText' }, `${t('loadFailed')}: ${ui.loadError}`)
      } else if (ui.bridge.available === false) {
        body = h(
          'div',
          { className: 'dshBridge_sideNote' },
          h('div', { className: 'dshBridge_sideNoteTitle' }, `${ui.bridge.name} · ${t('bridgeUnavailable')}`),
          h('div', null, ui.bridge.unavailableReason ?? t('bridgeUnavailableHint')),
        )
      } else if (groups.length === 0) {
        body = h(
          'div',
          { className: 'dshBridge_sideNote' },
          h('div', { className: 'dshBridge_sideNoteTitle' }, ui.sessions.length === 0 ? t('empty') : t('noMatches')),
          h('div', null, ui.sessions.length === 0 ? t('emptyHint') : t('searchPlaceholder')),
        )
      } else {
        body = h(
          React.Fragment,
          null,
          ...groups.map((group) =>
            h(
              'section',
              { key: group.id || '__ungrouped__', className: 'dshBridge_sideGroup' },
              h(
                'div',
                { className: 'dshBridge_sideGroupHead' },
                h('span', { className: 'dshBridge_sideGroupName', title: group.name }, group.name === '' ? t('noWorkspace') : group.name),
                h('span', { className: 'dshBridge_sideGroupCount' }, String(group.sessions.length)),
              ),
              ...group.sessions.map((session) =>
                h(
                  'button',
                  {
                    key: session.key,
                    type: 'button',
                    className: 'dshBridge_sideRow',
                    'aria-current': session.key === ui.selectedKey ? 'true' : undefined,
                    onClick: () => bridgeUi.selectSession(session.key),
                  },
                  h(
                    'span',
                    { className: 'dshBridge_sideRowTop' },
                    h('span', { className: 'dshBridge_sideRowTitle' }, session.name ?? session.firstMessage ?? session.id ?? t('panel')),
                    session.modified ? h('span', { className: 'dshBridge_sideRowTime' }, formatTime(session.modified)) : null,
                  ),
                  session.firstMessage && session.firstMessage !== session.name
                    ? h('span', { className: 'dshBridge_sideRowPreview' }, session.firstMessage)
                    : null,
                ),
              ),
            ),
          ),
        )
      }

      return h(
        'div',
        { className: 'dshBridge_sideWorkspace', 'aria-label': t('workspaces') },
        h(
          'div',
          { className: 'dshBridge_sideHead' },
          h('span', { className: 'dshBridge_sideHeadTitle' }, t('workspaces')),
          h('span', { className: 'dshBridge_sideHeadBackend' }, ui.bridge?.name ?? ''),
          h(
            'button',
            {
              type: 'button',
              className: 'dshBridge_sideIconButton',
              'aria-label': t('refresh'),
              disabled: ui.loading,
              onClick: () => bridgeUi.refresh(),
            },
            h(IconRefreshOutlineRegular, { size: 14 }),
          ),
        ),
        h(
          'div',
          { className: 'dshBridge_sideSearchWrap' },
          h('input', {
            className: 'dshBridge_sideSearch',
            type: 'search',
            value: ui.search,
            placeholder: t('searchPlaceholder'),
            'aria-label': t('search'),
            onChange: (event) => bridgeUi.set({ search: event.target.value }),
          }),
        ),
        h('div', { className: 'dshBridge_sideList' }, body),
        h(
          'button',
          {
            type: 'button',
            className: 'dshBridge_sideSettings',
            onClick: openBridgeSettings,
          },
          h(IconSettingsOutlineRegular, { size: 15 }),
          h('span', null, t('manageBridges')),
        ),
      )
    }

    function BridgePage(props) {
      const { t } = props
      const ui = useBridgeUi()
      const { bridge, sessions, selectedKey, loading } = ui
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

      const bridgeId = bridge?.id ?? null
      const loadSessions = useCallback(async () => {
        if (bridgeId === null) {
          bridgeUi.set({ sessions: [], workspaces: [], loading: false, loadError: null })
          return
        }
        bridgeUi.set({ loading: true, loadError: null })
        try {
          const body = await api(`sessions?bridge=${encodeURIComponent(bridgeId)}`)
          bridgeUi.set({
            bridge: body.bridge ?? bridgeUi.state.bridge,
            sessions: Array.isArray(body.sessions) ? body.sessions : [],
            workspaces: Array.isArray(body.workspaces) ? body.workspaces : [],
          })
        } catch (error) {
          bridgeUi.set({
            sessions: [],
            workspaces: [],
            loadError: error instanceof Error ? error.message : String(error),
          })
        } finally {
          bridgeUi.set({ loading: false })
        }
      }, [bridgeId])

      useEffect(() => {
        loadSessions()
      }, [loadSessions])

      useEffect(() => {
        const onNotice = (event) => {
          const detail = event?.detail ?? {}
          if (typeof detail.text === 'string' && detail.text !== '') {
            showNotice(detail.text, detail.error === true)
          }
        }
        const onConfigChanged = (event) => {
          const current = bridgeUi.state.bridge
          if (current === null) return
          const next = Array.isArray(event?.detail?.bridges)
            ? event.detail.bridges.find((entry) => entry.id === current.id)
            : undefined
          if (next === undefined) {
            bridgeUi.set({ bridge: null, sessions: [], workspaces: [], selectedKey: null, search: '' })
            selectedKeyRef.current = null
            setDetail(null)
            setTranscript([])
            setAttached(false)
            return
          }
          bridgeUi.set({ bridge: next })
          loadSessions()
        }
        window.addEventListener('bridge:notice', onNotice)
        window.addEventListener(CONFIG_CHANGED_EVENT, onConfigChanged)
        return () => {
          window.removeEventListener('bridge:notice', onNotice)
          window.removeEventListener(CONFIG_CHANGED_EVENT, onConfigChanged)
        }
      }, [loadSessions, showNotice])

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
          bridgeUi.set({ selectedKey: key })
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

      useEffect(() => {
        bridgeUi.selectHandler = (key) => openSession(key)
        bridgeUi.refreshHandler = () => loadSessions()
        return () => {
          bridgeUi.selectHandler = null
          bridgeUi.refreshHandler = null
        }
      }, [loadSessions, openSession])

      const applyBridgeEvent = useCallback((record) => {
        const event = record?.type
        if (event === 'agent-start') {
          setState((current) => (current === null ? current : { ...current, isStreaming: true }))
        } else if (event === 'agent-end') {
          setState((current) => (current === null ? current : { ...current, isStreaming: false }))
        } else if (event === 'message-start') {
          if (record.message?.role === 'assistant') setStreamingMessage({ ...record.message })
        } else if (event === 'message-update') {
          if (record.message?.role === 'assistant') setStreamingMessage({ ...record.message })
        } else if (event === 'message-end') {
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
        } else if (event === 'tool-start') {
          setTranscript((current) => [
            ...current,
            { kind: 'tool', id: record.toolCallId ?? `tool-${Date.now()}`, toolCallId: record.toolCallId, name: record.name, arguments: record.arguments, output: '', status: 'running' },
          ])
        } else if (event === 'tool-update') {
          const partial = typeof record.partialResult === 'string' ? record.partialResult : textOf(record.partialResult?.content)
          setTranscript((current) =>
            current.map((item) =>
              item.kind === 'tool' && item.toolCallId === record.toolCallId
                ? { ...item, output: partial !== '' ? partial : item.output }
                : item,
            ),
          )
        } else if (event === 'tool-end') {
          const output = typeof record.result === 'string' ? record.result : textOf(record.result?.content)
          setTranscript((current) =>
            current.map((item) =>
              item.kind === 'tool' && item.toolCallId === record.toolCallId
                ? { ...item, status: record.isError === true ? 'error' : 'done', output: output !== '' ? output : item.output }
                : item,
            ),
          )
        } else if (event === 'session-name') {
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
                if (record.event === 'bridge-event') applyBridgeEvent(record.data)
              }
            }
          })
          source.addEventListener('bridge-event', (message) => {
            try {
              applyBridgeEvent(JSON.parse(message.data))
            } catch {
              // Ignore a malformed frame; the next event repairs the view.
            }
          })
          source.addEventListener('bridge-ui-request', (message) => {
            try {
              setDialog(JSON.parse(message.data))
            } catch {
              // Ignore malformed extension requests.
            }
          })
          source.addEventListener('bridge-ui-notification', (message) => {
            try {
              const payload = JSON.parse(message.data)
              if (typeof payload?.message === 'string') {
                showNotice(`${t('notification')}: ${payload.message}`, payload.notifyType === 'error')
              }
            } catch {
              // Ignore malformed notifications.
            }
          })
          source.addEventListener('bridge-exit', () => {
            setAttached(false)
            setStreamingMessage(null)
          })
        },
        [applyBridgeEvent, showNotice, t],
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
              ? [bridge?.name, bridge?.engineLabel, t('subtitle')].filter(Boolean).join(' · ')
              : [bridge?.name, selectedSession?.cwd, attached ? (isStreaming ? t('running') : t('idle')) : t('notAttached')].filter(Boolean).join(' · ')),
          h('span', { className: 'dshBridge_headSpacer' }),
          selectedKey === null ? null : attached
            ? h(Button, { key: 'detach', variant: 'ghost', size: 'sm', onClick: detach }, t('detach'))
            : h(Button, { key: 'attach', variant: 'primary', size: 'sm', onClick: attach, disabled: attaching || detailLoading || detail === null }, attaching ? t('attaching') : t('attach')),
          h('button', {
            key: 'refresh',
            type: 'button',
            className: 'dshBridge_iconButton',
            'aria-label': t('refresh'),
            onClick: loadSessions,
            disabled: loading,
          }, h(IconRefreshOutlineRegular, { size: 16 })),
          h('button', {
            key: 'settings',
            type: 'button',
            className: 'dshBridge_iconButton',
            'aria-label': t('settings'),
            'aria-haspopup': 'dialog',
            onClick: openBridgeSettings,
          }, h(IconSettingsOutlineRegular, { size: 16 })),
        ),
        notice !== null ? h('div', { className: 'dshBridge_notice', 'data-error': noticeError ? 'true' : undefined }, notice) : null,
        streamState === 'disconnected' ? h('div', { className: 'dshBridge_notice' }, t('eventsDisconnected')) : null,
        h(
          'div',
          { className: 'dshBridge_body' },
          h(
            'div',
            { className: 'dshBridge_centre' },
            h(
              'div',
              { className: 'dshBridge_scroll', ref: scrollRef, onScroll },
              selectedKey === null
                ? h('div', { className: 'dshBridge_blank' },
                    h('div', { className: 'dshBridge_blankTitle' },
                      bridge === null
                        ? t('bridgeMenu')
                        : bridge.available === false
                          ? `${bridge.name} · ${t('bridgeUnavailable')}`
                          : sessions.length === 0 ? t('empty') : t('selectHint')),
                    h('div', { className: 'dshBridge_blankHint' },
                      bridge === null
                        ? t('bridgeSettingsHint')
                        : bridge.available === false ? (bridge.unavailableReason ?? t('bridgeUnavailableHint')) : t('emptyHint')))
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

      const openPanel = () => {
        try {
          ctx.layout?.selectPanel(PANEL_ID)
        } catch {
          // The panel may not be available during shell startup.
        }
      }

      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, BridgePage))
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          { name: 'shell.overlay', id: 'bridge-settings', locale: NS },
          function BridgeSettingsSeat() {
            return h(BridgeSettingsOverlay, { t })
          },
        ),
      )
      ctx.slots.inject('sidebar.brand.mark', () =>
        ctx.slots.register(
          { name: 'sidebar.brand.mark', locale: NS, priority: -1 },
          function BridgeBrandSeat({ size }) {
            return h(BridgeBrandSwitcher, {
              size,
              t,
              onSelectBridge: openPanel,
              onSelectLocal: () => {
                try {
                  ctx.layout?.selectPanel(null)
                } catch {
                  // Conversation may already be active.
                }
              },
            })
          },
        ),
      )

      // While the Bridge panel is active, shadow the stock workspace browser
      // with the active bridge's session list. Disposing the entry restores
      // the stock browser when the user returns to Conversation.
      ctx.slots.inject('sidebar.workspaces', () => {
        let dispose
        const sync = () => {
          const active = ctx.layout.panelInfo.getSnapshot().activePanelId === PANEL_ID
          if (active && dispose === undefined) {
            dispose = ctx.slots.register(
              { name: 'sidebar.workspaces', locale: NS, priority: -1 },
              BridgeWorkspaceList,
            )
          } else if (!active && dispose !== undefined) {
            dispose()
            dispose = undefined
          }
        }
        const unsubscribe = ctx.layout.panelInfo.subscribe(sync)
        sync()
        return () => {
          unsubscribe()
          dispose?.()
          dispose = undefined
        }
      })
    }

    exports.apply = apply
    exports.inject = ['slots', 'locale', 'layout']
    exports.__test = { textOf, formatTime, formatBytes, safeJson }
    return module.exports
  },
})
