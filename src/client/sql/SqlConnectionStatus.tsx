/**
 * What the SQL notebook tab is attached to, for the editor's status strip.
 *
 * The connection is now stated in exactly one place per view (ADR 0008): the notebook's own toolbar
 * carries it while the cell surface is on screen, and this strip carries it in the source view,
 * which has no toolbar. `hideReadout` is how the two stay out of each other's way — the same rule
 * `NotebookKernelStatus` already follows, that the strip says what nothing else on screen says.
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
  /**
   * Omit the database/tier/limit line while the notebook toolbar is on screen and already shows it.
   *
   * The hint about a vanished database file is *not* hidden: the toolbar keeps naming the database
   * it is connected to, so "that file is gone" is a fact with no other surface on screen.
   */
  hideReadout?: boolean
}

export function SqlConnectionStatus({ runtime, tabId, t, hideReadout = false }: SqlConnectionStatusProps) {
  const subscribe = useCallback((notify: () => void) => runtime.subscribe(tabId, notify), [runtime, tabId])
  const readState = useCallback(() => runtime.peek(tabId), [runtime, tabId])
  const state = useSyncExternalStore(subscribe, readState)

  const connection = state?.connection ?? null
  // A file that was renamed or deleted arrives as this code on whichever call touched it. There is
  // no file watcher by design, so the readout is where the reader learns to reconnect rather than
  // wondering why every later cell fails.
  const lostFile = state !== null && Object.values(state.cells).some(run => run.failure?.code === SQL_PATH_UNAVAILABLE_CODE)
  // Checked before `lostFile` only in the sense that losing the file wins: it is the one thing this
  // strip is never allowed to go quiet about, whatever else on screen is already reporting.
  const text = lostFile
    ? t('sqlnotebook.reconnectHint')
    : hideReadout
      ? ''
      : state === null || state.connecting
        ? t('sqlnotebook.connecting')
        : connection === null
          ? t('sqlnotebook.notConnected')
          : connectionReadout(connection, { readOnly: t('sqlnotebook.readOnlyTier'), writable: t('sqlnotebook.writableTier') })

  // Nothing at all when the toolbar is reporting: an empty span would still take a slot in the
  // strip's flex row and read as a missing value rather than as a fact stated once.
  if (text === '') return null
  // Plain text inside the strip's own flex row: the strip owns the spacing, and a class nothing
  // styles would be a hook with no consumer.
  return <span>{text}</span>
}
