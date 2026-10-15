/**
 * What the SQL notebook tab is attached to, for the editor's status strip.
 *
 * The strip is the only place that says which database a SQL notebook is on, in the
 * source view of a `.sqlnb`. The cell view of the same notebook paints its own readout
 * under the body — `EditorTabBody` does not wire this component into the strip while
 * the cell view is on screen, so the line is never duplicated. The strip outlives both
 * views, which is the right home for a fact the reader needs to remember between runs.
 *
 * Deliberately not `NotebookKernelStatus`: that chip reports a kernel's phase, and an in-process
 * handle has no phase — a reader told "ready" about a handle would be told about something that
 * does not exist. What this shows is the database, the tier it was granted and the row cap.
 *
 * The two standing session-level facts — a read-only handle on a WAL database still leaves the
 * sidecar files, and an in-memory database evaporates with the handle — also live here rather
 * than above the cell surface. They are true for the whole session, and the body strip on
 * top of the cells is read as "this run's status", not "this handle's standing facts". A WAL
 * notice that the reader only sees while a specific cell is on screen is the same kind of
 * leak as a toolbelt of session banners showing only in source view (#16's complaint, kept
 * honest by moving the control).
 */

import { Fragment, useCallback, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { SQL_PATH_UNAVAILABLE_CODE } from '../../shared/sql-protocol.ts'
import { connectionReadout } from './sql-connection-readout.ts'
import type { SqlRuntime } from './sql-runtime.ts'
import css from './sql-notebook.module.css'

export interface SqlConnectionStatusProps {
  runtime: SqlRuntime
  tabId: string
  t: TranslateNS<'workbench'>
}

export function SqlConnectionStatus({ runtime, tabId, t }: SqlConnectionStatusProps) {
  const subscribe = useCallback((notify: () => void) => runtime.subscribe(tabId, notify), [runtime, tabId])
  const readState = useCallback(() => runtime.peek(tabId), [runtime, tabId])
  const state = useSyncExternalStore(subscribe, readState)

  const connection = state?.connection ?? null
  // A file that was renamed or deleted arrives as this code on whichever call touched it. There is
  // no file watcher by design, so the readout is where the reader learns to reconnect rather than
  // wondering why every later cell fails.
  const lostFile = state !== null && Object.values(state.cells).some(run => run.failure?.code === SQL_PATH_UNAVAILABLE_CODE)
  // The lost-file hint wins over everything else: it is the one thing this strip is never
  // allowed to go quiet about, whatever else on screen is already reporting.
  const text = lostFile
    ? t('sqlnotebook.reconnectHint')
    : state === null || state.connecting
        ? t('sqlnotebook.connecting')
        : connection === null
          ? t('sqlnotebook.notConnected')
          : connectionReadout(connection, { readOnly: t('sqlnotebook.readOnlyTier'), writable: t('sqlnotebook.writableTier') })

  /*
   * The two standing session banners. The strip outlives the cell surface, so it is the
   * right home for the same fact regardless of which view the reader has on screen.
   */
  const isMemory = connection !== null && connection.path === ':memory:'
  const leavesSidecar = connection?.walSidecarExpected === true
  const notices: ReactNode[] = []
  if (isMemory) notices.push(<span key="memory" className={css.statusBarNotice}>{t('sqlnotebook.memoryNotice')}</span>)
  if (leavesSidecar) notices.push(<span key="sidecar" className={css.statusBarNotice}>{t('sqlnotebook.walSidecarNotice')}</span>)
  if (notices.length === 0 && text === '') return null
  return (
    <Fragment>
      {text === '' ? null : <span>{text}</span>}
      {notices}
    </Fragment>
  )
}
