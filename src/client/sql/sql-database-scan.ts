/**
 * The database list behind the SQL notebook's connection picker.
 *
 * N0-P0-2 asks for a recursive walk of the workspace with a cap and an honest "only the
 * first part is shown" note. It uses the same `/tree` route the file tree already calls, so
 * a read the client can already perform needs no new Host verb.
 *
 * Only entries the Host reported as regular files are offered: `/tree` labels a symlink with
 * its own kind, so the walk drops it here, and the Host refuses one again with
 * `SYMLINK_UNSUPPORTED` at open. The second gate is the one that matters — a listing can
 * change between the scan and the click — but hiding the row is still the kinder answer than
 * offering a path that will fail.
 */

import type { DirectoryListing } from '../../shared/contracts.ts'
import { isDatabasePath } from '../../shared/sql-protocol.ts'

/** Directories one scan will list before it stops and says so. */
export const SQL_SCAN_MAX_DIRECTORIES = 200

/** Database files one scan will offer before it stops and says so. */
export const SQL_SCAN_MAX_RESULTS = 50

/** A file the picker may offer, addressed the way every workbench path is. */
export interface SqlDatabaseChoice {
  path: string
  /** Shown in the row. Carried because a picker of `a.db` files still needs to say which is which. */
  name: string
}

export interface SqlDatabaseScan {
  /** Sorted by workspace-relative path, so a refresh does not shuffle the rows. */
  databases: SqlDatabaseChoice[]
  /** Directories actually listed, for the "searched N folders" line. */
  visited: number
  /**
   * True when this list is not everything the workspace holds.
   *
   * Set by either cap — this scan's own budget, or a directory whose listing the Host
   * already truncated. A short list that claims to be complete is the failure this flag
   * exists to prevent.
   */
  truncated: boolean
}

/** Walk the workspace breadth-first and collect the files SQLite can open. */
export async function scanDatabases(args: {
  list: (path: string) => Promise<DirectoryListing>
  maxResults?: number
  maxDirectories?: number
}): Promise<SqlDatabaseScan> {
  const maxResults = args.maxResults ?? SQL_SCAN_MAX_RESULTS
  const maxDirectories = args.maxDirectories ?? SQL_SCAN_MAX_DIRECTORIES
  const found: SqlDatabaseChoice[] = []
  const queue = ['']
  const seenDirectories = new Set<string>()
  let visited = 0
  let truncated = false

  while (queue.length > 0) {
    const directory = queue.shift() ?? ''
    if (seenDirectories.has(directory)) continue
    seenDirectories.add(directory)
    if (visited >= maxDirectories) {
      // The budget ran out with directories still queued, so whatever is in them is unseen.
      truncated = true
      break
    }
    visited += 1
    let listing: DirectoryListing
    try {
      listing = await args.list(directory)
    } catch {
      // A folder the Host will not list (a permission failure, a mount that vanished) is
      // reported as an incomplete scan rather than aborting the picker: the databases in
      // the other folders are still worth offering, and an empty list would say "none".
      truncated = true
      continue
    }
    if (listing.truncated) truncated = true
    for (const entry of listing.entries) {
      if (entry.kind === 'directory') {
        // `.git` holds nothing a reader wants to query, and walking it is the fastest way
        // to spend the whole directory budget on an object store.
        if (entry.name === '.git') continue
        queue.push(entry.path)
        continue
      }
      if (entry.kind !== 'file') continue
      if (!isDatabasePath(entry.name)) continue
      found.push({ path: entry.path, name: entry.name })
      if (found.length >= maxResults) {
        // Reached by having collected the cap, not by proving nothing else exists: a
        // breadth-first walk cannot know that without finishing the budget.
        truncated = true
        break
      }
    }
    if (found.length >= maxResults) break
  }

  return {
    databases: found.sort((left, right) => left.path.localeCompare(right.path)),
    visited,
    truncated,
  }
}
