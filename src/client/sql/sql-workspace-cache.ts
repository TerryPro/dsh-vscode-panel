/**
 * Workspace-wide cache for the SQL panel and the notebook toolbar.
 *
 * The panel used to run a full workspace walk on every mount, and the Host reported that as the
 * panel's worst hot path: opening a `.sqlnb` from the file tree, switching workspaces, even just
 * toggling the side panel closed and open again each paid for a directory listing. The walk itself
 * is not the problem — it caps at 200 directories and walks breadth-first — but doing it on every
 * mount is. The panel only ever needs the most recent result, and the result is invalidated exactly
 * when the user asks (the panel's refresh button) or when the workspace changes (the controller's
 * `setWorkspace` calls `invalidate`).
 *
 * It holds one walk's two lists — the notebooks and the databases — because both surfaces read both
 * kinds and a walk per list would double the round trips for one answer. See the header of
 * `sql-workspace-scan.ts` for why that doubling is the bug this shape exists to prevent.
 *
 * Cache values:
 * - `null`                 — never scanned, or invalidated. `ensure()` will run a scan.
 * - `SqlWorkspaceScan`     — the most recent scan, returned as-is by `ensure()`
 *                            and overwritten by a `refresh()`.
 *
 * ## One walk at a time, and only the newest one counts
 *
 * Two walks can genuinely overlap: the panel mounts (walk A), the reader presses refresh before
 * A answers (walk B), and A is the slower of the two. Ordering by *arrival* would then let A
 * write its stale answer over B's — measured, with A started first and finishing last, the cache
 * ended up holding A's notebook list while the reader had just asked for a fresh one.
 *
 * Every walk therefore takes a generation number. A walk may clear the in-flight slot and write
 * the snapshot only while its own generation is still the current one, so the older walk's late
 * answer is dropped instead of published. `invalidate()` and `refresh()` both move the
 * generation on, which is what makes "the reader asked for something newer" mean the same thing
 * as "this walk no longer counts".
 *
 * The cache is held on `WorkbenchController` (one instance per browser tab) so
 * it survives every React remount, and the controller is the one place that
 * already knows when the workspace changed. Tests create a fresh cache per
 * `mount()` via the controller's constructor.
 */
import { scanWorkspace, type SqlWorkspaceScan } from './sql-workspace-scan.ts'
import type { DirectoryListing } from '../../shared/contracts.ts'

/** Source for one scan; the panel hands its `listDirectory`/`readFile` wrappers in. */
export interface SqlWorkspaceScanner {
  list: (path: string) => Promise<DirectoryListing>
  readNotebook: (path: string) => Promise<string>
}

/**
 * The scanner both SQL surfaces walk the workspace with.
 *
 * One factory rather than two hand-written objects, because the `readNotebook` half carries a rule
 * that is easy to get subtly wrong and expensive to re-learn: it must return the **whole** file.
 * A notebook's `connection` record is appended after its cells, so a caller that slices the text
 * to a header hands the walk something that is not valid JSON, and every notebook holding results
 * silently reports "no database" — measured on `examples/`, 21 of 24.
 */
export function sqlWorkspaceScanner(
  api: {
    listDirectory: (workspaceId: string, path: string) => Promise<DirectoryListing>
    readFile: (workspaceId: string, path: string) => Promise<{ content: string }>
  },
  workspaceId: string,
): SqlWorkspaceScanner {
  return {
    list: path => api.listDirectory(workspaceId, path),
    readNotebook: async path => (await api.readFile(workspaceId, path)).content,
  }
}

/** Result the panel renders: `null` means "never scanned" rather than "scanned and empty". */
export type SqlWorkspaceSnapshot = SqlWorkspaceScan | null

/** The filter value meaning "every notebook, whatever database it is on". */
export const SQL_FILTER_ALL = ''

/**
 * The filter value meaning "the notebooks that record no database at all".
 *
 * A workspace-relative path can never contain NUL — the same reason the SQL backend uses NUL as
 * its key separator — so this cannot collide with a real database path, and the panel's
 * comparison can stay a plain string equality without a second "is this a sentinel" flag.
 */
export const SQL_FILTER_UNASSOCIATED = '\u0000unassociated'

export class SqlWorkspaceCache {
  private snapshot: SqlWorkspaceSnapshot = null
  private inflight: Promise<SqlWorkspaceScan> | null = null
  /** Workspace the cached snapshot belongs to. A scan started under workspace A
   * must not be served to a panel that has since switched to workspace B. */
  private snapshotWorkspace: string | null = null
  /** Workspace the in-flight walk belongs to, so a request for another one does not
   * dedup onto a walk that can never answer it. */
  private inflightWorkspace: string | null = null
  /**
   * Which walk is the current one.
   *
   * Bumped by every walk that starts and by every invalidation, so a walk that has been
   * superseded can tell — and drop its answer rather than publish it over a newer one.
   */
  private generation = 0
  /** The database the panel is filtered to; `SQL_FILTER_ALL` until the reader picks one. */
  private filter: string = SQL_FILTER_ALL
  /** Workspace the remembered filter belongs to; see `databaseFilter`. */
  private filterWorkspace: string | null = null

  /** The most recent scan, or `null` when no scan has been performed yet. */
  current(): SqlWorkspaceSnapshot {
    return this.snapshot
  }

  /**
   * Read the cache; when it is empty, run a scan and remember the result.
   *
   * Returning the in-flight promise is what keeps two simultaneous mounts from
   * starting two scans. That dedup is scoped to the workspace the walk was started for: a
   * request for a different workspace starts its own walk, because the answer in flight was
   * never going to describe the workspace being asked about.
   */
  async ensure(workspaceId: string, scanner: SqlWorkspaceScanner): Promise<SqlWorkspaceScan> {
    if (this.snapshot !== null && this.snapshotWorkspace === workspaceId) return this.snapshot
    if (this.inflight !== null && this.inflightWorkspace === workspaceId) return this.inflight
    // Mark the workspace before the scan starts so a concurrent `invalidate()`
    // (which resets `snapshotWorkspace` to `null`) makes the post-scan check
    // below fail and the result is dropped. Without this the in-flight walk
    // would overwrite a freshly invalidated cache.
    this.snapshotWorkspace = workspaceId
    this.generation += 1
    const generation = this.generation
    const promise = scanWorkspace({ list: scanner.list, readNotebook: scanner.readNotebook })
      .then((result) => {
        // Both writes are gated on still being the current walk: a superseded one must not free
        // the slot a newer walk is using, and must not publish an answer the reader has already
        // asked to replace.
        if (this.generation === generation) {
          this.inflight = null
          this.inflightWorkspace = null
          if (this.snapshotWorkspace === workspaceId) this.snapshot = result
        }
        return result
      })
      .catch((error: unknown) => {
        if (this.generation === generation) {
          this.inflight = null
          this.inflightWorkspace = null
        }
        throw error
      })
    this.inflight = promise
    this.inflightWorkspace = workspaceId
    return promise
  }

  /**
   * Force a fresh scan and overwrite the cache, regardless of what was there.
   *
   * The user gets this when they hit the panel's refresh button. There is no
   * dedup with `ensure()`'s in-flight walk: a button click is an explicit
   * gesture, so even if a walk is already running we want the new one to
   * finish, and the in-flight dedup is a side benefit, not a guarantee.
   */
  async refresh(workspaceId: string, scanner: SqlWorkspaceScanner): Promise<SqlWorkspaceScan> {
    // Drop any in-flight ensure so a concurrent `ensure()` waits for our walk
    // instead of starting a parallel one. Bumping the generation here is what
    // retires the dropped walk: it is still running, and its answer must not
    // land on top of this one when it eventually arrives.
    this.inflight = null
    this.inflightWorkspace = null
    this.generation += 1
    this.snapshotWorkspace = workspaceId
    this.snapshot = null
    return this.ensure(workspaceId, scanner)
  }

  /**
   * Drop the cached snapshot; the next `ensure()` will scan again.
   *
   * Also the entry point for "something on disk changed that this cache cannot know about" —
   * creating or deleting a notebook, for instance. The cache has no watcher and must not grow
   * one; the caller that performed the write is the only party that knows it happened.
   */
  invalidate(): void {
    this.snapshot = null
    this.snapshotWorkspace = null
    this.inflight = null
    this.inflightWorkspace = null
    // A walk already running is retired here rather than merely forgotten: without this it would
    // still consider itself current and write its result into the cache it was just cleared from.
    this.generation += 1
  }

  /**
   * The database the panel is filtered to, or `SQL_FILTER_ALL` when it is unfiltered or the
   * remembered choice belongs to a different workspace.
   *
   * Held here rather than in the panel because its lifetime is this cache's, not a component's:
   * the panel unmounts whenever the reader looks at another sidebar mode, and a filter that
   * silently widened to "everything" on the way back would read as the list forgetting an
   * instruction it was given.
   *
   * The workspace is part of the question rather than something the caller is trusted to reset.
   * A remembered value names a database inside one workspace, so carrying it to another would
   * filter the panel by a file that is not there — and the panel switches workspaces without ever
   * unmounting, so a `useEffect`-based reset would be a race against the first render. Asking
   * "what is the filter *for this workspace*" makes that impossible to get wrong.
   *
   * Deliberately *not* cleared by `invalidate()`: that is also what runs after the reader creates
   * a notebook, and losing the filter there would hide the very notebook they just asked for.
   */
  databaseFilter(workspaceId: string): string {
    return this.filterWorkspace === workspaceId ? this.filter : SQL_FILTER_ALL
  }

  /** Choose the database to filter by; `SQL_FILTER_ALL` shows every notebook. */
  setDatabaseFilter(workspaceId: string, value: string): void {
    this.filterWorkspace = workspaceId
    this.filter = value
  }
}
