/**
 * The workspace walk behind the panel's notebook list.
 *
 * What matters here is what the list *claims*: which files it offers, whether it says it stopped
 * early, and — the case this spec exists for — whether the database it prints next to a notebook
 * is the one the notebook actually records. That last one was silently wrong for every notebook
 * holding results, because the panel handed the scan a 512-byte prefix and a JSON object cannot
 * be parsed from a prefix of itself. The regression cases below therefore drive the scan with a
 * reader that behaves like the real one (whole file in, whole file out) and assert the resolved
 * database, not merely that some call happened.
 */
import { describe, expect, it, vi } from 'vitest'
import type { DirectoryListing, WorkspaceEntry } from '../src/shared/contracts.ts'
import {
  scanSqlNotebooks,
  SQL_NOTEBOOK_SCAN_MAX_DIRECTORIES,
  SQL_NOTEBOOK_SCAN_MAX_RESULTS,
} from '../src/client/sql/sql-notebook-scan.ts'

function file(path: string): WorkspaceEntry {
  return { name: path.slice(path.lastIndexOf('/') + 1), path, kind: 'file' }
}

function directory(path: string): WorkspaceEntry {
  return { name: path.slice(path.lastIndexOf('/') + 1), path, kind: 'directory' }
}

function listing(path: string, entries: WorkspaceEntry[], truncated = false): DirectoryListing {
  return { path, entries, truncated }
}

/** A `.sqlnb` whose `connection` is written where the real writer puts it: after the cells. */
function notebookText(connection: { path: string; access: string } | null, pad = 0): string {
  return JSON.stringify({
    version: 2,
    cells: [{ kind: 'sql', source: 'SELECT 1', ...(pad === 0 ? {} : { results: [{ columns: [], rows: Array.from({ length: pad }, (_u, i) => [i]) }] }) }],
    ...(connection === null ? {} : { connection }),
  }, null, 2)
}

/** The scan over a fixed set of folders, with the calls it made kept for counting. */
async function scan(
  folders: Record<string, DirectoryListing>,
  options: { maxResults?: number; maxDirectories?: number; read?: (path: string) => Promise<string> } = {},
) {
  const requested: string[] = []
  const list = vi.fn((path: string) => {
    requested.push(path)
    const found = folders[path]
    if (found === undefined) return Promise.reject(new Error(`unexpected listing of ${path}`))
    return Promise.resolve(found)
  })
  const readNotebook = vi.fn(options.read ?? (() => Promise.resolve(notebookText(null))))
  const result = await scanSqlNotebooks({ list, readNotebook, ...options })
  return { ...result, requested, readNotebook }
}

describe('scanSqlNotebooks — 找得到什么', () => {
  it('finds every notebook recursively and leaves the rest of the workspace out', async () => {
    const result = await scan({
      '': listing('', [directory('notes'), file('readme.md'), file('a.sqlnb')]),
      notes: listing('notes', [file('notes/b.sqlnb'), file('notes/data.csv'), directory('notes/deep')]),
      'notes/deep': listing('notes/deep', [file('notes/deep/c.sqlnb')]),
    })

    expect(result.notebooks.map(entry => entry.path)).toEqual(['a.sqlnb', 'notes/b.sqlnb', 'notes/deep/c.sqlnb'])
    expect(result.truncated).toBe(false)
  })

  it('sorts by path so a refresh leaves the rows in the same order', async () => {
    // `/tree` answers in the order the operating system reports, which is not stable across
    // machines; a list that shuffles between two identical refreshes reads like a bug.
    const result = await scan({
      '': listing('', [directory('m'), directory('b'), file('z.sqlnb')]),
      m: listing('m', [file('m/z.sqlnb'), file('m/a.sqlnb')]),
      b: listing('b', []),
    })

    expect(result.notebooks.map(entry => entry.path)).toEqual(['m/a.sqlnb', 'm/z.sqlnb', 'z.sqlnb'])
  })

  it('matches the notebook extension whatever case the file uses', async () => {
    // The file tree opens `.SQLNB` (its predicate lowercases), so a list that missed it would
    // hide a notebook the reader can see in the tree and open by hand. Order is `localeCompare`'s,
    // which is what the scan sorts by.
    const result = await scan({
      '': listing('', [file('QUERY.SQLNB'), file('other.sqlnb')]),
    })

    expect([...result.notebooks.map(entry => entry.path)].sort((l, r) => l.localeCompare(r)))
      .toEqual(['other.sqlnb', 'QUERY.SQLNB'])
  })

  it('ignores anything that is not a regular file', async () => {
    const result = await scan({
      '': listing('', [
        { name: 'link.sqlnb', path: 'link.sqlnb', kind: 'symlink' },
        { name: 'odd.sqlnb', path: 'odd.sqlnb', kind: 'other' },
      ]),
    })

    expect(result.notebooks).toEqual([])
    expect(result.requested).toEqual([''])
  })
})

describe('scanSqlNotebooks — 遍历预算花在哪里', () => {
  /**
   * The measured reason this rule exists: in a repository with 1466 directories under
   * `node_modules`, the walk spent 181 of its 200 listings there and reached one directory under
   * `src`. A budget the dependency tree can exhaust on its own does not cap the walk, it hides
   * the reader's own notebooks behind a `truncated` flag that cannot say why.
   */
  it('never descends into node_modules or .git', async () => {
    const result = await scan({
      '': listing('', [directory('node_modules'), directory('.git'), directory('src'), file('a.sqlnb')]),
      src: listing('src', [file('src/b.sqlnb')]),
    })

    expect(result.requested).toEqual(['', 'src'])
    expect(result.notebooks.map(entry => entry.path)).toEqual(['a.sqlnb', 'src/b.sqlnb'])
    expect(result.truncated).toBe(false)
  })

  it('leaves a notebook budget for the workspace when a dependency tree is huge', async () => {
    // The real shape: the root listing carries one entry named `node_modules`, and the hundreds of
    // packages only appear once that folder is listed. Skipping it means they are never queued at
    // all, so the reader's own folder is reached with the whole budget still in hand.
    const packages = Array.from({ length: 300 }, (_u, i) => directory(`node_modules/p${i}`))
    const folders: Record<string, DirectoryListing> = {
      '': listing('', [directory('node_modules'), directory('app')]),
      node_modules: listing('node_modules', packages),
      app: listing('app', [file('app/q.sqlnb')]),
    }
    const result = await scan(folders, { maxDirectories: 5 })

    expect(result.notebooks.map(entry => entry.path)).toEqual(['app/q.sqlnb'])
    expect(result.requested).toEqual(['', 'app'])
    expect(result.truncated).toBe(false)
  })

  it('says the list is partial when it hits the result cap', async () => {
    const many = Array.from({ length: SQL_NOTEBOOK_SCAN_MAX_RESULTS + 5 }, (_u, i) => file(`q-${i}.sqlnb`))
    const result = await scan({ '': listing('', many) })

    expect(result.notebooks).toHaveLength(SQL_NOTEBOOK_SCAN_MAX_RESULTS)
    expect(result.truncated).toBe(true)
  })

  it('stops descending at the directory budget and reports the scan as incomplete', async () => {
    const folders: Record<string, DirectoryListing> = {}
    let path = ''
    for (let depth = 0; depth < SQL_NOTEBOOK_SCAN_MAX_DIRECTORIES + 20; depth += 1) {
      const next = path === '' ? `d${depth}` : `${path}/d${depth}`
      folders[path] = listing(path, [directory(next)])
      path = next
    }
    folders[path] = listing(path, [file(`${path}/late.sqlnb`)])
    const result = await scan(folders)

    expect(result.requested).toHaveLength(SQL_NOTEBOOK_SCAN_MAX_DIRECTORIES)
    expect(result.notebooks).toEqual([])
    expect(result.truncated).toBe(true)
  })

  it('inherits a folder listing the Host already truncated', async () => {
    const result = await scan({ '': listing('', [file('a.sqlnb')], true) })

    expect(result.notebooks.map(entry => entry.path)).toEqual(['a.sqlnb'])
    expect(result.truncated).toBe(true)
  })

  it('keeps the folders it can read when one cannot be listed', async () => {
    // An unreadable folder is not an empty folder. Reporting a complete scan here would tell the
    // reader the workspace holds one notebook when the answer is "the rest is unknown".
    const folders: Record<string, DirectoryListing> = {
      '': listing('', [directory('locked'), directory('open')]),
      open: listing('open', [file('open/ok.sqlnb')]),
    }
    const result = await scanSqlNotebooks({
      list: (path: string) => {
        const found = folders[path]
        if (found === undefined) return Promise.reject(new Error('EACCES'))
        return Promise.resolve(found)
      },
      readNotebook: () => Promise.resolve(notebookText(null)),
    })

    expect(result.notebooks.map(entry => entry.path)).toEqual(['open/ok.sqlnb'])
    expect(result.truncated).toBe(true)
  })
})

describe('scanSqlNotebooks — 每个笔记连的是哪个库', () => {
  /**
   * The regression this file exists for.
   *
   * `connection` is appended after `cells` by `writeSqlNotebookConnection`, so in any notebook
   * that has recorded a result it sits past the first kilobyte. The panel used to read the first
   * 512 bytes and `JSON.parse` them; the prefix is not valid JSON, the parse threw, and the row
   * reported "no database" for a notebook that names one. Measured across `examples/`: 21 of 24.
   */
  it('resolves the recorded database even when it sits past the first 512 bytes', async () => {
    const text = notebookText({ path: 'data/orders.db', access: 'read-only' }, 400)
    expect(text.indexOf('"connection"')).toBeGreaterThan(512)
    const result = await scan(
      { '': listing('', [file('big.sqlnb')]) },
      { read: () => Promise.resolve(text) },
    )

    expect(result.notebooks[0]?.explicitDatabase).toEqual({ path: 'data/orders.db', name: 'orders.db' })
  })

  it('asks for the whole file rather than a prefix of it', async () => {
    // Stated as a call assertion as well as a behaviour one: a reader that quietly slices again
    // would still resolve small notebooks, and only the large ones would go wrong.
    const text = notebookText({ path: 'demo.db', access: 'writable' }, 400)
    const result = await scan({ '': listing('', [file('q.sqlnb')]) }, { read: () => Promise.resolve(text) })

    expect(result.readNotebook).toHaveBeenCalledWith('q.sqlnb')
    expect(result.readNotebook.mock.calls[0]?.[0]).toBe('q.sqlnb')
  })

  it('reads a notebook whose file is only the connection record and no results', async () => {
    const result = await scan(
      { '': listing('', [file('fresh.sqlnb')]) },
      { read: () => Promise.resolve(notebookText({ path: 'demo.db', access: 'read-only' })) },
    )

    expect(result.notebooks[0]?.explicitDatabase).toEqual({ path: 'demo.db', name: 'demo.db' })
  })

  it('reports no database for a notebook that records none', async () => {
    const result = await scan(
      { '': listing('', [file('plain.sqlnb')]) },
      { read: () => Promise.resolve(notebookText(null)) },
    )

    expect(result.notebooks[0]?.explicitDatabase).toBeNull()
  })

  it('reports no database for an in-memory notebook', async () => {
    // `:memory:` is a connection target, not a workspace path, so the row must not print it as
    // though it were a file the reader could find.
    const result = await scan(
      { '': listing('', [file('mem.sqlnb')]) },
      { read: () => Promise.resolve(notebookText({ path: ':memory:', access: 'writable' })) },
    )

    expect(result.notebooks[0]?.explicitDatabase).toBeNull()
  })

  it('reports no database when the recorded path is not one the connection layer opens', async () => {
    const result = await scan(
      { '': listing('', [file('weird.sqlnb')]) },
      { read: () => Promise.resolve(notebookText({ path: 'notes/readme.md', access: 'read-only' })) },
    )

    expect(result.notebooks[0]?.explicitDatabase).toBeNull()
  })

  it('keeps a notebook it could not read in the list rather than dropping it', async () => {
    // Too large for the Host to hand over, or deleted since the listing. The reader can still
    // open it and be told why; a row that vanished is one they cannot act on.
    const result = await scan(
      { '': listing('', [file('gone.sqlnb'), file('ok.sqlnb')]) },
      {
        read: (path: string) => path === 'gone.sqlnb'
          ? Promise.reject(new Error('FS_TOO_LARGE'))
          : Promise.resolve(notebookText({ path: 'demo.db', access: 'read-only' })),
      },
    )

    expect(result.notebooks.map(entry => entry.path)).toEqual(['gone.sqlnb', 'ok.sqlnb'])
    expect(result.notebooks[0]?.explicitDatabase).toBeNull()
    expect(result.notebooks[1]?.explicitDatabase).toEqual({ path: 'demo.db', name: 'demo.db' })
  })

  it('survives a file whose text is not JSON at all', async () => {
    const result = await scan(
      { '': listing('', [file('broken.sqlnb')]) },
      { read: () => Promise.resolve('this is not json') },
    )

    expect(result.notebooks[0]?.explicitDatabase).toBeNull()
  })

  it('does not read the same notebook twice', async () => {
    const result = await scan(
      { '': listing('', [directory('d'), file('a.sqlnb')]), d: listing('d', [file('d/b.sqlnb')]) },
      { read: () => Promise.resolve(notebookText({ path: 'demo.db', access: 'read-only' })) },
    )

    expect(result.readNotebook).toHaveBeenCalledTimes(2)
  })

  it('bounds how many notebooks it reads at once', async () => {
    // A workspace of a hundred large notebooks must not become a hundred simultaneous reads.
    let inFlight = 0
    let peak = 0
    const many = Array.from({ length: 40 }, (_u, i) => file(`q-${i}.sqlnb`))
    await scan({ '': listing('', many) }, {
      read: async () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise(resolve => setTimeout(resolve, 0))
        inFlight -= 1
        return notebookText({ path: 'demo.db', access: 'read-only' })
      },
    })

    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(8)
  })
})
