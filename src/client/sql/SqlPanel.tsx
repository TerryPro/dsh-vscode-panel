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
 * It is still not a second editor: no draft, no result, no run state of its own. It binds the
 * runtime and replays the file's connection record because the tree needs a live handle to describe
 * — and the editor may be showing a `.ts` file right now, which is exactly when nothing else on
 * screen would have connected.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SqlColumnEntry, SqlTablesResult, SqlTreeEntry } from '../../shared/sql-protocol.ts'
import { copyTextToClipboard } from '../core/clipboard.ts'
import type { WorkbenchController } from '../model/controller.ts'
import { messageOf } from '../model/tab-model.ts'
import { useWorkbench } from '../model/use-workbench.ts'
import { appendSqlCell } from './sql-notebook-document.ts'
import { activeSqlNotebook } from './sql-notebook-tab.ts'
import { quotedSqlIdentifier, selectAllFrom } from './sql-schema-tree.ts'
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

export function SqlPanel({ controller, workspaceId, t }: SqlPanelProps) {
  const state = useWorkbench(controller)
  const notebook = activeSqlNotebook(state)
  const tabId = notebook?.id ?? null
  const notebookPath = notebook?.path ?? null

  // The editor can be showing another file while this panel is on screen, so the panel binds the
  // runtime itself. `bind` is idempotent for one notebook, and it is what tells the runtime which
  // workspace and notebook a tab belongs to.
  useEffect(() => {
    if (workspaceId === undefined || tabId === null || notebookPath === null) return
    controller.sqlRuntime.bind(tabId, workspaceId, notebookPath)
    // Reopening a notebook connects to the database its file records (ADR 0007). That is the
    // notebook's own rule, not a connection control: the panel replays it because with the surface
    // unmounted there would otherwise be no handle, and so no tree to read.
    void controller.sqlRuntime.autoConnect(tabId)
  }, [controller, notebookPath, tabId, workspaceId])

  const subscribe = useCallback(
    (notify: () => void): (() => void) =>
      (tabId === null ? () => {} : controller.sqlRuntime.subscribe(tabId, notify)),
    [controller, tabId],
  )
  const readState = useCallback(
    () => (tabId === null ? null : controller.sqlRuntime.peek(tabId)),
    [controller, tabId],
  )
  const runState = useSyncExternalStore(subscribe, readState)

  const connection = runState?.connection ?? null
  const connectedPath = connection?.path ?? null

  const [tables, setTables] = useState<SqlTablesResult | null>(null)
  const [schemaProblem, setSchemaProblem] = useState<string | null>(null)
  const [columns, setColumns] = useState<Record<string, SqlColumnEntry[]>>({})
  const [menuTarget, setMenuTarget] = useState<SqlTableMenuTarget | null>(null)
  const lastExecution = useRef('')

  const loadSchema = useCallback((): void => {
    if (workspaceId === undefined || notebookPath === null) return
    setSchemaProblem(null)
    void controller.api.sqlTables(workspaceId, notebookPath).then(
      (result) => { setTables(result) },
      (error: unknown) => { setSchemaProblem(messageOf(error)) },
    )
  }, [controller, notebookPath, workspaceId])

  useEffect(() => {
    setTables(null)
    setColumns({})
    setSchemaProblem(null)
    if (connectedPath !== null) loadSchema()
  }, [connectedPath, loadSchema])

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
    if (workspaceId === undefined || notebookPath === null) return Promise.resolve([])
    return controller.api.sqlColumns(workspaceId, notebookPath, name).then(
      (result) => {
        setColumns(previous => ({ ...previous, [name]: result.columns }))
        return result.columns
      },
      (error: unknown) => {
        setSchemaProblem(messageOf(error))
        throw error
      },
    )
  }, [columns, controller, notebookPath, workspaceId])

  const insertSql = useCallback((source: string): void => {
    if (notebook === null || tabId === null || connection === null) return
    try {
      controller.setDraft(appendSqlCell(notebook.draft, source), 'input', tabId)
      setSchemaProblem(null)
    } catch {
      setSchemaProblem(t('sqlnotebook.treeRefused'))
    }
  }, [connection, controller, notebook, tabId, t])

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

  if (tabId === null || notebookPath === null) {
    return (
      <div className={css.panelBody}>
        {header}
        <div className={css.panelEmpty}>{t('sqlnotebook.panelNoNotebook')}</div>
      </div>
    )
  }

  return (
    <div className={css.panelBody}>
      {header}
      <div className={css.body}>
        {connection === null ? (
          <>
            <div className={css.muted}>{t('sqlnotebook.notConnected')}</div>
            <div className={css.pointer}>{t('sqlnotebook.connectInToolbar')}</div>
          </>
        ) : (
          <>
            <div className={css.schema} role="tree" aria-label={t('sqlnotebook.schema')}>
              {tables === null
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
          </>
        )}
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
