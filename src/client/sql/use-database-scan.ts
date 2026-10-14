/**
 * The workspace database walk the SQL notebook's picker lists.
 *
 * One surface asks the question now — the notebook's toolbar has been the only picker since ADR
 * 0008 moved the sidebar's copy out — but the state around the walk stays here rather than folded
 * back into the surface: it is the wanted-flag plus the two-state pair that a mount has to get
 * right, and it is the part worth keeping out of a component already holding a toolbar.
 *
 * The walk itself lives in `sql-database-scan.ts`.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { DirectoryListing } from '../../shared/contracts.ts'
import { scanDatabases, type SqlDatabaseScan } from './sql-database-scan.ts'

export interface DatabaseScanState {
  /** The last completed walk, or null before one has finished. */
  scan: SqlDatabaseScan | null
  scanning: boolean
  /** Walk again. The result of the walk that is superseded is dropped, not merged. */
  rescan: () => void
}

export function useDatabaseScan(list: (directory: string) => Promise<DirectoryListing>): DatabaseScanState {
  const [scan, setScan] = useState<SqlDatabaseScan | null>(null)
  const [scanning, setScanning] = useState(false)
  // Set false on unmount so a walk that finishes after the surface is gone does not set state, and
  // so a walk superseded by a newer one cannot overwrite its result.
  const wanted = useRef(false)
  const rescan = useCallback((): void => {
    wanted.current = true
    setScanning(true)
    void scanDatabases({ list }).then((result) => {
      if (!wanted.current) return
      setScan(result)
      setScanning(false)
    }, () => {
      if (!wanted.current) return
      setScanning(false)
    })
  }, [list])

  useEffect(() => {
    rescan()
    return () => { wanted.current = false }
  }, [rescan])

  return { scan, scanning, rescan }
}
