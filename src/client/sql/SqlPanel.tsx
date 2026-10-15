/**
 * The SQL sidebar panel: the structure of the database the reader's SQL notebook is on.
 *
 * Which notebook it describes is the *active* `.sqlnb` tab, falling back to the last one still
 * open. A connection belongs to a notebook (ADR 0002), so a panel that described "the connection of
 * this workspace" would be describing something the Host does not have. When no notebook is open it
 * says so instead of guessing.
 *
 * The split this panel lives inside is ADR 0008's: **connecting** belongs to the notebook's own
 * toolbar, **browsing** belongs here. The panel therefore holds no picker, no tier, no connect or
 * disconnect button and no connection readout — not because those facts are unimportant, but
 * because a second copy of a control is a second place the same rule has to be written, and a
 * reader facing two identical database dropdowns cannot tell which one is authoritative. What stays
 * here is the one thing the notebook cannot offer comfortably: the table tree, and the gestures
 * that write out of it into the notebook.
 *
 * The tree is the same shape as `FileTree`: a recursive list of nodes with a depth-based indent
 * and a lazy read on first expand. A database's nodes are tables and views; a table's nodes are
 * categories (字段 / 索引 / 外键 / 触发器); a 字段 node's nodes are columns. The four-level
 * shape is the standard one in DataGrip / DBeaver / TablePlus, and the "every field is a node"
 * rule is what file-management panels already follow here.
 *
 * Multiple open notebooks: the panel lists every open `.sqlnb` (ADR 0002 — a connection is keyed
 * by the notebook, so a workspace can hold several), with the active one expanded into the
 * four-level tree underneath. Picking a different row switches the active tab through the
 * controller, which is the same action the tab strip already exposes; the list is a navigation
 * aid, not a second tab strip.
 *
 * It is still not a second editor: no draft, no result, no run state of its own. It binds the
 * runtime and replays the file's connection record because the tree needs a live handle to describe
 * — and the editor may be showing a `.ts` file right now, which is exactly when nothing else on
 * screen would have connected.
 *
 * Two groups inside the panel body:
 *   1. **Open** — every `.sqlnb` the workbench has open, with the active one expanded into the
 *      four-level tree underneath. A click on a row switches the active tab through the
 *      controller (the same action the tab strip already exposes); the list is a navigation
 *      aid, not a second tab strip.
 *   2. **Workspace** — every `.sqlnb` the workspace scan found, addressed by workspace-relative
 *      path. A click on a row calls `controller.openFile`, the same seam the file tree uses,
 *      so a notebook that the scan found opens the same way as one the reader picked from
 *      the tree. Rows already in the top group are dimmed rather than hidden so a click on
 *      them is a no-op instead of a surprise duplicate tab.
 *
 * The two groups render in a single `body` with a fixed vertical gap, so a reader sees one
 * panel with two halves — not three different widgets.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkbenchFileTab, WorkbenchState } from '../model/controller.ts'
import type { DirectoryListing } from '../../shared/contracts.ts'
import type { SqlColumnEntry, SqlTablesResult, SqlTreeEntry } from '../../shared/sql-protocol.ts'
import { copyTextToClipboard } from '../core/clipboard.ts'
import type { WorkbenchController } from '../model/controller.ts'
import { messageOf } from '../model/tab-model.ts'
import { useWorkbench } from '../model/use-workbench.ts'
import { isSqlNotebookPath } from './sql-notebook-document.ts'
import { appendSqlCell } from './sql-notebook-document.ts'
import { activeSqlNotebook } from './sql-notebook-tab.ts'
import { quotedSqlIdentifier, selectAllFrom } from './sql-schema-tree.ts'
import { SqlRuntime, type SqlNotebookState } from './sql-runtime.ts'
import { scanSqlNotebooks, type SqlNotebookScan } from './sql-notebook-scan.ts'
import { SqlTableContextMenu, type SqlTableMenuAction, type SqlTableMenuTarget } from './SqlTableContextMenu.tsx'
import {
  SqlTreeNode,
  type SqlSchemaNode,
  type SqlTreeNodeLabels,
} from './sql-tree-node.tsx'
import css from './sql-panel.module.css'

export interface SqlPanelProps {
  controller: WorkbenchController
  /** Workspace the panel reads structure from; the connection itself is keyed by the notebook. */
  workspaceId: string | undefined
  t: TranslateNS<'workbench'>
}

/**
 * Snapshot of every SQL notebook tab the workbench has open, plus a single force-render key
 * bumped by any per-tab subscription. The hook does not own binding — that lives on the
 * `useEffect` below — it only keeps the panels and rows in sync with the runtimes that are
 * already up.
 *
 * A tab that has not been bound yet (the surface mounted before its binding effect ran) reads as
 * `null`; the panel renders that as "未连接" so the row never claims a connection that has not
 * landed.
 */
function useNotebookStates(
  runtime: SqlRuntime,
  tabs: ReadonlyArray<WorkbenchFileTab>,
): ReadonlyMap<string, SqlNotebookState | null> {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    const unsubs = tabs.map(tab => runtime.subscribe(tab.id, () => { setVersion(value => value + 1) }))
    return () => { for (const unsub of unsubs) unsub() }
  }, [runtime, tabs])
  return useMemo(() => {
    void version
    const map = new Map<string, SqlNotebookState | null>()
    for (const tab of tabs) map.set(tab.id, runtime.peek(tab.id))
    return map
  }, [runtime, tabs, version])
}

/**
 * One row in the notebook list. The row is the disclosure target for that tab's tree, so a
 * click on the row does two things at once: it switches the active tab (so the workbench tab
 * strip agrees) and it expands the four-level tree beneath it. The component keeps the two
 * concerns separate at the JSX level: `onActivate` is the tab switch, the rendering of the
 * tree below it is the parent's responsibility.
 */
interface NotebookRowProps {
  tab: WorkbenchFileTab
  active: boolean
  state: SqlNotebookState | null
  onActivate: (tabId: string) => void
  t: TranslateNS<'workbench'>
}

function NotebookRow({ tab, active, state, onActivate, t }: NotebookRowProps) {
  const className = active ? `${css.notebookRow} ${css.notebookRowActive}` : css.notebookRow
  const labelClass = active ? css.notebookRowLabel : `${css.notebookRowLabel} ${css.notebookRowInactive}`
  const connection = state?.connection ?? null
  const tierLabel = connection === null
    ? null
    : connection.access === 'writable'
      ? t('sqlnotebook.notebookListTierWritable')
      : t('sqlnotebook.notebookListTierReadOnly')
  const tierClass = connection === null
    ? css.notebookRowBadge
    : connection.access === 'writable'
      ? `${css.notebookRowBadge} ${css.notebookRowBadgeWritable}`
      : `${css.notebookRowBadge} ${css.notebookRowBadgeReadOnly}`
  return (
    <button
      type="button"
      className={className}
      aria-current={active ? 'true' : undefined}
      aria-label={tab.path}
      onClick={() => { onActivate(tab.id) }}
    >
      <span className={labelClass}>{tab.path}</span>
      <span className={css.notebookRowBadges}>
        {active && <span className={`${css.notebookRowBadge} ${css.notebookRowBadgeActive}`}>{t('sqlnotebook.notebookListActiveBadge')}</span>}
        {connection !== null && connection.path === ':memory:' && <span className={`${css.notebookRowBadge} ${css.notebookRowBadgeMemory}`}>{t('sqlnotebook.notebookListMemoryBadge')}</span>}
        {connection !== null && tierLabel !== null && <span className={tierClass}>{tierLabel}</span>}
        {connection?.walSidecarExpected === true && <span className={`${css.notebookRowBadge} ${css.notebookRowBadgeWal}`}>{t('sqlnotebook.notebookListWalBadge')}</span>}
      </span>
    </button>
  )
}

/** The SQL notebook tabs in the workbench tab strip, in the order the workbench reports them. */
function sqlNotebooks(state: WorkbenchState): WorkbenchFileTab[] {
  return state.tabs.filter(
    (tab): tab is WorkbenchFileTab => tab.kind === 'file' && isSqlNotebookPath(tab.path),
  )
}

export function SqlPanel({ controller, workspaceId, t }: SqlPanelProps) {
  const state = useWorkbench(controller)
  const activeNotebook = activeSqlNotebook(state)
  const activeTabId = activeNotebook?.id ?? null
  const activePath = activeNotebook?.path ?? null
  const notebooks = useMemo(() => sqlNotebooks(state), [state])
  const notebookStates = useNotebookStates(controller.sqlRuntime, notebooks)
  const activeState = activeTabId === null ? null : notebookStates.get(activeTabId) ?? null
  const connection = activeState?.connection ?? null
  const connectedPath = connection?.path ?? null

  // Bind every SQL notebook the panel can see, not just the active one. ADR 0002 keys a
  // connection by the notebook, so a panel that asked the runtime to track only one tab would
  // see the rest of its rows show "not connected" forever, even when each notebook has its
  // own database file the file system knows about.
  useEffect(() => {
    if (workspaceId === undefined) return
    const runtime = controller.sqlRuntime
    for (const tab of notebooks) {
      runtime.bind(tab.id, workspaceId, tab.path)
      void runtime.autoConnect(tab.id)
    }
  }, [controller, notebooks, workspaceId])

  const subscribe = useCallback(
    (notify: () => void): (() => void) =>
      (activeTabId === null ? () => {} : controller.sqlRuntime.subscribe(activeTabId, notify)),
    [controller, activeTabId],
  )
  const readState = useCallback(
    () => (activeTabId === null ? null : controller.sqlRuntime.peek(activeTabId)),
    [controller, activeTabId],
  )
  const runState = useSyncExternalStore(subscribe, readState)

  const [tables, setTables] = useState<SqlTablesResult | null>(null)
  const [schemaProblem, setSchemaProblem] = useState<string | null>(null)
  const [columns, setColumns] = useState<Record<string, SqlColumnEntry[]>>({})
  const [menuTarget, setMenuTarget] = useState<SqlTableMenuTarget | null>(null)
  const [workspaceScan, setWorkspaceScan] = useState<SqlNotebookScan | null>(null)
  const [scanning, setScanning] = useState(false)
  const lastExecution = useRef('')

  /**
   * Scan the workspace for every `.sqlnb` whenever the panel mounts or the workspace changes.
   *
   * A panel that opened before the user opened any notebook would otherwise show no way to
   * reach the on-disk ones: the "Open" list above is keyed by `tabs`, and a fresh workspace
   * has no tabs. The walk is the same `/tree`-based budgeted walk the file tree uses, so
   * the cost has been measured already; the user re-issues it through the ⟳ button.
   */
  const listDirectory = useCallback(
    (directory: string): Promise<DirectoryListing> => {
      if (workspaceId === undefined) return Promise.reject(new Error('No workspace'))
      return controller.api.listDirectory(workspaceId, directory)
    },
    [controller, workspaceId],
  )
  const wantedScan = useRef(false)
  const rescanWorkspace = useCallback((): void => {
    if (workspaceId === undefined) return
    wantedScan.current = true
    setScanning(true)
    void scanSqlNotebooks({ list: listDirectory }).then(
      (result) => {
        if (!wantedScan.current) return
        setWorkspaceScan(result)
        setScanning(false)
      },
      (error: unknown) => {
        if (!wantedScan.current) return
        setScanning(false)
        setSchemaProblem(messageOf(error))
      },
    )
  }, [listDirectory, workspaceId])
  useEffect(() => {
    wantedScan.current = true
    rescanWorkspace()
    return () => { wantedScan.current = false }
  }, [rescanWorkspace])

  const loadSchema = useCallback((): void => {
    if (workspaceId === undefined || activePath === null) return
    setSchemaProblem(null)
    void controller.api.sqlTables(workspaceId, activePath).then(
      (result) => { setTables(result) },
      (error: unknown) => { setSchemaProblem(messageOf(error)) },
    )
  }, [controller, activePath, workspaceId])

  // Schema is per-active-tab. Resetting when the active tab changes matters because a table
  // list from notebook A is not a table list for notebook B, and a column cache keyed by name
  // would silently mix the two.
  useEffect(() => {
    setTables(null)
    setColumns({})
    setSchemaProblem(null)
    if (connectedPath !== null) loadSchema()
  }, [activeTabId, connectedPath, loadSchema])

  const executed = runState === null
    ? ''
    : Object.entries(runState.cells)
      .map(([id, run]) => `${id}:${run.executionCount ?? '-'}:${run.failure?.code ?? ''}`)
      .join('|')
  useEffect(() => {
    if (executed === lastExecution.current) return
    lastExecution.current = executed
    if (connectedPath !== null) loadSchema()
  }, [connectedPath, executed, loadSchema])

  const handledAction = useRef(0)
  useEffect(() => {
    const request = state.sidebarAction
    if (request === undefined || request.action !== 'sql.refreshSchema') return
    if (handledAction.current === request.id) return
    handledAction.current = request.id
    controller.consumeSidebarAction(request.id)
    if (connectedPath !== null) loadSchema()
  }, [connectedPath, controller, loadSchema, state.sidebarAction])

  /**
   * Read a table's columns once, however often the column category is opened.
   *
   * Mirrors `FileTreeLevel`'s lazy load: the read is keyed by the table's name, and the
   * returned promise is dropped on the floor by the click handler. The "open" half of the
   * disclosure owns the read so a re-render of the panel does not silently trigger one.
   */
  const readColumns = useCallback((name: string): Promise<SqlColumnEntry[]> => {
    const known = columns[name]
    if (known !== undefined) return Promise.resolve(known)
    if (workspaceId === undefined || activePath === null) return Promise.resolve([])
    return controller.api.sqlColumns(workspaceId, activePath, name).then(
      (result) => {
        setColumns(previous => ({ ...previous, [name]: result.columns }))
        return result.columns
      },
      (error: unknown) => {
        setSchemaProblem(messageOf(error))
        throw error
      },
    )
  }, [columns, controller, activePath, workspaceId])

  const insertSql = useCallback((source: string): void => {
    if (activeNotebook === null || activeTabId === null || connection === null) return
    try {
      controller.setDraft(appendSqlCell(activeNotebook.draft, source), 'input', activeTabId)
      setSchemaProblem(null)
    } catch {
      setSchemaProblem(t('sqlnotebook.treeRefused'))
    }
  }, [activeNotebook, activeTabId, connection, controller, t])

  const copyOut = useCallback((text: string): void => {
    void copyTextToClipboard(text).then(
      () => {
        setSchemaProblem(previous => (previous === t('sqlnotebook.copyFailed') ? null : previous))
      },
      () => { setSchemaProblem(t('sqlnotebook.copyFailed')) },
    )
  }, [t])

  const onMenuSelect = useCallback((action: SqlTableMenuAction, table: string): void => {
    if (action === 'insert-select') insertSql(selectAllFrom(table, connection?.rowLimit ?? 0))
    if (action === 'insert-name') insertSql(quotedSqlIdentifier(table))
    if (action === 'copy-name') copyOut(table)
    if (action === 'copy-columns') void readColumns(table).then(entries => { copyOut(entries.map(entry => entry.name).join('\n')) }, () => {})
  }, [connection?.rowLimit, copyOut, insertSql, readColumns])

  /**
   * The labels every node reads. The tree itself does not look at the dictionary: a node's
   * `label` is already a translated string, and these are the few that the panel still
   * computes at render time (the loading line, the view badge, etc.).
   */
  const labels: SqlTreeNodeLabels = useMemo(() => ({
    databaseRoot: t('sqlnotebook.schema'),
    databaseMemory: t('sqlnotebook.memoryDatabaseLabel'),
    categoryColumns: t('sqlnotebook.categoryColumns'),
    categoryIndexes: t('sqlnotebook.categoryIndexes'),
    categoryForeignKeys: t('sqlnotebook.categoryForeignKeys'),
    categoryTriggers: t('sqlnotebook.categoryTriggers'),
    viewBadge: t('sqlnotebook.viewLabel'),
    columnNotNull: t('sqlnotebook.columnNotNull'),
    columnNullable: t('sqlnotebook.columnNullable'),
    openTable: t('sqlnotebook.openTable'),
    noColumns: t('sqlnotebook.schemaEmpty'),
    loading: t('sqlnotebook.schemaLoading'),
    badgePrimaryKey: t('sqlnotebook.badgePrimaryKey'),
    badgeNotNull: t('sqlnotebook.badgeNotNull'),
    badgeUnique: t('sqlnotebook.badgeUnique'),
    badgeForeignKey: t('sqlnotebook.badgeForeignKey'),
    badgeAutoIncrement: t('sqlnotebook.badgeAutoIncrement'),
  }), [t])

  /**
   * The root node, built from the host's last schema read.
   *
   * The root is the one place that owns the `path` value of the tree's first `Set` key,
   * because the root is what every other path is anchored to. The recursive children below
   * do not need to know that key — they just compose theirs from the `parentPath` prop.
   */
  const rootNode = useMemo<SqlSchemaNode | null>(() => {
    if (tables === null) return null
    return {
      kind: 'database',
      path: tables.path,
      databaseKind: tables.databaseKind,
      tables: tables.tables,
      truncated: tables.truncated,
    }
  }, [tables])

  /**
   * Expansion state. The set is keyed by the path the recursion threads, so a click on a
   * nested column toggles only that row. Default open: the root, so a reader sees the table
   * list without a click. Categories open lazily: opening "字段" issues a column read the
   * first time only.
   */
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['database']))
  const toggle = useCallback((path: string) => {
    setExpanded(previous => {
      const next = new Set(previous)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const header = (
    <header className={css.panelHeader} data-dsh-workbench-panel-header="">
      <span className={css.panelTitle}>{t('sqlnotebook.schema')}</span>
      <button
        type="button"
        className={css.headerAction}
        aria-label={t('sqlnotebook.refreshSchema')}
        title={t('sqlnotebook.refreshSchema')}
        disabled={connectedPath === null}
        onClick={loadSchema}
      >
        ⟳
      </button>
    </header>
  )

  /**
   * Pick a row and make the workbench show that notebook. The controller's `selectTab` is the
   * same action the tab strip's click does, so the panel does not invent a second switch.
   */
  const onActivate = useCallback((tabId: string) => {
    if (tabId === activeTabId) return
    controller.selectTab(tabId)
  }, [activeTabId, controller])

  const treeBody = activeTabId === null || activePath === null
    ? null
    : (
      <div className={css.schema} role="tree" aria-label={t('sqlnotebook.schema')}>
        {connection === null ? (
          <>
            <div className={css.muted}>{t('sqlnotebook.notConnected')}</div>
            <div className={css.pointer}>{t('sqlnotebook.connectInToolbar')}</div>
          </>
        ) : tables === null
          ? <div className={css.muted}>{t('sqlnotebook.schemaLoading')}</div>
          : tables.tables.length === 0
            ? <div className={css.muted}>{t('sqlnotebook.schemaEmpty')}</div>
            : rootNode === null
              ? null
              : (
                <SqlTreeNode
                  node={rootNode}
                  depth={0}
                  expanded={expanded}
                  onToggle={toggle}
                  onRequestColumns={(table) => { void readColumns(table).catch(() => {}) }}
                  onInsertSelect={(table) => { insertSql(selectAllFrom(table, connection.rowLimit)) }}
                  onTableContextMenu={(event, table) => {
                    event.preventDefault()
                    setMenuTarget({ table, rect: event.currentTarget.getBoundingClientRect() })
                  }}
                  columnsFor={name => columns[name]}
                  labels={labels}
                />
              )}
        {tables?.truncated === true && <div className={css.muted}>{t('sqlnotebook.schemaTruncated')}</div>}
        {schemaProblem !== null && <div className={css.problem} role="alert">{schemaProblem}</div>}
      </div>
    )

  // The top pane: "Open" notebooks. The toolbar is fixed-height (never scrolls); the
  // content below it scrolls independently so the header is always visible.
  const openListBody = (
    <div className={`${css.pane} ${css.paneTop}`} aria-label={t('sqlnotebook.openNotebooks')}>
      <div className={css.openNotebooks} role="toolbar">
        <span className={css.openNotebooksTitle}>{t('sqlnotebook.openNotebooks')}</span>
        <span
          className={css.openNotebooksCount}
          aria-label={t('sqlnotebook.openNotebooksCount', { count: notebooks.length })}
        >
          {notebooks.length}
        </span>
      </div>
      <div className={css.paneContent}>
        <div className={css.notebookList} role="list">
          {notebooks.length === 0
            ? <div className={css.notebookListEmpty}>{t('sqlnotebook.panelNoNotebook')}</div>
            : notebooks.map(tab => (
              <NotebookRow
                key={tab.id}
                tab={tab}
                active={tab.id === activeTabId}
                state={notebookStates.get(tab.id) ?? null}
                onActivate={onActivate}
                t={t}
              />
            ))}
        </div>
        {notebooks.length > 1 && activeTabId !== null && treeBody !== null
          ? <div className={css.notebookTreeSeparator} />
          : null}
        {treeBody}
        {treeBody === null && activeTabId !== null && notebooks.length > 0
          ? <div className={css.notebookTreePlaceholder}>{t('sqlnotebook.notebookListInactiveBadge')}</div>
          : null}
      </div>
    </div>
  )

  // The bottom pane: "Workspace" scan. Identical layout to the top pane — fixed toolbar,
  // independent scroll — so a reader's eye can freely move between the two without
  // adjusting to a different pattern.
  const openPaths = useMemo(() => new Set(notebooks.map(tab => tab.path)), [notebooks])
  const openNotebookFromDisk = useCallback((path: string) => {
    if (workspaceId === undefined) return
    void controller.openFile(workspaceId, path)
  }, [controller, workspaceId])
  const workspaceListBody = (
    <div className={`${css.pane} ${css.paneBottom}`} aria-label={t('sqlnotebook.workspaceNotebooks')}>
      <div className={css.workspaceNotebooks} role="toolbar">
        <span className={css.workspaceNotebooksTitle}>{t('sqlnotebook.workspaceNotebooks')}</span>
        <button
          type="button"
          className={css.headerAction}
          aria-label={t('sqlnotebook.rescan')}
          title={t('sqlnotebook.rescan')}
          disabled={scanning}
          onClick={rescanWorkspace}
        >
          ⟳
        </button>
      </div>
      <div className={css.paneContent}>
      {scanning && workspaceScan === null
        ? <div className={css.muted}>{t('sqlnotebook.workspaceNotebooksScanning')}</div>
        : workspaceScan === null
          ? null
          : workspaceScan.notebooks.length === 0
            ? <div className={css.notebookListEmpty}>{t('sqlnotebook.workspaceNotebooksEmpty')}</div>
            : (
              <div className={css.workspaceNotebookList} role="list">
                {workspaceScan.notebooks.map((choice) => {
                  const isOpen = openPaths.has(choice.path)
                  const rowClass = isOpen
                    ? `${css.workspaceNotebookRow} ${css.workspaceNotebookRowOpen}`
                    : css.workspaceNotebookRow
                  return (
                    <button
                      key={choice.path}
                      type="button"
                      role="listitem"
                      className={rowClass}
                      aria-label={t('sqlnotebook.workspaceNotebookOpenAria', { name: choice.name })}
                      title={t('sqlnotebook.workspaceNotebookOpen')}
                      onClick={() => { openNotebookFromDisk(choice.path) }}
                    >
                      <span className={css.workspaceNotebookName}>{choice.name}</span>
                      <span className={css.workspaceNotebookPath}>{choice.path}</span>
                    </button>
                  )
                })}
              </div>
            )}
      {workspaceScan?.truncated === true
        && <div className={css.muted}>{t('sqlnotebook.scanTruncated')}</div>}
      </div>
    </div>
  )

  return (
    <div className={css.panelBody}>
      {header}
      <div className={css.body}>
        {openListBody}
        {workspaceListBody}
      </div>
      <SqlTableContextMenu
        target={menuTarget}
        labels={{
          insertSelect: t('sqlnotebook.insertSelect'),
          insertTableName: t('sqlnotebook.insertTableName'),
          copyTableName: t('sqlnotebook.copyTableName'),
          copyColumnNames: t('sqlnotebook.copyColumnNames'),
        }}
        columnsKnownEmpty={menuTarget !== null && columns[menuTarget.table]?.length === 0}
        onClose={() => { setMenuTarget(null) }}
        onSelect={onMenuSelect}
      />
    </div>
  )
}