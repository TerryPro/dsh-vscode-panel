/**
 * One walk of the workspace, collecting both kinds of file the SQL panel needs.
 *
 * The panel lists notebooks, and it filters that list by database, and the notebook toolbar lists
 * databases to connect to. All three read from this one walk.
 *
 * ## Why a single walk rather than one per list
 *
 * This module used to be two — `scanSqlNotebooks` and `scanDatabases` — each doing its own
 * breadth-first traversal. Both are serial: one `/tree` round trip per directory, awaited before
 * the next. Measured on this repository, each walk listed 200 directories, so the panel paid
 * **two full traversals of the same tree** to answer one question. That shape is the exact bug
 * this session already fixed once — the picker taking "ages" to name a notebook's database — and
 * adding a second list to the panel without merging the walks would have re-introduced it
 * deliberately.
 *
 * ## The two caps stay separate
 *
 * Notebooks and databases have different limits (100 and 50, carried over from the two modules
 * this replaces), and each reports its own truncation. They cannot share one boolean: a workspace
 * with 60 databases and 5 notebooks has a *complete* notebook list and a *partial* database list,
 * and one flag would have to lie about one of them. The walk stops early only once **both** are
 * full; until then it keeps collecting whichever list still has room.
 *
 * The directory budget and a folder that cannot be listed are different: both mean the walk did
 * not see part of the tree, so they mark **both** lists partial.
 *
 * ## Why dependency trees are skipped
 *
 * Measured here, `node_modules` holds 1466 directories against a 200-directory budget: an
 * unskipped walk spent 181 of its 200 listings inside it and never reached the reader's own
 * folders. A budget a dependency tree can exhaust on its own is not a cap, it is a filter that
 * hides the reader's files — and a truncation notice cannot say so honestly, because "the list is
 * partial" and "the list is partial and everything missing is third-party" are different
 * sentences. `.git` is the same argument in miniature.
 *
 * Only entries the Host reported as regular files are collected: `/tree` labels a symlink with its
 * own kind, so the walk drops it here, and the Host refuses one again with `SYMLINK_UNSUPPORTED`
 * at open. Hiding the row is kinder than offering a path that will fail, and the second gate is
 * the one that matters — a listing can change between the scan and the click.
 */

import type { DirectoryListing } from '../../shared/contracts.ts'
import { isDatabasePath } from '../../shared/sql-protocol.ts'
import { isSqlNotebookPath } from './sql-notebook-document.ts'

/** Directories one walk will list before it stops and says so. */
export const SQL_WORKSPACE_SCAN_MAX_DIRECTORIES = 200

/** Notebooks one walk will list before it stops and says so. */
export const SQL_WORKSPACE_SCAN_MAX_NOTEBOOKS = 100

/** Database files one walk will list before it stops and says so. */
export const SQL_WORKSPACE_SCAN_MAX_DATABASES = 50

/** Notebooks one walk reads at once, so a large workspace is not a burst of reads. */
export const SQL_WORKSPACE_SCAN_READ_CONCURRENCY = 8

/**
 * Directory names the walk never descends into.
 *
 * Both hold another tool's storage rather than anything the reader wrote, so a notebook or a
 * database under either is not something anybody is looking for. One list for both kinds — a walk
 * that descends into a tree the other skips is how two views of "the workspace" start disagreeing.
 */
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules'])

/**
 * A notebook the walk found, addressed as a workspace-relative path.
 */
export interface SqlNotebookChoice {
  path: string
  /** Shown in the list row; derived from `path`. */
  name: string
  /**
   * The database this notebook declares in its own `connection.path` field.
   *
   * Present only when the file was readable and named something the connection layer would open.
   * Absent when the file could not be read, when it records no `connection`, when the path is
   * `:memory:` (a connection target, never a workspace-relative path), or when it names a file
   * the Host would refuse at open. This is also what the panel's database filter matches on: the
   * row's second line and the filter read the same field, so a notebook can never be filed under
   * one database while its row says another.
   */
  explicitDatabase: { path: string, name: string } | null
}

/** A database file the walk found. */
export interface SqlDatabaseChoice {
  path: string
  /** Shown in the row. Carried because a picker of `a.db` files still needs to say which is which. */
  name: string
}

export interface SqlWorkspaceScan {
  /** Sorted by path so a refresh does not shuffle the rows. */
  notebooks: SqlNotebookChoice[]
  /** Sorted by path, for the same reason. */
  databases: SqlDatabaseChoice[]
  /** Directories actually listed, for diagnostics. */
  visited: number
  /**
   * True when the notebook list is not everything the workspace holds — its own cap ran out, or
   * the walk did not finish (budget spent, or a folder that could not be listed).
   */
  notebooksTruncated: boolean
  /** The same claim, for the database list. Independent of the one above by design. */
  databasesTruncated: boolean
}

/** Walk the workspace once and collect both the notebooks and the databases it holds. */
export async function scanWorkspace(args: {
  list: (path: string) => Promise<DirectoryListing>
  /**
   * Read one `.sqlnb` file's text.
   *
   * Whole, not a prefix: the field this walk needs is written after the cells, so a caller that
   * returns only the head of the file silently answers "no database" for every notebook holding
   * results. Databases need no read at all — the listing already named them.
   */
  readNotebook: (path: string) => Promise<string>
  maxNotebooks?: number
  maxDatabases?: number
  maxDirectories?: number
}): Promise<SqlWorkspaceScan> {
  const maxNotebooks = args.maxNotebooks ?? SQL_WORKSPACE_SCAN_MAX_NOTEBOOKS
  const maxDatabases = args.maxDatabases ?? SQL_WORKSPACE_SCAN_MAX_DATABASES
  const maxDirectories = args.maxDirectories ?? SQL_WORKSPACE_SCAN_MAX_DIRECTORIES
  const notebooks: SqlNotebookChoice[] = []
  const databases: SqlDatabaseChoice[] = []
  const queue = ['']
  const seenDirectories = new Set<string>()
  let visited = 0
  let notebooksTruncated = false
  let databasesTruncated = false

  while (queue.length > 0) {
    // Both lists full: nothing left that this walk is allowed to collect, so the remaining
    // directories are not worth a round trip each. Each cap has already said so itself.
    if (notebooks.length >= maxNotebooks && databases.length >= maxDatabases) break

    const directory = queue.shift() ?? ''
    if (seenDirectories.has(directory)) continue
    seenDirectories.add(directory)
    if (visited >= maxDirectories) {
      // The budget ran out with directories still queued, so whatever is in them is unseen —
      // and unseen could hold either kind, so both lists admit it.
      notebooksTruncated = true
      databasesTruncated = true
      break
    }
    visited += 1

    let listing: DirectoryListing
    try {
      listing = await args.list(directory)
    } catch {
      // A folder the Host will not list (a permission failure, a mount that vanished) is reported
      // as an incomplete walk rather than aborting it: what the other folders yielded is still
      // worth showing, and an empty list would say "none".
      notebooksTruncated = true
      databasesTruncated = true
      continue
    }
    // A listing the Host itself clipped says the same thing for both kinds.
    if (listing.truncated) {
      notebooksTruncated = true
      databasesTruncated = true
    }

    for (const entry of listing.entries) {
      if (entry.kind === 'directory') {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue
        queue.push(entry.path)
        continue
      }
      if (entry.kind !== 'file') continue

      // The same predicate the tab logic uses, so a `.SQLNB` this build opens is a `.SQLNB` this
      // list offers; a second extension test here is how the two sides start disagreeing.
      if (isSqlNotebookPath(entry.name)) {
        if (notebooks.length >= maxNotebooks) continue
        notebooks.push({ path: entry.path, name: entry.name, explicitDatabase: null })
        // Reached by having collected the cap, not by proving nothing else exists: a breadth-first
        // walk cannot know that without finishing the budget.
        if (notebooks.length >= maxNotebooks) notebooksTruncated = true
        continue
      }
      if (isDatabasePath(entry.name)) {
        if (databases.length >= maxDatabases) continue
        databases.push({ path: entry.path, name: entry.name })
        if (databases.length >= maxDatabases) databasesTruncated = true
      }
    }
  }

  // Read what each notebook records, bounded so a workspace of a hundred large notebooks does not
  // open a hundred reads at once. A file that cannot be read keeps `null` rather than being dropped
  // from the list: the reader can still open it and be told why.
  await mapWithLimit(notebooks, SQL_WORKSPACE_SCAN_READ_CONCURRENCY, async (notebook) => {
    notebook.explicitDatabase = await readRecordedDatabase(notebook.path, args.readNotebook)
  })

  notebooks.sort((left, right) => left.path.localeCompare(right.path))
  databases.sort((left, right) => left.path.localeCompare(right.path))

  return { notebooks, databases, visited, notebooksTruncated, databasesTruncated }
}

/** The database one notebook records, or null when it records none this layer would open. */
async function readRecordedDatabase(
  notebookPath: string,
  readNotebook: (path: string) => Promise<string>,
): Promise<{ path: string, name: string } | null> {
  let raw: string
  try {
    raw = await readNotebook(notebookPath)
  } catch {
    // Too large for the Host to hand over, or gone since the listing was taken. Either way there
    // is no database to name, and the row must not invent one.
    return null
  }

  let json: { connection?: { path?: unknown } }
  try {
    json = JSON.parse(raw)
  } catch {
    return null
  }

  const connectionPath = json.connection?.path
  if (typeof connectionPath !== 'string' || connectionPath === '') return null
  // `:memory:` is a connection target, not a workspace path.
  if (connectionPath === ':memory:') return null

  // The recorded path is workspace-relative, so it is resolved from the workspace root — the same
  // way the Host resolves it when the notebook connects. Only the basename decides whether this is
  // a database: a dotted directory name must not be able to answer that question.
  const name = connectionPath.split('/').at(-1) ?? connectionPath
  if (!isDatabasePath(name)) return null

  // Returned as recorded rather than resolved: the caller shows it, and the Host is the one that
  // reports a file which is no longer there.
  return { path: connectionPath, name }
}

/**
 * Run one task per item with at most `limit` in flight.
 *
 * The task is expected to handle its own failures, which is what lets this stay a plain loop
 * instead of a result collector: a notebook that cannot be read is `null`, not an error.
 */
async function mapWithLimit<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor]
      cursor += 1
      if (item === undefined) continue
      await task(item)
    }
  })
  await Promise.all(workers)
}
