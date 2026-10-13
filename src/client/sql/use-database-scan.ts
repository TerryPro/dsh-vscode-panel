/**
 * The workspace database walk the SQL notebook's pickers list.
 *
 * Two surfaces ask the same question — the notebook's toolbar and the sidebar panel — and the
 * answer has the same lifecycle in both: one walk per mount, then only on request, because the
 * directory budget is what makes it thorough and is not a cost to pay on every render.
 *
 * The walk itself lives in `sql-database-scan.ts`; this is only the state around it, kept here so
 * neither surface grows its own copy of the wanted-flag and the two-state pair.
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
