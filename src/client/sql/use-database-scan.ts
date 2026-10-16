/**
 * The workspace database list behind the SQL notebook's connection picker.
 *
 * One surface asks the question now — the notebook's toolbar has been the only picker since ADR
 * 0008 moved the sidebar's copy out — but the state around the walk stays here rather than folded
 * back into the surface: it is the two-state pair plus the superseded-walk guard that a mount has
 * to get right, and it is the part worth keeping out of a component already holding a toolbar.
 *
 * ## It reads the shared cache; it does not walk
 *
 * The walk itself lives in `sql-workspace-scan.ts`, and the panel already pays for it — the same
 * traversal collects both the notebooks and the databases. This hook therefore *asks* for the
 * result rather than starting its own walk on mount.
 *
 * That is not a micro-optimisation. It used to call `scanDatabases` on every mount, so switching
 * tabs, collapsing the editor column, or reopening the notebook each paid for a fresh
 * breadth-first traversal of the workspace — one `/tree` round trip per directory, awaited one at
 * a time. That is the same serial-traversal shape this session already fixed once on the panel
 * side, and leaving a second copy of it here would mean the fix only held until someone opened a
 * notebook.
 *
 * The consequence the reader should expect: the list is now as fresh as the panel's, and the
 * toolbar's own rescan button is what forces a new walk.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { SqlDatabaseChoice } from './sql-workspace-scan.ts'
import type { SqlWorkspaceCache, SqlWorkspaceScanner } from './sql-workspace-cache.ts'

export interface DatabaseScanState {
  /** The databases the last walk found, empty before one has finished. */
  databases: SqlDatabaseChoice[]
  scanning: boolean
  /**
   * True when the list is not everything the workspace holds. Said on the picker, because a short
   * list that claims to be complete is the failure the flag exists to prevent.
   */
  truncated: boolean
  /** Walk again. */
  rescan: () => void
}

export function useDatabaseScan(
  cache: SqlWorkspaceCache,
  workspaceId: string | undefined,
  scanner: SqlWorkspaceScanner | null,
): DatabaseScanState {
  const [databases, setDatabases] = useState<SqlDatabaseChoice[]>([])
  const [truncated, setTruncated] = useState(false)
  const [scanning, setScanning] = useState(false)
  /**
   * Which request the screen is allowed to show.
   *
   * A boolean "still wanted" flag cannot express this: two walks can be in flight at once (a mount
   * and a rescan), both see the flag true, and whichever answers *last* wins — which is not
   * necessarily the newer one. A counter makes "is this still the answer I asked for" decidable.
   */
  const request = useRef(0)

  const run = useCallback((force: boolean): void => {
    if (workspaceId === undefined || scanner === null) return
    request.current += 1
    const ticket = request.current
    setScanning(true)
    const walk = force ? cache.refresh(workspaceId, scanner) : cache.ensure(workspaceId, scanner)
    void walk.then(
      result => {
        if (request.current !== ticket) return
        setDatabases(result.databases)
        setTruncated(result.databasesTruncated)
        setScanning(false)
      },
      () => {
        // A walk that failed leaves the previous list on screen rather than clearing it: an
        // empty picker would read as "the workspace has no databases", which is a claim, not a
        // failure. The next mount or rescan asks again.
        if (request.current !== ticket) return
        setScanning(false)
      },
    )
  }, [cache, scanner, workspaceId])

  useEffect(() => {
    run(false)
    // Retire whatever this mount was waiting on, so a walk that answers after the surface is gone
    // cannot write into a component that is no longer there.
    return () => { request.current += 1 }
  }, [run])

  return { databases, scanning, truncated, rescan: () => { run(true) } }
}
