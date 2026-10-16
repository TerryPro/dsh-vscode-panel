/**
 * The SQL sidebar panel redesigned per user requirements:
 *
 * Layout:
 * - Top half: workspace scan — all SQL notebooks found in the workspace,
 *   styled like terminal entries (name on first line, connection info on second)
 * - Bottom half: schema tree for the currently active/selected notebook
 *
 * Behavior:
 * - Clicking a notebook in the top half opens it or switches to it if already open
 * - The bottom half shows the schema of whichever notebook is currently active
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkbenchFileTab, WorkbenchState } from '../model/controller.ts'
import { copyTextToClipboard } from '../core/clipboard.ts'
import type { WorkbenchController } from '../model/controller.ts'
import { messageOf } from '../model/tab-model.ts'
import { useWorkbench } from '../model/use-workbench.ts'
import { isSqlNotebookPath } from './sql-notebook-document.ts'
import { appendSqlCell } from './sql-notebook-document.ts'
import { activeSqlNotebook } from './sql-notebook-tab.ts'
import { quotedSqlIdentifier, selectAllFrom } from './sql-schema-tree.ts'
import { SqlRuntime, type SqlNotebookState } from './sql-runtime.ts'
import { SqlWorkspaceCache, type SqlWorkspaceScanner, type SqlWorkspaceSnapshot } from './sql-workspace-cache.ts'
import { SqlTableContextMenu, type SqlTableMenuAction, type SqlTableMenuTarget } from './SqlTableContextMenu.tsx'
import {
  SqlTreeNode,
  type SqlSchemaNode,
  type SqlTreeNodeLabels,
} from './sql-tree-node.tsx'
import css from './sql-panel.module.css'

export interface SqlPanelProps {
  controller: WorkbenchController
  workspaceId: string | undefined
  t: TranslateNS<'workbench'>
}

/**
 * Snapshot of every SQL notebook tab the workbench has open.
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
 * One notebook entry row, styled like a terminal entry:
 * - First line: notebook name + status dot
 * - Second line: database connection info (path, tier, etc.)
 */
interface NotebookEntryProps {
  choice: { path: string; name: string; explicitDatabase: { path: string; name: string } | null }
  isOpen: boolean
  isActive: boolean
  state: SqlNotebookState | null
  onOpen: (path: string) => void
  t: TranslateNS<'workbench'>
}

function NotebookEntry({ choice, isOpen, isActive, state, onOpen, t }: NotebookEntryProps) {
  const connection = state?.connection ?? null

  const handleClick = (): void => {
    onOpen(choice.path)
  }

  // Status dot: green when connected, hollow when not
  const statusDotClass = connection !== null
    ? `${css.notebookStatusDot} ${css.notebookStatusDotConnected}`
    : `${css.notebookStatusDot} ${css.notebookStatusDotDisconnected}`

  // The entry div is the only box that paints: its hover / active fill covers both
  // lines, which is what makes the two read as one item. A class for the active
  // state would be a second source of that fact next to `data-active` below.
  const entryClass = css.notebookEntry

  return (
    <div
      className={entryClass}
      data-active={isActive ? true : undefined}
    >
      {/* First line: name + status dot */}
      <div className={css.notebookRow}>
        <button
          type="button"
          className={css.notebookSelect}
          onClick={handleClick}
          aria-label={t('sqlnotebook.workspaceNotebookOpenAria', { name: choice.name })}
        >
          <span className={statusDotClass} aria-hidden="true" />
          <span className={css.notebookName}>{choice.name}</span>
          {isActive && (
            <span className={css.activeBadge}>{t('sqlnotebook.notebookListActiveBadge')}</span>
          )}
        </button>
      </div>
      {/* Second line: the database this notebook is on.
       *
       * The path carries no label — it is the only fact on this line and the line
       * sits directly under the notebook it describes, so a "库文件" prefix would
       * just repeat what the reader already knows. The tier goes to the row's right
       * edge instead: the two ends of the line then read as "which database" and
       * "how it is opened", without the reader scanning between them. */}
      <div className={css.notebookStatusLine}>
        {connection !== null ? (
          <>
            <span className={css.statusValue}>{connection.path}</span>
            {connection.path === ':memory:' && (
              <span className={`${css.tierBadge} ${css.tierBadgeMemory}`}>
                {t('sqlnotebook.notebookListMemoryBadge')}
              </span>
            )}
            {connection.access === 'writable' ? (
              <span className={`${css.tierBadge} ${css.statusTier} ${css.tierBadgeWritable}`}>
                {t('sqlnotebook.notebookListTierWritable')}
              </span>
            ) : (
              <span className={`${css.tierBadge} ${css.statusTier} ${css.tierBadgeReadonly}`}>
                {t('sqlnotebook.notebookListTierReadOnly')}
              </span>
            )}
          </>
        ) : choice.explicitDatabase !== null ? (
          <span className={css.statusValue}>{choice.explicitDatabase.name}</span>
        ) : (
          <span>{t('sqlnotebook.notConnected')}</span>
        )}
      </div>
    </div>
  )
}

/** The SQL notebook tabs in the workbench tab strip. */
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

  // Build a map of open notebook paths for quick lookup
  const openPathsMap = useMemo(() => {
    const map = new Map<string, WorkbenchFileTab>()
    for (const tab of notebooks) {
      map.set(tab.path, tab)
    }
    return map
  }, [notebooks])

  // Bind every SQL notebook the panel can see
  useEffect(() => {
    if (workspaceId === undefined) return
    const runtime = controller.sqlRuntime
    for (const tab of notebooks) {
      runtime.bind(tab.id, workspaceId, tab.path)
      void runtime.autoConnect(tab.id)
    }
  }, [controller, notebooks, workspaceId])

  const [tables, setTables] = useState<import('../../shared/sql-protocol.ts').SqlTablesResult | null>(null)
  const [schemaProblem, setSchemaProblem] = useState<string | null>(null)
  const [columns, setColumns] = useState<Record<string, import('../../shared/sql-protocol.ts').SqlColumnEntry[]>>({})
  const [menuTarget, setMenuTarget] = useState<SqlTableMenuTarget | null>(null)
  // `null` means "never scanned for this workspace" — `null` is the trigger
  // for the panel to ask the cache to scan. The cache decides whether the
  // request actually walks the directory.
  const [workspaceScan, setWorkspaceScan] = useState<SqlWorkspaceSnapshot>(null)
  const [scanning, setScanning] = useState(false)
  const lastExecution = useRef('')

  // `connectedPath` is read by both the schema effect below and the panel's
  // "Refresh" button (which reloads the schema in addition to rescanning the
  // workspace). Hoisting it above the scan callbacks keeps both call sites
  // pointing at the same source of truth and avoids a TDZ reference.
  const activeState = activeTabId === null ? null : notebookStates.get(activeTabId) ?? null
  const connection = activeState?.connection ?? null
  const connectedPath = connection?.path ?? null

  /**
   * Wrap the controller's `listDirectory`/`readFile` so the cache only ever
   * sees the contract it cares about. Wrapping here (rather than at the
   * controller) keeps the cache free of any WorkbenchController-shaped input.
   */
  const scanner = useMemo<SqlWorkspaceScanner | null>(() => {
    if (workspaceId === undefined) return null
    return {
      list: (path: string) => controller.api.listDirectory(workspaceId, path),
      /**
       * The whole file, not its head.
       *
       * The scan parses this to read `connection`, which `writeSqlNotebookConnection` appends
       * after `cells` — so in every notebook that has ever recorded a result, the field sits past
       * the first kilobyte. Slicing the text here does not shorten a parse, it corrupts one: the
       * prefix is not valid JSON, `JSON.parse` throws, and the row silently reports "no database"
       * for a notebook that names one. Measured on `examples/`: 21 of 24 notebooks read that way.
       */
      readNotebook: async (path: string) => {
        const file = await controller.api.readFile(workspaceId, path)
        return file.content
      },
    }
  }, [controller, workspaceId])

  const loadSchema = useCallback((): void => {
    if (workspaceId === undefined || activePath === null) return
    setSchemaProblem(null)
    void controller.api.sqlTables(workspaceId, activePath).then(
      (result) => { setTables(result) },
      (error: unknown) => { setSchemaProblem(messageOf(error)) },
    )
  }, [controller, activePath, workspaceId])

  /**
   * Which scan request the panel is currently willing to render.
   *
   * The cache already refuses to *publish* a superseded walk, but it still answers whoever
   * awaited it — so a slow walk started before the reader pressed refresh would resolve after
   * the fresh one and paint its stale list over it. Gating on the request id here is what makes
   * "the newest walk is the one on screen" true of the panel and not only of the cache.
   */
  const scanRequest = useRef(0)

  /** Take one walk's result, unless a newer walk has been asked for since. */
  const acceptScan = useCallback((request: number, result: SqlWorkspaceSnapshot): void => {
    if (request !== scanRequest.current) return
    setWorkspaceScan(result)
    setScanning(false)
  }, [])

  /**
   * Run (or skip) a workspace scan through the controller-owned cache.
   *
   * The cache is what makes "切换到 SQL 面板要再扫一次" go away: it remembers
   * the most recent scan per workspace, and `setWorkspace()` invalidates it
   * when the user moves to a different one. The panel only ever asks the
   * cache; the cache is the one that decides whether a walk is needed.
   */
  const ensureWorkspaceScan = useCallback((): void => {
    if (workspaceId === undefined || scanner === null) return
    scanRequest.current += 1
    const request = scanRequest.current
    setScanning(true)
    const cache: SqlWorkspaceCache = controller.sqlWorkspaceCache
    void cache.ensure(workspaceId, scanner).then(
      (result) => { acceptScan(request, result) },
      (error: unknown) => {
        if (request !== scanRequest.current) return
        setScanning(false)
        setSchemaProblem(messageOf(error))
      },
    )
  }, [acceptScan, controller, scanner, workspaceId])

  /**
   * Force a fresh scan and reload the active schema, bound to the panel
   * header's refresh button. The button is the only gesture that overwrites
   * the cache: every other mount uses the cached snapshot.
   */
  const refreshAll = useCallback((): void => {
    if (workspaceId === undefined || scanner === null) return
    scanRequest.current += 1
    const request = scanRequest.current
    setScanning(true)
    const cache: SqlWorkspaceCache = controller.sqlWorkspaceCache
    void cache.refresh(workspaceId, scanner).then(
      (result) => {
        acceptScan(request, result)
        if (connectedPath !== null) loadSchema()
      },
      (error: unknown) => {
        if (request !== scanRequest.current) return
        setScanning(false)
        setSchemaProblem(messageOf(error))
      },
    )
  }, [acceptScan, controller, scanner, workspaceId, connectedPath, loadSchema])

  // Trigger the first scan on mount and whenever the cache for this workspace
  // becomes invalid (e.g. the controller cleared it after a workspace switch).
  useEffect(() => {
    ensureWorkspaceScan()
  }, [ensureWorkspaceScan])

  // Schema is per-active-tab
  useEffect(() => {
    setTables(null)
    setColumns({})
    setSchemaProblem(null)
    if (connectedPath !== null) loadSchema()
  }, [activeTabId, connectedPath, loadSchema])

  // Re-read schema after execution
  const executed = activeState === null
    ? ''
    : Object.entries(activeState.cells)
      .map(([id, run]) => `${id}:${run.executionCount ?? '-'}:${run.failure?.code ?? ''}`)
      .join('|')
  useEffect(() => {
    if (executed === lastExecution.current) return
    lastExecution.current = executed
    if (connectedPath !== null) loadSchema()
  }, [connectedPath, executed, loadSchema])

  // Handle sidebar action for schema refresh
  const handledAction = useRef(0)
  useEffect(() => {
    const request = state.sidebarAction
    if (request === undefined || request.action !== 'sql.refreshSchema') return
    if (handledAction.current === request.id) return
    handledAction.current = request.id
    controller.consumeSidebarAction(request.id)
    if (connectedPath !== null) loadSchema()
  }, [connectedPath, controller, loadSchema, state.sidebarAction])

  const readColumns = useCallback((name: string): Promise<import('../../shared/sql-protocol.ts').SqlColumnEntry[]> => {
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

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['database']))
  const toggle = useCallback((path: string) => {
    setExpanded(previous => {
      const next = new Set(previous)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const openNotebookFromDisk = useCallback((path: string) => {
    if (workspaceId === undefined) return
    void controller.openFile(workspaceId, path)
  }, [controller, workspaceId])

  // Top half: notebook list (workspace scan)
  const notebookListContent = (
    <div className={css.notebookList}>
      {workspaceScan === null || scanning && workspaceScan.notebooks.length === 0
        ? <div className={css.muted}>{t('sqlnotebook.workspaceNotebooksScanning')}</div>
        : workspaceScan.notebooks.length === 0
          ? <div className={css.notebookListEmpty}>{t('sqlnotebook.workspaceNotebooksEmpty')}</div>
          : workspaceScan.notebooks.map((choice) => {
            const openTab = openPathsMap.get(choice.path)
            const isOpen = openTab !== undefined
            const isActive = isOpen && openTab.id === activeTabId
            const state = isOpen ? (notebookStates.get(openTab.id) ?? null) : null
            return (
              <NotebookEntry
                key={choice.path}
                choice={choice}
                isOpen={isOpen}
                isActive={isActive}
                state={state}
                onOpen={openNotebookFromDisk}
                t={t}
              />
            )
          })}
      {/*
        The walk's own admission, said where its result is.

        `SqlNotebookScan.truncated` has existed since the scan was written and had no consumer:
        a workspace the caps cut short drew exactly the same list as a complete one, so a reader
        who could not find their notebook had nothing telling them it might be off the end. The
        empty case above does not cover this — a partial list is not an empty one.
      */}
      {workspaceScan?.truncated === true && (
        <div className={css.muted}>{t('sqlnotebook.scanNotebooksTruncated')}</div>
      )}
    </div>
  )

  // Bottom half: schema tree
  const schemaContent = (
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

  return (
    <div className={css.panelBody}>
      <header className={css.panelHeader} data-dsh-workbench-panel-header="">
        <span className={css.panelTitle}>{t('sqlnotebook.schema')}</span>
        <button
          type="button"
          className={css.headerAction}
          aria-label={t('sqlnotebook.refreshWorkspace')}
          title={t('sqlnotebook.refreshWorkspace')}
          disabled={workspaceId === undefined}
          onClick={refreshAll}
        >
          ⟳
        </button>
      </header>
      {/* Two-pane body: top = notebook list, bottom = schema tree */}
      <div className={css.body}>
        <div className={`${css.pane} ${css.paneTop}`} data-dsh-workbench-panel-rule-section="">
          <div className={css.paneContent}>
            {notebookListContent}
          </div>
        </div>
        <div className={css.pane} data-dsh-workbench-panel-rule-section="">
          <div className={css.paneContent}>
            {schemaContent}
          </div>
        </div>
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
