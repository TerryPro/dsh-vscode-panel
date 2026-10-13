/**
 * The SQL sidebar panel: the connection of the SQL notebook the reader is in.
 *
 * Which notebook it describes is the *active* `.sqlnb` tab, falling back to the last one still
 * open. A connection belongs to a notebook (ADR 0002), so a panel that described "the connection of
 * this workspace" would be describing something the Host does not have. When no notebook is open it
 * says so instead of guessing.
 *
 * The panel is not a second editor: it holds no draft, no result and no run state of its own. It
 * reads the same per-tab runtime the notebook surface reads, and every button here is one the
 * surface also offers, so the two can never disagree about what is connected.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { SQL_MEMORY_TARGET, type SqlAccess, type SqlColumnEntry, type SqlTablesResult } from '../../shared/sql-protocol.ts'
import type { WorkbenchController, WorkbenchFileTab, WorkbenchState } from '../model/controller.ts'
import { messageOf } from '../model/tab-model.ts'
import { useWorkbench } from '../model/use-workbench.ts'
import { appendSqlCell, isSqlNotebookPath } from './sql-notebook-document.ts'
import { selectAllFrom } from './sql-schema-tree.ts'
import { useDatabaseScan } from './use-database-scan.ts'
import css from './sql-panel.module.css'

export interface SqlPanelProps {
  controller: WorkbenchController
  /** Workspace the panel reads databases from; the connection itself is keyed by the notebook. */
  workspaceId: string | undefined
  t: TranslateNS<'workbench'>
}

/**
 * The notebook this panel is about.
 *
 * The active tab wins when it is a `.sqlnb`. Otherwise the last `.sqlnb` in open order is used —
 * tabs are kept in the order they were opened, so that is the most recently opened notebook, which
 * is what a reader switching to the SQL view means when the editor is showing something else.
 */
export function activeSqlNotebook(state: WorkbenchState): WorkbenchFileTab | null {
  const active = state.tabs.find(tab => tab.id === state.activeTabId)
  if (active?.kind === 'file' && isSqlNotebookPath(active.path)) return active
  for (const tab of [...state.tabs].reverse()) {
    if (tab.kind === 'file' && isSqlNotebookPath(tab.path)) return tab
  }
  return null
}

export function SqlPanel({ controller, workspaceId, t }: SqlPanelProps) {
  const state = useWorkbench(controller)
  const notebook = activeSqlNotebook(state)
  const tabId = notebook?.id ?? null
  const notebookPath = notebook?.path ?? null
  const [pickPath, setPickPath] = useState('')
  const [pickAccess, setPickAccess] = useState<SqlAccess>('read-only')

  // The editor can be showing another file while this panel is on screen, so the panel binds the
  // runtime itself. `bind` is idempotent for one notebook, and it is what tells the runtime which
  // workspace and notebook a tab belongs to.
  useEffect(() => {
    if (workspaceId === undefined || tabId === null || notebookPath === null) return
    controller.sqlRuntime.bind(tabId, workspaceId, notebookPath)
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

  // Stable identity on purpose: the scan hook re-walks whenever this function changes, and a fresh
  // closure per render would make it walk on every keystroke elsewhere in the workbench.
  const listDirectory = useCallback(
    (directory: string) => workspaceId === undefined
      ? Promise.resolve({ path: directory, entries: [], truncated: false })
      : controller.api.listDirectory(workspaceId, directory),
    [controller, workspaceId],
  )
  const { scan, scanning, rescan } = useDatabaseScan(listDirectory)

  /**
   * The connection and its schema.
   *
   * Every hook here sits above the "no notebook" return, so what the tree needs is derived here
   * rather than beside the JSX. The effects depend on `connectedPath` and not on the connection
   * object: that object is rebuilt on every runtime update, and a schema re-read per keystroke in a
   * cell would make the panel the slowest thing in the workbench.
   */
  const connection = runState?.connection ?? null
  const connectedPath = connection?.path ?? null
  const [tables, setTables] = useState<SqlTablesResult | null>(null)
  const [schemaProblem, setSchemaProblem] = useState<string | null>(null)
  const [openTable, setOpenTable] = useState<string | null>(null)
  const [columns, setColumns] = useState<Record<string, SqlColumnEntry[]>>({})
  const lastExecution = useRef(0)

  const loadSchema = useCallback((): void => {
    if (workspaceId === undefined || notebookPath === null) return
    setSchemaProblem(null)
    void controller.api.sqlTables(workspaceId, notebookPath).then(
      (result) => { setTables(result) },
      (error: unknown) => { setSchemaProblem(messageOf(error)) },
    )
  }, [controller, notebookPath, workspaceId])

  // A connection is a different database, so nothing read from the last one survives it.
  useEffect(() => {
    setTables(null)
    setColumns({})
    setOpenTable(null)
    setSchemaProblem(null)
    if (connectedPath !== null) loadSchema()
  }, [connectedPath, loadSchema])

  const executed = runState === null
    ? 0
    : Object.values(runState.cells).reduce((highest, run) => Math.max(highest, run.executionCount ?? 0), 0)
  // The ticket's rule: a refresh button plus one re-read per run, and no file watcher. A statement
  // may have created or dropped a table, so the run that just finished is what makes the tree stale.
  useEffect(() => {
    if (executed === lastExecution.current) return
    lastExecution.current = executed
    if (connectedPath !== null) loadSchema()
  }, [connectedPath, executed, loadSchema])

  // A rail action is consumed once, by id: the request is a store write, so the effect that handles
  // it runs again on every unrelated store change and must not re-read the schema each time.
  const handledAction = useRef(0)
  useEffect(() => {
    const request = state.sidebarAction
    if (request === undefined || request.action !== 'sql.refreshSchema') return
    if (handledAction.current === request.id) return
    handledAction.current = request.id
    controller.consumeSidebarAction(request.id)
    if (connectedPath !== null) loadSchema()
  }, [connectedPath, controller, loadSchema, state.sidebarAction])

  const toggleTable = useCallback((name: string): void => {
    if (openTable === name) {
      setOpenTable(null)
      return
    }
    setOpenTable(name)
    if (columns[name] !== undefined || workspaceId === undefined || notebookPath === null) return
    void controller.api.sqlColumns(workspaceId, notebookPath, name).then(
      (result) => { setColumns(previous => ({ ...previous, [name]: result.columns })) },
      (error: unknown) => { setSchemaProblem(messageOf(error)) },
    )
  }, [columns, controller, notebookPath, openTable, workspaceId])

  /**
   * Put a `SELECT *` for this table in a new cell of the notebook.
   *
   * The query is written through the same document layer the surface writes through, so a notebook
   * this build will not rewrite refuses here too and the reader keeps their bytes.
   */
  const insertSelect = useCallback((name: string): void => {
    if (notebook === null || tabId === null || connection === null) return
    try {
      controller.setDraft(appendSqlCell(notebook.draft, selectAllFrom(name, connection.rowLimit)), 'input', tabId)
      setSchemaProblem(null)
    } catch (error: unknown) {
      // The document layer refuses rather than re-serializing a file it does not fully understand,
      // so the reader keeps their bytes and is told to fix the file instead.
      void error
      setSchemaProblem(t('sqlnotebook.treeRefused'))
    }
  }, [connection, controller, notebook, t, tabId])

  const header = (
    <header className={css.panelHeader} data-dsh-workbench-panel-header="">
      <span className={css.panelTitle}>{t('sqlnotebook.panelTitle')}</span>
      <button
        type="button"
        className={css.headerAction}
        aria-label={t('sqlnotebook.rescan')}
        title={t('sqlnotebook.rescan')}
        disabled={scanning}
        onClick={rescan}
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

  const chosenTarget = connection?.path ?? pickPath
  /**
   * An in-memory database has no tier: there is nothing on disk to protect, so the Host opens it
   * writable and refuses a request that names a tier. The picker hides the choice rather than
   * defaulting it, and the connect sends `writable`.
   */
  const memoryPicked = chosenTarget === SQL_MEMORY_TARGET
  const connectAccess: SqlAccess = memoryPicked ? 'writable' : pickAccess
  const canConnect = runState !== null && !runState.connecting
  const problem = runState?.connectionProblem ?? null
  const readout = runState === null || runState.connecting
    ? t('sqlnotebook.connecting')
    : connection === null
      ? t('sqlnotebook.notConnected')
      : `${connection.path} · ${connection.access === 'writable' ? t('sqlnotebook.writableTier') : t('sqlnotebook.readOnlyTier')} · ${connection.rowLimit}`

  return (
    <div className={css.panelBody}>
      {header}
      <div className={css.body}>
        <div className={css.notebookLine}>{t('sqlnotebook.panelNotebook', { path: notebookPath })}</div>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('sqlnotebook.database')}</span>
          <select
            className={css.select}
            aria-label={t('sqlnotebook.database')}
            // Locked while a handle is open, on the Host's own rule: changing tier or database on a
            // live handle is a close plus reopen (`SQL_RECONNECT_REQUIRED`), and the reader has to
            // be told that before it happens rather than after. Disconnect is the way through.
            title={connection === null ? undefined : t('sqlnotebook.tierLocked')}
            disabled={connection !== null || !canConnect}
            value={chosenTarget}
            onChange={event => { setPickPath(event.target.value) }}
          >
            <option value="">{t('sqlnotebook.database')}</option>
            <option value={SQL_MEMORY_TARGET}>{t('sqlnotebook.memoryDatabase')}</option>
            {(scan?.databases ?? []).map(choice => (
              <option key={choice.path} value={choice.path}>{choice.path}</option>
            ))}
          </select>
        </label>
        {!memoryPicked && (
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('sqlnotebook.tier')}</span>
            <select
              className={css.select}
              aria-label={t('sqlnotebook.tier')}
              title={connection === null ? undefined : t('sqlnotebook.tierLocked')}
              disabled={connection !== null || !canConnect}
              value={pickAccess}
              onChange={event => { setPickAccess(event.target.value === 'writable' ? 'writable' : 'read-only') }}
            >
              <option value="read-only">{t('sqlnotebook.readOnlyTier')}</option>
              <option value="writable">{t('sqlnotebook.writableTier')}</option>
            </select>
          </label>
        )}
        {connection === null ? (
          <button
            type="button"
            className={css.primaryButton}
            disabled={!canConnect || chosenTarget === ''}
            title={chosenTarget === '' ? t('sqlnotebook.noDatabase') : t('sqlnotebook.connect')}
            onClick={() => { void controller.sqlRuntime.connect(tabId, chosenTarget, connectAccess) }}
          >
            {t('sqlnotebook.connect')}
          </button>
        ) : (
          <button
            type="button"
            className={css.primaryButton}
            // Disconnecting is also how the reader changes tier or database, and it costs the
            // connection's scratch work: temporary tables and an uncommitted transaction go with it.
            title={t('sqlnotebook.disconnectHint')}
            onClick={() => { void controller.sqlRuntime.disconnect(tabId) }}
          >
            {t('sqlnotebook.disconnect')}
          </button>
        )}
        <div className={css.readout}>{readout}</div>
        {problem !== null && (
          <div className={css.problem} role="alert">
            {problem.message === '' ? t('sqlnotebook.notConnectedRefusal') : problem.message}
          </div>
        )}
        {connection?.path === SQL_MEMORY_TARGET && (
          <div className={css.memoryNote}>{t('sqlnotebook.memoryNotice')}</div>
        )}
        {scan?.truncated === true && <div className={css.muted}>{t('sqlnotebook.scanTruncated')}</div>}
        {/*
          The schema tree, only while something is connected: it lists the *connected* database, so
          with no handle there is nothing it could be describing. Tables and their columns are two
          lazy reads (the Host's tables/columns routes), which is why expanding a table is the only
          thing that spends a request.
        */}
        {connection !== null && (
          <div className={css.schema}>
            <div className={css.schemaHeader}>
              <span className={css.fieldLabel}>{t('sqlnotebook.schema')}</span>
              <button
                type="button"
                className={css.headerAction}
                aria-label={t('sqlnotebook.refreshSchema')}
                title={t('sqlnotebook.refreshSchema')}
                onClick={loadSchema}
              >
                ⟳
              </button>
            </div>
            {tables === null
              ? <div className={css.muted}>{t('sqlnotebook.schemaLoading')}</div>
              : tables.tables.length === 0
                ? <div className={css.muted}>{t('sqlnotebook.schemaEmpty')}</div>
                : tables.tables.map(entry => (
                  <div key={entry.name} className={css.schemaNode}>
                    {/*
                      One click expands, two insert a query. The gesture that writes into the file
                      is the deliberate one, exactly as opening a `.db` from the tree is a double
                      click: a single click on a row the reader is scanning to read must not edit
                      anything.
                    */}
                    <button
                      type="button"
                      className={css.tableRow}
                      aria-expanded={openTable === entry.name}
                      title={t('sqlnotebook.openTable')}
                      onClick={() => { toggleTable(entry.name) }}
                      onDoubleClick={() => { insertSelect(entry.name) }}
                    >
                      <span className={css.tableName}>{entry.name}</span>
                      {entry.kind === 'view' && <span className={css.tableKind}>{t('sqlnotebook.viewLabel')}</span>}
                    </button>
                    {openTable === entry.name && (
                      columns[entry.name] === undefined
                        ? <div className={css.muted}>{t('sqlnotebook.schemaLoading')}</div>
                        : (
                          <ul className={css.columnList}>
                            {(columns[entry.name] ?? []).map(column => (
                              <li key={column.name} className={css.columnRow}>
                                <span className={css.columnName}>{column.name}</span>
                                <span className={css.columnType}>{column.type ?? ''}</span>
                                {column.primaryKey && <span className={css.columnBadge}>PK</span>}
                              </li>
                            ))}
                          </ul>
                        )
                    )}
                  </div>
                ))}
            {tables?.truncated === true && <div className={css.muted}>{t('sqlnotebook.schemaTruncated')}</div>}
            {schemaProblem !== null && <div className={css.problem} role="alert">{schemaProblem}</div>}
          </div>
        )}
      </div>
    </div>
  )
}
