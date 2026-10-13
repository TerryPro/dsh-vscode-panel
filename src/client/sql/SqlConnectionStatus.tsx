/**
 * What the SQL notebook tab is attached to, for the editor's status strip.
 *
 * The notebook toolbar already shows this while the cell surface is on screen, and the source view
 * has no toolbar — which is exactly when the connection is invisible everywhere else. The strip is
 * the one place both views share, so the readout lives here rather than being duplicated per view.
 *
 * Deliberately not `NotebookKernelStatus`: that chip reports a kernel's phase, and an in-process
 * handle has no phase — a reader told "ready" about a handle would be told about something that
 * does not exist. What this shows is the database, the tier it was granted and the row cap.
 */

import { useCallback, useSyncExternalStore } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { SQL_PATH_UNAVAILABLE_CODE } from '../../shared/sql-protocol.ts'
import { connectionReadout } from './sql-connection-readout.ts'
import type { SqlRuntime } from './sql-runtime.ts'

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
  const text = lostFile
    ? t('sqlnotebook.reconnectHint')
    : state === null || state.connecting
      ? t('sqlnotebook.connecting')
      : connection === null
        ? t('sqlnotebook.notConnected')
        : connectionReadout(connection, { readOnly: t('sqlnotebook.readOnlyTier'), writable: t('sqlnotebook.writableTier') })

  // Plain text inside the strip's own flex row: the strip owns the spacing, and a class nothing
  // styles would be a hook with no consumer.
  return <span>{text}</span>
}
