/**
 * What the SQL notebook tab is attached to, for the editor's status strip.
 *
 * This is the **one** place that sentence is said, in both views of a `.sqlnb`. The cell surface
 * used to paint `库名 · 档别 · 上限` in a row of its own directly above the strip, and the strip
 * held its copy back while that row was on screen (ADR 0008's `hideReadout`). Two rows, one
 * sentence, and the reader had to know which of them was the authority — so the row is gone and
 * the strip says it always. It is the surface that outlives both views, and the one the kernel
 * chip already uses for the same fact on an `.ipynb`.
 *
 * Deliberately not `NotebookKernelStatus`: that chip reports a kernel's phase, and an in-process
 * handle has no phase — a reader told "ready" about a handle would be told about something that
 * does not exist. What this shows is the database, the tier it was granted and the row cap.
 *
 * The two standing session facts — a read-only handle on a WAL database still leaves the
 * sidecar files, and an in-memory database evaporates with the handle — live here too: they are
 * true for the whole session, and a banner above the cells is only on screen while a specific
 * cell is. A notice the reader sees in one view and not the other is a fact they have to
 * remember the toolbar for (#16's complaint, kept honest by moving the control).
 */

import { Fragment, useCallback, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { SQL_PATH_UNAVAILABLE_CODE } from '../../shared/sql-protocol.ts'
import { connectionReadout } from './sql-connection-readout.ts'
import type { SqlNotebookConnectionRecord } from './sql-notebook-document.ts'
import type { SqlRuntime } from './sql-runtime.ts'
import css from './sql-notebook.module.css'

export interface SqlConnectionStatusProps {
  runtime: SqlRuntime
  tabId: string
  /**
   * The database this notebook's own file names, read from its `connection` record.
   *
   * Only consulted while the tab has no runtime yet: `bind` seeds the store with the same record,
   * so from that moment the store is the authority and this is dead weight. The gap it covers is
   * the paint before the bind effect runs — and in the source view, where no surface mounts to
   * bind anything and the sidebar may be closed, the whole time. Without it the strip would open
   * on "connecting…" for a notebook whose file already named its database, which is the frame the
   * reader reads as *disconnected while loading*.
   */
  recorded: SqlNotebookConnectionRecord | null
  t: TranslateNS<'workbench'>
}

export function SqlConnectionStatus({ runtime, tabId, recorded, t }: SqlConnectionStatusProps) {
  const subscribe = useCallback((notify: () => void) => runtime.subscribe(tabId, notify), [runtime, tabId])
  const readState = useCallback(() => runtime.peek(tabId), [runtime, tabId])
  const state = useSyncExternalStore(subscribe, readState)

  const connection = state?.connection ?? null
  // A file that was renamed or deleted arrives as this code on whichever call touched it. There is
  // no file watcher by design, so the readout is where the reader learns to reconnect rather than
  // wondering why every later cell fails.
  const lostFile = state !== null && Object.values(state.cells).some(run => run.failure?.code === SQL_PATH_UNAVAILABLE_CODE)
  /**
   * The strip's one line.
   *
   * `lostFile` is checked first: it outranks the readout because the readout would keep naming the
   * path the handle was opened on until the reader disconnects, and a line that says `demo.db ·
   * 只读` about a file that is gone is the one thing this row must not claim.
   *
   * `rowLimit: 0` is the marker `connectionReadout` reads as "the Host has not answered" and drops
   * the cap segment for, which is what lets the fallback name a real path and tier without
   * inventing a number nobody granted.
   */
  const text = lostFile
    ? t('sqlnotebook.reconnectHint')
    : state === null
      ? recorded === null
        ? t('sqlnotebook.notConnected')
        : connectionReadout({ path: recorded.path, access: recorded.access, rowLimit: 0 }, {
          readOnly: t('sqlnotebook.readOnlyTier'),
          writable: t('sqlnotebook.writableTier'),
        })
      : state.connecting && connection === null
        ? t('sqlnotebook.connecting')
        : connection === null
          ? t('sqlnotebook.notConnected')
          : connectionReadout(connection, { readOnly: t('sqlnotebook.readOnlyTier'), writable: t('sqlnotebook.writableTier') })

  /*
   * The two standing session banners. The strip is on screen in both views, so it is the home
   * for the same fact whichever one the reader is in.
   */
  const isMemory = connection !== null && connection.path === ':memory:'
  const leavesSidecar = connection?.walSidecarExpected === true
  const notices: ReactNode[] = []
  if (isMemory) notices.push(<span key="memory" className={css.statusBarNotice}>{t('sqlnotebook.memoryNotice')}</span>)
  if (leavesSidecar) notices.push(<span key="sidecar" className={css.statusBarNotice}>{t('sqlnotebook.walSidecarNotice')}</span>)
  return (
    <Fragment>
      {/* `role="status"` came with the row this replaced: the line is the reader's only notice that
       * a handle just opened, refused, or went away underneath them, and the strip itself is a
       * `contentinfo` landmark, which no screen reader treats as live. */}
      <span role="status">{text}</span>
      {notices}
    </Fragment>
  )
}
