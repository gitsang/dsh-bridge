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
      HoverCard,
      IconApiOutlineRegular,
      IconArchiveOutlineRegular,
      IconArchiveOffOutlineRegular,
      IconArchiveCheckOutlineRegular,
      IconCheckOutlineRegular,
      IconChevronDownOutlineRegular,
      IconChevronRightOutlineRegular,
      IconChevronsUpDownOutlineRegular,
      IconClockOutlineRegular,
      IconCloseFillRegular,
      IconCodeOutlineRegular,
      IconEditOutlineRegular,
      IconEllipsisOutlineRegular,
      IconFlatListOutlineRegular,
      IconFolderCloseRegular,
      IconFolderOpenRegular,
      IconPauseOutlineRegular,
      IconPlusOutlineRegular,
      IconProjectAddOutlineRegular,
      IconQueueOutlineRegular,
      IconRefreshOutlineRegular,
      IconSearchOutlineRegular,
      IconSendOutlineRegular,
      IconSettingsOutlineRegular,
      IconSlidersTwoOutlineRegular,
      IconTrashOutlineRegular,
      IconTriangleRightFillRegular,
      IconWorkspaceTreeOutlineRegular,
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
        searchExpanded: false,
        groupBy: 'workspace',
        orderBy: 'updated',
        archivedFilter: 'default',
        groupExpansion: {},
        sessionOrderByAccount: {},
        archivedKeys: [],
        extraWorkspaces: [],
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
          archivedKeys: state.archivedKeys,
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

    function useBridgeUi() {
      const [state, setState] = useState(bridgeUi.state)
      useEffect(() => bridgeUi.subscribe(() => setState(bridgeUi.state)), [])
      return state
    }

    const WORKSPACE_VIEW_STORAGE = 'dsh.bridge.workspace.view.v1'
    const FLAT_ORDER_KEY = '__flat_session_order__'
    const SEARCH_SLIDE_MS = 300

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
          archivedKeys: Array.isArray(stored.archivedKeys) ? stored.archivedKeys.filter((key) => typeof key === 'string') : [],
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

    function BridgeWorkspaceRow({ group, expanded, active, onToggle, t }) {
      const label = group.workspaceId === undefined ? t('groupUngrouped') : group.label
      return h(
        HoverCard,
        {
          openDelayMs: 800,
          copyText: group.cwd ?? undefined,
          copyLabel: t('copy'),
          copiedLabel: t('hoverCopied'),
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
              className: 'dshBridge_row_projectRow',
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
          ),
        },
      )
    }

    function BridgeSessionRow({ session, selected, archived, now, drag, onOpen, onArchive, onDragStart, onDragEnd, onDragOver, onDrop, t }) {
      const [menuOpen, setMenuOpen] = useState(false)
      const title = session.name || session.firstMessage || t('untitled')
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
        h('span', { className: 'dshBridge_row_slot' }),
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
      `.dshBridge_browser_root{--dsh-session-list-edge-inset:var(--dsh-sidebar-inline-padding);--dsh-session-list-scrollbar-width:5px;--dsh-session-list-scrollbar-offset:2px;box-sizing:border-box;min-height:0;padding-right:var(--dsh-session-list-edge-inset);flex-direction:column;flex:1;display:flex}.dshBridge_browser_root.dshBridge_browser_rail{padding-right:0}.dshBridge_browser_iconButton{border-radius:var(--dsw-radius-sm);cursor:pointer;width:28px;height:28px;color:var(--dsw-alias-label-secondary);background:0 0;border:none;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex}.dshBridge_browser_iconButton:focus-visible,.dshBridge_browser_searchButton:focus-visible,.dshBridge_browser_clearButton:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}.dshBridge_browser_iconButton:hover{background:var(--dsw-alias-interactive-bg-hover)}.dshBridge_browser_viewOptionsMenu{min-width:200px}.dshBridge_browser_sectionHeader{box-sizing:border-box;border-radius:var(--dsw-radius-md);height:36px;color:var(--dsw-alias-label-tertiary);flex:none;justify-content:flex-end;align-items:center;gap:4px;margin-bottom:4px;padding-left:4px;display:flex;overflow:hidden}.dshBridge_browser_root:not(.dshBridge_browser_rail) .dshBridge_browser_sectionHeader{margin-top:2px;margin-right:-4px}.dshBridge_browser_sectionLabel{white-space:nowrap;opacity:1;visibility:visible;min-width:0;max-width:45%;transition:max-width .18s var(--ds-ease-in-out),margin-right .18s var(--ds-ease-in-out),opacity .12s var(--ds-ease-in-out),transform .18s var(--ds-ease-in-out),visibility 0s linear;flex:none;line-height:20px;overflow:hidden}.dshBridge_browser_sectionLabelHidden{opacity:0;visibility:hidden;max-width:0;margin-right:-4px;transition-delay:0s,0s,0s,0s,.18s;transform:translate(-4px)}.dshBridge_browser_searchSlot{box-sizing:border-box;min-width:0;max-width:28px;transition:max-width .18s var(--ds-ease-in-out),padding-left .18s var(--ds-ease-in-out);flex:1;align-items:center;margin-left:auto;padding-left:0;display:flex}.dshBridge_browser_searchSlotExpanded{max-width:100%;padding-left:0}.dshBridge_browser_headerActions{opacity:1;visibility:visible;max-width:60px;transition:max-width .18s var(--ds-ease-in-out),opacity .12s var(--ds-ease-in-out),transform .18s var(--ds-ease-in-out),visibility 0s linear;flex:none;align-items:center;gap:4px;display:flex;overflow:hidden}.dshBridge_browser_headerActionsHidden{opacity:0;visibility:hidden;pointer-events:none;max-width:0;transition-delay:0s,0s,0s,.18s;transform:translate(4px)}.dshBridge_browser_search{box-sizing:border-box;border-radius:var(--dsw-radius-sm);cursor:text;width:100%;height:28px;color:var(--dsw-alias-label-secondary);transition:width .18s var(--ds-ease-in-out),padding .18s var(--ds-ease-in-out),border-color .18s var(--ds-ease-in-out),background-color .18s var(--ds-ease-in-out);background:0 0;border:none;flex:none;align-items:center;gap:0;margin:0;padding:0;display:flex;overflow:hidden}.dshBridge_browser_searchExpanded{border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);width:calc(100% + 4px);height:30px;color:var(--dsw-alias-label-caption);background:0 0;margin-inline:-2px;padding:0 4px 0 0}.dshBridge_browser_searchButton{border-radius:var(--dsw-radius-sm);cursor:pointer;width:28px;height:28px;color:inherit;background:0 0;border:none;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex}.dshBridge_browser_searchExpanded .dshBridge_browser_searchButton{width:28px;height:30px}.dshBridge_browser_searchButton:hover{background:var(--dsw-alias-interactive-bg-hover)}.dshBridge_browser_searchExpanded .dshBridge_browser_searchButton:hover{background:0 0}.dshBridge_browser_searchInput{opacity:0;pointer-events:none;width:0;min-width:0;color:var(--dsw-alias-label-primary);transition:opacity .12s var(--ds-ease-in-out);background:0 0;border:none;outline:none;flex:1;font-size:13px;line-height:18px}.dshBridge_browser_searchExpanded .dshBridge_browser_searchInput{opacity:1;pointer-events:auto;margin-left:-2px}.dshBridge_browser_searchInput::placeholder{color:var(--dsw-alias-label-tertiary)}.dshBridge_browser_clearButton{border-radius:var(--dsw-radius-sm);cursor:pointer;width:24px;height:24px;color:var(--dsw-alias-label-secondary);background:0 0;border:none;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex}.dshBridge_browser_clearButton:hover{background:var(--dsw-alias-interactive-bg-hover)}.dshBridge_browser_rail .dshBridge_browser_sectionHeader{justify-content:flex-start;gap:0;margin-bottom:12px;padding-left:0}.dshBridge_browser_rail .dshBridge_browser_headerActions{max-width:none}.dshBridge_browser_rail .dshBridge_browser_iconButton{border-radius:var(--dsw-radius-md);width:36px;height:36px;color:var(--dsw-alias-label-primary)}.dshBridge_browser_rail .dshBridge_browser_search{border-radius:var(--dsw-radius-md);background:0 0;border-color:#0000;gap:0;width:36px;height:36px;margin:0 0 12px;padding:0}.dshBridge_browser_rail .dshBridge_browser_searchButton{border-radius:var(--dsw-radius-md);width:36px;height:36px;color:var(--dsw-alias-label-primary)}.dshBridge_browser_rail .dshBridge_browser_searchButton:hover{background:var(--dsw-alias-interactive-bg-hover)}.dshBridge_browser_listArea{min-height:0;margin-left:-4px;margin-right:calc(-1 * var(--dsh-session-list-edge-inset));flex-direction:column;flex:1;padding-left:4px;display:flex;overflow:visible}.dshBridge_browser_rail .dshBridge_browser_listArea{margin-left:0;margin-right:0;padding-left:0}.dshBridge_browser_treeBody{flex-direction:column;flex:1;min-height:0;display:flex;position:relative}.dshBridge_browser_fade{left:0;right:var(--dsh-session-list-edge-inset);background:linear-gradient(to bottom,transparent,var(--dsw-specific-sidebar-fill));pointer-events:none;height:24px;position:absolute;bottom:0}[data-platform=darwin] .dshBridge_browser_fade{display:none}.dshBridge_browser_wide{animation:dshBridge_browser_wide-in .2s var(--ds-ease-in-out)}@keyframes dshBridge_browser_wide-in{0%{opacity:0}}.dshBridge_browser_list{min-height:0;margin-left:-4px;margin-right:var(--dsh-session-list-scrollbar-offset);padding-left:4px;padding-right:calc(var(--dsh-session-list-edge-inset) - var(--dsh-session-list-scrollbar-width) - var(--dsh-session-list-scrollbar-offset));scrollbar-gutter:stable;flex:1;padding-bottom:16px;overflow-y:auto}.dshBridge_browser_flatList>*+*,.dshBridge_browser_searchTree>[role=treeitem]+[role=treeitem],.dshBridge_browser_groupSection>*+*{margin-top:2px}.dshBridge_browser_searchStatus{color:var(--dsw-alias-label-tertiary);padding:10px 12px;font-size:12px;line-height:18px}.dshBridge_browser_groupSection{position:relative}.dshBridge_browser_groupSection+.dshBridge_browser_groupSection{margin-top:4px}.dshBridge_browser_listTopDropIndicator,.dshBridge_browser_workspaceDropBefore:before,.dshBridge_browser_workspaceDropAfter:after{content:"";z-index:1;background:linear-gradient(55deg,transparent calc(50% - 1px),var(--dsw-alias-state-business-primary) calc(50% - 1px) calc(50% + 1px),transparent calc(50% + 1px)) 0 0 / 5px 7px no-repeat,linear-gradient(125deg,transparent calc(50% - 1px),var(--dsw-alias-state-business-primary) calc(50% - 1px) calc(50% + 1px),transparent calc(50% + 1px)) 0 5px / 5px 7px no-repeat,linear-gradient(var(--dsw-alias-state-business-primary) 0 0) 4px 5px / calc(100% - 4px) 2px no-repeat;pointer-events:none;height:12px;position:absolute;left:0;right:0}.dshBridge_browser_listTopDropIndicator{top:-8px;left:0;right:var(--dsh-session-list-edge-inset)}.dshBridge_browser_listTopDropActive>.dshBridge_browser_workspaceDropBefore:first-child:before{display:none}.dshBridge_browser_workspaceDropBefore:before{top:-8px}.dshBridge_browser_workspaceDropAfter:after{bottom:-8px}.dshBridge_browser_sessionOverflowButton{border-radius:var(--dsw-radius-sm);width:100%;height:28px;padding:0 12px 0 calc(28px + var(--dsh-workspace-indent,0px));cursor:pointer;text-align:left;color:var(--dsw-alias-label-tertiary);background:0 0;border:none;font-size:12px}.dshBridge_browser_groupSection>.dshBridge_browser_sessionOverflowButton{margin-top:0}.dshBridge_browser_sessionOverflowButton:hover{color:var(--dsw-alias-label-secondary);background:0 0}.dshBridge_browser_empty{color:var(--dsw-alias-label-tertiary);padding:16px 12px;font-size:13px}.dshBridge_browser_emptyState{color:var(--dsw-alias-label-tertiary);flex-direction:column;align-items:center;gap:8px;margin-top:80px;padding:0 12px;font-size:13px;line-height:20px;display:flex}.dshBridge_browser_emptyState>svg{color:var(--dsw-alias-label-caption);margin-bottom:4px}.dshBridge_browser_emptyAction{cursor:pointer;color:var(--dsw-alias-link);background:0 0;border:none;padding:0;font-size:13px;line-height:20px}.dshBridge_browser_renameInput{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-lg);width:100%;height:44px;color:var(--dsw-alias-label-primary);background:0 0;outline:none;padding:7px 14px;font-size:14px;font-weight:400;line-height:22px}.dshBridge_browser_renameInput:disabled{color:var(--dsw-alias-label-dimmed)}.dshBridge_browser_renameError{color:var(--dsw-alias-state-error-primary);margin-top:8px;font-size:12px;line-height:18px}.dshBridge_browser_deleteAction:not(:disabled){color:var(--dsw-alias-state-error-primary)}.dshBridge_browser_deleteStatus{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}@media (prefers-reduced-motion:reduce){.dshBridge_browser_wide{animation:none}.dshBridge_browser_search,.dshBridge_browser_sectionLabel,.dshBridge_browser_searchSlot,.dshBridge_browser_searchInput,.dshBridge_browser_headerActions{transition:none}}`,
      `.dshBridge_row_projectRow,.dshBridge_row_sessionRow{border-radius:var(--dsw-radius-md);padding:0 8px;cursor:pointer;user-select:none;color:var(--dsw-alias-label-primary);align-items:center;gap:6px;padding-inline-start:calc(8px + var(--dsh-workspace-indent,0px));display:flex}.dshBridge_row_projectRow:hover,.dshBridge_row_sessionRow:hover,.dshBridge_row_sessionRow.dshBridge_row_selected{background:var(--dsw-alias-interactive-bg-hover)}.dshBridge_row_searchResultRow{box-sizing:border-box;border-radius:var(--dsw-radius-lg);cursor:pointer;text-align:left;width:100%;min-height:48px;color:var(--dsw-alias-label-primary);background:0 0;border:none;flex-direction:column;align-items:stretch;padding:4px 8px;display:flex}.dshBridge_row_searchResultRow:hover,.dshBridge_row_searchResultRow.dshBridge_row_selected{background:var(--dsw-alias-interactive-bg-hover)}.dshBridge_row_searchResultHeading{align-items:center;min-width:0;display:flex}.dshBridge_row_searchResultTitle{text-overflow:ellipsis;white-space:nowrap;flex:0 auto;min-width:0;margin-left:4px;font-size:14px;line-height:20px;overflow:hidden}.dshBridge_row_searchResultMeta{align-items:center;gap:6px;min-width:0;margin-left:20px;display:flex}.dshBridge_row_searchResultWorkspace,.dshBridge_row_searchResultSnippet{text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:17px;overflow:hidden}.dshBridge_row_searchResultWorkspace{max-width:40%;color:var(--dsw-alias-label-tertiary);flex:none}.dshBridge_row_searchResultWorkspace:only-child{max-width:100%}.dshBridge_row_searchResultSnippet{min-width:0;color:var(--dsw-alias-label-secondary);flex:1}.dshBridge_row_projectRow{box-sizing:border-box;align-items:center;height:34px}.dshBridge_row_projectRow .dshBridge_row_rowActions{height:20px}.dshBridge_row_sessionRow{gap:0;height:32px}.dshBridge_row_sessionRow .dshBridge_row_title{margin:0 6px 0 4px}.dshBridge_row_slot{width:16px;height:20px;color:var(--dsw-alias-label-tertiary);flex:none;justify-content:center;align-items:center;display:inline-flex}.dshBridge_row_visuallyHidden{clip:rect(0 0 0 0);white-space:nowrap;width:1px;height:1px;position:absolute;overflow:hidden}.dshBridge_row_folderActive{color:var(--dsw-alias-state-business-primary)}.dshBridge_row_projectRow .dshBridge_row_chevron{display:none}.dshBridge_row_projectRow:hover .dshBridge_row_chevron{display:inline-flex}.dshBridge_row_projectRow:hover .dshBridge_row_folder{display:none}.dshBridge_row_arrow{transition:transform .15s var(--ds-ease-in-out)}.dshBridge_row_arrowOpen{transform:rotate(90deg)}.dshBridge_row_projectText{flex-direction:column;flex:1;gap:2px;min-width:0;display:flex}.dshBridge_row_title{text-overflow:ellipsis;white-space:nowrap;min-width:0;font-size:14px;line-height:20px;overflow:hidden}.dshBridge_row_renameInput{border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-button-elevated-fill);min-width:0;color:inherit;outline:none;padding:0 2px;font-size:14px;line-height:20px}.dshBridge_row_sessionRow .dshBridge_row_title{flex:1}.dshBridge_row_meta{text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px;overflow:hidden}.dshBridge_row_time{color:var(--dsw-alias-label-tertiary);flex:none;font-size:10px;line-height:16px}.dshBridge_row_pinIndicator{width:16px;height:20px;color:var(--dsw-alias-label-caption);flex:none;justify-content:center;align-items:center;margin-left:6px;display:inline-flex}.dshBridge_row_sessionRow.dshBridge_row_archived .dshBridge_row_title,.dshBridge_row_searchResultRow.dshBridge_row_archived .dshBridge_row_searchResultTitle,.dshBridge_row_searchResultRow.dshBridge_row_archived .dshBridge_row_searchResultWorkspace,.dshBridge_row_searchResultRow.dshBridge_row_archived .dshBridge_row_searchResultSnippet{color:var(--dsw-alias-label-caption)}.dshBridge_row_dot{flex:none}.dshBridge_row_rowActions{flex:none;align-items:center;gap:10px;display:none}.dshBridge_row_projectRow:hover .dshBridge_row_rowActions,.dshBridge_row_sessionRow:hover .dshBridge_row_rowActions,.dshBridge_row_searchResultRow:hover .dshBridge_row_rowActions,.dshBridge_row_projectRow.dshBridge_row_menuOpen .dshBridge_row_rowActions,.dshBridge_row_sessionRow.dshBridge_row_menuOpen .dshBridge_row_rowActions{display:inline-flex}.dshBridge_row_searchResultHeading .dshBridge_row_rowActions{margin-left:auto}.dshBridge_row_sessionRow:hover .dshBridge_row_time,.dshBridge_row_sessionRow.dshBridge_row_menuOpen .dshBridge_row_time,.dshBridge_row_sessionRow:hover .dshBridge_row_pinIndicator,.dshBridge_row_sessionRow.dshBridge_row_menuOpen .dshBridge_row_pinIndicator{display:none}@media (hover:hover){.dshBridge_row_sessionRow:hover .dshBridge_row_title,.dshBridge_row_sessionRow.dshBridge_row_menuOpen .dshBridge_row_title{text-overflow:clip}}.dshBridge_row_projectRow.dshBridge_row_menuOpen,.dshBridge_row_sessionRow.dshBridge_row_menuOpen{background:var(--dsw-alias-interactive-bg-hover)}.dshBridge_row_sessionRow.dshBridge_row_dropBefore,.dshBridge_row_sessionRow.dshBridge_row_dropAfter{position:relative}.dshBridge_row_sessionRow.dshBridge_row_dropBefore:before,.dshBridge_row_sessionRow.dshBridge_row_dropAfter:after{content:"";z-index:1;background:linear-gradient(55deg,transparent calc(50% - 1px),var(--dsw-alias-state-business-primary) calc(50% - 1px) calc(50% + 1px),transparent calc(50% + 1px)) 0 0 / 5px 7px no-repeat,linear-gradient(125deg,transparent calc(50% - 1px),var(--dsw-alias-state-business-primary) calc(50% - 1px) calc(50% + 1px),transparent calc(50% + 1px)) 0 5px / 5px 7px no-repeat,linear-gradient(var(--dsw-alias-state-business-primary) 0 0) 4px 5px / calc(100% - 4px) 2px no-repeat;pointer-events:none;height:12px;position:absolute;left:0;right:4px}.dshBridge_row_sessionRow.dshBridge_row_dropBefore:before{top:-7px}.dshBridge_row_sessionRow.dshBridge_row_dropAfter:after{bottom:-7px}.dshBridge_row_hoverContent{flex-direction:column;gap:8px;display:flex}.dshBridge_row_hoverTitle{color:#fff;overflow-wrap:break-word;font-size:14px;line-height:20px}.dshBridge_row_hoverPath{color:#cfd3d6;word-break:break-all;font-size:12px;line-height:16px}.dshBridge_row_hoverTime{color:#cfd3d6;font-size:12px;line-height:16px}.dshBridge_row_hoverStatus{color:#adb2b8;align-items:center;gap:8px;font-size:12px;line-height:20px;display:flex}.dshBridge_row_iconButton{border-radius:var(--dsw-radius-xs);cursor:pointer;width:16px;height:16px;color:var(--dsw-alias-label-tertiary);background:0 0;border:none;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex}.dshBridge_row_iconButton:hover{color:var(--dsw-alias-label-primary)}.dshBridge_row_chevron{color:var(--dsw-alias-label-caption)}@media (prefers-reduced-motion:reduce){.dshBridge_row_arrow{transition:none;animation:none}}`,
      `.dshBridge_dir_dialog.dshBridge_dir_dialog{--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);gap:0;width:min(680px,100%);height:min(500px,100dvh - 32px);padding:0}.dshBridge_dir_editorScope{display:contents}.dshBridge_dir_header{border-bottom:.5px solid var(--dsw-alias-border-l3);flex-direction:column;flex:none;gap:8px;padding:16px 14px 8px 24px;display:flex}.dshBridge_dir_title{min-height:28px;color:var(--dsw-alias-label-primary);align-items:flex-end;margin:0;font-size:16px;font-weight:510;line-height:24px;display:flex}.dshBridge_dir_crumbBar{box-sizing:border-box;border-radius:var(--dsw-radius-sm);border:1px solid #0000;align-items:center;gap:4px;min-height:24px;margin-left:-9px;padding:0 8px;display:flex}.dshBridge_dir_crumbBar:has(.dshBridge_dir_crumbEditZone:enabled:hover),.dshBridge_dir_crumbBar:has(.dshBridge_dir_crumbEditZone:focus-visible),.dshBridge_dir_crumbBar:has(.dshBridge_dir_pathInput){border-color:var(--dsw-alias-border-l2)}.dshBridge_dir_millerRow{scrollbar-width:none;flex:1 1 0;align-items:stretch;gap:12px;min-height:0;display:flex;overflow-x:auto}.dshBridge_dir_crumbTrail{scrollbar-width:none;flex:0 auto;align-items:center;gap:4px;min-width:0;display:flex;overflow-x:auto}.dshBridge_dir_crumbSeat{flex:none;align-items:center;gap:4px;min-width:0;display:inline-flex}.dshBridge_dir_crumb{text-overflow:ellipsis;white-space:nowrap;max-width:160px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;padding:0;font-size:13px;font-weight:500;line-height:20px;overflow:hidden}.dshBridge_dir_crumb:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}.dshBridge_dir_crumb:hover{color:var(--dsw-alias-label-primary)}.dshBridge_dir_crumbChevron{color:var(--dsw-alias-label-tertiary);flex:none}.dshBridge_dir_crumbEditZone{cursor:text;background:0 0;border:none;outline:none;flex:1 0 34px;justify-content:flex-end;align-items:center;min-width:34px;height:22px;padding:0;display:flex}.dshBridge_dir_crumbEditGlyph{color:var(--dsw-alias-label-tertiary);flex:none}.dshBridge_dir_crumbEditZone:enabled:hover .dshBridge_dir_crumbEditGlyph,.dshBridge_dir_crumbEditZone:focus-visible .dshBridge_dir_crumbEditGlyph{color:var(--dsw-alias-label-primary)}.dshBridge_dir_crumbEditZone:disabled{cursor:default}.dshBridge_dir_crumbEditZone:disabled .dshBridge_dir_crumbEditGlyph{color:var(--dsw-alias-label-caption)}.dshBridge_dir_pathInput{box-sizing:border-box;min-width:0;height:22px;color:var(--dsw-alias-label-primary);background:0 0;border:none;outline:none;flex:1 1 0;padding:0;font-size:13px;line-height:20px}.dshBridge_dir_content{flex-direction:column;flex:1 1 0;min-height:0;padding:16px 16px 16px 24px;display:flex;position:relative}.dshBridge_dir_column{flex-direction:column;flex:1 1 0;gap:2px;min-width:256px;padding-right:8px;display:flex;overflow-y:auto}.dshBridge_dir_divider{background:var(--dsw-alias-border-l3);flex:none;width:.5px}.dshBridge_dir_rowSeat{flex:none;display:flex}.dshBridge_dir_row{border-radius:var(--dsw-radius-sm);text-align:left;cursor:pointer;background:0 0;border:none;flex:none;align-items:center;gap:4px;width:100%;height:28px;padding:4px;display:flex}.dshBridge_dir_row:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}.dshBridge_dir_row:hover{background:var(--dsw-alias-interactive-bg-hover)}.dshBridge_dir_rowSelected,.dshBridge_dir_rowSelected:hover{background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-interactive-bg-hover))}.dshBridge_dir_rowIcon{color:var(--dsw-alias-label-secondary);flex:none}.dshBridge_dir_rowIconSelected{color:var(--dsw-alias-button-info-fill);flex:none}.dshBridge_dir_rowName{text-overflow:ellipsis;white-space:nowrap;min-width:0;color:var(--dsw-alias-label-primary);flex:1 1 0;font-size:13px;font-weight:500;line-height:20px;overflow:hidden}.dshBridge_dir_rowChevron{color:var(--dsw-alias-label-tertiary);flex:none}.dshBridge_dir_status,.dshBridge_dir_error{padding:4px 120px 4px 4px;font-size:12px;line-height:18px}.dshBridge_dir_status{color:var(--dsw-alias-label-secondary)}.dshBridge_dir_error{color:var(--dsw-alias-state-error-primary)}.dshBridge_dir_loadingFloat{background:var(--dsw-alias-bg-layer-2);padding:2px 8px;position:absolute;bottom:8px;right:16px}.dshBridge_dir_footerBar{border-top:.5px solid var(--dsw-alias-border-l3);flex-wrap:wrap;flex:none;align-items:center;gap:8px;padding:16px 24px;display:flex}.dshBridge_dir_showHiddenToggle{color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;background:0 0;border:none;align-items:center;gap:4px;padding:0;font-size:13px;font-weight:500;line-height:20px;display:inline-flex}.dshBridge_dir_showHiddenToggle:hover{color:var(--dsw-alias-label-primary)}.dshBridge_dir_showHiddenToggle:disabled{color:var(--dsw-alias-label-caption);cursor:default}.dshBridge_dir_showHiddenToggleActive{color:var(--dsw-alias-label-primary)}.dshBridge_dir_footerGap{flex:1 1 0}.dshBridge_dir_footerAction{min-width:72px}.dshBridge_dir_createDialog.dshBridge_dir_createDialog{gap:0;width:min(380px,100%);padding:0}.dshBridge_dir_createBody{flex-direction:column;gap:12px;padding:22px 24px 20px;display:flex}.dshBridge_dir_createTitle{color:var(--dsw-alias-label-primary);margin:0;font-size:16px;font-weight:510;line-height:24px}.dshBridge_dir_createIn{color:var(--dsw-alias-label-primary);margin:0;font-size:14px;line-height:22px}.dshBridge_dir_createInput{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-lg);width:100%;height:44px;color:var(--dsw-alias-label-primary);background:0 0;outline:none;padding:7px 14px;font-size:14px;line-height:22px}.dshBridge_dir_createInput::placeholder{color:var(--dsw-alias-label-caption)}.dshBridge_dir_createActions{justify-content:flex-end;align-items:center;gap:8px;margin-top:8px;display:flex}`,
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
      const searchRoot = useRef(null)
      const searchInput = useRef(null)
      const [directoryOpen, setDirectoryOpen] = useState(false)
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

      const workspaceEntities = useMemo(() => {
        const byPath = new Map()
        const add = (workspace) => {
          const path = workspace.path ?? workspace.id ?? ''
          if (path === '' || byPath.has(path)) return
          byPath.set(path, {
            key: path,
            workspaceId: path,
            path,
            name: workspaceLabel(path),
            label: workspaceLabel(path),
            createdAt: workspace.createdAt,
          })
        }
        for (const workspace of ui.workspaces) add(workspace)
        for (const workspace of ui.extraWorkspaces) add(workspace)
        for (const session of ui.sessions) {
          if (typeof session.cwd === 'string' && session.cwd !== '') add({ path: session.cwd, name: workspaceLabel(session.cwd) })
        }
        return [...byPath.values()]
      }, [ui.sessions, ui.workspaces, ui.extraWorkspaces])

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

      const updateArchived = (sessionKey, shouldArchive) => {
        const next = shouldArchive
          ? [...ui.archivedKeys.filter((key) => key !== sessionKey), sessionKey]
          : ui.archivedKeys.filter((key) => key !== sessionKey)
        bridgeUi.setView({ archivedKeys: next })
      }

      const addWorkspace = (path) => {
        const exists = ui.extraWorkspaces.some((workspace) => workspace.path === path)
        const next = exists ? ui.extraWorkspaces : [...ui.extraWorkspaces, { path, name: workspaceLabel(path) }]
        bridgeUi.setView({ extraWorkspaces: next })
        setDirectoryOpen(false)
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('bridge:notice', { detail: { text: t('workspaceAdded') } }))
        }
      }

      const renderSession = (session, accountKey) => {
        const compatible = drag !== null && drag.accountKey === accountKey
        return h(BridgeSessionRow, {
          key: session.key,
          session,
          selected: session.key === ui.selectedKey,
          archived: archived.has(session.key),
          now,
          t,
          onOpen: (key) => bridgeUi.selectSession(key),
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
        ui.archivedFilter === 'only' ? h(IconArchiveOutlineRegular, { size: 24 }) : h(IconQueueOutlineRegular, { size: 24 }),
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
          : null,
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
          ),
          h(BridgeDirectoryDialog, {
            open: directoryOpen,
            t,
            onClose: () => setDirectoryOpen(false),
            onPick: addWorkspace,
          }),
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
          ),
        ),
        h('div', { className: 'dshBridge_browser_listArea' }, body),
        h(BridgeDirectoryDialog, {
          open: directoryOpen,
          t,
          onClose: () => setDirectoryOpen(false),
          onPick: addWorkspace,
        }),
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
        bridgeUi.hydrateView(bridgeId)
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
    }
    return module.exports
  },
})
