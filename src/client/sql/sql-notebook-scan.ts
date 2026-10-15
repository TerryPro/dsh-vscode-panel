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

/**
 * A notebook the scan found, addressed as a workspace-relative path.
 *
 * `explicitDatabase` is the database the notebook's own `connection.path` names.
 * `sameDirectoryDatabase` is the database the same directory holds, when the
 * notebook has no explicit database in its metadata.
 */
export interface SqlNotebookChoice {
  path: string
  /** Shown in the list row; derived from `path`. */
  name: string
  /**
   * The database this notebook declares in its own `connection.path` field.
   * Only present when the metadata was readable and named a file the
   * connection layer would open; absent when the file is not readable,
   * the notebook has no `connection`, or the `connection.path` is `:memory:`
   * (which is never a workspace-relative path).
   */
  explicitDatabase: { path: string, name: string } | null
  /**
   * The database the same directory as the notebook holds, if any.
   * Null when no database file in the same directory matches the
   * connection layer's accepted extensions, or when the notebook has an
   * `explicitDatabase` (which always wins). Shown in the row so a reader
   * can see what would happen if the notebook had no metadata at all.
   */
  sameDirectoryDatabase: { path: string, name: string } | null
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

/** Walk the workspace breadth-first and collect all `.sqlnb` files.

 * Each notebook's `connection.path` is read from the file (via `readNotebook`) so the
 * row can show the database the notebook actually intends rather than guessing from
 * the directory it lives in. Reading is done after the walk, not during it, so a
 * large directory listing that returns only `.sqlnb` files still stops as soon as the
 * result cap is hit and does not waste time fetching file contents.

 * The `connection.path` is resolved relative to the workspace root (not to the
 * notebook's directory), because that is how the Host resolves it when opening the
 * notebook. A resolved path that does not match a file the connection layer would
 * open is treated as "no explicit database" and falls back to the same-directory
 * heuristic. */
export async function scanSqlNotebooks(args: {
  list: (path: string) => Promise<DirectoryListing>
  /** Read the first bytes of a `.sqlnb` file to extract `connection.path`.
   *  The implementation may limit reads to just the JSON header. */
  readNotebook: (path: string) => Promise<string>
  maxResults?: number
  maxDirectories?: number
}): Promise<SqlNotebookScan> {
  const maxResults = args.maxResults ?? SQL_NOTEBOOK_SCAN_MAX_RESULTS
  const maxDirectories = args.maxDirectories ?? SQL_NOTEBOOK_SCAN_MAX_DIRECTORIES
  const found: SqlNotebookChoice[] = []
  // Directory → databases, so the second pass can answer "which database is the
  // neighbour of this notebook" in O(1).
  const databasesByDirectory = new Map<string, Array<{ path: string, name: string }>>()
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

    const databasesHere: Array<{ path: string, name: string }> = []
    for (const entry of listing.entries) {
      if (entry.kind === 'directory') {
        if (entry.name === '.git') continue
        queue.push(entry.path)
        continue
      }
      if (entry.kind !== 'file') continue
      if (entry.name.endsWith('.sqlnb')) {
        found.push({
          path: entry.path,
          name: entry.name,
          explicitDatabase: null,
          sameDirectoryDatabase: null,
        })
        if (found.length >= maxResults) {
          truncated = true
          break
        }
        continue
      }
      if (isDatabaseFile(entry.name)) {
        databasesHere.push({ path: entry.path, name: entry.name })
      }
    }
    if (databasesHere.length > 0) {
      databasesHere.sort((left, right) => left.name.localeCompare(right.name))
      databasesByDirectory.set(directory, databasesHere)
    }
    if (found.length >= maxResults) break
  }

  // Read the connection.path from each notebook and resolve it to a database file.
  // `readNotebook` is intentionally limited to a first-pass parse of just the
  // header; it should read at most the JSON header, not the full cell results.
  await Promise.allSettled(
    found.map(async (notebook) => {
      const explicitDb = await resolveExplicitDatabase(notebook.path, args.readNotebook)
      notebook.explicitDatabase = explicitDb

      const slash = notebook.path.lastIndexOf('/')
      const directory = slash < 0 ? '' : notebook.path.slice(0, slash)
      const sameDir = (databasesByDirectory.get(directory) ?? [])[0] ?? null
      notebook.sameDirectoryDatabase = sameDir
    }),
  )

  // Stable order on path.
  found.sort((left, right) => left.path.localeCompare(right.path))

  return { notebooks: found, visited, truncated }
}

/** Read the first bytes of a notebook and return the resolved database path,
 * or null when the notebook has no readable connection.path or it names a
 * non-file (e.g. `:memory:`). */
async function resolveExplicitDatabase(
  notebookPath: string,
  readNotebook: (path: string) => Promise<string>,
): Promise<{ path: string, name: string } | null> {
  let raw: string
  try {
    raw = await readNotebook(notebookPath)
  } catch {
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
  // `:memory:` is never a workspace-relative path.
  if (connectionPath === ':memory:') return null

  // The connection.path is workspace-relative; the directory it resolves
  // relative to is the workspace root, not the notebook's directory.
  const name = connectionPath.split('/').at(-1) ?? connectionPath
  if (!isDatabaseFile(name)) return null

  // Return the path as-is; the caller (SqlPanel) does not need to verify the
  // file exists here — the connection layer will report it if it does not.
  return { path: connectionPath, name }
}

/** True when `name` is one of the database file extensions the connection layer opens. */
function isDatabaseFile(name: string): boolean {
  const dot = name.lastIndexOf('.')
  if (dot < 1) return false
  return SQL_NOTEBOOK_DATABASE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
}

/** Lowercase extensions the workbench will open as a database. */
const SQL_NOTEBOOK_DATABASE_EXTENSIONS = new Set(['db', 'sqlite', 'sqlite3'])
