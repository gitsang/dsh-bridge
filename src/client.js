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
      DiffBlock,
      DisclosureRow,
      HoverCard,
      IconApiOutlineRegular,
      IconArchiveOutlineRegular,
      IconArchiveOffOutlineRegular,
      IconArchiveCheckOutlineRegular,
      IconBrowseOutlineRegular,
      IconCheckOutlineRegular,
      IconChevronDownOutlineRegular,
      IconChevronRightOutlineRegular,
      IconChevronsUpDownOutlineRegular,
      IconClockOutlineRegular,
      IconCloseFillRegular,
      IconCloseOutlineRegular,
      IconCodeOutlineRegular,
      IconEditOutlineRegular,
      IconEllipsisOutlineRegular,
      IconFlatListOutlineRegular,
      IconDatabaseOutlineRegular,
      IconFolderCloseRegular,
      IconFolderOpenRegular,
      IconGaugeOutlineRegular,
      IconNewChatOutlineRegular,
      IconPlusOutlineRegular,
      IconProjectAddOutlineRegular,
      IconQueueOutlineRegular,
      IconRefreshOutlineRegular,
      IconSearchOutlineRegular,
      IconSettingsOutlineRegular,
      IconSlidersTwoOutlineRegular,
      IconSparkleRegular,
      IconThinkOutlineRegular,
      IconTrashOutlineRegular,
      IconTriangleRightFillRegular,
      IconWorkspaceTreeOutlineRegular,
      FishLogo,
      MarkdownText,
      Menu,
      Modal,
      Switch,
      TerminalBlock,
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
        removedWorkspacePaths: [],
        loading: false,
        loadError: null,
        selectedKey: null,
        search: '',
        searchExpanded: false,
        groupBy: 'workspace',
        orderBy: 'updated',
        archivedFilter: 'default',
        groupExpansion: {},
        sessionOrderByAccount: {},
        archivedKeys: [],
        extraWorkspaces: [],
        activityByKey: {},
        activityLoaded: false,
        home: null,
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
      hydrateView(bridgeId) {
        const view = readStoredView(bridgeId)
        this.set({
          groupBy: view.groupBy,
          orderBy: view.orderBy,
          archivedFilter: view.archivedFilter,
          groupExpansion: view.groupExpansion,
          sessionOrderByAccount: view.sessionOrderByAccount,
          archivedKeys: view.archivedKeys,
          extraWorkspaces: view.extraWorkspaces,
          search: '',
          searchExpanded: false,
        })
      },
      setView(patch) {
        this.set(patch)
        const state = this.state
        writeStoredView(state.bridge?.id ?? null, {
          groupBy: state.groupBy,
          orderBy: state.orderBy,
          archivedFilter: state.archivedFilter,
          groupExpansion: state.groupExpansion,
          sessionOrderByAccount: state.sessionOrderByAccount,
          extraWorkspaces: state.extraWorkspaces,
        })
      },
    }

    function openBridgeSettings() {
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(SETTINGS_EVENT))
    }

    function notifyBridgeConfigChanged(payload) {
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(CONFIG_CHANGED_EVENT, { detail: payload }))
    }

    function connectionState(bridge, t) {
      const connection = bridge?.connection ?? { state: 'idle' }
      const state = connection.state ?? 'idle'
      const label = state === 'connected'
        ? t('connectionConnected')
        : state === 'connecting'
          ? t('connectionConnecting')
          : state === 'failed'
            ? t('connectionFailed')
            : t('connectionIdle')
      return { state, label, error: connection.error ?? null }
    }

    function StatusDot({ state, label, selected = false }) {
      return h(
        'span',
        {
          className: 'dshBridge_statusDotSlot',
          'data-selected': selected ? 'true' : 'false',
          role: 'img',
          'aria-label': label,
          title: label,
        },
        h('span', { className: 'dshBridge_statusDot', 'data-state': state }),
      )
    }

    function useBridgeUi() {
      const [state, setState] = useState(bridgeUi.state)
      useEffect(() => bridgeUi.subscribe(() => setState(bridgeUi.state)), [])
      return state
    }

    const WORKSPACE_VIEW_STORAGE = 'dsh.bridge.workspace.view.v1'
    const FLAT_ORDER_KEY = '__flat_session_order__'
    const SEARCH_SLIDE_MS = 300
    /** Match dsh-web conversations: both surfaces share one persisted width. */
    const CONTENT_WIDTH_STORAGE = 'dsh.conversation.contentWidth'
    const CONTENT_MIN = 640
    const CONTENT_EDGE_BUDGET = 176
    const WHEEL_DELTA_LINE = 1
    const WHEEL_DELTA_PAGE = 2
    const FALLBACK_WHEEL_LINE_PX = 16

    function readContentWidthPreference() {
      try {
        const raw = window?.localStorage?.getItem(CONTENT_WIDTH_STORAGE)
        if (raw === null || raw === undefined || raw === '') return null
        const value = Number(raw)
        return Number.isFinite(value) && value > 0 ? value : null
      } catch {
        return null
      }
    }

    function writeContentWidthPreference(width) {
      try {
        window?.localStorage?.setItem(CONTENT_WIDTH_STORAGE, `${width}`)
      } catch {
        // Private browsing/storage pressure must not break resizing.
      }
    }

    /** Resolve a stored/dragged preference against the current panel width. */
    function resolveContentWidth(columnWidth, preference) {
      const max = Math.max(CONTENT_MIN, columnWidth - CONTENT_EDGE_BUDGET)
      if (preference !== null) return Math.min(Math.max(preference, CONTENT_MIN), max)
      return Math.max(680, Math.min(columnWidth * .64, 920))
    }

    function wheelDeltaY(event, scrollport) {
      if (event.deltaMode === WHEEL_DELTA_LINE) {
        const lineHeight = Number.parseFloat(getComputedStyle(scrollport).lineHeight)
        return event.deltaY * (Number.isFinite(lineHeight) ? lineHeight : FALLBACK_WHEEL_LINE_PX)
      }
      if (event.deltaMode === WHEEL_DELTA_PAGE) return event.deltaY * scrollport.clientHeight
      return event.deltaY
    }

    function readStoredView(bridgeId) {
      const fallback = {
        groupBy: 'workspace',
        orderBy: 'updated',
        archivedFilter: 'default',
        groupExpansion: {},
        sessionOrderByAccount: {},
        archivedKeys: [],
        extraWorkspaces: [],
      }
      try {
        const raw = window?.localStorage?.getItem(`${WORKSPACE_VIEW_STORAGE}:${bridgeId ?? 'none'}`)
        if (typeof raw !== 'string' || raw === '') return fallback
        const stored = JSON.parse(raw)
        if (stored === null || typeof stored !== 'object') return fallback
        return {
          ...fallback,
          ...stored,
          groupBy: ['workspace', 'workspace-tree', 'flat'].includes(stored.groupBy) ? stored.groupBy : fallback.groupBy,
          orderBy: ['manual', 'updated'].includes(stored.orderBy) ? stored.orderBy : fallback.orderBy,
          archivedFilter: ['default', 'show', 'only'].includes(stored.archivedFilter) ? stored.archivedFilter : fallback.archivedFilter,
          groupExpansion: stored.groupExpansion && typeof stored.groupExpansion === 'object' ? stored.groupExpansion : {},
          sessionOrderByAccount: stored.sessionOrderByAccount && typeof stored.sessionOrderByAccount === 'object' ? stored.sessionOrderByAccount : {},
          // Archive state is host-owned now. Ignore legacy browser-local keys
          // so a stale tab cannot resurrect an old archive decision.
          archivedKeys: [],
          extraWorkspaces: Array.isArray(stored.extraWorkspaces)
            ? stored.extraWorkspaces.filter((workspace) => workspace && typeof workspace.path === 'string' && workspace.path !== '')
            : [],
        }
      } catch {
        return fallback
      }
    }

    function writeStoredView(bridgeId, view) {
      try {
        window?.localStorage?.setItem(`${WORKSPACE_VIEW_STORAGE}:${bridgeId ?? 'none'}`, JSON.stringify(view))
      } catch {
        // Private browsing/storage pressure must not break the sidebar.
      }
    }

    function workspaceTitleOf(path) {
      if (typeof path !== 'string') return ''
      const trimmed = path.replace(/[/\\]+$/, '')
      const separator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
      return trimmed.slice(separator + 1)
    }

    function workspaceLabel(path) {
      return workspaceTitleOf(path) || path || ''
    }

    function folderPath(path) {
      if (typeof path !== 'string') return ''
      return (/^[A-Za-z]:[/\\]/.test(path) || path.startsWith('\\\\') ? path.replaceAll('\\', '/') : path).replace(/\/+$/, '')
    }

    function owningParentFolder(path, parents) {
      const child = folderPath(path)
      let owner
      let length = -1
      for (const parent of parents) {
        const root = folderPath(parent)
        if (root.length > length && child !== root && child.startsWith(`${root}/`)) {
          owner = parent
          length = root.length
        }
      }
      return owner
    }

    function compareSessionsByUpdated(left, right) {
      const leftTime = Date.parse(left.modified ?? left.created ?? '') || 0
      const rightTime = Date.parse(right.modified ?? right.created ?? '') || 0
      if (leftTime !== rightTime) return rightTime - leftTime
      return String(left.key).localeCompare(String(right.key))
    }

    function reconcileSessionOrder(members, savedOrder, byKey) {
      const memberSet = new Set(members.map((session) => session.key))
      const included = new Set()
      const ordered = []
      for (const key of Array.isArray(savedOrder) ? savedOrder : []) {
        if (!memberSet.has(key) || included.has(key)) continue
        ordered.push(key)
        included.add(key)
      }
      const missing = members.filter((session) => !included.has(session.key)).sort(compareSessionsByUpdated)
      return [...ordered, ...missing.map((session) => session.key)]
    }

    function relativeTime(value, now, t) {
      const time = Date.parse(value ?? '')
      if (!Number.isFinite(time)) return ''
      const seconds = Math.max(0, Math.floor((now - time) / 1000))
      if (seconds < 60) return t('timeNow')
      const minutes = Math.floor(seconds / 60)
      if (minutes < 60) return t('timeAgo').replace('{t}', t('timeMinutes').replace('{n}', String(minutes)))
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return t('timeAgo').replace('{t}', t('timeHours').replace('{n}', String(hours)))
      const days = Math.floor(hours / 24)
      if (days < 30) return t('timeAgo').replace('{t}', t('timeDays').replace('{n}', String(days)))
      const months = Math.floor(days / 30)
      if (months < 12) return t('timeAgo').replace('{t}', t('timeMonths').replace('{n}', String(months)))
      return t('timeAgo').replace('{t}', t('timeYears').replace('{n}', String(Math.floor(months / 12))))
    }

    function pathCrumbs(path, home, homeLabel) {
      if (typeof path !== 'string' || path === '') return []
      const windows = /^[A-Za-z]:[/\\]/.test(path) || path.startsWith('\\\\')
      const separator = windows ? '\\' : '/'
      const normalized = path.replace(/[/\\]+$/, '')
      const cleanHome = typeof home === 'string' ? home.replace(/[/\\]+$/, '') : ''
      const underHome = cleanHome !== '' && (normalized === cleanHome || normalized.startsWith(`${cleanHome}${separator}`))
      const remainder = underHome ? normalized.slice(cleanHome.length).replace(/^[/\\]+/, '') : normalized
      const pieces = remainder.split(/[/\\]+/).filter(Boolean)
      const crumbs = []
      if (underHome) {
        crumbs.push({ name: homeLabel, path: cleanHome })
      } else if (windows) {
        const drive = pieces.shift()
        if (drive !== undefined) crumbs.push({ name: drive, path: `${drive}\\` })
      } else {
        crumbs.push({ name: '/', path: '/' })
      }
      let current = crumbs.length > 0 ? crumbs[0].path : ''
      for (const piece of pieces) {
        current = current === '' || current === '/' || current.endsWith('\\')
          ? `${current}${piece}`
          : `${current}${separator}${piece}`
        crumbs.push({ name: piece, path: current })
      }
      return crumbs
    }

    function BridgeViewOptionsMenu({ groupBy, orderBy, archivedFilter, onGroupPick, onOrderPick, onArchivedFilterPick, t }) {
      const [open, setOpen] = useState(false)
      const items = [
        { type: 'label', id: 'group-by', text: t('groupBy') },
        { id: 'workspace', label: t('groupByWorkspace'), icon: h(IconFolderCloseRegular, {}) },
        { id: 'workspace-tree', label: t('groupByWorkspaceTree'), icon: h(IconWorkspaceTreeOutlineRegular, {}) },
        { id: 'flat', label: t('groupByFlat'), icon: h(IconFlatListOutlineRegular, {}) },
        { type: 'separator', id: 'order-by-separator' },
        { type: 'label', id: 'order-by', text: t('orderBy') },
        { id: 'manual', label: t('orderByManual'), icon: h(IconChevronsUpDownOutlineRegular, {}) },
        { id: 'updated', label: t('orderByUpdated'), icon: h(IconClockOutlineRegular, {}) },
        { type: 'separator', id: 'archived-filter-separator' },
        { type: 'label', id: 'filter-by', text: t('filterBy') },
        { id: 'hide-archived', label: t('hideArchived'), icon: h(IconArchiveOffOutlineRegular, {}) },
        { id: 'show-archived', label: t('showArchived'), icon: h(IconQueueOutlineRegular, {}) },
        { id: 'only-archived', label: t('onlyArchived'), icon: h(IconArchiveCheckOutlineRegular, {}) },
      ]
      return h(Menu, {
        open,
        onClose: () => setOpen(false),
        items,
        selectedIds: [
          groupBy,
          orderBy,
          { default: 'hide-archived', show: 'show-archived', only: 'only-archived' }[archivedFilter],
        ],
        onSelect: (id) => {
          if (id === 'workspace' || id === 'workspace-tree' || id === 'flat') onGroupPick(id)
          else if (id === 'manual' || id === 'updated') onOrderPick(id)
          else if (id === 'hide-archived') onArchivedFilterPick('default')
          else if (id === 'show-archived') onArchivedFilterPick('show')
          else if (id === 'only-archived') onArchivedFilterPick('only')
          setOpen(false)
        },
        align: 'end',
        dense: true,
        listClassName: 'dshBridge_browser_viewOptionsMenu',
        portal: true,
        anchor: h(
          Tooltip,
          { label: t('viewOptions'), side: 'bottom', delayMs: 500 },
          h(
            'button',
            {
              type: 'button',
              className: 'dshBridge_browser_iconButton',
              'aria-label': t('viewOptions'),
              onClick: () => setOpen((value) => !value),
            },
            h(IconSlidersTwoOutlineRegular, {}),
          ),
        ),
      })
    }

    function BridgeDirectoryDialog({ open, onClose, onPick, t }) {
      const [listing, setListing] = useState(null)
      const [childListing, setChildListing] = useState(null)
      const [selected, setSelected] = useState(null)
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState(null)
      const [showHidden, setShowHidden] = useState(false)
      const [folderDraft, setFolderDraft] = useState(null)
      const [creating, setCreating] = useState(false)
      const [createError, setCreateError] = useState(null)
      const [pathDraft, setPathDraft] = useState(null)

      const loadRoot = useCallback(async (path) => {
        setLoading(true)
        setError(null)
        try {
          const suffix = path === undefined || path === null || path === '' ? '' : `?path=${encodeURIComponent(path)}`
          const body = await api(`directories${suffix}`)
          setListing(body)
          setChildListing(null)
          setSelected(null)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setLoading(false)
        }
      }, [])

      const loadChild = useCallback(async (entry) => {
        setSelected(entry)
        setLoading(true)
        setError(null)
        try {
          const body = await api(`directories?path=${encodeURIComponent(entry.path)}`)
          setChildListing(body)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setLoading(false)
        }
      }, [])

      useEffect(() => {
        if (!open) {
          setListing(null)
          setChildListing(null)
          setSelected(null)
          setFolderDraft(null)
          setCreateError(null)
          setPathDraft(null)
          setShowHidden(false)
          return
        }
        loadRoot()
      }, [open, loadRoot])

      const target = selected ?? (listing === null ? null : { name: workspaceLabel(listing.path), path: listing.path })
      const targetName = target?.name ?? ''
      const beginCreate = () => {
        setFolderDraft('')
        setCreateError(null)
      }
      const confirmCreate = async () => {
        if (target === null || folderDraft === null || creating || folderDraft.trim() === '') return
        setCreating(true)
        setCreateError(null)
        try {
          const body = await api('directories', {
            method: 'POST',
            body: JSON.stringify({ path: target.path, name: folderDraft.trim() }),
          })
          setFolderDraft(null)
          await loadRoot(target.path)
          await loadChild({ name: body.name, path: body.path, hidden: false })
        } catch (failure) {
          setCreateError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setCreating(false)
        }
      }

      const crumbs = pathCrumbs(listing?.path ?? '', listing?.home, t('folderHome'))
      const visibleEntries = (value) => (Array.isArray(value?.entries) ? value.entries : [])
        .filter((entry) => showHidden || !entry.hidden)
        .slice(0, 1000)
      const parentEntries = visibleEntries(listing)
      const childEntries = visibleEntries(childListing)
      const renderColumn = (entries, { selectedPath = null, onActivate }) =>
        h(
          'div',
          { className: 'dshBridge_dir_column', role: 'list' },
          ...entries.map((entry) =>
            h(
              'span',
              { key: entry.path, role: 'listitem', className: 'dshBridge_dir_rowSeat' },
              h(
                'button',
                {
                  type: 'button',
                  className: `dshBridge_dir_row${entry.path === selectedPath ? ' dshBridge_dir_rowSelected' : ''}`,
                  'aria-current': entry.path === selectedPath || undefined,
                  disabled: loading,
                  onClick: () => onActivate(entry),
                },
                entry.path === selectedPath
                  ? h(IconFolderOpenRegular, { size: 16, className: 'dshBridge_dir_rowIconSelected' })
                  : h(IconFolderCloseRegular, { size: 16, className: 'dshBridge_dir_rowIcon' }),
                h('span', { className: 'dshBridge_dir_rowName' }, entry.name),
                h(IconChevronRightOutlineRegular, { size: 12, className: 'dshBridge_dir_rowChevron' }),
              ),
            ),
          ),
        )

      const editor = h(
        'div',
        { className: 'dshBridge_dir_editorScope' },
        h(
          'div',
          { className: 'dshBridge_dir_header' },
          h('h2', { className: 'dshBridge_dir_title' }, t('folderPickerTitle')),
          h(
            'div',
            { className: 'dshBridge_dir_crumbBar' },
            pathDraft === null
              ? h(
                  React.Fragment,
                  null,
                  h(
                    'span',
                    { className: 'dshBridge_dir_crumbTrail', role: 'navigation' },
                    ...crumbs.map((crumb, index) =>
                      h(
                        'span',
                        { className: 'dshBridge_dir_crumbSeat', key: crumb.path },
                        index > 0 ? h(IconChevronRightOutlineRegular, { size: 12, className: 'dshBridge_dir_crumbChevron' }) : null,
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'dshBridge_dir_crumb',
                            disabled: loading,
                            onClick: () => loadRoot(crumb.path),
                          },
                          crumb.name,
                        ),
                      ),
                    ),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dshBridge_dir_crumbEditZone',
                      title: t('folderPickerTitle'),
                      'aria-label': t('folderPickerTitle'),
                      onClick: () => setPathDraft(listing?.path ?? ''),
                    },
                    h(IconEditOutlineRegular, { size: 14, className: 'dshBridge_dir_crumbEditGlyph' }),
                  ),
                )
              : h('input', {
                  className: 'dshBridge_dir_pathInput',
                  value: pathDraft,
                  'aria-label': t('folderPickerTitle'),
                  autoFocus: true,
                  onChange: (event) => setPathDraft(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Escape') {
                      setPathDraft(null)
                      return
                    }
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      loadRoot(pathDraft)
                      setPathDraft(null)
                    }
                  },
                }),
          ),
        ),
        h(
          'div',
          { className: 'dshBridge_dir_content' },
          h(
            'div',
            { className: 'dshBridge_dir_millerRow' },
            renderColumn(parentEntries, { selectedPath: selected?.path ?? null, onActivate: loadChild }),
            selected !== null && childListing !== null
              ? h(React.Fragment, null, h('span', { className: 'dshBridge_dir_divider' }), renderColumn(childEntries, { onActivate: (entry) => loadRoot(entry.path) }))
              : null,
          ),
          loading ? h('div', { className: 'dshBridge_dir_status dshBridge_dir_loadingFloat', role: 'status' }, t('folderLoading')) : null,
          listing?.truncated === true || childListing?.truncated === true
            ? h('div', { className: 'dshBridge_dir_status', role: 'status' }, t('folderTruncated'))
            : null,
          error !== null ? h('div', { className: 'dshBridge_dir_error', role: 'alert' }, error) : null,
        ),
        h(
          'div',
          { className: 'dshBridge_dir_footerBar' },
          h(
            Button,
            {
              variant: 'outline',
              icon: h(IconPlusOutlineRegular, { size: 14 }),
              disabled: listing === null || loading,
              onClick: beginCreate,
            },
            t('folderNew'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: `dshBridge_dir_showHiddenToggle${showHidden ? ' dshBridge_dir_showHiddenToggleActive' : ''}`,
              'aria-pressed': showHidden,
              onClick: () => setShowHidden((value) => !value),
            },
            t('folderShowHidden'),
            showHidden ? h(IconCheckOutlineRegular, { size: 14 }) : null,
          ),
          h('span', { className: 'dshBridge_dir_footerGap' }),
          h(Button, { variant: 'outline', className: 'dshBridge_dir_footerAction', onClick: onClose }, t('folderCancel')),
          h(
            Button,
            {
              variant: 'primary',
              className: 'dshBridge_dir_footerAction',
              disabled: target === null || loading,
              onClick: () => {
                if (target !== null) onPick(target.path)
              },
            },
            t('folderOpen'),
          ),
        ),
      )

      return h(
        React.Fragment,
        null,
        h(
          Modal,
          {
            open,
            onClose,
            title: t('folderPickerTitle'),
            className: 'dshBridge_dir_dialog',
            headless: true,
          },
          editor,
        ),
        h(
          Modal,
          {
            open: folderDraft !== null,
            onClose: () => {
              if (!creating) setFolderDraft(null)
            },
            title: t('folderNew'),
            className: 'dshBridge_dir_createDialog',
            headless: true,
          },
          h(
            'div',
            { className: 'dshBridge_dir_createBody' },
            h('h3', { className: 'dshBridge_dir_createTitle' }, t('folderNew')),
            h('p', { className: 'dshBridge_dir_createIn' }, t('folderCreateIn').replace('{name}', targetName)),
            h('input', {
              className: 'dshBridge_dir_createInput',
              value: folderDraft ?? '',
              'aria-label': t('folderName'),
              placeholder: t('folderUntitled'),
              'data-modal-autofocus': true,
              disabled: creating,
              onChange: (event) => setFolderDraft(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  confirmCreate()
                }
                if (event.key === 'Escape') {
                  event.stopPropagation()
                  if (!creating) setFolderDraft(null)
                }
              },
            }),
            createError !== null ? h('div', { className: 'dshBridge_dir_error', role: 'alert' }, createError) : null,
            h(
              'div',
              { className: 'dshBridge_dir_createActions' },
              h(Button, { variant: 'outline', disabled: creating, onClick: () => setFolderDraft(null) }, t('folderCancel')),
              h(
                Button,
                {
                  variant: 'primary',
                  disabled: creating || folderDraft === null || folderDraft.trim() === '',
                  onClick: confirmCreate,
                },
                t('folderCreate'),
              ),
            ),
          ),
        ),
      )
    }

    function BridgeWorkspaceRow({ group, expanded, active, onToggle, onCreate, onRename, onDelete, t }) {
      const [menuOpen, setMenuOpen] = useState(false)
      const label = group.workspaceId === undefined ? t('groupUngrouped') : group.label
      const actions = group.workspaceId === undefined
        ? null
        : h(
            'span',
            {
              className: 'dshBridge_row_rowActions',
              onClick: (event) => event.stopPropagation(),
            },
            h(Menu, {
              open: menuOpen,
              onClose: () => setMenuOpen(false),
              items: [
                { id: 'rename', label: t('renameWorkspace'), icon: h(IconEditOutlineRegular, {}) },
                { id: 'delete', label: t('deleteWorkspace'), icon: h(IconTrashOutlineRegular, {}), danger: true },
              ],
              portal: true,
              closeOnPointerLeave: true,
              onSelect: (id) => {
                setMenuOpen(false)
                if (id === 'rename') onRename()
                else if (id === 'delete') onDelete()
              },
              anchor: h(
                'button',
                {
                  type: 'button',
                  className: 'dshBridge_row_iconButton',
                  'aria-label': t('workspaceActions').replace('{name}', label),
                  onClick: () => setMenuOpen((value) => !value),
                },
                h(IconEllipsisOutlineRegular, {}),
              ),
            }),
            h(
              Tooltip,
              { label: t('newSession'), side: 'bottom', delayMs: 500 },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshBridge_row_iconButton',
                  'aria-label': t('newSessionIn').replace('{name}', label),
                  onClick: onCreate,
                },
                h(IconNewChatOutlineRegular, {}),
              ),
            ),
          )
      return h(
        HoverCard,
        {
          openDelayMs: 800,
          copyText: group.cwd ?? undefined,
          copyLabel: t('copy'),
          copiedLabel: t('hoverCopied'),
          disabled: menuOpen,
          content: h(
            'div',
            { className: 'dshBridge_row_hoverContent' },
            h('div', { className: 'dshBridge_row_hoverTitle' }, label),
            group.cwd ? h('div', { className: 'dshBridge_row_hoverPath' }, group.cwd) : null,
            group.createdAt ? h('div', { className: 'dshBridge_row_hoverTime' }, t('hoverCreated').replace('{time}', formatTime(group.createdAt))) : null,
          ),
          anchor: h(
            'div',
            {
              className: `dshBridge_row_projectRow${menuOpen ? ' dshBridge_row_menuOpen' : ''}`,
              'data-row-key': `workspace:${group.key}`,
              role: 'treeitem',
              'aria-expanded': expanded,
              onClick: onToggle,
            },
            h(
              'span',
              { className: `dshBridge_row_slot dshBridge_row_folder${active ? ' dshBridge_row_folderActive' : ''}` },
              expanded ? h(IconFolderOpenRegular, {}) : h(IconFolderCloseRegular, {}),
            ),
            h(
              'span',
              { className: 'dshBridge_row_slot dshBridge_row_chevron' },
              h(IconTriangleRightFillRegular, { className: `dshBridge_row_arrow${expanded ? ' dshBridge_row_arrowOpen' : ''}` }),
            ),
            h(
              'span',
              { className: 'dshBridge_row_projectText' },
              h('span', { className: 'dshBridge_row_title', title: group.cwd ?? label }, label),
            ),
            actions,
          ),
        },
      )
    }

    function BridgeWorkspaceActionDialog({ action, target, busy, error, t, onClose, onRename, onDelete }) {
      const [name, setName] = useState(target?.name ?? target?.label ?? '')
      useEffect(() => {
        setName(target?.name ?? target?.label ?? '')
      }, [target])
      if (target === null) return null
      const renaming = action === 'rename'
      const title = renaming ? t('renameWorkspace') : t('deleteWorkspace')
      const body = renaming
        ? h(
            'div',
            { className: 'dshBridge_form' },
            h('div', { className: 'dshBridge_label' }, t('workspaceName')),
            h('input', {
              className: 'dshBridge_input',
              value: name,
              maxLength: 200,
              'data-modal-autofocus': true,
              placeholder: t('workspaceRenamePlaceholder'),
              onChange: (event) => setName(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  if (name.trim() !== '' && !busy) onRename(name.trim())
                }
                if (event.key === 'Escape') {
                  event.stopPropagation()
                  if (!busy) onClose()
                }
              },
            }),
            h('div', { className: 'dshBridge_desc' }, target.cwd ?? target.path ?? ''),
            error !== null ? h('div', { className: 'dshBridge_error', role: 'alert' }, error) : null,
          )
        : h(
            'div',
            { className: 'dshBridge_form' },
            h('div', { className: 'dshBridge_desc' }, t('deleteWorkspaceDesc').replace('{name}', target.label)),
            error !== null ? h('div', { className: 'dshBridge_error', role: 'alert' }, error) : null,
          )
      const footer = h(
        React.Fragment,
        null,
        h(Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: onClose }, t('dialogCancel')),
        h(
          Button,
          {
            variant: renaming ? 'primary' : 'outline',
            size: 'sm',
            className: renaming ? undefined : 'dshBridge_dangerButton',
            disabled: busy || (renaming && name.trim() === ''),
            onClick: () => renaming ? onRename(name.trim()) : onDelete(),
          },
          busy ? t('savingBridge') : renaming ? t('saveBridge') : t('deleteWorkspace'),
        ),
      )
      return h(
        Modal,
        {
          open: true,
          onClose,
          title,
          closeLabel: t('dialogCancel'),
          className: 'dshBridge_workspaceActionModal',
          footer,
        },
        body,
      )
    }

    function BridgeSessionRow({ session, selected, archived, now, activity, drag, onOpen, onArchive, onDragStart, onDragEnd, onDragOver, onDrop, t }) {
      const [menuOpen, setMenuOpen] = useState(false)
      const title = session.name || session.firstMessage || t('untitled')
      const activityState = activity?.state ?? 'unknown'
      const statusLabel = activityState === 'running'
        ? t('sessionRunning')
        : activityState === 'idle'
          ? t('sessionCompleted')
          : activityState === 'failed'
            ? t('sessionFailed')
            : activityState === 'connecting'
              ? t('sessionConnecting')
              : t('sessionIdle')
      const menuItems = archived
        ? [{ id: 'unarchive', label: t('unarchiveSession'), icon: h(IconArchiveOffOutlineRegular, {}) }]
        : [{ id: 'archive', label: t('archiveSession'), icon: h(IconArchiveOutlineRegular, {}) }]
      const row = h(
        'div',
        {
          className: [
            'dshBridge_row_sessionRow',
            selected ? 'dshBridge_row_selected' : '',
            menuOpen ? 'dshBridge_row_menuOpen' : '',
            archived ? 'dshBridge_row_archived' : '',
            drag?.marker === 'before' ? 'dshBridge_row_dropBefore' : '',
            drag?.marker === 'after' ? 'dshBridge_row_dropAfter' : '',
          ].filter(Boolean).join(' '),
          role: 'treeitem',
          'aria-selected': selected,
          draggable: drag !== undefined,
          onClick: () => onOpen(session.key),
          onDragStart: drag === undefined ? undefined : (event) => {
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData('text/plain', session.key)
            onDragStart()
          },
          onDragEnd: drag === undefined ? undefined : onDragEnd,
          onDragOver: drag === undefined ? undefined : (event) => {
            if (!drag.active) return
            event.preventDefault()
            const rect = event.currentTarget.getBoundingClientRect()
            onDragOver(event.clientY < rect.top + rect.height / 2 ? 'before' : 'after')
          },
          onDrop: drag === undefined ? undefined : (event) => {
            if (!drag.active) return
            event.preventDefault()
            const rect = event.currentTarget.getBoundingClientRect()
            onDrop(event.clientY < rect.top + rect.height / 2 ? 'before' : 'after')
          },
        },
        h(
          'span',
          { className: 'dshBridge_row_slot' },
          activityState === 'running' || activityState === 'connecting'
            ? h('span', { className: 'dshBridge_row_spinner', role: 'img', 'aria-label': statusLabel, title: statusLabel })
            : activityState === 'idle'
              ? h('span', { className: 'dshBridge_row_doneDot', role: 'img', 'aria-label': statusLabel, title: statusLabel })
              : activityState === 'failed'
                ? h('span', { className: 'dshBridge_row_failedDot', role: 'img', 'aria-label': statusLabel, title: statusLabel })
                : null,
        ),
        h('span', { className: 'dshBridge_row_title', ref: undefined }, title),
        h('span', { className: 'dshBridge_row_time' }, relativeTime(session.modified ?? session.created, now, t)),
        h(
          'span',
          {
            className: 'dshBridge_row_rowActions',
            onClick: (event) => event.stopPropagation(),
          },
          h(Menu, {
            open: menuOpen,
            onClose: () => setMenuOpen(false),
            items: menuItems,
            portal: true,
            closeOnPointerLeave: true,
            onSelect: (id) => {
              setMenuOpen(false)
              if (id === 'archive' || id === 'unarchive') onArchive(session.key, id === 'archive')
            },
            anchor: h(
              'button',
              {
                type: 'button',
                className: 'dshBridge_row_iconButton',
                'aria-label': t('sessionActions').replace('{name}', title),
                onClick: () => setMenuOpen((value) => !value),
              },
              h(IconEllipsisOutlineRegular, {}),
            ),
          }),
        ),
      )
      return h(HoverCard, {
        anchor: row,
        openDelayMs: 800,
        disabled: menuOpen,
        copyText: title,
        copyLabel: t('copy'),
        copiedLabel: t('hoverCopied'),
        content: h(
          'div',
          { className: 'dshBridge_row_hoverContent' },
          h('div', { className: 'dshBridge_row_hoverTitle' }, title),
          h('div', { className: 'dshBridge_row_hoverTime' }, relativeTime(session.modified ?? session.created, now, t)),
          session.cwd ? h('div', { className: 'dshBridge_row_hoverPath' }, session.cwd) : null,
          session.firstMessage && session.firstMessage !== title ? h('div', { className: 'dshBridge_row_hoverStatus' }, session.firstMessage) : null,
        ),
      })
    }

    function BridgeSearchResult({ session, selected, now, onOpen, t }) {
      const title = session.name || session.firstMessage || t('untitled')
      return h(
        'div',
        {
          className: `dshBridge_row_searchResultRow${selected ? ' dshBridge_row_selected' : ''}`,
          role: 'treeitem',
          'aria-selected': selected,
          onClick: () => onOpen(session.key),
        },
        h(
          'span',
          { className: 'dshBridge_row_searchResultHeading' },
          h('span', { className: 'dshBridge_row_slot' }),
          h('span', { className: 'dshBridge_row_searchResultTitle' }, title),
        ),
        h(
          'span',
          { className: 'dshBridge_row_searchResultMeta' },
          h('span', { className: 'dshBridge_row_searchResultWorkspace' }, session.cwd ? workspaceLabel(session.cwd) : t('groupUngrouped')),
          session.firstMessage && session.firstMessage !== title
            ? h('span', { className: 'dshBridge_row_searchResultSnippet' }, session.firstMessage)
            : h('span', { className: 'dshBridge_row_searchResultSnippet' }, relativeTime(session.modified ?? session.created, now, t)),
        ),
      )
    }

    /**
     * Import is the admission gate for the Bridge sidebar. The dialog discovers
     * every session under the bridge's engine root, lets the user inspect the
     * same data as a workspace tree or a flat list, and only persists the
     * selected keys when Import is pressed.
     */
    function BridgeImportDialog({ open, bridgeId, t, onClose, onImported }) {
      const [data, setData] = useState(null)
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [mode, setMode] = useState('tree')
      const [query, setQuery] = useState('')
      const [selected, setSelected] = useState(() => new Set())
      const [expanded, setExpanded] = useState({})

      const load = useCallback(async () => {
        if (bridgeId === null || bridgeId === undefined) return
        setLoading(true)
        setError(null)
        try {
          const body = await api(`imports?bridge=${encodeURIComponent(bridgeId)}`)
          setData(body)
          setSelected(new Set())
        } catch (failure) {
          setData(null)
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setLoading(false)
        }
      }, [bridgeId])

      useEffect(() => {
        if (!open) return
        setMode('tree')
        setQuery('')
        setExpanded({})
        setBusy(false)
        load()
      }, [open, load])

      const sessions = Array.isArray(data?.sessions) ? data.sessions : []
      const selectableSessions = sessions.filter((session) => session.imported !== true)
      const normalizedQuery = query.trim().toLowerCase()
      const sessionTitle = (session) => session.name || session.firstMessage || t('untitled')

      const workspaceGroups = useMemo(() => {
        const paths = new Map()
        const addPath = (path, name) => {
          if (typeof path !== 'string' || path === '') return
          if (!paths.has(path)) paths.set(path, { path, name: name || workspaceLabel(path) })
        }
        for (const workspace of Array.isArray(data?.workspaces) ? data.workspaces : []) addPath(workspace.path, workspace.name)
        for (const session of sessions) addPath(session.cwd)
        const groups = [...paths.values()].map((workspace) => ({
          ...workspace,
          sessions: sessions.filter((session) => session.cwd === workspace.path),
        }))
        const ungrouped = sessions.filter((session) => typeof session.cwd !== 'string' || session.cwd === '')
        if (ungrouped.length > 0) groups.push({ path: '', name: t('groupUngrouped'), sessions: ungrouped })
        return groups.sort((left, right) => left.path.localeCompare(right.path))
      }, [data?.workspaces, sessions, t])

      const visibleGroups = useMemo(() => {
        if (normalizedQuery === '') return workspaceGroups
        return workspaceGroups.flatMap((group) => {
          const groupMatches = [group.name, group.path].filter(Boolean).some((value) => value.toLowerCase().includes(normalizedQuery))
          const matches = group.sessions.filter((session) => {
            if (groupMatches) return true
            return [session.name, session.firstMessage, session.cwd, session.id]
              .filter(Boolean)
              .some((value) => String(value).toLowerCase().includes(normalizedQuery))
          })
          return matches.length === 0 ? [] : [{ ...group, sessions: matches }]
        })
      }, [normalizedQuery, workspaceGroups])

      const listSessions = useMemo(() => {
        const source = normalizedQuery === '' ? sessions : visibleGroups.flatMap((group) => group.sessions)
        return [...source].sort(compareSessionsByUpdated)
      }, [normalizedQuery, sessions, visibleGroups])

      const groupUnderPath = useCallback((group) => {
        if (group.path === '') return group.sessions
        return sessions.filter((session) => {
          if (typeof session.cwd !== 'string' || session.cwd === '') return false
          const cwd = session.cwd.replaceAll('\\', '/').replace(/\/+$/, '')
          const root = group.path.replaceAll('\\', '/').replace(/\/+$/, '')
          return cwd === root || cwd.startsWith(`${root}/`)
        })
      }, [sessions])
      const groupSelectable = useCallback(
        (group) => groupUnderPath(group).filter((session) => session.imported !== true),
        [groupUnderPath],
      )

      const toggleSession = (session) => {
        if (session.imported === true) return
        setSelected((current) => {
          const next = new Set(current)
          if (next.has(session.key)) next.delete(session.key)
          else next.add(session.key)
          return next
        })
      }

      const toggleGroup = (group) => {
        const members = groupUnderPath(group).filter((session) => session.imported !== true)
        if (members.length === 0) return
        const allSelected = members.every((session) => selected.has(session.key))
        setSelected((current) => {
          const next = new Set(current)
          for (const session of members) {
            if (allSelected) next.delete(session.key)
            else next.add(session.key)
          }
          return next
        })
      }

      const toggleAll = () => {
        const visible = mode === 'tree'
          ? visibleGroups.flatMap((group) => groupSelectable(group))
          : listSessions.filter((session) => session.imported !== true)
        if (visible.length === 0) return
        const allSelected = visible.every((session) => selected.has(session.key))
        setSelected((current) => {
          const next = new Set(current)
          for (const session of visible) {
            if (allSelected) next.delete(session.key)
            else next.add(session.key)
          }
          return next
        })
      }

      const parentByPath = useMemo(() => {
        const paths = visibleGroups.filter((group) => group.path !== '').map((group) => group.path)
        return new Map(visibleGroups.map((group) => [group.path, group.path === '' ? undefined : owningParentFolder(group.path, paths)]))
      }, [visibleGroups])

      const childrenByParent = useMemo(() => {
        const children = new Map()
        for (const group of visibleGroups) {
          const parent = parentByPath.get(group.path)
          const siblings = children.get(parent)
          if (siblings === undefined) children.set(parent, [group])
          else siblings.push(group)
        }
        return children
      }, [parentByPath, visibleGroups])

      const renderSession = (session) => {
        const title = sessionTitle(session)
        const imported = session.imported === true
        return h(
          'button',
          {
            key: session.key,
            type: 'button',
            className: `dshBridge_import_row dshBridge_import_sessionRow${selected.has(session.key) ? ' dshBridge_import_rowSelected' : ''}${imported ? ' dshBridge_import_rowDisabled' : ''}`,
            'aria-pressed': imported ? undefined : selected.has(session.key),
            'aria-disabled': imported || undefined,
            disabled: imported,
            onClick: () => toggleSession(session),
          },
          h('span', { className: 'dshBridge_import_check', 'data-state': imported || selected.has(session.key) ? 'checked' : 'empty' },
            imported || selected.has(session.key) ? h(IconCheckOutlineRegular, { size: 12 }) : null),
          h('span', { className: 'dshBridge_import_sessionText' },
            h('span', { className: 'dshBridge_import_sessionTitle' }, title),
            h('span', { className: 'dshBridge_import_sessionMeta' }, session.cwd ? workspaceLabel(session.cwd) : t('groupUngrouped'))),
          imported ? h('span', { className: 'dshBridge_import_badge' }, t('imported')) : null,
          h('span', { className: 'dshBridge_import_sessionTime' }, relativeTime(session.modified ?? session.created, Date.now(), t)),
        )
      }

      const renderGroup = (group, depth) => {
        const children = childrenByParent.get(group.path) ?? []
        const members = groupUnderPath(group)
        const selectable = groupSelectable(group)
        const selectedCount = selectable.filter((session) => selected.has(session.key)).length
        const allSelected = selectable.length > 0 && selectedCount === selectable.length
        const partial = selectedCount > 0 && !allSelected
        const isExpanded = expanded[group.path] ?? true
        return h(
          'div',
          { key: group.path || '__ungrouped__', className: 'dshBridge_import_group', style: { '--dsh-import-indent': `${depth * 16}px` } },
          h(
            'div',
            { className: 'dshBridge_import_workspaceRow', style: { paddingLeft: `${depth * 16}px` } },
            h(
              'button',
              {
                type: 'button',
                className: 'dshBridge_import_chevron',
                'aria-label': isExpanded ? t('sessionsCollapse') : t('sessionsExpand').replace('{n}', String(members.length)),
                'aria-expanded': isExpanded,
                onClick: () => setExpanded((current) => ({ ...current, [group.path]: !isExpanded })),
              },
              isExpanded ? h(IconChevronDownOutlineRegular, { size: 14 }) : h(IconChevronRightOutlineRegular, { size: 14 }),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dshBridge_import_groupCheck',
                'aria-label': group.name,
                'aria-pressed': allSelected,
                disabled: selectable.length === 0,
                onClick: (event) => {
                  event.stopPropagation()
                  toggleGroup(group)
                },
              },
              h('span', {
                className: 'dshBridge_import_check',
                'data-state': allSelected ? 'checked' : partial ? 'partial' : 'empty',
              }, allSelected ? h(IconCheckOutlineRegular, { size: 12 }) : partial ? h('span', { className: 'dshBridge_import_dash' }) : null),
            ),
            h(IconFolderCloseRegular, { size: 16, className: 'dshBridge_import_folderIcon' }),
            h('span', { className: 'dshBridge_import_groupName' }, group.name),
            h('span', { className: 'dshBridge_import_count' }, String(members.length)),
          ),
          isExpanded
            ? h(
                React.Fragment,
                null,
                ...children.map((child) => renderGroup(child, depth + 1)),
                ...group.sessions.map((session) => h('div', { key: session.key, style: { paddingLeft: `${depth * 16}px` } }, renderSession(session))),
              )
            : null,
        )
      }

      const selectedWorkspacePaths = workspaceGroups
        .filter((group) => {
          const selectable = groupSelectable(group)
          return group.path !== '' && selectable.length > 0 && selectable.every((session) => selected.has(session.key))
        })
        .map((group) => group.path)

      const submit = async () => {
        if (busy || selected.size === 0) return
        setBusy(true)
        setError(null)
        try {
          const body = await api('imports', {
            method: 'POST',
            body: JSON.stringify({
              bridge: bridgeId,
              sessionKeys: [...selected],
              workspacePaths: selectedWorkspacePaths,
            }),
          })
          onImported?.(body, selected.size)
          onClose()
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }

      const closeDisabled = busy
      const visibleSelectable = mode === 'tree'
        ? visibleGroups.flatMap((group) => groupSelectable(group))
        : listSessions.filter((session) => session.imported !== true)
      const allVisibleSelected = visibleSelectable.length > 0 && visibleSelectable.every((session) => selected.has(session.key))

      const body = h(
        'div',
        { className: 'dshBridge_import_body' },
        h(
          'div',
          { className: 'dshBridge_import_header' },
          h('div', { className: 'dshBridge_import_heading' },
            h('h2', { className: 'dshBridge_import_title' }, t('importSessionsTitle')),
            h('p', { className: 'dshBridge_import_hint' }, t('importSessionsHint'))),
          h(
            'button',
            {
              type: 'button',
              className: 'dshBridge_settingsClose',
              'aria-label': t('settingsClose'),
              disabled: closeDisabled,
              onClick: onClose,
            },
            h(IconCloseOutlineRegular, { size: 16 }),
          ),
        ),
        h(
          'div',
          { className: 'dshBridge_import_toolbar' },
          h('div', { className: 'dshBridge_import_modeToggle', role: 'group', 'aria-label': t('importView') },
            h('button', {
              type: 'button',
              className: 'dshBridge_import_modeButton',
              'data-active': mode === 'tree',
              onClick: () => setMode('tree'),
            }, h(IconWorkspaceTreeOutlineRegular, { size: 14 }), t('importTree')),
            h('button', {
              type: 'button',
              className: 'dshBridge_import_modeButton',
              'data-active': mode === 'list',
              onClick: () => setMode('list'),
            }, h(IconFlatListOutlineRegular, { size: 14 }), t('importList'))),
          h('label', { className: 'dshBridge_import_search' },
            h(IconSearchOutlineRegular, { size: 14 }),
            h('input', {
              type: 'search',
              value: query,
              placeholder: t('importSearchPlaceholder'),
              'aria-label': t('importSearchPlaceholder'),
              onChange: (event) => setQuery(event.target.value),
            })),
          h(
            'button',
            {
              type: 'button',
              className: 'dshBridge_import_selectAll',
              disabled: visibleSelectable.length === 0,
              onClick: toggleAll,
            },
            allVisibleSelected ? t('importClear') : t('importAll'),
          ),
        ),
        h(
          'div',
          { className: 'dshBridge_import_content' },
          loading ? h('div', { className: 'dshBridge_import_status', role: 'status' }, t('loading'))
            : error !== null ? h('div', { className: 'dshBridge_import_status dshBridge_import_error', role: 'alert' }, error)
              : sessions.length === 0 ? h('div', { className: 'dshBridge_import_empty' },
                  h(IconDatabaseOutlineRegular, { size: 26 }),
                  h('div', { className: 'dshBridge_import_emptyTitle' }, t('importEmpty')),
                  h('div', { className: 'dshBridge_import_emptyHint' }, t('importEmptyHint')))
                : mode === 'tree'
                  ? h('div', { className: 'dshBridge_import_tree', role: 'tree', 'aria-label': t('importSessionsTitle') },
                      ...(childrenByParent.get(undefined) ?? []).map((group) => renderGroup(group, 0)),
                      visibleGroups.length === 0 ? h('div', { className: 'dshBridge_import_status' }, t('importNoMatches')) : null)
                  : h('div', { className: 'dshBridge_import_list', role: 'list', 'aria-label': t('importSessionsTitle') },
                      ...listSessions.map((session) => renderSession(session)),
                      listSessions.length === 0 ? h('div', { className: 'dshBridge_import_status' }, t('importNoMatches')) : null),
        ),
        h(
          'div',
          { className: 'dshBridge_import_footer' },
          h('span', { className: 'dshBridge_import_selection' }, error !== null && !loading
            ? error
            : t('importSelectedCount').replace('{n}', String(selected.size))),
          h('span', { className: 'dshBridge_import_footerGap' }),
          h(Button, { variant: 'outline', disabled: busy, onClick: onClose }, t('folderCancel')),
          h(Button, {
            variant: 'primary',
            disabled: busy || loading || selected.size === 0,
            onClick: submit,
          }, busy ? t('importing') : t('importConfirm')),
        ),
      )

      return h(
        Modal,
        {
          open,
          onClose: closeDisabled ? () => {} : onClose,
          title: t('importSessionsTitle'),
          className: 'dshBridge_import_dialog',
          headless: true,
        },
        body,
      )
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
      connectionConnected: '已连接',
      connectionConnecting: '正在连接',
      connectionFailed: '连接失败',
      connectionIdle: '未检测',
      reconnect: '重新检测连接',
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
      searchPlaceholder: '搜索会话名称',
      noMatches: '无匹配会话',
      sectionWorkspaces: '工作区',
      sectionSessions: '会话',
      groupUngrouped: '未分组',
      untitled: '未命名',
      viewOptions: '视图选项',
      groupBy: '分组方式',
      groupByWorkspace: '按工作区',
      groupByWorkspaceTree: '按工作区树',
      groupByFlat: '单列表',
      orderBy: '排序方式',
      orderByManual: '手动排序',
      orderByUpdated: '最近更新',
      filterBy: '筛选会话',
      hideArchived: '隐藏已归档',
      showArchived: '全部对话（显示已归档）',
      onlyArchived: '仅显示已归档',
      sessionsExpand: '展开其余 {n} 个会话',
      sessionsCollapse: '收起',
      emptyArchived: '暂无已归档会话',
      emptyViewOthers: '查看其他会话',
      addWorkspace: '添加工作区',
      importSessions: '导入会话',
      importSessionsTitle: '导入会话与工作区',
      importSessionsHint: '选择要加入左侧工作区的会话。未导入的会话会保留在引擎目录中，可随时再次导入。',
      importView: '导入视图',
      importTree: '树视图',
      importList: '列表视图',
      importAll: '全选',
      importClear: '取消全选',
      importSelectedCount: '已选择 {n} 个会话',
      importConfirm: '导入',
      importing: '正在导入…',
      imported: '已导入',
      importEmpty: '没有可导入的会话',
      importEmptyHint: '先在外部运行一次 Agent，或前往 Bridge 设置检查会话根目录。',
      importNoMatches: '没有匹配的会话',
      importSearchPlaceholder: '搜索会话或工作区',
      importFailed: '导入失败',
      importSucceeded: '已导入 {n} 个会话',
      newSession: '新建会话',
      newSessionIn: '在“{name}”中新建会话',
      newSessionPickWorkspace: '请点击某个工作区右侧的新建会话按钮。',
      newSessionFailed: '无法新建会话',
      workspaceAddFailed: '无法添加工作区',
      workspaceRenamed: '工作区已重命名',
      workspaceDeleted: '工作区已删除（会话和文件夹均保留）',
      workspaceName: '工作区名称',
      workspaceRenamePlaceholder: '输入工作区显示名称',
      searchClear: '清除搜索',
      searchResults: '搜索结果',
      archiveSession: '归档会话',
      unarchiveSession: '取消归档',
      sessionActions: '会话“{name}”的操作',
      workspaceActions: '工作区“{name}”的操作',
      renameWorkspace: '重命名工作区',
      deleteWorkspace: '删除工作区',
      deleteWorkspaceDesc: '将把“{name}”从工作区列表中移除。文件夹与会话记录会保留，其会话将显示在“未分组”下。',
      folderPickerTitle: '选择工作区目录',
      folderHome: '主目录',
      folderNew: '新建文件夹',
      folderName: '文件夹名称',
      folderCreateIn: '在“{name}”中新建文件夹',
      folderUntitled: '未命名文件夹',
      folderCreate: '创建',
      folderCancel: '取消',
      folderOpen: '打开',
      folderLoading: '加载中…',
      folderTruncated: '文件夹过多，仅显示开头部分。',
      folderShowHidden: '显示隐藏文件',
      folderCreateFailed: '无法创建文件夹',
      folderCreated: '工作区目录已添加',
      workspaceAdded: '工作区已添加',
      timeNow: '刚刚',
      timeMinutes: '{n}分钟',
      timeHours: '{n}小时',
      timeDays: '{n}天',
      timeMonths: '{n}个月',
      timeYears: '{n}年',
      timeAgo: '{t}前',
      hoverCreated: '创建于 {time}',
      hoverCopied: '已复制',
      selectHint: '从左侧选择一个会话',
      heroHeadline: '探索未至之境',
      heroPreview: '预览版',
      heroChooseWorkspace: '选择工作区',
      heroAddWorkspace: '添加工作区…',
      heroPickWorkspaceFirst: '先选择一个工作区再发送。',
      heroPlaceholder: '选择一个工作区开始',
      heroPlaceholderReady: '描述你想要构建的内容，/ 调用指令，@ 文件或对话',
      attach: '连接会话',
      attaching: '正在连接…',
      deepDiving: '深度求索中',
      deepDivingFor: '深度求索中，用时 {duration} ···',
      durationHour: '小时',
      durationMinute: '分',
      durationSecond: '秒',
      attached: '已连接',
      notAttached: '未连接',
      running: '运行中',
      sessionRunning: '运行中',
      sessionCompleted: '已完成',
      sessionFailed: '运行失败',
      sessionConnecting: '正在连接',
      sessionIdle: '空闲',
      ensureFailed: '无法连接 agent',
      idle: '空闲',
      send: '发送',
      placeholder: '给这个会话发送消息…',
      chooseModel: '选择模型',
      modelLoading: '正在加载模型…',
      modelLoadFailed: '无法加载模型目录',
      modelSelectFailed: '切换模型失败',
      statsCounts: '{turns} 轮 {steps} 步',
      statsCacheHit: '缓存命中 {percent}%',
      statsDialogTitle: '会话统计',
      statsUsageTitle: 'Token 用量',
      statsTurns: '用户消息',
      statsSteps: '助手步骤',
      statsToolCalls: '工具调用',
      statsTotalMessages: '消息总数',
      statsUncachedInput: '未缓存输入',
      statsCacheRead: '缓存读取',
      statsCacheWrite: '缓存写入',
      statsOutput: '输出',
      statsTokens: '{count} tok',
      statsContextUsed: '上下文已用 {percent}%',
      statsContextWindow: '上下文窗口',
      statsContextTokens: '{used} / {window}',
      statsContextPanel: '上下文占用',
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
      /* Process rows: one localized verb per tool variant, plus the chrome the
       * shared TerminalBlock/DiffBlock primitives take as label props. */
      toolTitleRead: '读取',
      toolTitleSearch: '搜索',
      toolTitleBash: '运行命令',
      toolTitleWrite: '写入',
      toolTitleEdit: '编辑',
      toolTitleCode: '代码',
      toolTitleGeneric: '工具调用',
      toolRunning: '运行中',
      toolFailed: '失败',
      toolNoOutput: '无输出',
      toolArguments: '参数',
      toolResult: '结果',
      terminalCommandLine: '命令第 {n} 行',
      terminalSignal: '信号 {signal}',
      terminalExitCode: '退出码 {code}',
      terminalNoExitCode: '未正常退出',
      terminalExpandAria: '展开其余 {n} 行输出',
      terminalExpandRest: '… 其余 {n} 行',
      collapse: '收起',
      collapseOutput: '收起输出',
      codeBlockTitle: '代码',
      codeBlockWrap: '自动换行',
      codeBlockUnwrap: '取消换行',
      attachNotice: '已连接会话。',
      detachedNotice: '已断开；会话文件保持不变。',
      thinking: '思考',
      turnCompleted: '已完成',
      metrics: '{size} · {time}',
      notification: 'Bridge 通知',
      userRole: '我',
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
      connectionConnected: 'Connected',
      connectionConnecting: 'Connecting…',
      connectionFailed: 'Connection failed',
      connectionIdle: 'Not checked',
      reconnect: 'Check connection again',
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
      searchPlaceholder: 'Search session names',
      noMatches: 'No matching sessions',
      sectionWorkspaces: 'Workspaces',
      sectionSessions: 'Sessions',
      groupUngrouped: 'Ungrouped',
      untitled: 'Untitled',
      viewOptions: 'View options',
      groupBy: 'Group by',
      groupByWorkspace: 'WorkSpace',
      groupByWorkspaceTree: 'Workspace Tree',
      groupByFlat: 'In one list',
      orderBy: 'Order by',
      orderByManual: 'Manual',
      orderByUpdated: 'Last updated',
      filterBy: 'Filter sessions',
      hideArchived: 'Hide archived',
      showArchived: 'All conversations (show archived)',
      onlyArchived: 'Archived only',
      sessionsExpand: 'Show {n} more sessions',
      sessionsCollapse: 'Show less',
      emptyArchived: 'No archived sessions yet',
      emptyViewOthers: 'View other sessions',
      addWorkspace: 'Add workspace',
      importSessions: 'Import sessions',
      importSessionsTitle: 'Import sessions and workspaces',
      importSessionsHint: 'Choose the sessions to add to the sidebar. Unimported sessions stay in the engine directory and can be imported later.',
      importView: 'Import view',
      importTree: 'Tree',
      importList: 'List',
      importAll: 'Select all',
      importClear: 'Clear selection',
      importSelectedCount: '{n} sessions selected',
      importConfirm: 'Import',
      importing: 'Importing…',
      imported: 'Imported',
      importEmpty: 'No sessions to import',
      importEmptyHint: 'Run an agent once outside dsh, or check the sessions root in Bridge settings.',
      importNoMatches: 'No matching sessions',
      importSearchPlaceholder: 'Search sessions or workspaces',
      importFailed: 'Import failed',
      importSucceeded: 'Imported {n} sessions',
      newSession: 'New session',
      newSessionIn: 'New session in {name}',
      newSessionPickWorkspace: 'Choose the new-session button on a workspace row.',
      newSessionFailed: 'Could not create a session',
      workspaceAddFailed: 'Could not add workspace',
      workspaceRenamed: 'Workspace renamed',
      workspaceDeleted: 'Workspace removed; sessions and folders were kept',
      workspaceName: 'Workspace name',
      workspaceRenamePlaceholder: 'Enter a workspace display name',
      searchClear: 'Clear search',
      searchResults: 'Search results',
      archiveSession: 'Archive session',
      unarchiveSession: 'Unarchive session',
      sessionActions: 'Session actions for {name}',
      workspaceActions: 'Workspace actions for {name}',
      renameWorkspace: 'Rename workspace',
      deleteWorkspace: 'Delete workspace',
      deleteWorkspaceDesc: 'This removes “{name}” from the workspace list. The folder and session logs will be kept. Its sessions will appear under Ungrouped.',
      folderPickerTitle: 'Select Workspace Directory',
      folderHome: 'Home',
      folderNew: 'New folder',
      folderName: 'Folder name',
      folderCreateIn: 'New folder in “{name}”',
      folderUntitled: 'Untitled folder',
      folderCreate: 'Create',
      folderCancel: 'Cancel',
      folderOpen: 'Open',
      folderLoading: 'Loading…',
      folderTruncated: 'Too many folders to list; only the beginning is shown.',
      folderShowHidden: 'Show hidden files',
      folderCreateFailed: 'Could not create folder',
      folderCreated: 'Workspace folder added',
      workspaceAdded: 'Workspace added',
      timeNow: 'now',
      timeMinutes: '{n}min',
      timeHours: '{n}h',
      timeDays: '{n}d',
      timeMonths: '{n}mo',
      timeYears: '{n}y',
      timeAgo: '{t} ago',
      hoverCreated: 'Created {time}',
      hoverCopied: 'Copied',
      selectHint: 'Select a session on the left',
      heroHeadline: 'Into the Unknown',
      heroPreview: 'Preview',
      heroChooseWorkspace: 'Choose workspace',
      heroAddWorkspace: 'Add workspace…',
      heroPickWorkspaceFirst: 'Choose a workspace before sending.',
      heroPlaceholder: 'Choose a workspace to start',
      heroPlaceholderReady: 'Describe what you want to build, / for commands, @ for files or chats',
      attach: 'Connect session',
      attaching: 'Connecting…',
      deepDiving: 'Deep diving',
      deepDivingFor: 'Deep diving for {duration} ···',
      durationHour: 'h ',
      durationMinute: 'm ',
      durationSecond: 's',
      attached: 'Connected',
      notAttached: 'Not connected',
      running: 'Running',
      sessionRunning: 'Running',
      sessionCompleted: 'Completed',
      sessionFailed: 'Failed',
      sessionConnecting: 'Connecting',
      sessionIdle: 'Idle',
      ensureFailed: 'Could not connect to the agent',
      idle: 'Idle',
      send: 'Send',
      placeholder: 'Message this session…',
      chooseModel: 'Choose model',
      modelLoading: 'Loading models…',
      modelLoadFailed: 'Could not load models',
      modelSelectFailed: 'Could not switch model',
      statsCounts: '{turns} turns {steps} steps',
      statsCacheHit: 'Cache hit {percent}%',
      statsDialogTitle: 'Session statistics',
      statsUsageTitle: 'Token usage',
      statsTurns: 'User messages',
      statsSteps: 'Assistant steps',
      statsToolCalls: 'Tool calls',
      statsTotalMessages: 'Total messages',
      statsUncachedInput: 'Uncached input',
      statsCacheRead: 'Cached input',
      statsCacheWrite: 'Cache write',
      statsOutput: 'Output',
      statsTokens: '{count} tok',
      statsContextUsed: '{percent}% of context used',
      statsContextWindow: 'Context window',
      statsContextTokens: '{used} / {window}',
      statsContextPanel: 'Context occupancy',
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
      /* Process rows: one localized verb per tool variant, plus the chrome the
       * shared TerminalBlock/DiffBlock primitives take as label props. */
      toolTitleRead: 'Read',
      toolTitleSearch: 'Search',
      toolTitleBash: 'Run command',
      toolTitleWrite: 'Write',
      toolTitleEdit: 'Edit',
      toolTitleCode: 'Code',
      toolTitleGeneric: 'Tool call',
      toolRunning: 'running',
      toolFailed: 'failed',
      toolNoOutput: 'No output',
      toolArguments: 'Arguments',
      toolResult: 'Result',
      terminalCommandLine: 'Command line {n}',
      terminalSignal: 'signal {signal}',
      terminalExitCode: 'exit code {code}',
      terminalNoExitCode: 'no exit code',
      terminalExpandAria: 'Expand {n} more output lines',
      terminalExpandRest: '… {n} more lines',
      collapse: 'Collapse',
      collapseOutput: 'Collapse output',
      codeBlockTitle: 'Code',
      codeBlockWrap: 'Wrap',
      codeBlockUnwrap: 'Unwrap',
      attachNotice: 'Session connected.',
      detachedNotice: 'Detached; the session file is unchanged.',
      thinking: 'Think',
      turnCompleted: 'Completed',
      metrics: '{size} · {time}',
      notification: 'Bridge notification',
      userRole: 'You',
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
      '.dshBridge_body{position:relative;display:flex;flex:1;min-height:0;--dsh-chat-content-width:var(--dsh-chat-user-width,clamp(680px, calc(var(--dsh-conversation-column-width,0px) * .64), 920px));--dsh-composer-card-max-width:calc(var(--dsh-chat-content-width) + 32px);--dsh-composer-side-clearance:16px;--dsh-composer-dock-inset:8px}',
      '.dshBridge_centre{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0}',
      '.dshBridge_scroll{flex:1;min-height:0;overflow:auto;scroll-behavior:auto;padding:16px calc(var(--dsh-composer-side-clearance,16px) + 16px)}',
      '.dshBridge_column{box-sizing:border-box;width:100%;max-width:var(--dsh-chat-content-width,712px);margin:0 auto}',
      '.wSkVaW_widthHandle{z-index:0;width:min(10px, calc((100% - var(--dsh-chat-content-width)) / 2 - 24px - 24px));cursor:col-resize;position:absolute;top:0;bottom:0}',
      '.wSkVaW_widthHandle[data-side=left]{right:calc(50% + var(--dsh-chat-content-width) / 2 + 24px)}',
      '.wSkVaW_widthHandle[data-side=right]{left:calc(50% + var(--dsh-chat-content-width) / 2 + 24px)}',
      '.wSkVaW_widthHandle:after{content:"";background:linear-gradient(to bottom, transparent calc(var(--dsh-width-handle-pointer-y,50%) - 36px), var(--dsw-alias-scrollbar-bg-l1) calc(var(--dsh-width-handle-pointer-y,50%) - 8px), var(--dsw-alias-scrollbar-bg-l1) calc(var(--dsh-width-handle-pointer-y,50%) + 8px), transparent calc(var(--dsh-width-handle-pointer-y,50%) + 36px));opacity:0;pointer-events:none;border-radius:2px;width:2px;position:absolute;top:0;bottom:0}',
      '.wSkVaW_widthHandle[data-side=left]:after{right:4px}',
      '.wSkVaW_widthHandle[data-side=right]:after{left:4px}',
      '.wSkVaW_widthHandle:hover:after,.wSkVaW_widthHandle[data-dragging]:after{opacity:1}',
      '.wSkVaW_widthHandle[data-dragging]{z-index:8}',
      '.dshBridge_body:has([data-conversation-composer-overlay]) .wSkVaW_widthHandle{display:none}',
      /* Transcript flow. Column spacing, row geometry, and colour tiers are
       * copied from dsh's own chat surface: process rows sit 6px apart inside
       * one block, blocks and answers are separated by 12px, and the answer
       * clears the process block it follows by 16px. */
      '.dshBridge_flow{display:flex;flex-direction:column;gap:12px}',
      '.dshBridge_flow>.dshBridge_userRow+.dshBridge_processGroup{margin-top:4px}',
      '.dshBridge_flow>.dshBridge_processGroup+.dshBridge_answer{margin-top:4px}',
      '.dshBridge_processGroup{display:flex;flex-direction:column;gap:6px;min-width:0}',
      /* Running turn: dsh's deep-diving ink, 12px type, whale tail + shimmering clock. */
      '.dshBridge_running{display:flex;flex-direction:column;align-items:flex-start;margin-top:4px;--dsw-alias-label-shimmer:var(--dsw-alias-label-deep-diving-shimmer,var(--dsw-alias-state-business-primary,#3964fe));color:var(--dsw-alias-label-deep-diving,var(--dsw-alias-state-business-primary,#3964fe));font-size:calc(var(--dsh-content-font-size,14px) - 2px);line-height:calc(22px + var(--dsh-content-font-delta,0px))}',
      '.dshBridge_runningContent{display:inline-flex;align-items:center;min-width:0;gap:6px}',
      '.dshBridge_runningText{min-width:0;font-variant-numeric:tabular-nums}',
      '.dshBridge_runningIcon{display:inline-flex;flex:none;width:calc(14px + var(--dsh-content-font-delta,0px));height:calc(14px + var(--dsh-content-font-delta,0px))}',
      '.dshBridge_visuallyHidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}',
      '.dshBridge_processRow{display:flex;flex-direction:column;min-width:0}',
      '.dshBridge_processRow[data-variant="read"] [data-disclosure-header],.dshBridge_processRow[data-variant="search"] [data-disclosure-header]{min-width:0}',
      '.dshBridge_processBody{display:flex;flex-direction:column;gap:6px;padding-left:calc(22px + var(--dsh-content-font-delta,0px))}',
      '.dshBridge_processSep{flex:none;width:2px;height:2px;margin:0 8px;border-radius:1px;background:var(--dsw-alias-label-caption,rgba(0,0,0,.35))}',
      '.dshBridge_processSummary{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px))}',
      '.dshBridge_processSummary[data-streaming="true"]{mask-image:linear-gradient(to right,black calc(100% - 48px),transparent)}',
      '.dshBridge_processError{color:var(--dsw-alias-state-error-primary,#d33)}',
      '.dshBridge_processFileLink{text-decoration:underline dotted;text-decoration-thickness:1px;text-underline-offset:3px;cursor:pointer}',
      '.dshBridge_processDiff{flex:none;margin-left:10px;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:calc(var(--dsh-content-font-size-secondary,13px) - 2px);line-height:calc(24px + var(--dsh-content-font-delta,0px));transform:translateY(.5px);white-space:nowrap}',
      '.dshBridge_diffAdded,.dshBridge_diffRemoved{color:inherit}',
      '.dshBridge_processRow:is(:hover,[data-expanded="true"]) .dshBridge_diffAdded{color:var(--dsw-alias-state-success-primary,#16a34a)}',
      '.dshBridge_processRow:is(:hover,[data-expanded="true"]) .dshBridge_diffRemoved{color:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.dshBridge_thinkRow[data-expanded] [data-disclosure-header]{position:sticky;top:0;z-index:1;background:var(--dsw-alias-bg-base,Canvas)}',
      /* Expanded tool body: dsh's input/output card, indented under the row. */
      '.dshBridge_ioCard{display:flex;flex-direction:column;margin:4px 0 4px 4px;border:.5px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:var(--dsw-radius-lg,16px);background:var(--dsw-alias-markdown-code-block,rgba(0,0,0,.04));font-family:var(--dsw-font-markdown-code-block-small,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:18px}',
      '.dshBridge_ioSection{display:grid;grid-template-columns:max-content minmax(0,1fr);align-items:baseline;column-gap:14px;max-height:150px;padding:12px 16px;overflow-y:auto}',
      '.dshBridge_ioLabel{position:sticky;top:0;align-self:start;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary,currentColor))}',
      '.dshBridge_ioDivider{flex:none;height:.5px;background:var(--dsw-alias-border-l2,rgba(0,0,0,.1))}',
      '.dshBridge_ioText{min-width:0;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary,currentColor)}',
      '.dshBridge_ioText[data-error="true"]{color:var(--dsw-alias-state-error-primary,#d33)}',
      /* User input: one right-aligned bubble, as dsh renders submitted text. */
      '.dshBridge_userRow{display:flex;flex-direction:column;align-items:flex-end;gap:6px}',
      '.dshBridge_userStack{display:flex;flex-direction:column;align-items:flex-end;gap:8px;min-width:0;max-width:min(calc(var(--dsh-chat-content-width,748px) * .702),82%)}',
      '.dshBridge_bubble{max-width:100%;padding:10px 16px;border-radius:var(--dsw-radius-xl,20px);background:var(--dsw-specific-bubble,var(--dsw-alias-bg-layer-2,rgba(0,0,0,.04)));color:var(--dsw-alias-label-primary,currentColor);font-size:var(--dsh-content-font-size,14px);line-height:calc(22px + var(--dsh-content-font-delta,0px));white-space:pre-wrap;word-break:break-word}',
      /* Assistant answer: body only, no role header, copy action below. */
      '.dshBridge_answer{display:flex;flex-direction:column;min-width:0}',
      '.dshBridge_assistantBody{display:flex;flex-direction:column;gap:16px;font-size:var(--dsh-content-font-size,14px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-primary,currentColor);word-break:break-word}',
      '.dshBridge_stopped{align-self:flex-start;padding:0 6px;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));color:var(--dsw-alias-label-tertiary,currentColor);font-size:11px;line-height:18px}',
      '.dshBridge_answerActions{margin-top:16px;margin-left:-6px;opacity:0;transition:opacity .1s ease}',
      '.dshBridge_answer:hover .dshBridge_answerActions,.dshBridge_answerActions:focus-within{opacity:1}',
      '.dshBridge_streaming{min-height:24px}',
      '.dshBridge_blank{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;height:100%;padding:24px;text-align:center;color:var(--dsw-alias-label-tertiary,currentColor)}',
      '.dshBridge_blankTitle{font-size:15px;line-height:22px;font-weight:600;color:var(--dsw-alias-label-primary,currentColor)}',
      '.dshBridge_blankHint{font-size:12px;line-height:20px;max-width:420px}',
      /* New Session hero, on dsh's own geometry: centred fish + 26/32 headline with a
       * superscript preview badge, then the workspace chip and the input card. */
      '.dshBridge_hero{display:flex;align-items:center;justify-content:center;height:100%;min-width:0;padding:0 24px}',
      '.dshBridge_heroStack{display:flex;flex-direction:column;align-items:stretch;gap:12px;width:100%;max-width:var(--dsh-composer-card-max-width,calc(var(--dsh-chat-content-width,712px) + 32px))}',
      '.dshBridge_heroHeadline{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;column-gap:10px;row-gap:12px;font-size:26px;line-height:32px;font-weight:500;color:var(--dsw-alias-label-primary,currentColor)}',
      '.dshBridge_heroFish{display:inline-flex;flex:none;align-items:center;justify-content:center;color:var(--dsw-alias-label-primary,currentColor)}',
      '.dshBridge_heroTitleGroup{display:inline-flex;flex-wrap:wrap;align-items:center;justify-content:center;column-gap:7px;row-gap:4px;min-width:0}',
      '.dshBridge_heroBadge{align-self:flex-start;margin-top:2px;padding:1px 7px 0;border:.5px solid var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));border-radius:999px;corner-shape:round;background:var(--dsw-alias-state-business-tertiary,rgba(57,100,254,.08));color:var(--dsw-alias-label-primary-bluish,var(--dsw-alias-state-business-primary,#3964fe));font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:18px;font-weight:500;white-space:nowrap}',
      '.dshBridge_heroBody{display:flex;flex-direction:column;gap:12px;min-width:0}',
      '.dshBridge_heroWorkspaceRow{display:flex;align-items:center;min-width:0;padding-left:8px}',
      '.dshBridge_heroWorkspace{display:inline-flex;align-items:center;gap:4px;max-width:min(100%,360px);min-height:28px;padding:0 8px;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-primary,currentColor);font:inherit;font-size:13px;line-height:20px;font-weight:500;cursor:pointer}',
      '.dshBridge_heroWorkspace:hover,.dshBridge_heroWorkspace[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      '.dshBridge_heroWorkspaceLabel{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshBridge_heroWorkspaceIcon{flex:none;color:var(--dsw-alias-label-primary,currentColor)}',
      '.dshBridge_heroWorkspaceChevron{flex:none;color:var(--dsw-alias-label-caption,currentColor)}',      '.dshBridge_notice{margin:0 auto;max-width:var(--dsh-chat-content-width,712px);padding:0 calc(var(--dsh-composer-side-clearance,16px) + 16px);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,currentColor)}',
      '.dshBridge_notice[data-error="true"]{color:var(--dsw-alias-state-error-primary,#d33)}',
      '.dshBridge_composerSeat{flex:none;padding:0 var(--dsh-composer-side-clearance,16px) 4px}',
      '.dshBridge_composerStack{box-sizing:border-box;display:flex;flex-direction:column;gap:4px;width:100%;max-width:var(--dsh-composer-card-max-width,calc(clamp(680px,calc(64% + 20.48px),920px) + 32px));margin:0 auto}',
      '.dshBridge_card{box-sizing:border-box;display:flex;flex-direction:column;gap:12px;width:100%;padding-top:8px;border:0;border-radius:var(--dsw-radius-panel,28px);background:var(--dsw-specific-input-major,var(--dsw-alias-bg-base,Canvas));--dsw-elevation-stroke-color:var(--dsw-alias-border-l2,rgba(0,0,0,.12));box-shadow:var(--dsw-elevation-soft,0 0 0 .5px rgba(0,0,0,.1),0 4px 16px rgba(0,0,0,.03));font-size:var(--dsh-content-font-size,14px);line-height:calc(24px + var(--dsh-content-font-delta,0px))}',
      '.dshBridge_textarea{box-sizing:border-box;display:block;width:100%;min-height:36px;max-height:var(--dsh-composer-text-max-height,336px);padding:4px 8px 0 14px;border:0;outline:none;resize:none;background:transparent;color:var(--dsw-alias-label-primary,currentColor);font:inherit;font-size:inherit;line-height:inherit;caret-color:var(--dsw-alias-state-business-primary,#3b82f6)}',
      '.dshBridge_textarea::placeholder{color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary,currentColor))}',
      '.dshBridge_toolbar{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:12px;padding:2px 8px 6px;min-width:0;min-height:34px;container-type:inline-size}',
      '.dshBridge_trailing{display:flex;align-items:center;flex:none;gap:12px;margin-left:auto;min-width:0}',
      '.dshBridge_modelSeat{display:flex;align-items:center;min-width:0}',
      '.dshBridge_modelTrigger{display:flex;align-items:center;gap:4px;min-width:0;max-width:min(360px,45cqw);height:28px;padding:0 4px 0 8px;border:0;border-radius:var(--dsw-radius-sm,8px);outline:none;background:transparent;color:var(--dsw-alias-label-secondary,currentColor);font:inherit;font-size:13px;line-height:20px;font-weight:400;cursor:pointer}',
      '.dshBridge_modelTrigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      '.dshBridge_modelTrigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#3b82f6))}',
      '.dshBridge_modelTrigger:disabled{color:var(--dsw-alias-label-dimmed,currentColor);cursor:default;opacity:.7}',
      '.dshBridge_modelLabel{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshBridge_modelChevron{flex:none;color:var(--dsw-alias-label-caption,currentColor)}',
      '.dshBridge_modelMenu{min-width:240px}',
      '.dshBridge_toolbarSpacer{flex:1;min-width:4px}',
      '.dshBridge_hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,currentColor);white-space:nowrap}',
      '.dshBridge_iconButton{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-secondary,currentColor);cursor:pointer;font:inherit}',
      '.dshBridge_iconButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      '.dshBridge_iconButton:disabled{opacity:.4;cursor:default}',
      /* The shell paints a global superellipse corner-shape; the send circle opts back
       * out to a true round corner, exactly as dsh's own InputBar primary does. */
      '.dshBridge_send{box-sizing:border-box;display:grid;place-items:center;flex:none;width:34px;height:34px;padding:0;border:0;border-radius:999px;corner-shape:round;background:var(--dsw-alias-button-info-fill,#3964fe);color:#fff;cursor:pointer;transition:background-color .1s ease;transform:translateY(-2px)}',
      '.dshBridge_send:hover:not(:disabled){background:var(--dsw-alias-button-info-hover,#2f55d8)}',
      '.dshBridge_send:disabled{opacity:.4;cursor:default}',
      /* Stop keeps the send circle: the shell swaps only the glyph, never the fill. */
      '.dshBridge_send[data-stop="true"]{background:var(--dsw-alias-button-info-fill,#3964fe)}',
      '.dshBridge_send[data-stop="true"]:hover:not(:disabled){background:var(--dsw-alias-button-info-hover,#2f55d8)}',
      '.dshBridge_statusline{box-sizing:border-box;display:flex;align-items:center;justify-content:center;gap:12px;min-height:22px;padding-top:4px;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}',
      '.dshBridge_statusline:empty{display:none}',
      '.dshBridge_statusPillWrap{position:relative;display:inline-flex;min-width:0}',
      '.dshBridge_context{display:inline-flex;align-items:center;gap:6px;height:22px;padding:1px 8px;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-tertiary,currentColor);font:inherit;font-size:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;cursor:pointer}',
      '.dshBridge_context:hover,.dshBridge_context[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));color:var(--dsw-alias-label-secondary,currentColor)}',
      '.dshBridge_contextRing{flex:none;width:14px;height:14px;transform:rotate(-90deg)}',
      '.dshBridge_contextTrack{fill:none;stroke:var(--dsw-alias-border-l3,rgba(0,0,0,.15));stroke-width:2}',
      '.dshBridge_contextFill{fill:none;stroke:var(--dsw-alias-label-tertiary,currentColor);stroke-width:2;stroke-linecap:round}',
      '.dshBridge_statusPill{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:1px 8px;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-tertiary,currentColor);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;cursor:pointer}',
      '.dshBridge_statusPill svg{flex:none;width:14px;height:14px}',
      '.dshBridge_statusPill:hover,.dshBridge_statusPill[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));color:var(--dsw-alias-label-secondary,currentColor)}',
      '.dshBridge_statusLabel{min-width:0;overflow:hidden;text-overflow:ellipsis}',
      '.dshBridge_statusPanel{position:absolute;right:0;bottom:calc(100% + 8px);z-index:1100;box-sizing:border-box;width:max-content;min-width:min(300px,calc(100vw - 24px));max-width:min(440px,calc(100vw - 24px));padding:16px;border:0;border-radius:var(--dsw-radius-lg,16px);background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-2,Canvas));backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1,rgba(0,0,0,.1));box-shadow:var(--dsw-elevation-prominent,0 6px 24px rgba(0,0,0,.12));color:var(--dsw-alias-label-secondary,currentColor);font-size:12px;line-height:18px;cursor:default}',
      '.dshBridge_statusTitle{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:8px;font-weight:500;color:var(--dsw-alias-label-primary,currentColor)}',
      '.dshBridge_statusTitleLabel{display:inline-flex;align-items:center;gap:6px;min-width:0}',
      '.dshBridge_statusTitleLabel svg{flex:none;width:14px;height:14px}',
      '.dshBridge_statusTitleValue{font-variant-numeric:tabular-nums}',
      '.dshBridge_statusRule{margin-bottom:10px;border-top:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}',
      '.dshBridge_statusDetails{display:grid;grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px;margin:0;color:var(--dsw-alias-label-tertiary,currentColor)}',
      '.dshBridge_statusDetails dt,.dshBridge_statusDetails dd{min-width:0;margin:0}',
      '.dshBridge_statusDetails dd{text-align:right;color:var(--dsw-alias-label-secondary,currentColor);font-variant-numeric:tabular-nums}',
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
      '[role="menuitem"]:has(.dshBridge_statusDotSlot) > svg{display:none}',
      '[role="menuitem"]:has(.dshBridge_statusDotSlot[data-selected="true"]){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      '.dshBridge_menuName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshBridge_menuMeta{flex:none;margin-left:auto;font-size:10px;line-height:14px;white-space:nowrap;color:var(--dsw-alias-label-tertiary,currentColor)}',
      '.dshBridge_statusDotSlot{display:inline-flex;flex:none;align-items:center;justify-content:center;width:14px;height:14px}',
      '.dshBridge_statusDot{flex:none;width:7px;height:7px;border-radius:999px;background:var(--dsw-alias-label-dimmed,rgba(0,0,0,.25))}',
      '.dshBridge_statusDot[data-state="connected"]{background:var(--dsw-alias-state-success-primary,#16a34a);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-success-primary,#16a34a) 18%,transparent)}',
      '.dshBridge_statusDot[data-state="connecting"]{background:var(--dsw-alias-state-warning-primary,#d97706);animation:dshBridgePulse 1.1s ease-in-out infinite}',
      '.dshBridge_statusDot[data-state="failed"]{background:var(--dsw-alias-state-error-primary,#dc2626)}',
      '@keyframes dshBridgePulse{0%,100%{opacity:1}50%{opacity:.35}}',
      '.dshBridge_statusRow{display:inline-flex;align-items:center;gap:6px}',
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
      /* Native dsh Settings section. These rules intentionally use the same
       * tokens, dimensions, and rhythm as ui-settings-models so Bridge rows
       * sit in the host dialog rather than a look-alike overlay. */
      /* Standalone Bridge settings page. Geometry and tokens are copied 1:1
       * from the native dsh Settings shell so it reads as the same product
       * without registering a section in dsh's own Settings dialog. */
      '.dshBridge_settingsOverlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center}',
      '.dshBridge_settingsMask{position:absolute;inset:var(--dsh-frame-chrome-top,0px) 0 0;background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur)}',
      '.dshBridge_settingsPanel{position:relative;z-index:1;display:flex;width:800px;max-width:calc(100vw - 48px);height:min(800px,calc(100vh - 2 * max(24px,var(--dsh-frame-overlay-top,24px))));overflow:hidden;border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}',
      '.dshBridge_settingsPanel:focus{outline:none}',
      '.dshBridge_settingsNav{box-sizing:border-box;display:flex;flex:none;flex-direction:column;gap:18px;width:188px;padding:22px 12px 0}',
      '.dshBridge_settingsNavTitle{padding:0 12px;color:var(--dsw-alias-label-primary);font-size:16px;font-weight:500;line-height:24px}',
      '.dshBridge_settingsNavList{display:flex;flex-direction:column;gap:4px;overflow-y:auto}',
      '.dshBridge_settingsNavCell{box-sizing:border-box;display:flex;align-items:center;gap:8px;height:40px;padding:9px 16px 9px 12px;border:none;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;font-weight:400;line-height:22px;text-align:left;cursor:pointer}',
      '.dshBridge_settingsNavCell:hover{background:var(--dsw-specific-sidebar-nav-item-hover)}',
      '.dshBridge_settingsNavCell[data-active="true"]{background:var(--dsw-specific-sidebar-nav-item-active)}',
      '.dshBridge_settingsNavIcon{flex:none}',
      '.dshBridge_settingsNavLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshBridge_settingsContent{display:flex;flex:1;flex-direction:column;min-width:0}',
      '.dshBridge_settingsHeader{box-sizing:border-box;display:flex;flex:none;align-items:flex-start;justify-content:space-between;gap:8px;height:54px;padding:20px 14px 8px 10px}',
      '.dshBridge_settingsActions{display:flex;align-items:center;justify-content:flex-end;gap:8px;min-width:0;margin-left:auto}',
      '.dshBridge_settingsClose{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer}',
      '.dshBridge_settingsClose:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshBridge_settingsOptions{flex:1;min-height:0;padding:0 24px 24px;overflow-y:auto}',
      '.dshBridge_settingsHiddenLabel{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}',
      '.dshBridge_settingsSection{display:flex;flex-direction:column;gap:12px;max-width:720px;color:var(--dsw-alias-label-primary)}',
      '.dshBridge_settingsTitle{margin:0;color:var(--dsw-alias-label-primary);font-size:16px;font-weight:500;line-height:24px}',
      '.dshBridge_settingsIntro{margin:0;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:22px}',
      '.dshBridge_settingsHint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.dshBridge_settingsNotice{margin:0;color:var(--dsw-alias-state-warn-label);font-size:12px;line-height:18px}',
      '.dshBridge_settingsSaved{margin:0;color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:18px}',
      '.dshBridge_settingsError{margin:0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}',
      '.dshBridge_settingsRows{display:flex;flex-direction:column;gap:8px;margin:12px 0 0;padding:0;list-style:none}',
      '.dshBridge_settingsRowCard{display:flex;flex-direction:column;gap:12px;padding:12px 14px;border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2));border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-2))}',
      '.dshBridge_settingsRowHead{display:flex;align-items:center;gap:10px}',
      '.dshBridge_settingsRowIdentity{display:inline-flex;align-items:center;gap:6px;min-width:0}',
      '.dshBridge_settingsRowName{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}',
      '.dshBridge_settingsRowTag{flex:none;padding:1px 6px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xs);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}',
      '.dshBridge_settingsRowActions{display:inline-flex;align-items:center;gap:4px;margin-left:auto}',
      '.dshBridge_settingsConfigSummary{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshBridge_settingsEmpty{margin:0;padding:12px;border:1px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;text-align:center}',
      '.dshBridge_settingsPrimaryButton,.dshBridge_settingsSecondaryButton,.dshBridge_settingsAddButton{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:36px;padding:0 14px;border:none;border-radius:var(--dsw-radius-md);font:inherit;font-size:14px;line-height:22px;cursor:pointer}',
      '.dshBridge_settingsPrimaryButton{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}',
      '.dshBridge_settingsPrimaryButton:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
      '.dshBridge_settingsSecondaryButton,.dshBridge_settingsAddButton{border:.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-primary)}',
      '.dshBridge_settingsSecondaryButton:hover:not(:disabled),.dshBridge_settingsAddButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshBridge_settingsSecondaryButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}',
      '.dshBridge_settingsDangerButton{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;height:36px;padding:0 14px;border:none;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-state-error-primary);font:inherit;font-size:14px;line-height:22px;cursor:pointer}',
      '.dshBridge_settingsDangerButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}',
      '.dshBridge_settingsPrimaryButton:disabled,.dshBridge_settingsSecondaryButton:disabled,.dshBridge_settingsDangerButton:disabled,.dshBridge_settingsAddButton:disabled{opacity:.4;cursor:default}',
      '.dshBridge_settingsRowActions .dshBridge_settingsSecondaryButton,.dshBridge_settingsRowActions .dshBridge_settingsDangerButton{height:28px;padding:0 10px;border-radius:var(--dsw-radius-sm);font-size:12px;line-height:18px}',
      '.dshBridge_settingsPrimaryButton:focus-visible,.dshBridge_settingsSecondaryButton:focus-visible,.dshBridge_settingsDangerButton:focus-visible,.dshBridge_settingsAddButton:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline:none}',
      '.dshBridge_settingsAddBlock{display:flex;flex-direction:column;gap:12px}',
      '.dshBridge_settingsAddActions{display:flex}',
      '.dshBridge_settingsAddButton{flex:1 1 0;min-width:180px;height:44px;gap:6px;border:1px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg)}',
      '.dshBridge_settingsEditor{display:flex;flex-direction:column;gap:14px;padding:14px 16px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-module-platform,var(--dsw-alias-bg-layer-2))}',
      '.dshBridge_settingsField{display:flex;flex-direction:column;gap:6px}',
      '.dshBridge_settingsFieldLabel{display:inline-flex;align-items:center;gap:10px;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px}',
      '.dshBridge_settingsInput{box-sizing:border-box;width:100%;height:32px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px}',
      '.dshBridge_settingsInput:focus{border-color:var(--dsw-alias-state-business-primary);outline:none}',
      '.dshBridge_settingsInput::placeholder{color:var(--dsw-alias-label-dimmed)}',
      '.dshBridge_settingsInput:disabled{opacity:.6;cursor:default}',
      '.dshBridge_settingsSelect{appearance:none;max-width:240px;padding-right:32px;background-image:url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'12\' height=\'12\' viewBox=\'0 0 12 12\' fill=\'none\'%3E%3Cpath d=\'M3 4.5L6 7.5L9 4.5\' stroke=\'%2381858C\' stroke-width=\'1.5\' stroke-linecap=\'round\' stroke-linejoin=\'round\'/%3E%3C/svg%3E");background-position:right 12px center;background-repeat:no-repeat;background-size:12px 12px;cursor:pointer}',
      '.dshBridge_settingsSwitchRow{display:flex;align-items:flex-start;gap:10px}',
      '.dshBridge_settingsSwitchText{display:flex;flex:1;flex-direction:column;gap:2px;min-width:0}',
      '.dshBridge_settingsEditorActions{display:flex;justify-content:flex-end;gap:8px}',
      `.dshBridge_browser_root{--dsh-session-list-edge-inset:var(--dsh-sidebar-inline-padding);--dsh-session-list-scrollbar-width:5px;--dsh-session-list-scrollbar-offset:2px;box-sizing:border-box;min-height:0;padding-right:var(--dsh-session-list-edge-inset);flex-direction:column;flex:1;display:flex}.dshBridge_browser_root.dshBridge_browser_rail{padding-right:0}.dshBridge_browser_iconButton{border-radius:var(--dsw-radius-sm);cursor:pointer;width:28px;height:28px;color:var(--dsw-alias-label-secondary);background:0 0;border:none;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex}.dshBridge_browser_iconButton:focus-visible,.dshBridge_browser_searchButton:focus-visible,.dshBridge_browser_clearButton:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}.dshBridge_browser_iconButton:hover{background:var(--dsw-alias-interactive-bg-hover)}.dshBridge_browser_viewOptionsMenu{min-width:200px}.dshBridge_browser_sectionHeader{box-sizing:border-box;border-radius:var(--dsw-radius-md);height:36px;color:var(--dsw-alias-label-tertiary);flex:none;justify-content:flex-end;align-items:center;gap:4px;margin-bottom:4px;padding-left:4px;display:flex;overflow:hidden}.dshBridge_browser_root:not(.dshBridge_browser_rail) .dshBridge_browser_sectionHeader{margin-top:2px;margin-right:-4px}.dshBridge_browser_sectionLabel{white-space:nowrap;opacity:1;visibility:visible;min-width:0;max-width:45%;transition:max-width .18s var(--ds-ease-in-out),margin-right .18s var(--ds-ease-in-out),opacity .12s var(--ds-ease-in-out),transform .18s var(--ds-ease-in-out),visibility 0s linear;flex:none;line-height:20px;overflow:hidden}.dshBridge_browser_sectionLabelHidden{opacity:0;visibility:hidden;max-width:0;margin-right:-4px;transition-delay:0s,0s,0s,0s,.18s;transform:translate(-4px)}.dshBridge_browser_searchSlot{box-sizing:border-box;min-width:0;max-width:28px;transition:max-width .18s var(--ds-ease-in-out),padding-left .18s var(--ds-ease-in-out);flex:1;align-items:center;margin-left:auto;padding-left:0;display:flex}.dshBridge_browser_searchSlotExpanded{max-width:100%;padding-left:0}.dshBridge_browser_headerActions{opacity:1;visibility:visible;max-width:124px;transition:max-width .18s var(--ds-ease-in-out),opacity .12s var(--ds-ease-in-out),transform .18s var(--ds-ease-in-out),visibility 0s linear;flex:none;align-items:center;gap:4px;display:flex;overflow:hidden}.dshBridge_browser_headerActionsHidden{opacity:0;visibility:hidden;pointer-events:none;max-width:0;transition-delay:0s,0s,0s,.18s;transform:translate(4px)}.dshBridge_browser_search{box-sizing:border-box;border-radius:var(--dsw-radius-sm);cursor:text;width:100%;height:28px;color:var(--dsw-alias-label-secondary);transition:width .18s var(--ds-ease-in-out),padding .18s var(--ds-ease-in-out),border-color .18s var(--ds-ease-in-out),background-color .18s var(--ds-ease-in-out);background:0 0;border:none;flex:none;align-items:center;gap:0;margin:0;padding:0;display:flex;overflow:hidden}.dshBridge_browser_searchExpanded{border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);width:calc(100% + 4px);height:30px;color:var(--dsw-alias-label-caption);background:0 0;margin-inline:-2px;padding:0 4px 0 0}.dshBridge_browser_searchButton{border-radius:var(--dsw-radius-sm);cursor:pointer;width:28px;height:28px;color:inherit;background:0 0;border:none;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex}.dshBridge_browser_searchExpanded .dshBridge_browser_searchButton{width:28px;height:30px}.dshBridge_browser_searchButton:hover{background:var(--dsw-alias-interactive-bg-hover)}.dshBridge_browser_searchExpanded .dshBridge_browser_searchButton:hover{background:0 0}.dshBridge_browser_searchInput{opacity:0;pointer-events:none;width:0;min-width:0;color:var(--dsw-alias-label-primary);transition:opacity .12s var(--ds-ease-in-out);background:0 0;border:none;outline:none;flex:1;font-size:13px;line-height:18px}.dshBridge_browser_searchExpanded .dshBridge_browser_searchInput{opacity:1;pointer-events:auto;margin-left:-2px}.dshBridge_browser_searchInput::placeholder{color:var(--dsw-alias-label-tertiary)}.dshBridge_browser_clearButton{border-radius:var(--dsw-radius-sm);cursor:pointer;width:24px;height:24px;color:var(--dsw-alias-label-secondary);background:0 0;border:none;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex}.dshBridge_browser_clearButton:hover{background:var(--dsw-alias-interactive-bg-hover)}.dshBridge_browser_rail .dshBridge_browser_sectionHeader{justify-content:flex-start;gap:0;margin-bottom:12px;padding-left:0}.dshBridge_browser_rail .dshBridge_browser_headerActions{max-width:none}.dshBridge_browser_rail .dshBridge_browser_iconButton{border-radius:var(--dsw-radius-md);width:36px;height:36px;color:var(--dsw-alias-label-primary)}.dshBridge_browser_rail .dshBridge_browser_search{border-radius:var(--dsw-radius-md);background:0 0;border-color:#0000;gap:0;width:36px;height:36px;margin:0 0 12px;padding:0}.dshBridge_browser_rail .dshBridge_browser_searchButton{border-radius:var(--dsw-radius-md);width:36px;height:36px;color:var(--dsw-alias-label-primary)}.dshBridge_browser_rail .dshBridge_browser_searchButton:hover{background:var(--dsw-alias-interactive-bg-hover)}.dshBridge_browser_listArea{min-height:0;margin-left:-4px;margin-right:calc(-1 * var(--dsh-session-list-edge-inset));flex-direction:column;flex:1;padding-left:4px;display:flex;overflow:visible}.dshBridge_browser_rail .dshBridge_browser_listArea{margin-left:0;margin-right:0;padding-left:0}.dshBridge_browser_treeBody{flex-direction:column;flex:1;min-height:0;display:flex;position:relative}.dshBridge_browser_fade{left:0;right:var(--dsh-session-list-edge-inset);background:linear-gradient(to bottom,transparent,var(--dsw-specific-sidebar-fill));pointer-events:none;height:24px;position:absolute;bottom:0}[data-platform=darwin] .dshBridge_browser_fade{display:none}.dshBridge_browser_wide{animation:dshBridge_browser_wide-in .2s var(--ds-ease-in-out)}@keyframes dshBridge_browser_wide-in{0%{opacity:0}}.dshBridge_browser_list{min-height:0;margin-left:-4px;margin-right:var(--dsh-session-list-scrollbar-offset);padding-left:4px;padding-right:calc(var(--dsh-session-list-edge-inset) - var(--dsh-session-list-scrollbar-width) - var(--dsh-session-list-scrollbar-offset));scrollbar-gutter:stable;flex:1;padding-bottom:16px;overflow-y:auto}.dshBridge_browser_flatList>*+*,.dshBridge_browser_searchTree>[role=treeitem]+[role=treeitem],.dshBridge_browser_groupSection>*+*{margin-top:2px}.dshBridge_browser_searchStatus{color:var(--dsw-alias-label-tertiary);padding:10px 12px;font-size:12px;line-height:18px}.dshBridge_browser_groupSection{position:relative}.dshBridge_browser_groupSection+.dshBridge_browser_groupSection{margin-top:4px}.dshBridge_browser_listTopDropIndicator,.dshBridge_browser_workspaceDropBefore:before,.dshBridge_browser_workspaceDropAfter:after{content:"";z-index:1;background:linear-gradient(55deg,transparent calc(50% - 1px),var(--dsw-alias-state-business-primary) calc(50% - 1px) calc(50% + 1px),transparent calc(50% + 1px)) 0 0 / 5px 7px no-repeat,linear-gradient(125deg,transparent calc(50% - 1px),var(--dsw-alias-state-business-primary) calc(50% - 1px) calc(50% + 1px),transparent calc(50% + 1px)) 0 5px / 5px 7px no-repeat,linear-gradient(var(--dsw-alias-state-business-primary) 0 0) 4px 5px / calc(100% - 4px) 2px no-repeat;pointer-events:none;height:12px;position:absolute;left:0;right:0}.dshBridge_browser_listTopDropIndicator{top:-8px;left:0;right:var(--dsh-session-list-edge-inset)}.dshBridge_browser_listTopDropActive>.dshBridge_browser_workspaceDropBefore:first-child:before{display:none}.dshBridge_browser_workspaceDropBefore:before{top:-8px}.dshBridge_browser_workspaceDropAfter:after{bottom:-8px}.dshBridge_browser_sessionOverflowButton{border-radius:var(--dsw-radius-sm);width:100%;height:28px;padding:0 12px 0 calc(28px + var(--dsh-workspace-indent,0px));cursor:pointer;text-align:left;color:var(--dsw-alias-label-tertiary);background:0 0;border:none;font-size:12px}.dshBridge_browser_groupSection>.dshBridge_browser_sessionOverflowButton{margin-top:0}.dshBridge_browser_sessionOverflowButton:hover{color:var(--dsw-alias-label-secondary);background:0 0}.dshBridge_browser_empty{color:var(--dsw-alias-label-tertiary);padding:16px 12px;font-size:13px}.dshBridge_browser_emptyState{color:var(--dsw-alias-label-tertiary);flex-direction:column;align-items:center;gap:8px;margin-top:80px;padding:0 12px;font-size:13px;line-height:20px;display:flex}.dshBridge_browser_emptyState>svg{color:var(--dsw-alias-label-caption);margin-bottom:4px}.dshBridge_browser_emptyAction{cursor:pointer;color:var(--dsw-alias-link);background:0 0;border:none;padding:0;font-size:13px;line-height:20px}.dshBridge_browser_renameInput{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-lg);width:100%;height:44px;color:var(--dsw-alias-label-primary);background:0 0;outline:none;padding:7px 14px;font-size:14px;font-weight:400;line-height:22px}.dshBridge_browser_renameInput:disabled{color:var(--dsw-alias-label-dimmed)}.dshBridge_browser_renameError{color:var(--dsw-alias-state-error-primary);margin-top:8px;font-size:12px;line-height:18px}.dshBridge_browser_deleteAction:not(:disabled){color:var(--dsw-alias-state-error-primary)}.dshBridge_browser_deleteStatus{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}@media (prefers-reduced-motion:reduce){.dshBridge_browser_wide{animation:none}.dshBridge_browser_search,.dshBridge_browser_sectionLabel,.dshBridge_browser_searchSlot,.dshBridge_browser_searchInput,.dshBridge_browser_headerActions{transition:none}}`,
      `.dshBridge_row_projectRow,.dshBridge_row_sessionRow{border-radius:var(--dsw-radius-md);padding:0 8px;cursor:pointer;user-select:none;color:var(--dsw-alias-label-primary);align-items:center;gap:6px;padding-inline-start:calc(8px + var(--dsh-workspace-indent,0px));display:flex}.dshBridge_row_projectRow:hover,.dshBridge_row_sessionRow:hover,.dshBridge_row_sessionRow.dshBridge_row_selected{background:var(--dsw-alias-interactive-bg-hover)}.dshBridge_row_searchResultRow{box-sizing:border-box;border-radius:var(--dsw-radius-lg);cursor:pointer;text-align:left;width:100%;min-height:48px;color:var(--dsw-alias-label-primary);background:0 0;border:none;flex-direction:column;align-items:stretch;padding:4px 8px;display:flex}.dshBridge_row_searchResultRow:hover,.dshBridge_row_searchResultRow.dshBridge_row_selected{background:var(--dsw-alias-interactive-bg-hover)}.dshBridge_row_searchResultHeading{align-items:center;min-width:0;display:flex}.dshBridge_row_searchResultTitle{text-overflow:ellipsis;white-space:nowrap;flex:0 auto;min-width:0;margin-left:4px;font-size:14px;line-height:20px;overflow:hidden}.dshBridge_row_searchResultMeta{align-items:center;gap:6px;min-width:0;margin-left:20px;display:flex}.dshBridge_row_searchResultWorkspace,.dshBridge_row_searchResultSnippet{text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:17px;overflow:hidden}.dshBridge_row_searchResultWorkspace{max-width:40%;color:var(--dsw-alias-label-tertiary);flex:none}.dshBridge_row_searchResultWorkspace:only-child{max-width:100%}.dshBridge_row_searchResultSnippet{min-width:0;color:var(--dsw-alias-label-secondary);flex:1}.dshBridge_row_projectRow{box-sizing:border-box;align-items:center;height:34px}.dshBridge_row_projectRow .dshBridge_row_rowActions{height:20px}.dshBridge_row_sessionRow{gap:0;height:32px}.dshBridge_row_sessionRow .dshBridge_row_title{margin:0 6px 0 4px}.dshBridge_row_slot{width:16px;height:20px;color:var(--dsw-alias-label-tertiary);flex:none;justify-content:center;align-items:center;display:inline-flex}.dshBridge_row_visuallyHidden{clip:rect(0 0 0 0);white-space:nowrap;width:1px;height:1px;position:absolute;overflow:hidden}.dshBridge_row_folderActive{color:var(--dsw-alias-state-business-primary)}.dshBridge_row_projectRow .dshBridge_row_chevron{display:none}.dshBridge_row_projectRow:hover .dshBridge_row_chevron{display:inline-flex}.dshBridge_row_projectRow:hover .dshBridge_row_folder{display:none}.dshBridge_row_arrow{transition:transform .15s var(--ds-ease-in-out)}.dshBridge_row_arrowOpen{transform:rotate(90deg)}.dshBridge_row_projectText{flex-direction:column;flex:1;gap:2px;min-width:0;display:flex}.dshBridge_row_title{text-overflow:ellipsis;white-space:nowrap;min-width:0;font-size:14px;line-height:20px;overflow:hidden}.dshBridge_row_renameInput{border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-button-elevated-fill);min-width:0;color:inherit;outline:none;padding:0 2px;font-size:14px;line-height:20px}.dshBridge_row_sessionRow .dshBridge_row_title{flex:1}.dshBridge_row_meta{text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px;overflow:hidden}.dshBridge_row_time{color:var(--dsw-alias-label-tertiary);flex:none;font-size:10px;line-height:16px}.dshBridge_row_spinner{box-sizing:border-box;width:10px;height:10px;border-radius:999px;border:1.5px solid color-mix(in srgb,var(--dsw-alias-state-business-primary,#3b82f6) 30%,transparent);border-top-color:var(--dsw-alias-state-business-primary,#3b82f6);animation:dshBridgeSpin .8s linear infinite}.dshBridge_row_doneDot{width:7px;height:7px;border-radius:999px;background:var(--dsw-alias-state-success-primary,#16a34a)}.dshBridge_row_failedDot{width:7px;height:7px;border-radius:999px;background:var(--dsw-alias-state-error-primary,#dc2626)}@keyframes dshBridgeSpin{to{transform:rotate(360deg)}}.dshBridge_row_pinIndicator{width:16px;height:20px;color:var(--dsw-alias-label-caption);flex:none;justify-content:center;align-items:center;margin-left:6px;display:inline-flex}.dshBridge_row_sessionRow.dshBridge_row_archived .dshBridge_row_title,.dshBridge_row_searchResultRow.dshBridge_row_archived .dshBridge_row_searchResultTitle,.dshBridge_row_searchResultRow.dshBridge_row_archived .dshBridge_row_searchResultWorkspace,.dshBridge_row_searchResultRow.dshBridge_row_archived .dshBridge_row_searchResultSnippet{color:var(--dsw-alias-label-caption)}.dshBridge_row_dot{flex:none}.dshBridge_row_rowActions{flex:none;align-items:center;gap:10px;display:none}.dshBridge_row_projectRow:hover .dshBridge_row_rowActions,.dshBridge_row_sessionRow:hover .dshBridge_row_rowActions,.dshBridge_row_searchResultRow:hover .dshBridge_row_rowActions,.dshBridge_row_projectRow.dshBridge_row_menuOpen .dshBridge_row_rowActions,.dshBridge_row_sessionRow.dshBridge_row_menuOpen .dshBridge_row_rowActions{display:inline-flex}.dshBridge_row_searchResultHeading .dshBridge_row_rowActions{margin-left:auto}.dshBridge_row_sessionRow:hover .dshBridge_row_time,.dshBridge_row_sessionRow.dshBridge_row_menuOpen .dshBridge_row_time,.dshBridge_row_sessionRow:hover .dshBridge_row_pinIndicator,.dshBridge_row_sessionRow.dshBridge_row_menuOpen .dshBridge_row_pinIndicator{display:none}@media (hover:hover){.dshBridge_row_sessionRow:hover .dshBridge_row_title,.dshBridge_row_sessionRow.dshBridge_row_menuOpen .dshBridge_row_title{text-overflow:clip}}.dshBridge_row_projectRow.dshBridge_row_menuOpen,.dshBridge_row_sessionRow.dshBridge_row_menuOpen{background:var(--dsw-alias-interactive-bg-hover)}.dshBridge_row_sessionRow.dshBridge_row_dropBefore,.dshBridge_row_sessionRow.dshBridge_row_dropAfter{position:relative}.dshBridge_row_sessionRow.dshBridge_row_dropBefore:before,.dshBridge_row_sessionRow.dshBridge_row_dropAfter:after{content:"";z-index:1;background:linear-gradient(55deg,transparent calc(50% - 1px),var(--dsw-alias-state-business-primary) calc(50% - 1px) calc(50% + 1px),transparent calc(50% + 1px)) 0 0 / 5px 7px no-repeat,linear-gradient(125deg,transparent calc(50% - 1px),var(--dsw-alias-state-business-primary) calc(50% - 1px) calc(50% + 1px),transparent calc(50% + 1px)) 0 5px / 5px 7px no-repeat,linear-gradient(var(--dsw-alias-state-business-primary) 0 0) 4px 5px / calc(100% - 4px) 2px no-repeat;pointer-events:none;height:12px;position:absolute;left:0;right:4px}.dshBridge_row_sessionRow.dshBridge_row_dropBefore:before{top:-7px}.dshBridge_row_sessionRow.dshBridge_row_dropAfter:after{bottom:-7px}.dshBridge_row_hoverContent{flex-direction:column;gap:8px;display:flex}.dshBridge_row_hoverTitle{color:#fff;overflow-wrap:break-word;font-size:14px;line-height:20px}.dshBridge_row_hoverPath{color:#cfd3d6;word-break:break-all;font-size:12px;line-height:16px}.dshBridge_row_hoverTime{color:#cfd3d6;font-size:12px;line-height:16px}.dshBridge_row_hoverStatus{color:#adb2b8;align-items:center;gap:8px;font-size:12px;line-height:20px;display:flex}.dshBridge_row_iconButton{border-radius:var(--dsw-radius-xs);cursor:pointer;width:16px;height:16px;color:var(--dsw-alias-label-tertiary);background:0 0;border:none;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex}.dshBridge_row_iconButton:hover{color:var(--dsw-alias-label-primary)}.dshBridge_row_chevron{color:var(--dsw-alias-label-caption)}@media (prefers-reduced-motion:reduce){.dshBridge_row_arrow{transition:none;animation:none}}`,
      `.dshBridge_dir_dialog.dshBridge_dir_dialog{--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);gap:0;width:min(680px,100%);height:min(500px,100dvh - 32px);padding:0}.dshBridge_dir_editorScope{display:contents}.dshBridge_dir_header{border-bottom:.5px solid var(--dsw-alias-border-l3);flex-direction:column;flex:none;gap:8px;padding:16px 14px 8px 24px;display:flex}.dshBridge_dir_title{min-height:28px;color:var(--dsw-alias-label-primary);align-items:flex-end;margin:0;font-size:16px;font-weight:510;line-height:24px;display:flex}.dshBridge_dir_crumbBar{box-sizing:border-box;border-radius:var(--dsw-radius-sm);border:1px solid #0000;align-items:center;gap:4px;min-height:24px;margin-left:-9px;padding:0 8px;display:flex}.dshBridge_dir_crumbBar:has(.dshBridge_dir_crumbEditZone:enabled:hover),.dshBridge_dir_crumbBar:has(.dshBridge_dir_crumbEditZone:focus-visible),.dshBridge_dir_crumbBar:has(.dshBridge_dir_pathInput){border-color:var(--dsw-alias-border-l2)}.dshBridge_dir_millerRow{scrollbar-width:none;flex:1 1 0;align-items:stretch;gap:12px;min-height:0;display:flex;overflow-x:auto}.dshBridge_dir_crumbTrail{scrollbar-width:none;flex:0 auto;align-items:center;gap:4px;min-width:0;display:flex;overflow-x:auto}.dshBridge_dir_crumbSeat{flex:none;align-items:center;gap:4px;min-width:0;display:inline-flex}.dshBridge_dir_crumb{text-overflow:ellipsis;white-space:nowrap;max-width:160px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;padding:0;font-size:13px;font-weight:500;line-height:20px;overflow:hidden}.dshBridge_dir_crumb:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}.dshBridge_dir_crumb:hover{color:var(--dsw-alias-label-primary)}.dshBridge_dir_crumbChevron{color:var(--dsw-alias-label-tertiary);flex:none}.dshBridge_dir_crumbEditZone{cursor:text;background:0 0;border:none;outline:none;flex:1 0 34px;justify-content:flex-end;align-items:center;min-width:34px;height:22px;padding:0;display:flex}.dshBridge_dir_crumbEditGlyph{color:var(--dsw-alias-label-tertiary);flex:none}.dshBridge_dir_crumbEditZone:enabled:hover .dshBridge_dir_crumbEditGlyph,.dshBridge_dir_crumbEditZone:focus-visible .dshBridge_dir_crumbEditGlyph{color:var(--dsw-alias-label-primary)}.dshBridge_dir_crumbEditZone:disabled{cursor:default}.dshBridge_dir_crumbEditZone:disabled .dshBridge_dir_crumbEditGlyph{color:var(--dsw-alias-label-caption)}.dshBridge_dir_pathInput{box-sizing:border-box;min-width:0;height:22px;color:var(--dsw-alias-label-primary);background:0 0;border:none;outline:none;flex:1 1 0;padding:0;font-size:13px;line-height:20px}.dshBridge_dir_content{flex-direction:column;flex:1 1 0;min-height:0;padding:16px 16px 16px 24px;display:flex;position:relative}.dshBridge_dir_column{flex-direction:column;flex:1 1 0;gap:2px;min-width:256px;padding-right:8px;display:flex;overflow-y:auto}.dshBridge_dir_divider{background:var(--dsw-alias-border-l3);flex:none;width:.5px}.dshBridge_dir_rowSeat{flex:none;display:flex}.dshBridge_dir_row{border-radius:var(--dsw-radius-sm);text-align:left;cursor:pointer;background:0 0;border:none;flex:none;align-items:center;gap:4px;width:100%;height:28px;padding:4px;display:flex}.dshBridge_dir_row:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}.dshBridge_dir_row:hover{background:var(--dsw-alias-interactive-bg-hover)}.dshBridge_dir_rowSelected,.dshBridge_dir_rowSelected:hover{background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-interactive-bg-hover))}.dshBridge_dir_rowIcon{color:var(--dsw-alias-label-secondary);flex:none}.dshBridge_dir_rowIconSelected{color:var(--dsw-alias-button-info-fill);flex:none}.dshBridge_dir_rowName{text-overflow:ellipsis;white-space:nowrap;min-width:0;color:var(--dsw-alias-label-primary);flex:1 1 0;font-size:13px;font-weight:500;line-height:20px;overflow:hidden}.dshBridge_dir_rowChevron{color:var(--dsw-alias-label-tertiary);flex:none}.dshBridge_dir_status,.dshBridge_dir_error{padding:4px 120px 4px 4px;font-size:12px;line-height:18px}.dshBridge_dir_status{color:var(--dsw-alias-label-secondary)}.dshBridge_dir_error{color:var(--dsw-alias-state-error-primary)}.dshBridge_dir_loadingFloat{background:var(--dsw-alias-bg-layer-2);padding:2px 8px;position:absolute;bottom:8px;right:16px}.dshBridge_dir_footerBar{border-top:.5px solid var(--dsw-alias-border-l3);flex-wrap:wrap;flex:none;align-items:center;gap:8px;padding:16px 24px;display:flex}.dshBridge_dir_showHiddenToggle{color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;background:0 0;border:none;align-items:center;gap:4px;padding:0;font-size:13px;font-weight:500;line-height:20px;display:inline-flex}.dshBridge_dir_showHiddenToggle:hover{color:var(--dsw-alias-label-primary)}.dshBridge_dir_showHiddenToggle:disabled{color:var(--dsw-alias-label-caption);cursor:default}.dshBridge_dir_showHiddenToggleActive{color:var(--dsw-alias-label-primary)}.dshBridge_dir_footerGap{flex:1 1 0}.dshBridge_dir_footerAction{min-width:72px}.dshBridge_dir_createDialog.dshBridge_dir_createDialog{gap:0;width:min(380px,100%);padding:0}.dshBridge_dir_createBody{flex-direction:column;gap:12px;padding:22px 24px 20px;display:flex}.dshBridge_dir_createTitle{color:var(--dsw-alias-label-primary);margin:0;font-size:16px;font-weight:510;line-height:24px}.dshBridge_dir_createIn{color:var(--dsw-alias-label-primary);margin:0;font-size:14px;line-height:22px}.dshBridge_dir_createInput{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-lg);width:100%;height:44px;color:var(--dsw-alias-label-primary);background:0 0;outline:none;padding:7px 14px;font-size:14px;line-height:22px}.dshBridge_dir_createInput::placeholder{color:var(--dsw-alias-label-caption)}.dshBridge_dir_createActions{justify-content:flex-end;align-items:center;gap:8px;margin-top:8px;display:flex}`,
      '.dshBridge_import_dialog{width:min(920px,calc(100vw - 48px));max-width:920px}',
      '.dshBridge_import_body{box-sizing:border-box;display:flex;flex-direction:column;width:min(920px,calc(100vw - 48px));height:min(720px,calc(100vh - 96px));overflow:hidden;border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.dshBridge_import_header{display:flex;flex:none;align-items:flex-start;justify-content:space-between;gap:16px;padding:20px 20px 12px 24px;border-bottom:.5px solid var(--dsw-alias-border-l2)}',
      '.dshBridge_import_heading{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.dshBridge_import_title{margin:0;font-size:16px;font-weight:500;line-height:24px}',
      '.dshBridge_import_hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.dshBridge_import_toolbar{display:flex;flex:none;align-items:center;gap:10px;padding:12px 24px;border-bottom:.5px solid var(--dsw-alias-border-l2)}',
      '.dshBridge_import_modeToggle{display:inline-flex;flex:none;align-items:center;gap:2px;padding:2px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshBridge_import_modeButton{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 9px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}',
      '.dshBridge_import_modeButton[data-active="true"]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 0 0 .5px var(--dsw-alias-border-l2)}',
      '.dshBridge_import_search{display:flex;flex:1;align-items:center;gap:6px;min-width:0;height:30px;padding:0 9px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);color:var(--dsw-alias-label-tertiary)}',
      '.dshBridge_import_search input{flex:1;min-width:0;border:0;outline:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px}',
      '.dshBridge_import_selectAll{flex:none;height:28px;padding:0 8px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}',
      '.dshBridge_import_selectAll:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dshBridge_import_selectAll:disabled{opacity:.4;cursor:default}',
      '.dshBridge_import_content{flex:1;min-height:0;overflow:auto;padding:8px 16px 12px 24px}',
      '.dshBridge_import_tree,.dshBridge_import_list{display:flex;flex-direction:column;gap:2px;min-height:0}',
      '.dshBridge_import_group{display:flex;flex-direction:column;gap:2px}',
      '.dshBridge_import_workspaceRow{box-sizing:border-box;display:flex;align-items:center;gap:6px;height:32px;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-secondary)}',
      '.dshBridge_import_workspaceRow:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshBridge_import_chevron{display:inline-flex;flex:none;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:0;border-radius:var(--dsw-radius-xs);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}',
      '.dshBridge_import_groupCheck{display:inline-flex;flex:none;align-items:center;justify-content:center;padding:0;border:0;background:transparent;cursor:pointer}',
      '.dshBridge_import_groupCheck:disabled{cursor:default}',
      '.dshBridge_import_folderIcon{flex:none;color:var(--dsw-alias-label-tertiary)}',
      '.dshBridge_import_groupName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary)}',
      '.dshBridge_import_count{flex:none;margin-right:8px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.dshBridge_import_row{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;height:34px;padding:0 8px 0 28px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer}',
      '.dshBridge_import_row:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshBridge_import_rowSelected{background:var(--dsw-alias-interactive-bg-active)}',
      '.dshBridge_import_rowDisabled{color:var(--dsw-alias-label-tertiary);cursor:default}',
      '.dshBridge_import_check{box-sizing:border-box;display:inline-flex;flex:none;align-items:center;justify-content:center;width:16px;height:16px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xs);background:transparent;color:var(--dsw-alias-label-primary-foreground)}',
      '.dshBridge_import_check[data-state="checked"]{border-color:var(--dsw-alias-button-primary-fill);background:var(--dsw-alias-button-primary-fill)}',
      '.dshBridge_import_check[data-state="partial"]{border-color:var(--dsw-alias-button-primary-fill);background:var(--dsw-alias-button-primary-fill)}',
      '.dshBridge_import_dash{display:block;width:8px;height:1.5px;border-radius:1px;background:currentColor}',
      '.dshBridge_import_sessionText{display:flex;flex:1;flex-direction:column;min-width:0;gap:0}',
      '.dshBridge_import_sessionTitle{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:18px}',
      '.dshBridge_import_sessionMeta{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}',
      '.dshBridge_import_sessionTime{flex:none;font-size:10px;line-height:16px;color:var(--dsw-alias-label-tertiary)}',
      '.dshBridge_import_badge{flex:none;padding:1px 6px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:16px}',
      '.dshBridge_import_status{padding:20px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;text-align:center}',
      '.dshBridge_import_error{color:var(--dsw-alias-state-error-primary)}',
      '.dshBridge_import_empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;min-height:260px;padding:24px;text-align:center;color:var(--dsw-alias-label-tertiary)}',
      '.dshBridge_import_emptyTitle{color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}',
      '.dshBridge_import_emptyHint{max-width:420px;font-size:12px;line-height:18px}',
      '.dshBridge_import_footer{display:flex;flex:none;align-items:center;gap:8px;padding:12px 24px 16px;border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.dshBridge_import_selection{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.dshBridge_import_footerGap{flex:1}',
      '@media (max-width:700px){.dshBridge_import_toolbar{flex-wrap:wrap}.dshBridge_import_search{order:3;flex-basis:100%}}',
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

    /** Compact token count with the same K/M rhythm as dsh's status pills. */
    function compactTokens(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '0'
      if (value < 1000) return String(Math.round(value))
      if (value < 1_000_000) {
        const scaled = value / 1000
        return `${scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10}K`
      }
      const scaled = value / 1_000_000
      return `${scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10}M`
    }

    function exactTokens(value) {
      const digits = String(Math.round(typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0))
      return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    }

    function countNumber(value) {
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
    }

    /** Normalize Pi's `get_session_stats` payload into the dock's display shape. */
    function normalizeBridgeStats(raw) {
      if (raw === null || typeof raw !== 'object') return null
      const tokens = raw.tokens !== null && typeof raw.tokens === 'object' ? raw.tokens : {}
      const uncachedInput = countNumber(tokens.input ?? raw.uncachedInputTokens)
      const cacheRead = countNumber(tokens.cacheRead ?? raw.cacheReadTokens)
      const cacheWrite = countNumber(tokens.cacheWrite ?? raw.cacheWriteTokens)
      const output = countNumber(tokens.output ?? raw.outputTokens)
      const total = countNumber(tokens.total) || uncachedInput + cacheRead + cacheWrite + output
      const rawContext = raw.contextUsage !== null && typeof raw.contextUsage === 'object' ? raw.contextUsage : null
      const contextUsed = rawContext === null ? 0 : countNumber(rawContext.tokens)
      const contextWindow = rawContext === null ? 0 : countNumber(rawContext.contextWindow)
      const contextPercent = rawContext === null
        ? 0
        : countNumber(rawContext.percent) || (contextWindow > 0 ? (contextUsed / contextWindow) * 100 : 0)
      return {
        turns: countNumber(raw.userMessages ?? raw.turns),
        steps: countNumber(raw.assistantMessages ?? raw.steps),
        toolCalls: countNumber(raw.toolCalls),
        totalMessages: countNumber(raw.totalMessages),
        tokens: { uncachedInput, cacheRead, cacheWrite, output, total },
        context: contextWindow > 0 ? { used: contextUsed, window: contextWindow, percent: contextPercent } : null,
      }
    }

    /** Fallback statistics folded from the durable transcript when the engine has no stats RPC. */
    function deriveBridgeStats(messages) {
      const list = Array.isArray(messages) ? messages : []
      const tokens = { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 }
      let turns = 0
      let steps = 0
      let toolCalls = 0
      for (const message of list) {
        if (message?.role === 'user') turns += 1
        if (message?.role === 'assistant') {
          steps += 1
          const usage = message.usage !== null && typeof message.usage === 'object' ? message.usage : {}
          tokens.uncachedInput += countNumber(usage.input)
          tokens.cacheRead += countNumber(usage.cacheRead)
          tokens.cacheWrite += countNumber(usage.cacheWrite)
          tokens.output += countNumber(usage.output)
        }
        if (Array.isArray(message?.content)) {
          toolCalls += message.content.filter((block) => block && block.type === 'toolCall').length
        }
      }
      tokens.total = tokens.uncachedInput + tokens.cacheRead + tokens.cacheWrite + tokens.output
      return { turns, steps, toolCalls, totalMessages: list.length, tokens, context: null }
    }

    function statsVisible(stats) {
      return stats !== null && typeof stats === 'object'
        && (stats.steps > 0 || stats.turns > 0 || stats.tokens.total > 0)
    }

    /** Cache-hit share over every prompt-side billing bucket, like dsh's usage pill. */
    function bridgeCacheHitPercent(tokens) {
      const denominator = tokens.uncachedInput + tokens.cacheRead + tokens.cacheWrite
      if (denominator <= 0) return null
      if (tokens.cacheRead === denominator) return '100'
      const percent = (tokens.cacheRead / denominator) * 100
      if (percent > 99.9 && percent < 100) return percent.toFixed(2)
      return String(Math.round(percent))
    }

    function normalizeModelCatalog(value) {
      const list = Array.isArray(value) ? value : Array.isArray(value?.models) ? value.models : []
      return list
        .filter((model) => model !== null && typeof model === 'object')
        .map((model) => ({
          id: typeof model.id === 'string' && model.id !== '' ? model.id : String(model.model ?? ''),
          provider: typeof model.provider === 'string' ? model.provider : '',
          name: typeof model.name === 'string' && model.name !== '' ? model.name : String(model.id ?? model.model ?? ''),
          contextWindow: countNumber(model.contextWindow),
          reasoning: model.reasoning === true,
        }))
        .filter((model) => model.id !== '')
    }

    function modelIdOf(model) {
      if (model === null || typeof model !== 'object') return ''
      return `${model.provider ?? ''}/${model.id ?? model.model ?? ''}`
    }

    function modelNameOf(model, fallback) {
      if (model === null || typeof model !== 'object') return fallback
      return model.name || model.id || model.model || fallback
    }

    /** One pointer-captured transcript width handle, matching dsh Web. */
    function BridgeWidthHandle({ side, onStart, onDrag, onCommit, onEnd }) {
      const dragging = useRef(false)
      const base = useRef(0)
      const origin = useRef(0)
      const latest = useRef(0)
      const frame = useRef(null)
      const callbacks = useRef({ side, onStart, onDrag, onCommit, onEnd })
      callbacks.current = { side, onStart, onDrag, onCommit, onEnd }

      const outwardWidth = () => {
        const dx = latest.current - origin.current
        const outward = callbacks.current.side === 'right' ? dx : -dx
        return base.current + outward * 2
      }
      const cancelFrame = () => {
        if (frame.current !== null) {
          cancelAnimationFrame(frame.current)
          frame.current = null
        }
      }
      const onPointerDown = useCallback((event) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        origin.current = event.clientX
        latest.current = event.clientX
        base.current = callbacks.current.onStart()
        dragging.current = true
        event.currentTarget.toggleAttribute('data-dragging', true)
      }, [])
      const onPointerMove = useCallback((event) => {
        if (!dragging.current) return
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
        const box = event.currentTarget.getBoundingClientRect()
        event.currentTarget.style.setProperty('--dsh-width-handle-pointer-y', `${event.clientY - box.top}px`)
        latest.current = event.clientX
        frame.current ??= requestAnimationFrame(() => {
          frame.current = null
          callbacks.current.onDrag(outwardWidth())
        })
      }, [])
      const onPointerUp = useCallback((event) => {
        if (!dragging.current) return
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
        dragging.current = false
        event.currentTarget.toggleAttribute('data-dragging', false)
        event.currentTarget.releasePointerCapture(event.pointerId)
        cancelFrame()
        latest.current = event.clientX
        if (latest.current !== origin.current) callbacks.current.onCommit(outwardWidth())
        callbacks.current.onEnd()
      }, [])
      const onPointerCancel = useCallback(() => {
        if (!dragging.current) return
        dragging.current = false
        cancelFrame()
        callbacks.current.onEnd()
      }, [])
      const onWheel = useCallback((event) => {
        const body = event.currentTarget.parentElement
        if (body === null) return
        const scrollport = body.querySelector('.dshBridge_scroll')
        if (scrollport === null) return
        if (event.ctrlKey || event.deltaY === 0) return
        scrollport.scrollBy({ top: wheelDeltaY(event, scrollport) })
      }, [])
      return h('div', {
        className: 'wSkVaW_widthHandle',
        'data-side': side,
        'data-width-handle': side,
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerCancel,
        onLostPointerCapture: onPointerCancel,
        onWheel,
      })
    }

    /**
     * Install the same content-width axis dsh Web uses and render its two
     * pointer handles. The stored preference is shared with dsh conversations.
     */
    function useBridgeWidthControls(containerRef, enabled) {
      const publishWidths = useCallback(() => {
        const container = containerRef.current
        if (container === null) return
        const column = container.offsetWidth
        container.style.setProperty('--dsh-conversation-column-width', `${column}px`)
        const preference = readContentWidthPreference()
        if (preference === null) container.style.removeProperty('--dsh-chat-user-width')
        else container.style.setProperty('--dsh-chat-user-width', `${resolveContentWidth(column, preference)}px`)
      }, [containerRef])

      useEffect(() => {
        const container = containerRef.current
        if (!enabled || container === null) return undefined
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(publishWidths) : null
        observer?.observe(container)
        publishWidths()
        return () => observer?.disconnect()
      }, [containerRef, enabled, publishWidths])

      const onStart = useCallback(() => {
        const container = containerRef.current
        if (container === null) return 680
        return resolveContentWidth(container.offsetWidth, readContentWidthPreference())
      }, [containerRef])
      const onDrag = useCallback((width) => {
        const container = containerRef.current
        if (container === null) return
        container.style.setProperty(
          '--dsh-chat-user-width',
          `${resolveContentWidth(container.offsetWidth, width)}px`,
        )
      }, [containerRef])
      const onCommit = useCallback((width) => {
        const container = containerRef.current
        if (container === null) return
        writeContentWidthPreference(resolveContentWidth(container.offsetWidth, width))
      }, [containerRef])
      const onEnd = useCallback(() => publishWidths(), [publishWidths])

      return enabled
        ? ['left', 'right'].map((side) => h(BridgeWidthHandle, {
            key: side,
            side,
            onStart,
            onDrag,
            onCommit,
            onEnd,
          }))
        : null
    }

    /**
     * The composer's model seat. It follows dsh's ToggleButton shape: the
     * current model label plus a small chevron in a 28px transparent chip,
     * with the catalogs rendered by the shared Menu primitive.
     */
    function BridgeModelSelect({ models, current, loading, error, disabled, onSelect, t }) {
      const [open, setOpen] = useState(false)
      const selectedId = modelIdOf(current)
      const currentLabel = modelNameOf(current, t('chooseModel'))
      const items = models.length === 0
        ? [{ type: 'label', id: 'empty', text: loading ? t('modelLoading') : error ?? t('modelLoadFailed') }]
        : models.flatMap((model, index) => {
            const previous = models[index - 1]
            const provider = model.provider || 'provider'
            const group = previous === undefined || (previous.provider || 'provider') !== provider
              ? [{ type: 'label', id: `provider-${provider}`, text: provider }]
              : []
            return [...group, { id: modelIdOf(model), label: modelNameOf(model, model.id) }]
          })
      return h(Menu, {
        open,
        onClose: () => setOpen(false),
        items,
        selectedId,
        onSelect: (id) => {
          setOpen(false)
          const model = models.find((candidate) => modelIdOf(candidate) === id)
          if (model !== undefined) onSelect?.(model)
        },
        align: 'end',
        portal: true,
        listClassName: 'dshBridge_modelMenu',
        anchor: h(
          Tooltip,
          { label: error ?? t('chooseModel'), side: 'top', delayMs: 400 },
          h(
            'button',
            {
              type: 'button',
              className: 'dshBridge_modelTrigger',
              'aria-label': t('chooseModel'),
              'aria-haspopup': 'menu',
              'aria-expanded': open,
              disabled: disabled || loading,
              onClick: () => setOpen((value) => !value),
            },
            h('span', { className: 'dshBridge_modelLabel' }, loading ? t('modelLoading') : currentLabel),
            h(IconChevronDownOutlineRegular, { size: 12, className: 'dshBridge_modelChevron' }),
          ),
        ),
      })
    }

    /**
     * The dock below the composer. This is a projection-free mirror of dsh's
     * shipped statusline: a gauge pill for turn/step counts and a database
     * pill for token usage and cache hit. Bridge stats come from the attached
     * engine, not dsh's session projection.
     */
    function BridgeStatusline({ stats, t }) {
      const [open, setOpen] = useState(null)
      useEffect(() => {
        if (open === null) return undefined
        const close = (event) => {
          if (event?.target instanceof Element && event.target.closest('.dshBridge_statusPillWrap') !== null) return
          setOpen(null)
        }
        document.addEventListener('mousedown', close)
        return () => document.removeEventListener('mousedown', close)
      }, [open])
      if (!statsVisible(stats)) return null
      const cacheHit = bridgeCacheHitPercent(stats.tokens)
      const countRows = [
        { key: 'turns', label: t('statsTurns'), value: String(stats.turns) },
        { key: 'steps', label: t('statsSteps'), value: String(stats.steps) },
        { key: 'tools', label: t('statsToolCalls'), value: String(stats.toolCalls) },
        { key: 'messages', label: t('statsTotalMessages'), value: String(stats.totalMessages) },
      ]
      const usageRows = [
        ...(cacheHit === null ? [] : [{ key: 'cache', label: t('statsCacheHit').replace('{percent}', '').trim(), value: `${cacheHit}%` }]),
        { key: 'input', label: t('statsUncachedInput'), value: t('statsTokens', { count: exactTokens(stats.tokens.uncachedInput) }) },
        { key: 'cacheRead', label: t('statsCacheRead'), value: t('statsTokens', { count: exactTokens(stats.tokens.cacheRead) }) },
        ...(stats.tokens.cacheWrite === 0 ? [] : [{ key: 'cacheWrite', label: t('statsCacheWrite'), value: t('statsTokens', { count: exactTokens(stats.tokens.cacheWrite) }) }]),
        { key: 'output', label: t('statsOutput'), value: t('statsTokens', { count: exactTokens(stats.tokens.output) }) },
      ]
      const pill = (id, icon, label, ariaLabel, rows, title, titleValue) => h(
        'span',
        { className: 'dshBridge_statusPillWrap' },
        h(
          'button',
          {
            type: 'button',
            className: 'dshBridge_statusPill',
            'aria-haspopup': 'dialog',
            'aria-expanded': open === id,
            'aria-label': ariaLabel,
            onClick: () => setOpen((value) => (value === id ? null : id)),
          },
          icon,
          h('span', { className: 'dshBridge_statusLabel' }, label),
        ),
        open === id
          ? h(
              'div',
              { className: 'dshBridge_statusPanel', role: 'dialog', 'aria-label': title },
              h(
                'div',
                { className: 'dshBridge_statusTitle' },
                h('span', { className: 'dshBridge_statusTitleLabel' }, icon, title),
                titleValue === null ? null : h('span', { className: 'dshBridge_statusTitleValue' }, titleValue),
              ),
              h('div', { className: 'dshBridge_statusRule', 'aria-hidden': 'true' }),
              h(
                'dl',
                { className: 'dshBridge_statusDetails' },
                ...rows.flatMap((row) => [
                  h('dt', { key: `${row.key}-label` }, row.label),
                  h('dd', { key: `${row.key}-value` }, row.value),
                ]),
              ),
            )
          : null,
      )
      const counts = t('statsCounts', { turns: stats.turns, steps: stepsLabel(stats) })
      const totalText = t('statsTokens', { count: compactTokens(stats.tokens.total) })
      const cacheText = cacheHit === null ? null : t('statsCacheHit', { percent: cacheHit })
      const context = stats.context ?? null
      const contextPercent = context === null ? 0 : Math.max(0, Math.min(100, Math.round(context.percent)))
      const contextRadius = 5.5
      const contextCircumference = 2 * Math.PI * contextRadius
      return h(
        'div',
        { className: 'dshBridge_statusline', 'data-composer-stats': 'true' },
        stats.steps > 0
          ? pill(
              'counts',
              h(IconGaugeOutlineRegular, { size: 14 }),
              counts,
              counts,
              countRows,
              t('statsDialogTitle'),
              null,
            )
          : null,
        stats.tokens.total > 0
          ? pill(
              'usage',
              h(IconDatabaseOutlineRegular, { size: 14 }),
              cacheText === null ? totalText : `${totalText} · ${cacheText}`,
              cacheText === null ? totalText : `${totalText} · ${cacheText}`,
              usageRows,
              t('statsUsageTitle'),
              t('statsTokens', { count: exactTokens(stats.tokens.total) }),
            )
          : null,
        context === null
          ? null
          : h(
              'span',
              { className: 'dshBridge_statusPillWrap' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshBridge_context',
                  'aria-haspopup': 'dialog',
                  'aria-expanded': open === 'context',
                  'aria-label': t('statsContextUsed', { percent: contextPercent }),
                  onClick: () => setOpen((value) => (value === 'context' ? null : 'context')),
                },
                h(
                  'svg',
                  { viewBox: '0 0 14 14', width: 14, height: 14, className: 'dshBridge_contextRing', 'aria-hidden': 'true' },
                  h('circle', { cx: 7, cy: 7, r: contextRadius, className: 'dshBridge_contextTrack' }),
                  h('circle', {
                    cx: 7,
                    cy: 7,
                    r: contextRadius,
                    className: 'dshBridge_contextFill',
                    strokeDasharray: `${contextCircumference * contextPercent / 100} ${contextCircumference}`,
                  }),
                ),
                h('span', { className: 'dshBridge_statusLabel' }, `${contextPercent}%`),
              ),
              open === 'context'
                ? h(
                    'div',
                    { className: 'dshBridge_statusPanel', role: 'dialog', 'aria-label': t('statsContextPanel') },
                    h(
                      'div',
                      { className: 'dshBridge_statusTitle' },
                      h('span', { className: 'dshBridge_statusTitleLabel' }, t('statsContextPanel')),
                      h('span', { className: 'dshBridge_statusTitleValue' }, t('statsContextUsed', { percent: contextPercent })),
                    ),
                    h('div', { className: 'dshBridge_statusRule', 'aria-hidden': 'true' }),
                    h(
                      'dl',
                      { className: 'dshBridge_statusDetails' },
                      h('dt', null, t('statsContextWindow')),
                      h('dd', null, t('statsContextTokens', {
                        used: compactTokens(context.used),
                        window: compactTokens(context.window),
                      })),
                    ),
                  )
                : null,
            ),
      )
    }

    /** Pi has no turn counter separate from assistant messages; keep the two readings aligned. */
    function stepsLabel(stats) {
      return Math.max(0, stats.steps)
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

    /**
     * The composer card shared by the transcript view and the New Session
     * hero, so both carry dsh's input geometry, model seat, and send control.
     */
    function BridgeComposer({
      t, draft, onDraft, onSend, onAbort, sending, attaching, isStreaming,
      models, currentModel, modelsLoading, modelsError, modelSwitching, onSelectModel,
      stats, textareaRef, canSend = true, placeholder,
    }) {
      const disabled = sending || attaching || draft.trim() === '' || !canSend
      const resize = (node) => {
        node.style.height = 'auto'
        node.style.height = `${Math.min(node.scrollHeight, 336)}px`
      }
      return h(
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
            placeholder: placeholder ?? t('placeholder'),
            'aria-label': placeholder ?? t('placeholder'),
            onChange: (event) => {
              onDraft(event.target.value)
              resize(event.target)
            },
            onKeyDown: (event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                if (!disabled) onSend()
              }
            },
          }),
          h(
            'div',
            { className: 'dshBridge_toolbar' },
            h(
              'div',
              { className: 'dshBridge_trailing' },
              h(
                'div',
                { className: 'dshBridge_modelSeat' },
                h(BridgeModelSelect, {
                  models,
                  current: currentModel,
                  loading: modelsLoading,
                  error: modelsError,
                  disabled: modelSwitching,
                  onSelect: onSelectModel,
                  t,
                }),
              ),
              isStreaming
                ? h(
                    Tooltip,
                    { label: t('stop') },
                    h(
                      'button',
                      { type: 'button', className: 'dshBridge_send', 'data-stop': 'true', 'aria-label': t('stop'), onClick: onAbort },
                      h(StopGlyph),
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
                        disabled,
                        onClick: onSend,
                      },
                      h(SendGlyph),
                    ),
                  ),
            ),
          ),
        ),
        h(BridgeStatusline, { stats, t }),
      )
    }

    /**
     * The New Session hero: dsh's headline, then the composer with a workspace
     * chip above its top-left corner. Picking a workspace is what turns the
     * hero into a real session, so the chip sits with the input rather than in
     * the panel header.
     */
    function BridgeWorkspaceChip({ workspaces, path, onPick, onAddWorkspace, t }) {
      const [open, setOpen] = useState(false)
      const current = workspaces.find((workspace) => workspace.path === path) ?? null
      const items = [
        ...workspaces.map((workspace) => ({
          id: workspace.path,
          label: workspace.name ?? workspace.path,
          icon: h(IconFolderOpenRegular, { size: 14 }),
        })),
        ...(workspaces.length === 0 ? [] : [{ type: 'separator', id: 'add-separator' }]),
        { id: '__add__', label: t('heroAddWorkspace'), icon: h(IconFolderCloseRegular, { size: 14 }) },
      ]
      return h(Menu, {
        open,
        onClose: () => setOpen(false),
        items,
        selectedIds: current === null ? [] : [current.path],
        onSelect: (id) => {
          setOpen(false)
          if (id === '__add__') onAddWorkspace()
          else onPick(id)
        },
        align: 'start',
        dense: true,
        portal: true,
        anchor: h(
          'button',
          {
            type: 'button',
            className: 'dshBridge_heroWorkspace',
            'aria-label': t('heroChooseWorkspace'),
            'aria-haspopup': 'menu',
            'aria-expanded': open,
            onClick: () => setOpen((value) => !value),
          },
          current === null
            ? h(IconFolderCloseRegular, { size: 16, className: 'dshBridge_heroWorkspaceIcon' })
            : h(IconFolderOpenRegular, { size: 16, className: 'dshBridge_heroWorkspaceIcon' }),
          h('span', { className: 'dshBridge_heroWorkspaceLabel' }, current === null ? t('heroChooseWorkspace') : (current.name ?? current.path)),
          h(IconChevronDownOutlineRegular, { size: 12, className: 'dshBridge_heroWorkspaceChevron' }),
        ),
      })
    }

    /**
     * The running-turn indicator dsh paints after the last row: a whale tail and
     * the `深度求索中，用时 …` label in the deep-diving ink. The clock is isolated
     * from the transcript, so a tick re-renders this line alone; an absent
     * `startTime` is the connecting phase, which shows the bare label because
     * the agent has not started its turn yet.
     */
    function BridgeRunningStatus({ startTime, t }) {
      const [now, setNow] = useState(Date.now)
      useEffect(() => {
        if (startTime === undefined || startTime === null) return undefined
        setNow(Date.now())
        const timer = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(timer)
      }, [startTime])
      const label = startTime === undefined || startTime === null
        ? t('deepDiving')
        // dsh's own floor: a turn never reads as taking under one second.
        : t('deepDivingFor', { duration: formatRunDuration(Math.max(1000, now - startTime), t) })
      return h(
        'div',
        { className: 'dshBridge_running', 'data-chat-running': 'true' },
        h('span', { className: 'dshBridge_visuallyHidden', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' }, t('deepDiving')),
        h(
          'span',
          { className: 'dshBridge_runningContent' },
          h(WhaleTailGlyph),
          h(TextShimmer, { active: true, className: 'dshBridge_runningText' }, label),
        ),
      )
    }

    /**
     * The resting whale tail from dsh's running indicator, as a static stroked
     * glyph: the shell animates an APNG mask, the Bridge keeps the same outline
     * and lets the shimmering label carry the motion.
     */
    function WhaleTailGlyph() {
      return h('span', { className: 'dshBridge_runningIcon', 'aria-hidden': 'true' },
        h('svg', { width: '100%', height: '100%', viewBox: '0 0 16 16', fill: 'none' },
          h('path', {
            d: 'M8.844 13.742C8.967 12.328 8.45 10.4 8.45 9.65C8.45 8.94 8.88 8.43 9.6 8.43C11.285 8.43 12.106 8.281 12.685 8.104C13.71 7.791 14.585 6.768 15.055 5.945C15.137 5.803 14.99 5.641 14.829 5.671C13.829 5.86 12.828 5.376 11.827 4.978C10.659 4.514 9.491 4.707 8.935 4.876C8.805 4.915 8.658 4.819 8.636 4.686C8.468 3.643 7.405 2.615 5.498 2.238C4.54 2.048 3.748 1.574 3.347 1.202C3.252 1.113 3.088 1.125 3.03 1.242C2.628 2.059 2.168 3.82 5.248 6.115C5.82 6.494 6.31 6.785 6.574 7.637C6.72 8.104 6.157 9.168 6.061 9.368C5.157 11.27 5.089 12.19 4.926 13.742',
            stroke: 'currentColor',
            strokeWidth: 1,
          }),
        ),
      )
    }

    /**
     * Turn duration in dsh's wording: whole seconds, with minutes joining at
     * 60 and hours at 60 minutes, each number followed by its localized unit.
     */
    function formatRunDuration(ms, t) {
      const total = Math.max(0, Math.floor(ms / 1000))
      const hours = Math.floor(total / 3600)
      const minutes = Math.floor(total / 60) % 60
      const seconds = total % 60
      const parts = []
      if (hours > 0) parts.push(`${hours}${t('durationHour')}`)
      if (total >= 60) parts.push(`${minutes}${t('durationMinute')}`)
      parts.push(`${seconds}${t('durationSecond')}`)
      return parts.join('')
    }

    /**
     * Drop the echo the Host just made durable. Matching on text is the honest
     * signal; an agent that rewrites the user turn leaves no match, and the
     * oldest echo is retired so nothing can stick on screen forever.
     */
    function dropEchoFor(echoes, text) {
      if (!Array.isArray(echoes) || echoes.length === 0) return echoes ?? []
      const index = echoes.findIndex((entry) => entry.text === text)
      const drop = index === -1 ? 0 : index
      return echoes.filter((_, position) => position !== drop)
    }

    /**
     * Composer action glyphs, copied from dsh's own input bar so the Bridge
     * send control is literally the same button: a filled up arrow at rest and
     * a rounded square while the agent runs (the shell never shows a pause
     * bar). Both are 16px glyphs on the 34px info-blue circle.
     */
    function SendGlyph() {
      return h('svg', { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': true },
        h('path', {
          d: 'M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z',
          fill: 'currentColor',
        }),
      )
    }

    function StopGlyph() {
      return h('svg', { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': true },
        h('rect', { x: 3, y: 3, width: 10, height: 10, rx: 3, fill: 'currentColor' }),
      )
    }

    /**
     * Intermediate-process rows copy dsh Web's chat rows instead of inventing a
     * second vocabulary: one 24px line per reasoning block or tool call shaped
     * as `[16px variant icon] title · one-line summary`, where the summary is
     * derived from the call arguments the same way the shipped tool renderer
     * derives it (file tools show a workspace-relative path, shell tools show
     * the command, search tools show the query).
     */
    const TOOL_VARIANT_BY_NAME = {
      bash: 'bash',
      pwsh: 'bash',
      read: 'read',
      read_image: 'read',
      ls: 'read',
      web_fetch: 'read',
      grep: 'search',
      glob: 'search',
      web_search: 'search',
      write: 'write',
      edit: 'edit',
      run_code: 'code',
    }

    /** Locale key per row variant, matching dsh's `tool.title.*` wording. */
    const TOOL_VARIANT_TITLE_KEYS = {
      bash: 'toolTitleBash',
      read: 'toolTitleRead',
      search: 'toolTitleSearch',
      write: 'toolTitleWrite',
      edit: 'toolTitleEdit',
      code: 'toolTitleCode',
      others: 'toolTitleGeneric',
    }

    /** Summary key preference per variant (args-derived, as dsh's tool model). */
    const TOOL_SUMMARY_KEYS = {
      bash: ['description', 'command'],
      read: ['path', 'file_path', 'url'],
      search: ['query', 'pattern', 'url'],
      write: ['path', 'file_path'],
      edit: ['path', 'file_path'],
      code: ['description'],
      others: [],
    }

    const TOOL_FILE_PATH_KEYS = ['path', 'file_path']
    const TOOL_FILE_PATH_VARIANTS = new Set(['read', 'write', 'edit'])
    const TOOL_DIFF_VARIANTS = new Set(['write', 'edit'])

    function bridgeToolVariant(name) {
      return TOOL_VARIANT_BY_NAME[name] ?? 'others'
    }

    function bridgeToolTitleKey(name) {
      return TOOL_VARIANT_TITLE_KEYS[bridgeToolVariant(name)]
    }

    function bridgeToolState(status) {
      if (status === 'running') return 'running'
      if (status === 'error') return 'error'
      return 'ok'
    }

    function bridgeToolIcon(variant) {
      if (variant === 'read') return h(IconBrowseOutlineRegular, { size: 14 })
      if (variant === 'search') return h(IconSearchOutlineRegular, { size: 14 })
      if (variant === 'bash') return h(IconApiOutlineRegular, { size: 14 })
      if (variant === 'write' || variant === 'edit') return h(IconEditOutlineRegular, { size: 14 })
      if (variant === 'code') return h(IconCodeOutlineRegular, { size: 14 })
      return h(IconSparkleRegular, { size: 14 })
    }

    function firstLineText(text) {
      if (typeof text !== 'string') return ''
      const newline = text.indexOf('\n')
      return newline === -1 ? text : text.slice(0, newline)
    }

    /**
     * While a reasoning block is still streaming, only completed paragraphs are
     * eligible for the preview; the sentence being written would flicker.
     */
    function latestParagraphFirstLine(text) {
      if (typeof text !== 'string') return ''
      let summary = ''
      let paragraphStart = 0
      const separator = /\r?\n(?:[\t ]*\r?\n)+/g
      for (;;) {
        const next = separator.exec(text)
        const paragraphEnd = next === null ? text.length : next.index + next[0].indexOf('\n')
        const newline = text.indexOf('\n', paragraphStart)
        if (newline !== -1 && newline <= paragraphEnd) {
          const candidate = text.slice(paragraphStart, newline).trim()
          if (candidate !== '') summary = candidate
        }
        if (next === null) return summary
        paragraphStart = next.index + next[0].length
      }
    }

    function parseToolArguments(value) {
      if (value === null || value === undefined) return null
      if (typeof value === 'object') return Array.isArray(value) ? null : value
      if (typeof value !== 'string' || value === '') return null
      try {
        const parsed = JSON.parse(value)
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
      } catch {
        return null
      }
    }

    /** Session-relative paths read the way the shipped chat surface shows them. */
    function displayToolPath(value, cwd) {
      if (typeof value !== 'string' || value === '') return ''
      if (typeof cwd !== 'string' || cwd === '') return value
      const base = cwd.endsWith('/') ? cwd : `${cwd}/`
      return value.startsWith(base) ? value.slice(base.length) : value
    }

    /** A path under the host account home reads as `~/…`, matching dsh. */
    function abbreviateHomePath(value, home) {
      if (typeof value !== 'string' || value === '' || typeof home !== 'string' || home === '') return value
      const base = home.endsWith('/') ? home.slice(0, -1) : home
      if (base === '' || base === '/') return value
      if (value === base) return '~'
      return value.startsWith(`${base}/`) ? `~${value.slice(base.length)}` : value
    }

    function deriveToolSummary(name, args, cwd, home) {
      if (args === null) return ''
      const variant = bridgeToolVariant(name)
      if (variant === 'search' && Array.isArray(args.queries)) {
        const queries = args.queries.filter((query) => typeof query === 'string' && query !== '')
        if (queries.length > 0) return queries.map(firstLineText).join(', ')
      }
      for (const key of TOOL_SUMMARY_KEYS[variant]) {
        const value = args[key]
        if (typeof value !== 'string' || value === '') continue
        const line = firstLineText(value)
        return TOOL_FILE_PATH_KEYS.includes(key) ? abbreviateHomePath(displayToolPath(line, cwd), home) : line
      }
      for (const value of Object.values(args)) {
        if (typeof value === 'string' && value !== '') return firstLineText(value)
      }
      return ''
    }

    /**
     * Text lines of one edit side, following dsh's rule: an absent side draws
     * nothing and a single trailing newline terminates the last line rather
     * than adding an empty one.
     */
    function diffSideLines(value) {
      if (typeof value !== 'string' || value === '') return []
      const text = value.endsWith('\n') ? value.slice(0, -1) : value
      return text.split('\n')
    }

    /** `path` + both sides of every edit, in dsh's DiffBlock input shape. */
    function toolDiffEdits(name, args) {
      if (args === null) return []
      const variant = bridgeToolVariant(name)
      if (!TOOL_DIFF_VARIANTS.has(variant)) return []
      const rawEdits = Array.isArray(args.edits) ? args.edits : null
      const edits = rawEdits === null
        ? [{ oldText: args.old_string ?? args.oldText ?? null, newText: args.new_string ?? args.newText ?? (variant === 'write' ? args.content : null) }]
        : rawEdits.filter((edit) => edit !== null && typeof edit === 'object')
          .map((edit) => ({ oldText: edit.oldText ?? edit.old_string ?? null, newText: edit.newText ?? edit.new_string ?? null }))
      return edits.filter((edit) => (edit.oldText ?? '') !== '' || (edit.newText ?? '') !== '')
    }

    function toolDiffEntries(name, args, cwd) {
      if (args === null) return null
      const path = displayToolPath(args.file_path ?? args.path ?? '', cwd)
      if (path === '') return null
      const edits = toolDiffEdits(name, args)
      return edits.length === 0 ? null : { path, edits }
    }

    /**
     * Chrome copy for the primitives' TerminalBlock and DiffBlock. Those
     * components take every label as data, so the same tables dsh ships are
     * restated here against the Bridge locale namespace.
     */
    function toolBlockLabels(t) {
      return {
        commandLine: (n) => t('terminalCommandLine', { n }),
        signal: (signal) => t('terminalSignal', { signal }),
        exitCode: (code) => t('terminalExitCode', { code }),
        noExitCode: t('terminalNoExitCode'),
        running: t('toolRunning'),
        failed: t('toolFailed'),
        done: t('turnCompleted'),
        copy: t('copy'),
        copied: t('copied'),
        noOutput: t('toolNoOutput'),
        collapseAria: t('collapseOutput'),
        collapse: t('collapse'),
        expandAria: (hidden) => t('terminalExpandAria', { n: hidden }),
        expand: (hidden) => t('terminalExpandRest', { n: hidden }),
        codeLabel: t('codeBlockTitle'),
        wrapLabel: t('codeBlockWrap'),
        unwrapLabel: t('codeBlockUnwrap'),
      }
    }

    /**
     * Count the added and removed lines of one edit. The counts come from the
     * same minimal line-edit script DiffBlock draws, so a `+N -N` summary and
     * its expanded card can never disagree. Very large sides fall back to the
     * coarse both-sides count rather than paying for the quadratic table.
     */
    function countDiffLines(oldText, newText) {
      const before = diffSideLines(oldText)
      const after = diffSideLines(newText)
      if (before.length === 0) return { added: after.length, removed: 0 }
      if (after.length === 0) return { added: 0, removed: before.length }
      if (before.length * after.length > 250000) return { added: after.length, removed: before.length }
      let previous = new Array(after.length + 1).fill(0)
      for (let i = 1; i <= before.length; i += 1) {
        const current = new Array(after.length + 1).fill(0)
        for (let j = 1; j <= after.length; j += 1) {
          current[j] = before[i - 1] === after[j - 1]
            ? previous[j - 1] + 1
            : Math.max(previous[j], current[j - 1])
        }
        previous = current
      }
      const kept = previous[after.length]
      return { added: after.length - kept, removed: before.length - kept }
    }

    /** `+added −removed` for the file tools that rewrite content, as dsh shows it. */
    function toolDiffTotals(name, args) {
      if (args === null) return null
      const edits = toolDiffEdits(name, args)
      if (edits.length === 0) return null
      let added = 0
      let removed = 0
      for (const edit of edits) {
        const counts = countDiffLines(edit.oldText, edit.newText)
        added += counts.added
        removed += counts.removed
      }
      return added === 0 && removed === 0 ? null : { added, removed }
    }

    /** Expanded tool body: bash gets a terminal card, file edits a diff card. */
    function toolExpandedBody(name, variant, args, output, state, cwd, t, labels) {
      if (variant === 'bash' && args !== null && typeof args.command === 'string') {
        return h(TerminalBlock, {
          command: args.command,
          cwd: typeof cwd === 'string' ? cwd : undefined,
          output: output ?? '',
          running: state === 'running',
          maxLines: Infinity,
          labels,
        })
      }
      const diff = toolDiffEntries(name, args, cwd)
      if (diff !== null) {
        const diffs = diff.edits.map((edit) => ({
          path: diff.path,
          oldText: (edit.oldText ?? '') === '' ? null : diffSideLines(edit.oldText).join('\n'),
          newText: diffSideLines(edit.newText).join('\n'),
        }))
        return h(DiffBlock, { diffs, maxLines: 9, labels })
      }
      // dsh shows a single-file tool's path as the only args interaction, so the
      // expanded body carries the result alone rather than restating JSON args.
      const singleFile = TOOL_FILE_PATH_VARIANTS.has(variant)
      const rawArgs = singleFile || args === null ? '' : safeJson(args)
      if (rawArgs === '' && output === null) return null
      return h(
        'div',
        { className: 'dshBridge_ioCard' },
        rawArgs === '' ? null : h('div', { className: 'dshBridge_ioSection' },
          h('span', { className: 'dshBridge_ioLabel' }, t('toolArguments')),
          h('span', { className: 'dshBridge_ioText' }, rawArgs)),
        rawArgs !== '' && output !== null ? h('span', { className: 'dshBridge_ioDivider', 'aria-hidden': true }) : null,
        output === null ? null : h('div', { className: 'dshBridge_ioSection' },
          h('span', { className: 'dshBridge_ioLabel' }, t('toolResult')),
          h('span', { className: 'dshBridge_ioText', 'data-error': state === 'error' ? 'true' : undefined }, output)),
      )
    }

    /** One tool call: dsh's 24px summary row plus its expanded result card. */
    function ToolRow({ item, cwd, home, t }) {
      const [open, setOpen] = useState(false)
      const variant = bridgeToolVariant(item.name)
      const state = bridgeToolState(item.status)
      const args = parseToolArguments(item.arguments)
      const output = typeof item.output === 'string' && item.output !== '' ? item.output : null
      const summary = deriveToolSummary(item.name, args, cwd, home)
      const errorSummary = state === 'error' && output !== null ? firstLineText(output) : ''
      // An unclassified tool has no verb of its own, so the raw name leads the
      // summary line: `Tool call · TaskGet · 1`, the same order dsh renders.
      const named = variant === 'others' && typeof item.name === 'string' && item.name !== ''
        ? [item.name, summary].filter(Boolean).join(' · ')
        : summary
      const summaryText = errorSummary !== '' ? errorSummary : named
      const totals = toolDiffTotals(item.name, args)
      const expandable = output !== null || args !== null || typeof item.arguments === 'string'
      const collapsed = []
      if (summaryText !== '') {
        collapsed.push(h('span', { key: 'sep', className: 'dshBridge_processSep', 'data-shimmer-decoration': true, 'aria-hidden': true }))
        const summaryClass = [
          'dshBridge_processSummary',
          state === 'error' ? 'dshBridge_processError' : '',
          TOOL_FILE_PATH_VARIANTS.has(variant) ? 'dshBridge_processFileLink' : '',
        ].filter(Boolean).join(' ')
        collapsed.push(h('span', {
          key: 'summary',
          className: summaryClass,
          'data-streaming': state === 'running' ? 'true' : undefined,
        }, summaryText))
      }
      if (totals !== null) {
        collapsed.push(h('span', {
          key: 'diff',
          className: 'dshBridge_processDiff',
        },
          h('span', { className: 'dshBridge_diffAdded' }, `+${totals.added}`),
          ' ',
          h('span', { className: 'dshBridge_diffRemoved' }, `-${totals.removed}`)))
      }
      const labels = toolBlockLabels(t)
      const body = open ? toolExpandedBody(item.name, variant, args, output, state, cwd, t, labels) : null
      return h(
        'div',
        {
          className: 'dshBridge_processRow',
          'data-variant': variant,
          'data-tool': item.name ?? 'tool',
          'data-state': state,
          'data-expanded': open ? 'true' : undefined,
        },
        h(DisclosureRow, {
          icon: bridgeToolIcon(variant),
          title: t(bridgeToolTitleKey(item.name)),
          open,
          expandable,
          onToggle: () => setOpen(!open),
          expandOnRowClick: true,
          running: state === 'running',
          collapsedContent: collapsed.length === 0 ? null : h(React.Fragment, null, ...collapsed),
        }, body === null
          ? null
          : h('div', { className: 'dshBridge_processBody' }, body)),
      )
    }

    /** One assistant reasoning block: dsh's thinking row with a rolling preview. */
    function ThinkingRow({ text, running, t }) {
      const [open, setOpen] = useState(false)
      const preview = (running ? latestParagraphFirstLine(text) : firstLineText(text)).replaceAll('**', '')
      const collapsed = preview === ''
        ? null
        : h(React.Fragment, null,
            h('span', { className: 'dshBridge_processSep', 'data-shimmer-decoration': true, 'aria-hidden': true }),
            h('span', { className: 'dshBridge_processSummary', 'data-streaming': running ? 'true' : undefined }, preview))
      return h(
        'div',
        {
          className: 'dshBridge_processRow dshBridge_thinkRow',
          'data-variant': 'think',
          'data-state': running ? 'running' : 'ok',
          'data-expanded': open ? 'true' : undefined,
          'data-preview': preview === '' ? undefined : 'true',
        },
        h(DisclosureRow, {
          icon: h(IconThinkOutlineRegular, { size: 14 }),
          title: t('thinking'),
          open,
          expandable: true,
          onToggle: () => setOpen(!open),
          expandOnRowClick: true,
          running,
          collapsedContent: collapsed,
        }, open
          ? h('div', { className: 'dshBridge_processBody' }, h(Markdown, { text, streaming: running, t, variant: 'compact' }))
          : null),
      )
    }

    /**
     * Split one assistant message into the two things dsh renders separately:
     * reasoning rows that belong to the intermediate process, and text/image
     * blocks that form the answer. Tool calls are already separate items.
     */
    function assistantParts(message) {
      const content = message?.content
      if (typeof content === 'string') {
        return { reasoning: [], answer: content.trim() === '' ? null : { ...message, content } }
      }
      if (!Array.isArray(content)) return { reasoning: [], answer: null }
      const reasoning = []
      const answer = []
      for (const block of content) {
        if (block === null || typeof block !== 'object') continue
        if (block.type === 'thinking') reasoning.push(block)
        // A blank text block is protocol punctuation, not an answer.
        else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() === '') continue
        else if (block.type === 'text' || block.type === 'image') answer.push(block)
      }
      return {
        reasoning,
        answer: answer.length === 0 ? null : { ...message, content: answer },
      }
    }

    /** Reasoning rows for one message, shaped like dsh's thinking disclosures. */
    function reasoningRows(message, running, t, keyPrefix) {
      return (message === null ? [] : assistantParts(message).reasoning).map((block, index) =>
        h(ThinkingRow, { key: `${keyPrefix}-think-${index}`, text: block.thinking ?? '', running, t }))
    }

    /** Render one answer body: Markdown text and inline images only. */
    function AssistantContent({ blocks, streaming, t }) {
      const nodes = []
      blocks.forEach((block, index) => {
        if (block === null || typeof block !== 'object') return
        if (block.type === 'text') {
          nodes.push(h('div', { key: `t${index}`, className: 'dshBridge_assistantBody' }, h(Markdown, { text: block.text ?? '', streaming, t })))
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

    /** A user message reads as one right-aligned bubble, as in dsh Web. */
    function UserTurn({ message, t }) {
      const text = textOf(message.content)
      const images = Array.isArray(message.content) ? message.content.filter((block) => block && block.type === 'image') : []
      const stack = []
      if (text !== '') stack.push(h('div', { key: 'text', className: 'dshBridge_bubble' }, text))
      images.forEach((block, index) => {
        const source = block.source ?? {}
        const src = typeof source.data === 'string' ? `data:${source.mediaType ?? 'image/png'};base64,${source.data}` : block.data
        if (typeof src === 'string') stack.push(h('img', { key: `img${index}`, src, alt: '', style: { maxWidth: '100%', borderRadius: 12 } }))
      })
      if (stack.length === 0) return null
      return h(
        'div',
        {
          className: 'dshBridge_userRow',
          'data-role': 'user',
          'aria-label': t('userRole'),
          title: message.timestamp ? formatTime(message.timestamp) : undefined,
        },
        h('div', { className: 'dshBridge_userStack' }, ...stack),
      )
    }

    /** The assistant answer: built-in body, stop badge, and dsh's copy action below it. */
    function AssistantTurn({ message, streaming, t }) {
      if (!streaming && message === null) return null
      const blocks = Array.isArray(message?.content) ? message.content : []
      const body = message === null ? null : h(AssistantContent, { blocks, streaming, t })
      const text = textOf(message?.content)
      return h(
        'div',
        { className: 'dshBridge_answer', 'data-role': 'assistant' },
        body === null && streaming
          ? h('div', { className: 'dshBridge_assistantBody dshBridge_streaming' }, h(TextShimmer, { active: true }, '…'))
          : body,
        !streaming && message?.stopReason === 'aborted'
          ? h('div', { className: 'dshBridge_stopped' }, t('stopped'))
          : null,
        !streaming && text !== ''
          ? h('div', { className: 'dshBridge_answerActions' }, h(CopyButton, { text, t }))
          : null,
      )
    }

    /**
     * Build the transcript flow: consecutive reasoning rows, tool rows, and
     * process-only assistant messages collapse into one process block, so the
     * session reads as user bubble → steps → answer, which is how dsh groups a
     * turn. `streamingMessage` contributes its reasoning rows and, once text
     * exists, its answer tail.
     */
    function renderTranscriptFlow(items, cwd, t, streamingMessage, home) {
      const nodes = []
      let process = null
      const flush = () => {
        if (process !== null && process.children.length > 0) {
          nodes.push(h('div', { key: `process-${process.key}`, className: 'dshBridge_processGroup' }, ...process.children))
        }
        process = null
      }
      const pushProcess = (key, children) => {
        if (children.length === 0) return
        if (process === null) process = { key, children: [] }
        process.children.push(...children)
      }
      for (const item of items) {
        if (item.kind === 'tool') {
          pushProcess(item.id, [h(ToolRow, { key: item.id, item, cwd, home, t })])
          continue
        }
        const message = item.message
        if (message?.role === 'user') {
          flush()
          nodes.push(h(UserTurn, { key: item.id, message, t }))
          continue
        }
        if (message?.role !== 'assistant') continue
        const parts = assistantParts(message)
        pushProcess(item.id, reasoningRows(message, false, t, item.id))
        if (parts.answer !== null) {
          flush()
          nodes.push(h(AssistantTurn, { key: item.id, message: parts.answer, t }))
        }
      }
      if (streamingMessage !== null && streamingMessage !== undefined) {
        pushProcess('streaming', reasoningRows(streamingMessage, true, t, 'streaming'))
        const parts = assistantParts(streamingMessage)
        flush()
        nodes.push(h(AssistantTurn, { key: 'streaming', message: parts.answer, streaming: true, t }))
      }
      flush()
      return nodes
    }

    function ConfigField({ field, value, configured, disabled, onChange, t }) {
      const label = t(field.labelKey ?? field.key)
      const hint = field.hintKey ? t(field.hintKey) : ''
      const shownHint = field.type === 'secret' && configured ? `${t('secretConfigured')} ${hint}` : hint
      if (field.type === 'boolean') {
        return h(
          'div',
          { className: 'dshBridge_settingsSwitchRow' },
          h(
            'div',
            { className: 'dshBridge_settingsSwitchText' },
            h('span', { className: 'dshBridge_settingsFieldLabel' }, label),
            hint === '' ? null : h('span', { className: 'dshBridge_settingsHint' }, hint),
          ),
          h(Switch, {
            checked: value !== false,
            label,
            disabled,
            onChange: (next) => onChange(next),
          }),
        )
      }
      return h(
        'div',
        { className: 'dshBridge_settingsField' },
        h('span', { className: 'dshBridge_settingsFieldLabel' }, label),
        h('input', {
          className: 'dshBridge_settingsInput',
          type: field.type === 'secret' ? 'password' : 'text',
          value: value ?? '',
          placeholder: field.placeholder ?? '',
          disabled,
          onChange: (event) => onChange(event.target.value),
        }),
        shownHint === '' ? null : h('span', { className: 'dshBridge_settingsHint' }, shownHint),
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
     * Bridge's own settings page. This is deliberately not a dsh Settings
     * section: it is a standalone overlay with its own open/close lifecycle,
     * while its shell geometry, nav rail, typography, row cards, and controls
     * mirror the native dsh Settings / Models surfaces exactly.
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
      const closeButton = useRef(null)

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

      // Match the native settings layer: Escape closes, focus starts on the
      // close control, and neither listener exists while the page is hidden.
      useEffect(() => {
        if (!open) return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('keydown', onKeyDown)
        closeButton.current?.focus?.()
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [open])

      useEffect(() => {
        const onChanged = () => load()
        window.addEventListener(CONFIG_CHANGED_EVENT, onChanged)
        return () => window.removeEventListener(CONFIG_CHANGED_EVENT, onChanged)
      }, [load])

      const close = () => setOpen(false)
      const engines = Array.isArray(data?.engines) ? data.engines : []
      const bridges = Array.isArray(data?.bridges) ? data.bridges : []
      const modes = Array.isArray(data?.modes) ? data.modes : []
      const selectedEngine = engines.find((engine) => engine.id === engineId)

      const startCreate = () => {
        const firstEngine = engines.find((engine) => engine.mode === 'cli') ?? engines[0]
        setEditingId(null)
        setName('')
        setMode(firstEngine?.mode ?? 'cli')
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

      const closeForm = () => {
        setView('list')
        setError(null)
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

      let content
      if (view === 'form') {
        if (selectedEngine === undefined) {
          content = h(
            'div',
            { className: 'dshBridge_settingsSection' },
            h('h2', { className: 'dshBridge_settingsTitle' }, t('addBridge')),
            h('p', { className: 'dshBridge_settingsIntro' }, t('loading')),
          )
        } else {
          const engineOptions = engines.filter((engine) => engine.mode === mode)
          content = h(
            'div',
            { className: 'dshBridge_settingsSection' },
            h('h2', { className: 'dshBridge_settingsTitle' }, editingId === null ? t('addBridge') : t('editBridge')),
            h('p', { className: 'dshBridge_settingsIntro' }, t('bridgeSettingsHint')),
            error !== null
              ? h('p', { className: 'dshBridge_settingsError', role: 'alert' }, `${t('settingsFailed')}: ${error}`)
              : null,
            h(
              'div',
              { className: 'dshBridge_settingsEditor' },
              h(
                'div',
                { className: 'dshBridge_settingsField' },
                h('span', { className: 'dshBridge_settingsFieldLabel' }, t('bridgeName')),
                h('input', {
                  className: 'dshBridge_settingsInput',
                  value: name,
                  placeholder: t('bridgeNamePlaceholder'),
                  disabled: saving,
                  onChange: (event) => setName(event.target.value),
                }),
              ),
              h(
                'div',
                { className: 'dshBridge_settingsField' },
                h('span', { className: 'dshBridge_settingsFieldLabel' }, t('bridgeMode')),
                h(
                  'select',
                  {
                    className: 'dshBridge_settingsInput dshBridge_settingsSelect',
                    value: mode,
                    disabled: saving,
                    onChange: (event) => chooseMode(event.target.value),
                  },
                  ...modes.map((entry) =>
                    h('option', { key: entry.id, value: entry.id }, entry.id === 'cli' ? t('modeCli') : t('modeWeb')),
                  ),
                ),
              ),
              h(
                'div',
                { className: 'dshBridge_settingsField' },
                h('span', { className: 'dshBridge_settingsFieldLabel' }, t('bridgeEngine')),
                h(
                  'select',
                  {
                    className: 'dshBridge_settingsInput dshBridge_settingsSelect',
                    value: engineId,
                    disabled: saving,
                    onChange: (event) => chooseEngine(event.target.value),
                  },
                  ...engineOptions.map((engine) =>
                    h(
                      'option',
                      { key: engine.id, value: engine.id },
                      engine.available === false ? `${engine.label} (${t('bridgeUnavailable')})` : engine.label,
                    ),
                  ),
                ),
              ),
              selectedEngine.available === false
                ? h('p', { className: 'dshBridge_settingsNotice' }, `${t('bridgeUnavailableHint')} ${selectedEngine.unavailableReason ?? ''}`)
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
                { className: 'dshBridge_settingsEditorActions' },
                h(
                  'button',
                  { type: 'button', className: 'dshBridge_settingsSecondaryButton', onClick: closeForm },
                  t('dialogCancel'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dshBridge_settingsPrimaryButton',
                    disabled: saving || name.trim() === '',
                    onClick: save,
                  },
                  saving ? t('savingBridge') : t('saveBridge'),
                ),
              ),
            ),
          )
        }
      } else {
        content = h(
          'div',
          { className: 'dshBridge_settingsSection' },
          h('h2', { className: 'dshBridge_settingsTitle' }, t('bridgeSettingsGeneral')),
          h('p', { className: 'dshBridge_settingsIntro' }, t('bridgeSettingsHint')),
          error !== null
            ? h('p', { className: 'dshBridge_settingsError', role: 'alert' }, `${t('settingsFailed')}: ${error}`)
            : null,
          notice !== null
            ? h('p', { className: 'dshBridge_settingsSaved', role: 'status', 'aria-live': 'polite' }, notice)
            : null,
          loading
            ? h('p', { className: 'dshBridge_settingsIntro' }, t('loading'))
            : bridges.length === 0
              ? h('p', { className: 'dshBridge_settingsEmpty' }, `${t('noBridges')} ${t('noBridgesHint')}`)
              : h(
                  'ul',
                  { className: 'dshBridge_settingsRows' },
                  ...bridges.map((bridge) => {
                    const summary = configSummary(bridge, t)
                    return h(
                      'li',
                      { key: bridge.id, className: 'dshBridge_settingsRowCard' },
                      h(
                        'div',
                        { className: 'dshBridge_settingsRowHead' },
                        h(
                          'span',
                          { className: 'dshBridge_settingsRowIdentity' },
                          h('span', { className: 'dshBridge_settingsRowName' }, bridge.name),
                          h(
                            'span',
                            { className: 'dshBridge_settingsRowTag' },
                            bridge.available
                              ? `${bridge.mode === 'cli' ? t('modeCli') : t('modeWeb')} · ${bridge.engineLabel}`
                              : t('bridgeUnavailable'),
                          ),
                        ),
                        h(
                          'span',
                          { className: 'dshBridge_settingsRowActions' },
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'dshBridge_settingsSecondaryButton',
                              'aria-label': t('editBridge'),
                              onClick: () => startEdit(bridge),
                            },
                            t('editBridge'),
                          ),
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'dshBridge_settingsDangerButton',
                              'aria-label': t('deleteBridge'),
                              onClick: () => remove(bridge),
                            },
                            t('deleteBridge'),
                          ),
                        ),
                      ),
                      bridge.description
                        ? h('span', { className: 'dshBridge_settingsConfigSummary' }, bridge.description)
                        : null,
                      summary !== '' ? h('span', { className: 'dshBridge_settingsConfigSummary' }, summary) : null,
                    )
                  }),
                ),
          h(
            'div',
            { className: 'dshBridge_settingsAddBlock' },
            h(
              'div',
              { className: 'dshBridge_settingsAddActions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshBridge_settingsAddButton',
                  onClick: startCreate,
                  disabled: loading || engines.length === 0,
                },
                h(IconPlusOutlineRegular, { size: 16 }),
                h('span', null, t('addBridge')),
              ),
            ),
          ),
        )
      }

      if (!open) return null
      return h(
        'div',
        { className: 'dshBridge_settingsOverlay', role: 'presentation' },
        h('div', {
          className: 'dshBridge_settingsMask',
          'aria-hidden': 'true',
          onClick: close,
        }),
        h(
          'div',
          {
            className: 'dshBridge_settingsPanel',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'dshBridge_settingsNavTitle',
          },
          h(
            'nav',
            { className: 'dshBridge_settingsNav' },
            h('div', { className: 'dshBridge_settingsNavTitle', id: 'dshBridge_settingsNavTitle' }, t('settingsTitle')),
            h(
              'div',
              { className: 'dshBridge_settingsNavList' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshBridge_settingsNavCell',
                  'data-active': 'true',
                  'aria-current': 'true',
                  onClick: () => setView('list'),
                },
                h(IconSettingsOutlineRegular, { size: 16, className: 'dshBridge_settingsNavIcon' }),
                h('span', { className: 'dshBridge_settingsNavLabel' }, t('bridgeSettingsGeneral')),
              ),
            ),
          ),
          h(
            'div',
            { className: 'dshBridge_settingsContent' },
            h(
              'div',
              { className: 'dshBridge_settingsHeader' },
              h('div', { className: 'dshBridge_settingsActions' }),
              h(
                'button',
                {
                  ref: closeButton,
                  type: 'button',
                  className: 'dshBridge_settingsClose',
                  'aria-label': t('settingsClose'),
                  onClick: close,
                },
                h(IconCloseOutlineRegular, { size: 14 }),
                h('span', { className: 'dshBridge_settingsHiddenLabel' }, t('settingsClose')),
              ),
            ),
            h('div', { className: 'dshBridge_settingsOptions' }, content),
          ),
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

      // Poll the lightweight status route while the menu is open, so a
      // background probe transitioning orange -> green/red is reflected
      // without closing and reopening the menu.
      useEffect(() => {
        if (!open) return undefined
        let cancelled = false
        const tick = async () => {
          try {
            const body = await api('status')
            if (cancelled) return
            setData((current) => {
              if (current === null || !Array.isArray(current.bridges)) return current
              const states = new Map((body.bridges ?? []).map((entry) => [entry.id, entry]))
              return {
                ...current,
                bridges: current.bridges.map((bridge) => {
                  const next = states.get(bridge.id)
                  return next === undefined
                    ? bridge
                    : { ...bridge, connection: { state: next.state, error: next.error, checkedAt: next.checkedAt, latencyMs: next.latencyMs } }
                }),
              }
            })
          } catch {
            // Keep the last known state; the next tick retries.
          }
        }
        void tick()
        const timer = setInterval(tick, 2500)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [open])

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
            h('span', { className: 'dshBridge_menuMeta dshBridge_statusRow' },
              bridge.available === false
                ? t('bridgeUnavailable')
                : h(StatusDot, {
                    state: connectionState(bridge, t).state,
                    label: connectionState(bridge, t).label,
                    selected: ui.bridge?.id === bridge.id,
                  })),
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
        bridgeUi.set({ bridge, sessions: [], workspaces: [], removedWorkspacePaths: [], selectedKey: null, search: '', loadError: null, loading: true })
        onSelectBridge(bridge)
        // Re-picking the bridge that is already open leaves the panel mounted,
        // so its bridge-id effect never fires again. Ask the panel to reload
        // explicitly; with no mounted panel this is a no-op and mounting loads
        // the list itself. Without it the sidebar would stay on "Loading…".
        bridgeUi.refresh()
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
      // Session activity is host-owned and changes without a filesystem write,
      // so poll the lightweight activity route while the Bridge browser is live.
      useEffect(() => {
        if (!ui.bridge?.id) return undefined
        let cancelled = false
        const tick = async () => {
          try {
            const body = await api(`activity?bridge=${encodeURIComponent(ui.bridge.id)}`)
            if (cancelled) return
            const map = {}
            for (const entry of Array.isArray(body.activity) ? body.activity : []) map[entry.key] = entry
            bridgeUi.set({ activityByKey: map, activityLoaded: true })
          } catch {
            // Keep the last known status; the next tick retries.
          }
        }
        void tick()
        const timer = setInterval(tick, 2000)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [ui.bridge?.id])
      const searchRoot = useRef(null)
      const searchInput = useRef(null)
      const [directoryOpen, setDirectoryOpen] = useState(false)
      const [importOpen, setImportOpen] = useState(false)
      const [searchOnExpand, setSearchOnExpand] = useState(false)
      const [drag, setDrag] = useState(null)
      const [sessionLimits, setSessionLimits] = useState({})
      const now = Date.now()
      const query = ui.search.trim().toLowerCase()

      const expandSidebarForSearch = () => {
        if (!wide) {
          setSearchOnExpand(true)
          expandSidebar()
        }
      }

      useEffect(() => {
        if (!wide || !searchOnExpand) return undefined
        const timer = window.setTimeout(() => {
          searchInput.current?.focus({ preventScroll: true })
          setSearchOnExpand(false)
        }, SEARCH_SLIDE_MS)
        return () => window.clearTimeout(timer)
      }, [wide, searchOnExpand])

      useEffect(() => {
        if (!wide || !ui.searchExpanded || searchOnExpand) return undefined
        searchInput.current?.focus({ preventScroll: true })
        return undefined
      }, [wide, ui.searchExpanded, searchOnExpand])

      useEffect(() => {
        if (!wide || !ui.searchExpanded || searchOnExpand) return undefined
        const onClick = (event) => {
          if (!(event.target instanceof Node) || searchRoot.current?.contains(event.target) === true) return
          if (ui.search !== '') return
          bridgeUi.set({ searchExpanded: false })
        }
        document.addEventListener('click', onClick)
        return () => document.removeEventListener('click', onClick)
      }, [ui.search, ui.searchExpanded, wide, searchOnExpand])

      /**
       * Workspaces come from the host's durable metadata, merged with any
       * session cwd that has no record yet. The host reconciles new cwds on
       * every session query; the extraWorkspaces list is only the legacy
       * browser-local fallback and is intentionally lower priority.
       */
      const removedWorkspaces = useMemo(
        () => new Set(Array.isArray(ui.removedWorkspacePaths) ? ui.removedWorkspacePaths : []),
        [ui.removedWorkspacePaths],
      )

      const workspaceEntities = useMemo(() => {
        const byPath = new Map()
        const add = (workspace) => {
          const path = workspace.path ?? workspace.id ?? ''
          if (path === '' || byPath.has(path) || removedWorkspaces.has(path)) return
          byPath.set(path, {
            key: path,
            workspaceId: workspace.id ?? path,
            path,
            name: workspace.name ?? workspaceLabel(path),
            label: workspace.name ?? workspaceLabel(path),
            createdAt: workspace.createdAt,
            sessionCount: workspace.sessionCount,
            deleted: workspace.deleted === true,
          })
        }
        for (const workspace of ui.workspaces) add(workspace)
        for (const workspace of ui.extraWorkspaces) add(workspace)
        for (const session of ui.sessions) {
          if (typeof session.cwd === 'string' && session.cwd !== '') add({ path: session.cwd, name: workspaceLabel(session.cwd) })
        }
        return [...byPath.values()]
      }, [ui.sessions, ui.workspaces, ui.extraWorkspaces, removedWorkspaces])

      /**
       * A session belongs to a persisted workspace record only. Leftover
       * browser-only paths still group by cwd so existing users lose no view,
       * but a soft-deleted path is deliberately absent from workspaceEntities
       * and its sessions fall through to Ungrouped.
       */
      const workspaceBySession = useMemo(() => {
        const map = new Map()
        for (const workspace of workspaceEntities) {
          for (const session of ui.sessions) {
            if (session.cwd === workspace.path) map.set(session.key, workspace.key)
          }
        }
        return map
      }, [ui.sessions, workspaceEntities])

      const archived = useMemo(() => new Set(ui.archivedKeys), [ui.archivedKeys])
      const visibleSessions = useMemo(() => {
        return ui.sessions.filter((session) => {
          if (ui.archivedFilter === 'default' && archived.has(session.key)) return false
          if (ui.archivedFilter === 'only' && !archived.has(session.key)) return false
          return true
        })
      }, [archived, ui.archivedFilter, ui.sessions])

      const matches = useMemo(() => {
        if (query === '') return []
        return visibleSessions
          .filter((session) => {
            const haystack = [session.name, session.cwd, session.firstMessage, session.id].filter(Boolean).join('\n').toLowerCase()
            return haystack.includes(query)
          })
          .sort(compareSessionsByUpdated)
      }, [query, visibleSessions])

      const groupMembers = useCallback((key) => {
        return visibleSessions.filter((session) => (workspaceBySession.get(session.key) ?? '') === key)
      }, [visibleSessions, workspaceBySession])

      const orderMembers = useCallback((key, members) => {
        if (ui.orderBy === 'updated') return [...members].sort(compareSessionsByUpdated)
        const byKey = new Map(members.map((session) => [session.key, session]))
        const orderedKeys = reconcileSessionOrder(members, ui.sessionOrderByAccount[key], byKey)
        return orderedKeys.flatMap((sessionKey) => {
          const session = byKey.get(sessionKey)
          return session === undefined ? [] : [session]
        })
      }, [ui.orderBy, ui.sessionOrderByAccount])

      const groups = useMemo(() => {
        const result = []
        for (const workspace of workspaceEntities) {
          const members = groupMembers(workspace.key)
          if (ui.archivedFilter === 'only' && members.length === 0) continue
          result.push({
            key: workspace.key,
            workspaceId: workspace.key,
            cwd: workspace.path,
            label: workspace.label,
            createdAt: workspace.createdAt,
            sessions: orderMembers(workspace.key, members),
          })
        }
        const ungrouped = visibleSessions.filter((session) => !workspaceBySession.get(session.key))
        if (ungrouped.length > 0 || workspaceEntities.length === 0) {
          if (ui.archivedFilter !== 'only' || ungrouped.length > 0) {
            result.push({
              key: '',
              workspaceId: undefined,
              cwd: undefined,
              label: '',
              sessions: orderMembers('', ungrouped),
            })
          }
        }
        return result
      }, [groupMembers, orderMembers, ui.archivedFilter, visibleSessions, workspaceBySession, workspaceEntities])

      const flatSessions = useMemo(() => {
        if (ui.orderBy === 'updated') return [...visibleSessions].sort(compareSessionsByUpdated)
        const byKey = new Map(visibleSessions.map((session) => [session.key, session]))
        return reconcileSessionOrder(visibleSessions, ui.sessionOrderByAccount[FLAT_ORDER_KEY], byKey).flatMap((key) => {
          const session = byKey.get(key)
          return session === undefined ? [] : [session]
        })
      }, [ui.orderBy, ui.sessionOrderByAccount, visibleSessions])

      const parents = useMemo(() => {
        if (ui.groupBy !== 'workspace-tree') return new Map()
        const byPath = new Map(workspaceEntities.map((workspace) => [workspace.path, workspace.key]))
        const paths = [...byPath.keys()]
        return new Map(workspaceEntities.map((workspace) => {
          const parent = owningParentFolder(workspace.path, paths)
          return [workspace.key, parent === undefined ? undefined : byPath.get(parent)]
        }))
      }, [ui.groupBy, workspaceEntities])

      const childrenByParent = useMemo(() => {
        const rendered = new Set(groups.map((group) => group.key))
        const children = new Map()
        for (const group of groups) {
          let parent = parents.get(group.key)
          while (parent !== undefined && !rendered.has(parent)) parent = parents.get(parent)
          const siblings = children.get(parent)
          if (siblings === undefined) children.set(parent, [group])
          else siblings.push(group)
        }
        return children
      }, [groups, parents])

      const setGroupExpanded = (key, expanded) => {
        bridgeUi.setView({ groupExpansion: { ...ui.groupExpansion, [key]: expanded } })
      }

      const setOrderBy = (mode) => {
        if (mode === ui.orderBy) return
        if (mode === 'manual') {
          const orders = {}
          for (const group of groups) orders[group.key] = group.sessions.map((session) => session.key)
          orders[FLAT_ORDER_KEY] = flatSessions.map((session) => session.key)
          bridgeUi.setView({ orderBy: mode, sessionOrderByAccount: orders })
        } else {
          bridgeUi.setView({ orderBy: mode, sessionOrderByAccount: {} })
        }
      }

      const commitSessionDrag = (active, over) => {
        if (active === null || over === undefined) return
        if (active.sessionKey === over.sessionKey) return
        const accountKey = active.accountKey
        const members = accountKey === FLAT_ORDER_KEY ? flatSessions : groupMembers(accountKey)
        const accountOrder = (accountKey === FLAT_ORDER_KEY ? flatSessions : orderMembers(accountKey, members)).map((session) => session.key)
        const next = accountOrder.filter((key) => key !== active.sessionKey)
        const targetIndex = next.indexOf(over.sessionKey)
        if (targetIndex === -1) return
        next.splice(targetIndex + (over.half === 'after' ? 1 : 0), 0, active.sessionKey)
        const allMembers = ui.sessions
          .filter((session) => accountKey === FLAT_ORDER_KEY || (workspaceBySession.get(session.key) ?? '') === accountKey)
          .map((session) => session.key)
        const complete = [...next, ...allMembers.filter((key) => !next.includes(key))]
        bridgeUi.setView({
          orderBy: 'manual',
          sessionOrderByAccount: {
            ...ui.sessionOrderByAccount,
            [accountKey]: complete,
            ...(accountKey === FLAT_ORDER_KEY ? {} : { [FLAT_ORDER_KEY]: [...flatSessions.map((session) => session.key)] }),
          },
        })
      }

      /**
       * Archive state lives on the bridge host. Optimistically mirror the
       * result for instant feedback, then install the authoritative complete
       * key set returned by the host. On failure, re-query so a rejected
       * archive (for example, while the session is running) cannot leave the
       * sidebar hiding a session that the host still considers active.
       */
      const updateArchived = async (sessionKey, shouldArchive) => {
        const optimistic = shouldArchive
          ? [...ui.archivedKeys.filter((key) => key !== sessionKey), sessionKey]
          : ui.archivedKeys.filter((key) => key !== sessionKey)
        bridgeUi.set({ archivedKeys: optimistic })
        try {
          const body = await api('archive', {
            method: 'POST',
            body: JSON.stringify({ key: sessionKey, archived: shouldArchive }),
          })
          bridgeUi.set({
            archivedKeys: Array.isArray(body.archivedKeys) ? body.archivedKeys : optimistic,
            ...(shouldArchive && ui.selectedKey === sessionKey ? { selectedKey: null } : {}),
          })
        } catch (error) {
          bridgeUi.refresh()
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('bridge:notice', {
              detail: {
                text: `${shouldArchive ? t('archiveFailed') : t('unarchiveFailed')}: ${error instanceof Error ? error.message : String(error)}`,
                error: true,
              },
            }))
          }
        }
      }

      const addWorkspace = async (path) => {
        try {
          const body = await api('workspaces', {
            method: 'POST',
            body: JSON.stringify({ bridge: ui.bridge?.id, path }),
          })
          bridgeUi.set({
            workspaces: Array.isArray(body.workspaces) ? body.workspaces : ui.workspaces,
            removedWorkspacePaths: Array.isArray(body.removedWorkspacePaths) ? body.removedWorkspacePaths : ui.removedWorkspacePaths,
          })
          setDirectoryOpen(false)
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('bridge:notice', { detail: { text: t('workspaceAdded') } }))
          }
          bridgeUi.refresh()
        } catch (error) {
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('bridge:notice', {
              detail: { text: `${t('workspaceAddFailed')}: ${error instanceof Error ? error.message : String(error)}`, error: true },
            }))
          }
        }
      }

      const handleImported = useCallback((body, count) => {
        bridgeUi.set({
          sessions: Array.isArray(body?.sessions) ? body.sessions : bridgeUi.state.sessions,
          workspaces: Array.isArray(body?.workspaces) ? body.workspaces : bridgeUi.state.workspaces,
          removedWorkspacePaths: Array.isArray(body?.removedWorkspacePaths)
            ? body.removedWorkspacePaths
            : bridgeUi.state.removedWorkspacePaths,
        })
        bridgeUi.refresh()
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('bridge:notice', {
            detail: { text: t('importSucceeded').replace('{n}', String(count)) },
          }))
        }
      }, [t])

      const [workspaceAction, setWorkspaceAction] = useState(null)
      const [workspaceActionBusy, setWorkspaceActionBusy] = useState(false)
      const [workspaceActionError, setWorkspaceActionError] = useState(null)

      const beginWorkspaceAction = (action, group) => {
        if (group.workspaceId === undefined) return
        setWorkspaceActionError(null)
        setWorkspaceAction({ action, target: group })
      }

      const closeWorkspaceAction = () => {
        if (workspaceActionBusy) return
        setWorkspaceAction(null)
        setWorkspaceActionError(null)
      }

      const renameWorkspace = async (name) => {
        if (workspaceAction === null || workspaceActionBusy) return
        setWorkspaceActionBusy(true)
        setWorkspaceActionError(null)
        try {
          await api('workspaces', {
            method: 'PUT',
            body: JSON.stringify({ bridge: ui.bridge?.id, id: workspaceAction.target.workspaceId, name }),
          })
          await loadSessions()
          setWorkspaceAction(null)
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('bridge:notice', { detail: { text: t('workspaceRenamed') } }))
          }
        } catch (error) {
          setWorkspaceActionError(error instanceof Error ? error.message : String(error))
        } finally {
          setWorkspaceActionBusy(false)
        }
      }

      const removeWorkspace = async () => {
        if (workspaceAction === null || workspaceActionBusy) return
        setWorkspaceActionBusy(true)
        setWorkspaceActionError(null)
        try {
          const body = await api('workspaces', {
            method: 'DELETE',
            body: JSON.stringify({ bridge: ui.bridge?.id, id: workspaceAction.target.workspaceId }),
          })
          bridgeUi.set({
            workspaces: Array.isArray(body.workspaces) ? body.workspaces : ui.workspaces,
            removedWorkspacePaths: Array.isArray(body.removedWorkspacePaths) ? body.removedWorkspacePaths : ui.removedWorkspacePaths,
          })
          setWorkspaceAction(null)
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('bridge:notice', { detail: { text: t('workspaceDeleted') } }))
          }
          await loadSessions()
        } catch (error) {
          setWorkspaceActionError(error instanceof Error ? error.message : String(error))
        } finally {
          setWorkspaceActionBusy(false)
        }
      }

      const createSession = async (group) => {
        let workspace = group
        if (workspace === null || workspace === undefined) {
          const candidates = workspaceEntities.filter((entry) => entry.workspaceId !== undefined)
          if (candidates.length !== 1) {
            if (typeof window !== 'undefined') {
              window.dispatchEvent(new CustomEvent('bridge:notice', { detail: { text: t('newSessionPickWorkspace'), error: true } }))
            }
            return
          }
          workspace = candidates[0]
        }
        try {
          const body = await api('sessions', {
            method: 'POST',
            body: JSON.stringify({ bridge: ui.bridge?.id, cwd: workspace.path ?? workspace.cwd }),
          })
          await loadSessions()
          if (body.session?.key) {
            bridgeUi.selectSession(body.session.key)
          }
        } catch (error) {
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('bridge:notice', {
              detail: { text: `${t('newSessionFailed')}: ${error instanceof Error ? error.message : String(error)}`, error: true },
            }))
          }
        }
      }

      const renderSession = (session, accountKey) => {
        const compatible = drag !== null && drag.accountKey === accountKey
        return h(BridgeSessionRow, {
          key: session.key,
          session,
          selected: session.key === ui.selectedKey,
          archived: archived.has(session.key),
          activity: ui.activityLoaded
            ? ui.activityByKey?.[session.key]
            : session.activity,
          now,
          t,
          onOpen: (key) => {
            if (archived.has(key)) {
              if (typeof window !== 'undefined') {
                window.dispatchEvent(new CustomEvent('bridge:notice', { detail: { text: t('archivedNotOpenable'), error: true } }))
              }
              return
            }
            bridgeUi.selectSession(key)
          },
          onArchive: updateArchived,
          drag: {
            active: compatible,
            marker: compatible && drag.over?.sessionKey === session.key ? drag.over.half : null,
          },
          onDragStart: () => setDrag({ accountKey, sessionKey: session.key, over: null }),
          onDragEnd: () => {
            if (drag?.over !== null && drag?.over !== undefined) commitSessionDrag(drag, drag.over)
            setDrag(null)
          },
          onDragOver: (half) => setDrag((current) => current === null ? current : { ...current, over: { sessionKey: session.key, half } }),
          onDrop: (half) => {
            if (drag !== null) commitSessionDrag(drag, { sessionKey: session.key, half })
            setDrag(null)
          },
        })
      }

      const renderGroup = (group, depth) => {
        const children = childrenByParent.get(group.key) ?? []
        const expanded = ui.groupExpansion[group.key] ?? (children.length > 0 || group.sessions.some((session) => session.key === ui.selectedKey))
        const limit = sessionLimits[group.key]
        let idle = 0
        const visible = group.sessions.filter((session) => {
          if (session.key === ui.selectedKey) return true
          if (limit === Infinity) return true
          if (idle < (limit ?? 5)) {
            idle += 1
            return true
          }
          return false
        })
        const hiddenCount = group.sessions.length - visible.length
        return h(
          'div',
          {
            key: group.key || '__ungrouped__',
            className: 'dshBridge_browser_groupSection',
            style: { '--dsh-workspace-indent': `${depth * 12}px` },
          },
          h(BridgeWorkspaceRow, {
            group,
            expanded,
            active: group.sessions.some((session) => session.key === ui.selectedKey),
            t,
            onToggle: () => setGroupExpanded(group.key, !expanded),
            onCreate: () => createSession(group),
            onRename: () => beginWorkspaceAction('rename', group),
            onDelete: () => beginWorkspaceAction('delete', group),
          }),
          expanded && children.length > 0 ? h('div', { role: 'group' }, ...children.map((child) => renderGroup(child, depth + 1))) : null,
          expanded ? visible.map((session) => renderSession(session, group.key)) : null,
          expanded && hiddenCount > 0
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dshBridge_browser_sessionOverflowButton',
                  'aria-expanded': limit === Infinity,
                  onClick: () => setSessionLimits((limits) => ({
                    ...limits,
                    [group.key]: limit === Infinity ? 5 : (limits[group.key] ?? 5) + 5,
                  })),
                },
                limit === Infinity ? t('sessionsCollapse') : t('sessionsExpand').replace('{n}', String(hiddenCount)),
              )
            : null,
        )
      }

      const emptyState = h(
        'div',
        { className: 'dshBridge_browser_emptyState', 'data-row-key': 'empty' },
        ui.archivedFilter === 'only' ? h(IconArchiveOutlineRegular, { size: 24 }) : h(IconDatabaseOutlineRegular, { size: 24 }),
        h('div', null, ui.archivedFilter === 'only' ? t('emptyArchived') : t('empty')),
        ui.archivedFilter === 'only'
          ? h(
              'button',
              {
                type: 'button',
                className: 'dshBridge_browser_emptyAction',
                onClick: () => bridgeUi.setView({ archivedFilter: 'default' }),
              },
              t('emptyViewOthers'),
            )
          : h(
              'button',
              {
                type: 'button',
                className: 'dshBridge_browser_emptyAction',
                onClick: () => setImportOpen(true),
              },
              t('importSessions'),
            ),
      )

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
      } else if (query !== '') {
        body = h(
          'div',
          { className: 'dshBridge_browser_treeBody dshBridge_browser_wide' },
          h(
            'div',
            { className: 'dshBridge_browser_list' },
            h(
              'div',
              { className: 'dshBridge_browser_searchTree', role: 'tree', 'aria-label': t('searchResults') },
              ...matches.map((session) =>
                h(BridgeSearchResult, {
                  key: session.key,
                  session,
                  selected: session.key === ui.selectedKey,
                  now,
                  t,
                  onOpen: (key) => {
                    if (archived.has(key)) {
                      if (typeof window !== 'undefined') {
                        window.dispatchEvent(new CustomEvent('bridge:notice', { detail: { text: t('archivedNotOpenable'), error: true } }))
                      }
                      return
                    }
                    bridgeUi.selectSession(key)
                    bridgeUi.set({ search: '', searchExpanded: false })
                  },
                }),
              ),
            ),
            matches.length === 0 ? h('div', { className: 'dshBridge_browser_empty' }, t('noMatches')) : null,
          ),
          h('span', { className: 'dshBridge_browser_fade' }),
        )
      } else if (ui.groupBy === 'flat') {
        body = h(
          'div',
          { className: 'dshBridge_browser_treeBody dshBridge_browser_wide' },
          h(
            'div',
            { className: 'dshBridge_browser_list dshBridge_browser_flatList' },
            ...(flatSessions.length === 0 ? [emptyState] : flatSessions.map((session) => renderSession(session, FLAT_ORDER_KEY))),
          ),
          h('span', { className: 'dshBridge_browser_fade' }),
        )
      } else {
        const rootGroups = childrenByParent.get(undefined) ?? []
        body = h(
          'div',
          { className: 'dshBridge_browser_treeBody dshBridge_browser_wide' },
          h(
            'div',
            { className: 'dshBridge_browser_list' },
            ...(rootGroups.length === 0 ? [emptyState] : rootGroups.map((group) => renderGroup(group, 0))),
          ),
          h('span', { className: 'dshBridge_browser_fade' }),
        )
      }

      const workspaceActionDialog = h(BridgeWorkspaceActionDialog, {
        action: workspaceAction?.action ?? null,
        target: workspaceAction?.target ?? null,
        busy: workspaceActionBusy,
        error: workspaceActionError,
        t,
        onClose: closeWorkspaceAction,
        onRename: renameWorkspace,
        onDelete: removeWorkspace,
      })

      if (!wide) {
        return h(
          'div',
          { className: 'dshBridge_browser_root dshBridge_browser_rail' },
          h(
            'div',
            { className: 'dshBridge_browser_sectionHeader' },
            h(
              'div',
              { className: 'dshBridge_browser_search' },
              h(
                Tooltip,
                { label: t('search'), side: 'bottom', delayMs: 500 },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dshBridge_browser_searchButton',
                    'aria-label': t('search'),
                    onClick: () => {
                      bridgeUi.set({ searchExpanded: true })
                      expandSidebarForSearch()
                    },
                  },
                  h(IconSearchOutlineRegular, { size: 18 }),
                ),
              ),
            ),
            h(
              Tooltip,
              { label: t('importSessions'), side: 'bottom', delayMs: 500 },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshBridge_browser_iconButton',
                  'aria-label': t('importSessions'),
                  disabled: ui.bridge === null || ui.bridge.available === false,
                  onClick: () => {
                    setImportOpen(true)
                    expandSidebar()
                  },
                },
                h(IconDatabaseOutlineRegular, { size: 18 }),
              ),
            ),
            h(
              Tooltip,
              { label: t('addWorkspace'), side: 'bottom', delayMs: 500 },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshBridge_browser_iconButton',
                  'aria-label': t('addWorkspace'),
                  onClick: () => {
                    setDirectoryOpen(true)
                    expandSidebar()
                  },
                },
                h(IconProjectAddOutlineRegular, { size: 18 }),
              ),
            ),
            h(
              Tooltip,
              { label: t('newSession'), side: 'bottom', delayMs: 500 },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshBridge_browser_iconButton',
                  'aria-label': t('newSession'),
                  disabled: workspaceEntities.length === 0,
                  onClick: () => createSession(null),
                },
                h(IconNewChatOutlineRegular, { size: 18 }),
              ),
            ),
          ),
          h(BridgeDirectoryDialog, {
            open: directoryOpen,
            t,
            onClose: () => setDirectoryOpen(false),
            onPick: addWorkspace,
          }),
          h(BridgeImportDialog, {
            open: importOpen,
            bridgeId: ui.bridge?.id ?? null,
            t,
            onClose: () => setImportOpen(false),
            onImported: handleImported,
          }),
          workspaceActionDialog,
        )
      }

      return h(
        'div',
        { className: 'dshBridge_browser_root' },
        h(
          'div',
          { className: 'dshBridge_browser_sectionHeader' },
          h(
            'span',
            {
              className: `dshBridge_browser_sectionLabel dshBridge_browser_wide${ui.searchExpanded ? ' dshBridge_browser_sectionLabelHidden' : ''}`,
            },
            ui.groupBy === 'flat' ? t('sectionSessions') : t('sectionWorkspaces'),
          ),
          h(
            'div',
            { className: `dshBridge_browser_searchSlot${ui.searchExpanded ? ' dshBridge_browser_searchSlotExpanded' : ''}` },
            h(
              'div',
              {
                ref: searchRoot,
                className: `dshBridge_browser_search${ui.searchExpanded ? ' dshBridge_browser_searchExpanded' : ''}`,
                onClick: () => {
                  bridgeUi.set({ searchExpanded: true })
                  searchInput.current?.focus()
                },
              },
              h(
                Tooltip,
                { label: t('search'), side: 'bottom', delayMs: 500, disabled: ui.searchExpanded },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dshBridge_browser_searchButton',
                    'aria-label': t('search'),
                    'aria-expanded': ui.searchExpanded,
                    onClick: () => {
                      bridgeUi.set({ searchExpanded: true })
                      searchInput.current?.focus()
                    },
                  },
                  h(IconSearchOutlineRegular, { size: ui.searchExpanded ? 11 : 14 }),
                ),
              ),
              h('input', {
                ref: searchInput,
                className: 'dshBridge_browser_searchInput',
                type: 'text',
                placeholder: t('searchPlaceholder'),
                maxLength: 500,
                value: ui.search,
                tabIndex: ui.searchExpanded ? 0 : -1,
                onChange: (event) => bridgeUi.set({ search: event.target.value.replaceAll('\0', '') }),
                onKeyDown: (event) => {
                  if (event.key !== 'Escape') return
                  bridgeUi.set({ search: '', searchExpanded: false })
                },
              }),
              ui.searchExpanded
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'dshBridge_browser_clearButton',
                      'aria-label': t('searchClear'),
                      onClick: (event) => {
                        event.stopPropagation()
                        bridgeUi.set({ search: '', searchExpanded: false })
                      },
                    },
                    h(IconCloseFillRegular, {}),
                  )
                : null,
            ),
          ),
          h(
            'div',
            { className: `dshBridge_browser_headerActions${ui.searchExpanded ? ' dshBridge_browser_headerActionsHidden' : ''}` },
            h(BridgeViewOptionsMenu, {
              groupBy: ui.groupBy,
              orderBy: ui.orderBy,
              archivedFilter: ui.archivedFilter,
              onGroupPick: (mode) => bridgeUi.setView({ groupBy: mode }),
              onOrderPick: setOrderBy,
              onArchivedFilterPick: (mode) => bridgeUi.setView({ archivedFilter: mode }),
              t,
            }),
            h(
              Tooltip,
              { label: t('importSessions'), side: 'bottom', delayMs: 500 },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshBridge_browser_iconButton',
                  'aria-label': t('importSessions'),
                  disabled: ui.bridge === null || ui.bridge.available === false,
                  onClick: () => setImportOpen(true),
                },
                h(IconDatabaseOutlineRegular, { size: 16 }),
              ),
            ),
            h(
              Tooltip,
              { label: t('addWorkspace'), side: 'bottom', delayMs: 500 },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshBridge_browser_iconButton',
                  'aria-label': t('addWorkspace'),
                  onClick: () => setDirectoryOpen(true),
                },
                h(IconProjectAddOutlineRegular, { size: 16 }),
              ),
            ),
            h(
              Tooltip,
              { label: t('newSession'), side: 'bottom', delayMs: 500 },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshBridge_browser_iconButton',
                  'aria-label': t('newSession'),
                  disabled: workspaceEntities.length === 0,
                  onClick: () => createSession(null),
                },
                h(IconNewChatOutlineRegular, { size: 16 }),
              ),
            ),
          ),
        ),
        h('div', { className: 'dshBridge_browser_listArea' }, body),
        h(BridgeDirectoryDialog, {
          open: directoryOpen,
          t,
          onClose: () => setDirectoryOpen(false),
          onPick: addWorkspace,
        }),
        h(BridgeImportDialog, {
          open: importOpen,
          bridgeId: ui.bridge?.id ?? null,
          t,
          onClose: () => setImportOpen(false),
          onImported: handleImported,
        }),
        workspaceActionDialog,
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
      // Submitted-but-not-yet-durable user text. dsh echoes the bubble locally
      // and swaps it for the Host occurrence; the clock starts at the same click.
      const [echoes, setEchoes] = useState([])
      const [turnPhase, setTurnPhase] = useState(null)
      const [runStartedAt, setRunStartedAt] = useState(null)
      const turnPhaseRef = useRef(null)
      const sendingRef = useRef(false)
      const [draft, setDraft] = useState('')
      const [sending, setSending] = useState(false)
      const [notice, setNotice] = useState(null)
      const [noticeError, setNoticeError] = useState(false)
      const [dialog, setDialog] = useState(null)
      const [streamState, setStreamState] = useState('idle')
      const [models, setModels] = useState([])
      const [modelsLoading, setModelsLoading] = useState(false)
      const [modelsError, setModelsError] = useState(null)
      const [modelSwitching, setModelSwitching] = useState(false)
      const [pendingModel, setPendingModel] = useState(null)
      const [sessionStats, setSessionStats] = useState(null)
      const [statsVersion, setStatsVersion] = useState(0)
      // New Session hero: the workspace the first message will land in, the
      // directory picker opened from its chip, and the message waiting for the
      // session it is about to create.
      const [heroWorkspacePath, setHeroWorkspacePath] = useState(null)
      const [heroDirectoryOpen, setHeroDirectoryOpen] = useState(false)
      const [heroSending, setHeroSending] = useState(false)
      const heroPendingDraftRef = useRef(null)
      const heroPendingKeyRef = useRef(null)
      const sourceRef = useRef(null)
      const connectEventsRef = useRef(null)
      const firstSnapshotRef = useRef(true)
      const lastSeqRef = useRef(0)
      const selectedKeyRef = useRef(null)
      const scrollRef = useRef(null)
      const bodyRef = useRef(null)
      const textareaRef = useRef(null)
      const stickToBottomRef = useRef(true)
      const widthHandles = useBridgeWidthControls(bodyRef, selectedKey !== null)

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
          bridgeUi.set({ sessions: [], workspaces: [], removedWorkspacePaths: [], loading: false, loadError: null })
          return
        }
        bridgeUi.set({ loading: true, loadError: null })
        try {
          const body = await api(`sessions?bridge=${encodeURIComponent(bridgeId)}`)
          bridgeUi.set({
            bridge: body.bridge ?? bridgeUi.state.bridge,
            sessions: Array.isArray(body.sessions) ? body.sessions : [],
            workspaces: Array.isArray(body.workspaces) ? body.workspaces : [],
            removedWorkspacePaths: Array.isArray(body.removedWorkspacePaths) ? body.removedWorkspacePaths : [],
            archivedKeys: Array.isArray(body.archivedKeys) ? body.archivedKeys : [],
            home: typeof body.home === 'string' ? body.home : bridgeUi.state.home,
          })
        } catch (error) {
          bridgeUi.set({
            sessions: [],
            workspaces: [],
            removedWorkspacePaths: [],
            loadError: error instanceof Error ? error.message : String(error),
          })
        } finally {
          bridgeUi.set({ loading: false })
        }
      }, [bridgeId])

      useEffect(() => {
        bridgeUi.hydrateView(bridgeId)
      }, [bridgeId])

      useEffect(() => {
        loadSessions()
      }, [loadSessions])

      // Sessions created by the Pi CLI outside this browser become visible as
      // soon as the tab regains focus. The host also re-queries on every
      // sessions request, so no filesystem watcher is required.
      useEffect(() => {
        const refresh = () => {
          if (document?.visibilityState === 'hidden') return
          loadSessions()
        }
        window.addEventListener('focus', refresh)
        document?.addEventListener?.('visibilitychange', refresh)
        return () => {
          window.removeEventListener('focus', refresh)
          document?.removeEventListener?.('visibilitychange', refresh)
        }
      }, [loadSessions])

      // Model catalog and session statistics are attachment-scoped. Both are
      // reloaded after the agent settles so the composer and statusline track
      // the live session rather than the stale history snapshot.
      useEffect(() => {
        if (selectedKey === null) {
          setModels([])
          setModelsLoading(false)
          setModelsError(null)
          setSessionStats(null)
          return undefined
        }
        let cancelled = false
        setModelsLoading(true)
        setModelsError(null)
        // The catalog is bridge-scoped, so it loads before any agent exists.
        api(`models?key=${encodeURIComponent(selectedKey)}`)
          .then((body) => {
            if (cancelled) return
            setModels(normalizeModelCatalog(body.models))
          })
          .catch((error) => {
            if (cancelled) return
            setModels([])
            setModelsError(error instanceof Error ? error.message : String(error))
          })
          .finally(() => {
            if (!cancelled) setModelsLoading(false)
          })
        if (attached) {
          api(`stats?key=${encodeURIComponent(selectedKey)}`)
          .then((body) => {
            if (!cancelled) setSessionStats(normalizeBridgeStats(body.stats))
          })
            .catch(() => {
              // Engines without a stats RPC still get the transcript fold below.
              if (!cancelled) setSessionStats(null)
            })
        } else {
          setSessionStats(null)
        }
        return () => {
          cancelled = true
        }
      }, [attached, bridgeId, selectedKey, statsVersion])

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
            bridgeUi.set({ bridge: null, sessions: [], workspaces: [], removedWorkspacePaths: [], selectedKey: null, search: '' })
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
          // Opening a session acknowledges its finished-turn dot immediately;
          // the host clears the durable marker so the next poll agrees.
          const remaining = { ...(bridgeUi.state.activityByKey ?? {}) }
          delete remaining[key]
          bridgeUi.set({ activityByKey: remaining })
          void api('activity', { method: 'POST', body: JSON.stringify({ key }) }).catch(() => {})
          setAttached(false)
          setState(null)
          setPendingModel(null)
          setStreamingMessage(null)
          setDialog(null)
          setTranscript([])
          // A half-submitted turn belongs to the session being left behind.
          setEchoes([])
          turnPhaseRef.current = null
          setTurnPhase(null)
          setRunStartedAt(null)
          setDetail(null)
          setDetailError(null)
          setDetailLoading(true)
          try {
            const body = await api(`session?key=${encodeURIComponent(key)}`)
            if (selectedKeyRef.current !== key) return
            setDetail(body.session)
            setTranscript(historyItems(body.session))
            // A session may already have a live agent (a turn started from
            // another tab, or a still-draining process). Adopt that state
            // instead of pretending the session is detached.
            setAttached(body.attached === true)
            if (body.attached === true) {
              firstSnapshotRef.current = true
              connectEventsRef.current?.(key)
            }
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

      /**
       * Drop one submitted echo once the Host owns that text. Text matching is
       * the honest signal: whichever echo carries the same body is the one the
       * durable message replaces. Unknown text (an agent that rewrites the user
       * turn) falls back to the oldest echo so nothing is left stuck on screen.
       */
      const settleEcho = useCallback((text) => {
        setEchoes((current) => dropEchoFor(current, text))
      }, [])

      /** The turn is over: drop the clock so the running row unmounts. */
      const finishTurn = useCallback(() => {
        turnPhaseRef.current = null
        setTurnPhase(null)
        setRunStartedAt(null)
      }, [])

      /** Publish the live phase to both the render tree and the SSE closure. */
      const setLivePhase = useCallback((phase) => {
        turnPhaseRef.current = phase
        setTurnPhase(phase)
      }, [])

      /** Abandon one in-flight submission: the echo goes away and the text returns. */
      const rollbackTurn = useCallback((echoId) => {
        setEchoes((current) => current.filter((entry) => entry.id !== echoId))
        finishTurn()
      }, [finishTurn])

      const applyBridgeEvent = useCallback((record) => {
        const event = record?.type
        if (event === 'agent-start') {
          setState((current) => (current === null ? current : { ...current, isStreaming: true }))
        } else if (event === 'agent-end') {
          setState((current) => (current === null ? current : { ...current, isStreaming: false }))
          setStatsVersion((value) => value + 1)
        } else if (event === 'agent-settled') {
          setState((current) => (current === null ? current : { ...current, isStreaming: false }))
          setStreamingMessage(null)
          finishTurn()
          // The host closes the per-turn agent shortly after this event.
          void loadSessions()
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
          if (message.role === 'user') settleEcho(textOf(message.content))
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
          void loadSessions()
        }
      }, [loadSessions, settleEcho, finishTurn])

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
            if (payload?.activity?.state === 'running') setPendingModel(null)
            // Reconcile against the Host: a turn this tab still paints but the
            // Host reports neither running nor attached has ended some other way
            // (a crash, a close from another tab) and its row must not linger.
            if (turnPhaseRef.current === 'running'
              && payload?.activity?.state !== 'running'
              && payload?.running !== true) {
              finishTurn()
            }
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
            finishTurn()
            void loadSessions()
          })
          source.addEventListener('bridge-session-closed', () => {
            setAttached(false)
            setStreamingMessage(null)
            finishTurn()
            void loadSessions()
          })
        },
        [applyBridgeEvent, finishTurn, showNotice, t],
      )

      useEffect(() => {
        connectEventsRef.current = connectEvents
      }, [connectEvents])

      /**
       * Lazy attach. The host spawns Pi on the first send (or when a turn is
       * already running elsewhere) and closes it after the settled turn, so a
       * browser-side "connect" action is no longer needed.
       */
      const ensureAttached = useCallback(async (key) => {
        setAttaching(true)
        try {
          const body = await api('attach', { method: 'POST', body: JSON.stringify({ key }) })
          setState(body.state ?? null)
          setAttached(true)
          firstSnapshotRef.current = true
          connectEvents(key)
          return true
        } catch (error) {
          showNotice(`${t('attachFailed')}: ${error instanceof Error ? error.message : String(error)}`, true)
          return false
        } finally {
          setAttaching(false)
        }
      }, [connectEvents, showNotice, t])

      /**
       * Submit the draft the way dsh does: the bubble appears immediately, the
       * card is free at once, and the spinner waits below the transcript. The
       * clock deliberately starts when the Host accepts the prompt, not on the
       * click, so connecting a fresh agent never inflates the reported time.
       */
      const send = useCallback(async (overrideText) => {
        const message = (typeof overrideText === 'string' ? overrideText : draft).trim()
        if (message === '' || selectedKey === null || sending) return
        const echo = { id: `echo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text: message, timestamp: new Date().toISOString() }
        sendingRef.current = true
        setSending(true)
        stickToBottomRef.current = true
        setDraft('')
        if (textareaRef.current !== null) textareaRef.current.style.height = 'auto'
        setEchoes((current) => [...current, echo])
        setLivePhase('connecting')
        setRunStartedAt(null)
        try {
          if (!attached) {
            const ready = await ensureAttached(selectedKey)
            if (!ready) {
              // The prompt never left the browser: take the bubble back and
              // hand the text to the reader, the way a failed send should.
              rollbackTurn(echo.id)
              setDraft(message)
              return
            }
          }
          await api('prompt', { method: 'POST', body: JSON.stringify({ key: selectedKey, message, mode: 'auto' }) })
          setRunStartedAt(Date.now())
          setLivePhase('running')
        } catch (error) {
          rollbackTurn(echo.id)
          setDraft(message)
          showNotice(`${t('promptFailed')}: ${error instanceof Error ? error.message : String(error)}`, true)
        } finally {
          sendingRef.current = false
          setSending(false)
        }
      }, [attached, draft, ensureAttached, rollbackTurn, selectedKey, sending, setLivePhase, showNotice, t])

      /**
       * Add a workspace from the hero chip. The sidebar owns its own dialog; the
       * page owns this one, so the POST lives here with the shared store update.
       */
      const addWorkspaceToBridge = useCallback(async (bridgeId, path) => {
        if (bridgeId === null) return
        try {
          const body = await api('workspaces', {
            method: 'POST',
            body: JSON.stringify({ bridge: bridgeId, path }),
          })
          bridgeUi.set({
            workspaces: Array.isArray(body.workspaces) ? body.workspaces : bridgeUi.state.workspaces,
            removedWorkspacePaths: Array.isArray(body.removedWorkspacePaths)
              ? body.removedWorkspacePaths
              : bridgeUi.state.removedWorkspacePaths,
          })
          await loadSessions()
        } catch (error) {
          showNotice(`${t('workspaceAddFailed')}: ${error instanceof Error ? error.message : String(error)}`, true)
        }
      }, [loadSessions, showNotice, t])

      // A fresh hero has no workspace yet; default to the first one so the chip
      // reads a name and Enter works without an extra pick.
      useEffect(() => {
        if (heroWorkspacePath !== null || selectedKey !== null) return
        const first = (ui.workspaces ?? []).find((workspace) => typeof workspace.path === 'string' && workspace.path !== '')
        if (first !== undefined) setHeroWorkspacePath(first.path)
      }, [heroWorkspacePath, selectedKey, ui.workspaces])

      /**
       * The New Session send: dsh creates the session, then submits the text.
       * The draft stays in the hero card until the session exists, so a failed
       * create leaves the message where the reader left it.
       */
      const heroSend = useCallback(async () => {
        const message = draft.trim()
        if (message === '' || bridge === null || bridge.available === false || heroSending) return
        const path = heroWorkspacePath ?? (ui.workspaces ?? []).find((workspace) => workspace.path)?.path ?? null
        if (path === null) {
          showNotice(t('heroPickWorkspaceFirst'), true)
          return
        }
        setHeroSending(true)
        try {
          const body = await api('sessions', {
            method: 'POST',
            body: JSON.stringify({ bridge: bridge.id, cwd: path }),
          })
          const key = body.session?.key
          if (typeof key !== 'string') throw new Error(t('newSessionFailed'))
          // Hand the text to the session the create just produced; `send` owns
          // the echo, the clock, and the failure rollback from here.
          heroPendingDraftRef.current = message
          heroPendingKeyRef.current = key
          setDraft('')
          await loadSessions()
          bridgeUi.selectSession(key)
        } catch (error) {
          showNotice(`${t('newSessionFailed')}: ${error instanceof Error ? error.message : String(error)}`, true)
        } finally {
          setHeroSending(false)
        }
      }, [bridge, draft, heroSending, heroWorkspacePath, loadSessions, showNotice, t, ui.workspaces])

      const chooseModel = useCallback(async (model) => {
        if (selectedKey === null || modelSwitching) return
        setModelSwitching(true)
        try {
          const body = await api('models', {
            method: 'POST',
            body: JSON.stringify({
              key: selectedKey,
              provider: model.provider,
              model: model.id,
            }),
          })
          if (body.pending === true) setPendingModel({ provider: model.provider, id: model.id })
          setState((current) => (current === null ? current : {
            ...current,
            model: { ...model, ...(body.model !== null && typeof body.model === 'object' ? body.model : {}) },
          }))
        } catch (error) {
          showNotice(`${t('modelSelectFailed')}: ${error instanceof Error ? error.message : String(error)}`, true)
        } finally {
          setModelSwitching(false)
        }
      }, [modelSwitching, selectedKey, showNotice, t])

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
      }, [transcript, streamingMessage, echoes, turnPhase])

      /**
       * Backstop for the running row. The settle event is the happy path; a
       * dropped event stream, a crashed child, or a turn adopted by another tab
       * would otherwise leave the row ticking forever. Poll only while a turn is
       * painted, and never while the submit itself is still in flight.
       */
      useEffect(() => {
        if (turnPhase === null || selectedKey === null) return undefined
        let cancelled = false
        const check = async () => {
          // The submit owns the phase until its own promise settles.
          if (cancelled || sendingRef.current) return
          // Prefer the bridge the panel is showing; a session key also carries
          // its bridge id as the prefix before the encoded native key.
          const id = bridgeId ?? String(selectedKey).slice(0, String(selectedKey).lastIndexOf('.'))
          if (id === '' || id === null) return
          try {
            const body = await api(`activity?bridge=${encodeURIComponent(id)}`)
            if (cancelled) return
            const entry = (Array.isArray(body.activity) ? body.activity : []).find((row) => row.key === selectedKey)
            const live = entry !== undefined && (entry.state === 'running' || entry.state === 'connecting')
            if (!live) finishTurn()
          } catch {
            // A failed probe says nothing about the turn; keep the row.
          }
        }
        const timer = setInterval(check, 5000)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [turnPhase, selectedKey, bridgeId, finishTurn])

      /**
       * Finish a New Session submit: once the created session is the open one,
       * hand its text to `send`, which owns the echo and the clock.
       */
      useEffect(() => {
        const pending = heroPendingDraftRef.current
        if (pending === null || selectedKey === null || selectedKey !== heroPendingKeyRef.current) return
        if (detailLoading || detailError !== null) return
        heroPendingDraftRef.current = null
        void send(pending)
      }, [selectedKey, detailLoading, detailError, send])

      const onScroll = useCallback(() => {
        const node = scrollRef.current
        if (node === null) return
        stickToBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 64
      }, [])


      const isStreaming = state?.isStreaming === true || streamingMessage !== null
      // A turn is live from the submit click until the agent settles: the
      // indicator shows while connecting and while the model is working.
      const isTurnLive = turnPhase !== null || isStreaming
      // The header meta and the running row describe the same live turn, so both
      // read the deep-diving label while an agent is connecting or working.
      const turnLabel = t('deepDiving')
      const fallbackStats = useMemo(
        () => deriveBridgeStats(transcript.filter((item) => item.kind === 'message').map((item) => item.message)),
        [transcript],
      )
      const statusStats = sessionStats ?? fallbackStats
      const selectedSession = detail ?? sessions.find((session) => session.key === selectedKey)
      // Live state is authoritative; otherwise fall back to what the session
      // JSONL recorded, so an unconnected session still shows its model.
      const currentModel = state?.model ?? detail?.model ?? (pendingModel === null ? null : {
        provider: pendingModel.provider,
        id: pendingModel.id,
        name: pendingModel.id,
      })
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
              : [bridge?.name, selectedSession?.cwd, isTurnLive ? turnLabel : attached ? t('idle') : t('sessionIdle')].filter(Boolean).join(' · ')),
          h('span', { className: 'dshBridge_headSpacer' }),
          h('button', {
            key: 'refresh',
            type: 'button',
            className: 'dshBridge_iconButton',
            'aria-label': t('refresh'),
            onClick: loadSessions,
            disabled: loading,
          }, h(IconRefreshOutlineRegular, { size: 16 })),
        ),
        notice !== null ? h('div', { className: 'dshBridge_notice', 'data-error': noticeError ? 'true' : undefined }, notice) : null,
        streamState === 'disconnected' ? h('div', { className: 'dshBridge_notice' }, t('eventsDisconnected')) : null,
        h(
          'div',
          { className: 'dshBridge_body', ref: bodyRef },
          widthHandles,
          h(
            'div',
            { className: 'dshBridge_centre' },
            h(
              'div',
              { className: 'dshBridge_scroll', ref: scrollRef, onScroll },
              selectedKey === null
                ? bridge === null || bridge.available === false
                  // Nothing usable to start a session on: keep dsh's plain notice.
                  ? h('div', { className: 'dshBridge_blank' },
                      h('div', { className: 'dshBridge_blankTitle' },
                        bridge === null ? t('bridgeMenu') : `${bridge.name} · ${t('bridgeUnavailable')}`),
                      h('div', { className: 'dshBridge_blankHint' },
                        bridge === null
                          ? t('bridgeSettingsHint')
                          : (bridge.unavailableReason ?? t('bridgeUnavailableHint'))))
                  // New Session: the shipped hero, its workspace chip, and the
                  // composer share one centred column above the fold.
                  : h('div', { className: 'dshBridge_hero' },
                      h('div', { className: 'dshBridge_heroStack' },
                        h('div', { className: 'dshBridge_heroHeadline' },
                          h('span', { className: 'dshBridge_heroFish' }, h(FishLogo, { size: 34 })),
                          h('span', { className: 'dshBridge_heroTitleGroup' },
                            h('span', null, t('heroHeadline')),
                            h('span', { className: 'dshBridge_heroBadge' }, t('heroPreview')))),
                        h('div', { className: 'dshBridge_heroBody' },
                          h('div', { className: 'dshBridge_heroWorkspaceRow' },
                            h(BridgeWorkspaceChip, {
                              workspaces: ui.workspaces ?? [],
                              path: heroWorkspacePath,
                              onPick: (path) => setHeroWorkspacePath(path),
                              onAddWorkspace: () => setHeroDirectoryOpen(true),
                              t,
                            })),
                          h(BridgeComposer, {
                            t,
                            draft,
                            onDraft: setDraft,
                            onSend: heroSend,
                            onAbort: abort,
                            sending: heroSending,
                            attaching: false,
                            isStreaming: false,
                            models,
                            currentModel,
                            modelsLoading,
                            modelsError,
                            modelSwitching,
                            onSelectModel: chooseModel,
                            stats: null,
                            textareaRef,
                            placeholder: heroWorkspacePath === null ? t('heroPlaceholder') : t('heroPlaceholderReady'),
                          }))))
                : detailLoading
                  ? h('div', { className: 'dshBridge_blank' }, t('loading'))
                  : detailError !== null
                    ? h('div', { className: 'dshBridge_blank' }, `${t('historyLoadFailed')}: ${detailError}`)
                    : h(
                        'div',
                        { className: 'dshBridge_column' },
                        h(
                          'div',
                          { className: 'dshBridge_flow' },
                          ...renderTranscriptFlow(transcript, selectedSession?.cwd ?? detail?.cwd ?? null, t, streamingMessage, ui.home),
                          ...echoes.map((echo) => h(UserTurn, {
                            key: echo.id,
                            message: {
                              role: 'user',
                              content: [{ type: 'text', text: echo.text }],
                              timestamp: echo.timestamp,
                            },
                            t,
                          })),
                          isTurnLive ? h(BridgeRunningStatus, { key: 'running', startTime: runStartedAt, t }) : null,
                        ),
                      ),
            ),
            selectedKey !== null && detail !== null && detailError === null
              ? h(
                  'div',
                  { className: 'dshBridge_composerSeat' },
                  h(BridgeComposer, {
                    t,
                    draft,
                    onDraft: setDraft,
                    onSend: send,
                    onAbort: abort,
                    sending,
                    attaching,
                    isStreaming,
                    models,
                    currentModel,
                    modelsLoading,
                    modelsError,
                    modelSwitching,
                    onSelectModel: chooseModel,
                    stats: statusStats,
                    textareaRef,
                  }),
                )
              : null,
          ),
        ),
        h(BridgeDirectoryDialog, {
          open: heroDirectoryOpen,
          t,
          onClose: () => setHeroDirectoryOpen(false),
          onPick: async (path) => {
            // Adding from the hero selects it at once: the reader's next Enter
            // should land there, not in a workspace they still have to pick.
            await addWorkspaceToBridge(bridge?.id ?? null, path)
            setHeroWorkspacePath(path)
            setHeroDirectoryOpen(false)
          },
        }),
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
    exports.__test = {
      textOf,
      formatTime,
      formatBytes,
      safeJson,
      workspaceLabel,
      owningParentFolder,
      compareSessionsByUpdated,
      reconcileSessionOrder,
      pathCrumbs,
      relativeTime,
      compactTokens,
      exactTokens,
      normalizeBridgeStats,
      deriveBridgeStats,
      bridgeCacheHitPercent,
      normalizeModelCatalog,
      modelIdOf,
      statsVisible,
      readContentWidthPreference,
      resolveContentWidth,
      bridgeToolVariant,
      deriveToolSummary,
      formatRunDuration,
      dropEchoFor,
      abbreviateHomePath,
      toolDiffTotals,
      assistantParts,
    }
    return module.exports
  },
})
