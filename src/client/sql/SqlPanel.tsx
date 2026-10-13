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

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { SQL_MEMORY_TARGET, type SqlAccess } from '../../shared/sql-protocol.ts'
import type { WorkbenchController, WorkbenchFileTab, WorkbenchState } from '../model/controller.ts'
import { useWorkbench } from '../model/use-workbench.ts'
import { isSqlNotebookPath } from './sql-notebook-document.ts'
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

  const connection = runState?.connection ?? null
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
      </div>
    </div>
  )
}
