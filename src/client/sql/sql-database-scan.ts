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
 *
 * ## Why dependency trees are skipped
 *
 * Measured on this repository, which holds 1466 directories under `node_modules` against a
 * 200-directory budget: the walk spent 181 of its 200 listings inside `node_modules` and found
 * only the five databases that live in `examples/`. A budget a dependency tree can exhaust on its
 * own is not a cap, it is a filter that hides the reader's own files — and `truncated` cannot say
 * so honestly, because "the list is partial" and "the list is partial and everything missing is
 * third-party" are different sentences. `.git` was already skipped for the same reason.
 *
 * This walk runs on the notebook's toolbar, so its cost is paid on the critical path of opening a
 * notebook — which is why the same skip the notebook scan carries matters twice here.
 */

import type { DirectoryListing } from '../../shared/contracts.ts'
import { isDatabasePath } from '../../shared/sql-protocol.ts'

/** Directories one scan will list before it stops and says so. */
export const SQL_SCAN_MAX_DIRECTORIES = 200

/** Database files one scan will offer before it stops and says so. */
export const SQL_SCAN_MAX_RESULTS = 50

/**
 * Directory names a scan never descends into.
 *
 * Both hold another tool's storage rather than anything the reader put there, so a database under
 * either is not one anybody is looking for. Kept as one list, and in step with the notebook scan's
 * copy, because a walk that descends into a tree the other one skips is how the two start
 * disagreeing about what "the workspace" means.
 */
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules'])

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
        // to spend the whole directory budget on an object store. `node_modules` is the same
        // hazard at a hundred times the size — measured, it ate 181 of 200 listings.
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue
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
