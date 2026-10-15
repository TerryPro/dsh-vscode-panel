/**
 * Recursively scan the workspace for `.sqlnb` files.
 *
 * Uses the same `/tree` route the file tree already calls, so the client can already perform
 * this walk without a new Host verb. The walk is breadth-first, skips `.git` (spending
 * directory budget on an object store buys nothing), and reports `truncated` whenever it
 * stops early — either because the per-walk caps ran out, or because a directory listing
 * came back already clipped by the Host.
 */

import type { DirectoryListing } from '../../shared/contracts.ts'

/** Directories one scan will list before it stops and says so. */
export const SQL_NOTEBOOK_SCAN_MAX_DIRECTORIES = 200

/** Notebook files one scan will list before it stops and says so. */
export const SQL_NOTEBOOK_SCAN_MAX_RESULTS = 100

/** A notebook the scan found, addressed as a workspace-relative path. */
export interface SqlNotebookChoice {
  path: string
  /** Shown in the list row; derived from `path`. */
  name: string
}

export interface SqlNotebookScan {
  /** Sorted by path so a refresh does not shuffle the rows. */
  notebooks: SqlNotebookChoice[]
  /** Directories actually listed, for diagnostics. */
  visited: number
  /**
   * True when the list is not everything the workspace holds.
   *
   * Set by either cap — this scan's own budget, or a directory whose listing the Host
   * already truncated.
   */
  truncated: boolean
}

/** Walk the workspace breadth-first and collect all `.sqlnb` files. */
export async function scanSqlNotebooks(args: {
  list: (path: string) => Promise<DirectoryListing>
  maxResults?: number
  maxDirectories?: number
}): Promise<SqlNotebookScan> {
  const maxResults = args.maxResults ?? SQL_NOTEBOOK_SCAN_MAX_RESULTS
  const maxDirectories = args.maxDirectories ?? SQL_NOTEBOOK_SCAN_MAX_DIRECTORIES
  const found: SqlNotebookChoice[] = []
  const queue = ['']
  const seenDirectories = new Set<string>()
  let visited = 0
  let truncated = false

  while (queue.length > 0) {
    const directory = queue.shift() ?? ''
    if (seenDirectories.has(directory)) continue
    seenDirectories.add(directory)
    if (visited >= maxDirectories) {
      truncated = true
      break
    }
    visited += 1

    let listing: DirectoryListing
    try {
      listing = await args.list(directory)
    } catch {
      truncated = true
      continue
    }
    if (listing.truncated) truncated = true

    for (const entry of listing.entries) {
      if (entry.kind === 'directory') {
        if (entry.name === '.git') continue
        queue.push(entry.path)
        continue
      }
      if (entry.kind !== 'file') continue
      if (!entry.name.endsWith('.sqlnb')) continue
      found.push({ path: entry.path, name: entry.name })
      if (found.length >= maxResults) {
        truncated = true
        break
      }
    }
    if (found.length >= maxResults) break
  }

  return {
    notebooks: found.sort((left, right) => left.path.localeCompare(right.path)),
    visited,
    truncated,
  }
}
