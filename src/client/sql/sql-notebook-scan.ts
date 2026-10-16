/**
 * Recursively scan the workspace for `.sqlnb` files.
 *
 * Uses the same `/tree` route the file tree already calls, so the client can already perform
 * this walk without a new Host verb. The walk is breadth-first, never descends into the two
 * directories that hold other tools' storage rather than the reader's own files, and reports
 * `truncated` whenever it stops early — either because the per-walk caps ran out, or because a
 * directory listing came back already clipped by the Host.
 *
 * ## Why `node_modules` is skipped rather than left to the directory budget
 *
 * Measured on this repository, which holds 1466 directories under `node_modules` against a
 * 200-directory budget: the walk spent 181 of its 200 listings inside `node_modules` and reached
 * exactly one directory under `src`. A budget the dependency tree can exhaust on its own is not
 * a cap, it is a filter that happens to hide the reader's own notebooks — and `truncated` cannot
 * say so honestly, because "the list is partial" and "the list is partial and everything missing
 * is third-party" are different sentences. `.git` was already skipped for the same reason.
 *
 * ## Why each notebook is read whole
 *
 * A row shows the database a notebook records, which lives in the file's `connection` field, so
 * the file has to be parsed — and a JSON object cannot be parsed from a prefix of itself. An
 * earlier revision read the first 512 bytes and called `JSON.parse` on them; measured across the
 * 24 notebooks in `examples/`, 21 failed to parse that way (every file holding recorded results,
 * because `connection` is written after `cells`), so their database silently read as "none". The
 * whole file is read instead: at the Host's 2 MB cap a parse costs about 1.5 ms, and the reads
 * are bounded so a large workspace cannot open a hundred of them at once.
 */

import type { DirectoryListing } from '../../shared/contracts.ts'
import { isDatabasePath } from '../../shared/sql-protocol.ts'
import { isSqlNotebookPath } from './sql-notebook-document.ts'

/** Directories one scan will list before it stops and says so. */
export const SQL_NOTEBOOK_SCAN_MAX_DIRECTORIES = 200

/** Notebook files one scan will list before it stops and says so. */
export const SQL_NOTEBOOK_SCAN_MAX_RESULTS = 100

/** Notebooks one scan reads at once, so a large workspace is not a burst of reads. */
export const SQL_NOTEBOOK_SCAN_READ_CONCURRENCY = 8

/**
 * Directory names a scan never descends into.
 *
 * Both hold another tool's storage rather than anything the reader wrote, so a `.sqlnb` under
 * either is not a notebook anybody is looking for. The measured reason the budget cannot be
 * left to make this call on its own is in this module's header.
 */
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules'])

/**
 * A notebook the scan found, addressed as a workspace-relative path.
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
   * the Host would refuse at open. All of those read as "no database" in the row, which is what
   * the reader would find if they clicked it.
   */
  explicitDatabase: { path: string, name: string } | null
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

/** Walk the workspace breadth-first and collect every `.sqlnb` file. */
export async function scanSqlNotebooks(args: {
  list: (path: string) => Promise<DirectoryListing>
  /**
   * Read one `.sqlnb` file's text.
   *
   * Whole, not a prefix: the field this scan needs is written after the cells, so a caller that
   * returns only the head of the file silently answers "no database" for every notebook holding
   * results. The cost of the honest read is stated in this module's header.
   */
  readNotebook: (path: string) => Promise<string>
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
      // reported as an incomplete scan rather than aborting the list: the notebooks in the
      // other folders are still worth offering, and an empty list would say "none".
      truncated = true
      continue
    }
    if (listing.truncated) truncated = true

    for (const entry of listing.entries) {
      if (entry.kind === 'directory') {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue
        queue.push(entry.path)
        continue
      }
      if (entry.kind !== 'file') continue
      // The same predicate the tab logic uses, so a `.SQLNB` this build opens is a `.SQLNB`
      // this list offers; a second extension test here is how the two sides start disagreeing.
      if (!isSqlNotebookPath(entry.name)) continue
      found.push({ path: entry.path, name: entry.name, explicitDatabase: null })
      if (found.length >= maxResults) {
        // Reached by having collected the cap, not by proving nothing else exists: a
        // breadth-first walk cannot know that without finishing the budget.
        truncated = true
        break
      }
    }
    if (found.length >= maxResults) break
  }

  // Read what each notebook records, bounded so a workspace of a hundred large notebooks does
  // not open a hundred reads at once. A file that cannot be read keeps `null` rather than being
  // dropped from the list: the reader can still open it and be told why.
  await mapWithLimit(found, SQL_NOTEBOOK_SCAN_READ_CONCURRENCY, async (notebook) => {
    notebook.explicitDatabase = await readRecordedDatabase(notebook.path, args.readNotebook)
  })

  found.sort((left, right) => left.path.localeCompare(right.path))

  return { notebooks: found, visited, truncated }
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

  // The recorded path is workspace-relative, so it is resolved from the workspace root — the
  // same way the Host resolves it when the notebook connects. Only the basename decides whether
  // this is a database: a dotted directory name must not be able to answer that question.
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
