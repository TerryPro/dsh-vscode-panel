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
 * here is the one thing the notebook cannot offer comfortably: the table and column tree, and the
 * gestures that write out of it into the notebook.
 *
 * It is still not a second editor: no draft, no result, no run state of its own. It binds the
 * runtime and replays the file's connection record because the tree needs a live handle to describe
 * — and the editor may be showing a `.ts` file right now, which is exactly when nothing else on
 * screen would have connected.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SqlColumnEntry, SqlTablesResult } from '../../shared/sql-protocol.ts'
import { copyTextToClipboard } from '../core/clipboard.ts'
import type { WorkbenchController } from '../model/controller.ts'
import { messageOf } from '../model/tab-model.ts'
import { useWorkbench } from '../model/use-workbench.ts'
import { appendSqlCell } from './sql-notebook-document.ts'
import { activeSqlNotebook } from './sql-notebook-tab.ts'
import { quotedSqlIdentifier, selectAllFrom } from './sql-schema-tree.ts'
import { SqlTableContextMenu, type SqlTableMenuAction, type SqlTableMenuTarget } from './SqlTableContextMenu.tsx'
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

  /**
   * The connection, and the path it is on.
   *
   * The effects below depend on `connectedPath` and not on the connection object: that object is
   * rebuilt on every runtime update, and a schema re-read per keystroke in a cell would make this
   * panel the slowest thing in the workbench.
   */
  const connection = runState?.connection ?? null
  const connectedPath = connection?.path ?? null

  const [tables, setTables] = useState<SqlTablesResult | null>(null)
  const [schemaProblem, setSchemaProblem] = useState<string | null>(null)
  const [openTable, setOpenTable] = useState<string | null>(null)
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

  // A connection is a different database, so nothing read from the last one survives it.
  useEffect(() => {
    setTables(null)
    setColumns({})
    setOpenTable(null)
    setSchemaProblem(null)
    if (connectedPath !== null) loadSchema()
  }, [connectedPath, loadSchema])

  const executed = runState === null
    ? ''
    : Object.entries(runState.cells)
      // The signature is what the tree is stale *about*: a finished run may have created or dropped a
      // table, and a failure may be the file going away — which the ticket wants re-read too. Keying
      // on the execution count alone would miss every refused request, and those are the ones where
      // the schema most likely changed underneath the reader.
      .map(([id, run]) => `${id}:${run.executionCount ?? '-'}:${run.failure?.code ?? ''}`)
      .join('|')
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

  /**
   * Read a table's columns once, however often it is opened.
   *
   * Shared by the expander and by the menu's copy row, because a reader who right-clicks a table
   * they never expanded is asking a question the panel can answer — it just has to go get the data
   * first. The cached read is returned as-is so the caller never re-derives it.
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

  const toggleTable = useCallback((name: string): void => {
    if (openTable === name) {
      setOpenTable(null)
      return
    }
    setOpenTable(name)
    if (columns[name] !== undefined) return
    void readColumns(name).catch(() => {})
  }, [columns, openTable, readColumns])

  /**
   * Write a statement into a new cell of the notebook.
   *
   * The query goes through the same document layer the surface writes through, so a notebook this
   * build will not rewrite refuses here too and the reader keeps their bytes.
   */
  const insertSql = useCallback((source: string): void => {
    if (notebook === null || tabId === null || connection === null) return
    try {
      controller.setDraft(appendSqlCell(notebook.draft, source), 'input', tabId)
      setSchemaProblem(null)
    } catch {
      // The document layer refuses rather than re-serializing a file it does not fully understand,
      // so the reader keeps their bytes and is told to fix the file instead.
      setSchemaProblem(t('sqlnotebook.treeRefused'))
    }
  }, [connection, controller, notebook, tabId, t])

  /**
   * Copy out of the tree.
   *
   * Success is deliberately silent, matching the tab menu's "Copy path": a clipboard write that
   * worked has nothing to report. Failure is the opposite case — the browser can refuse the write,
   * and a copy that vanished without a word is a reader pasting nothing and wondering whether the
   * tree is broken. It lands in the same line the schema reads use, because it is the same kind of
   * "this panel could not do the thing you asked".
   */
  const copyOut = useCallback((text: string): void => {
    // Success clears only a previous COPY failure, never the line wholesale: a schema read that
    // failed stays failed just because a copy worked, and blanking it here would hide a real
    // problem behind an unrelated success.
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

  const header = (
    <header className={css.panelHeader} data-dsh-workbench-panel-header="">
      {/*
        The panel is the structure of a database, so that is its title. The key it uses is the one
        the tree itself was labelled with: keeping both would have said 结构 twice in one column,
        once as a heading and once as the heading of the thing under it.
      */}
      <span className={css.panelTitle}>{t('sqlnotebook.schema')}</span>
      <button
        type="button"
        className={css.headerAction}
        aria-label={t('sqlnotebook.refreshSchema')}
        title={t('sqlnotebook.refreshSchema')}
        // Nothing to re-read until there is a handle: this button reloads the tree, and the tree
        // belongs to a connected database, not to the workspace.
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
        <div className={css.notebookLine}>{t('sqlnotebook.panelNotebook', { path: notebookPath })}</div>
        {/*
          With no handle there is nothing this panel could list, and the action that would change
          that is no longer here. Saying only 未连接 would strand the reader in a column that offers
          neither the fact nor the way out, so the second line names where the control went.
        */}
        {connection === null ? (
          <>
            <div className={css.muted}>{t('sqlnotebook.notConnected')}</div>
            <div className={css.pointer}>{t('sqlnotebook.connectInToolbar')}</div>
          </>
        ) : (
          <div className={css.schema}>
            {tables === null
              ? <div className={css.muted}>{t('sqlnotebook.schemaLoading')}</div>
              : tables.tables.length === 0
                ? <div className={css.muted}>{t('sqlnotebook.schemaEmpty')}</div>
                : tables.tables.map(entry => (
                  <div key={entry.name} className={css.schemaNode}>
                    {/*
                      One click expands, two insert a query, right-click lists what else the row can
                      do. The gesture that writes into the file is the deliberate one, exactly as
                      opening a `.db` from the tree is a double click: a single click on a row the
                      reader is scanning to read must not edit anything. The menu is what makes the
                      write gesture findable — a double-click nobody has been told about is a feature
                      that does not exist yet.
                    */}
                    <button
                      type="button"
                      className={css.tableRow}
                      aria-expanded={openTable === entry.name}
                      title={t('sqlnotebook.openTable')}
                      onClick={() => { toggleTable(entry.name) }}
                      onDoubleClick={() => { insertSql(selectAllFrom(entry.name, connection.rowLimit)) }}
                      onContextMenu={event => {
                        event.preventDefault()
                        setMenuTarget({ table: entry.name, rect: event.currentTarget.getBoundingClientRect() })
                      }}
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
                                {column.primaryKey && <span className={css.columnBadge}>{t('sqlnotebook.primaryKey')}</span>}
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
