import { describe, expect, it, vi } from 'vitest'
import type { CreatedWorkspaceEntry, SavedWorkspaceFile, WorkspaceFile } from '../src/shared/contracts.ts'
import { WorkbenchApiError, type WorkbenchApi } from '../src/client/model/api.ts'
import {
  createSqlNotebook,
  SQL_NOTEBOOK_NAME_ATTEMPTS,
  SQL_NOTEBOOK_STEM,
  type SqlNotebookSeed,
} from '../src/client/sql/sql-notebook-create.ts'
import { parseSqlNotebook, SQLNB_VERSION } from '../src/client/sql/sql-notebook-document.ts'

/**
 * A file system that behaves like the Host's create-then-save pair.
 *
 * `createFile` makes zero bytes and refuses a name that exists, and the version needed by
 * `saveFile` only comes back from reading the file — that three-call shape is exactly what
 * the helper under test has to get right, so the fake keeps it rather than shortcutting to
 * a single "create with content" call the Host does not offer.
 */
function apiFake(taken: string[] = []) {
  const existing = new Set(taken)
  const created: string[] = []
  const saved: Array<{ path: string; content: string; version: string }> = []
  const createFile = vi.fn((_workspaceId: string, path: string): Promise<CreatedWorkspaceEntry> => {
    if (existing.has(path)) return Promise.reject(new WorkbenchApiError('FS_ALREADY_EXISTS', '同名文件或目录已经存在。'))
    existing.add(path)
    created.push(path)
    return Promise.resolve({ name: path.slice(path.lastIndexOf('/') + 1), path, kind: 'file', size: 0 })
  })
  const readFile = vi.fn((_workspaceId: string, path: string): Promise<WorkspaceFile> =>
    Promise.resolve({ path, content: '', version: `version-of-${path}`, size: 0, markdown: false }))
  const saveFile = vi.fn((_workspaceId: string, path: string, content: string, version: string): Promise<SavedWorkspaceFile> => {
    saved.push({ path, content, version })
    return Promise.resolve({ path, version: 'version-2', size: content.length })
  })
  return { api: { createFile, readFile, saveFile } as unknown as WorkbenchApi, created, saved }
}

function make(directory: string, seed: SqlNotebookSeed, taken: string[] = []) {
  const fake = apiFake(taken)
  return {
    ...fake,
    result: createSqlNotebook({ api: fake.api, workspaceId: 'workspace-1', directory, seed }),
  }
}

describe('createSqlNotebook', () => {
  it('creates the next free name in the given directory and writes a valid document into it', async () => {
    const { api, created, saved, result } = make('analysis', 'empty')
    const path = await result

    expect(path).toBe(`analysis/${SQL_NOTEBOOK_STEM}-1.sqlnb`)
    expect(created).toEqual([path])
    // The bytes the file lands with have to be a document the surface can edit, not zero
    // bytes the reader has to fill in through the raw view.
    expect(saved).toHaveLength(1)
    expect(saved[0]?.path).toBe(path)
    expect(saved[0]?.version).toBe(`version-of-${path}`)
    const document = parseSqlNotebook(saved[0]?.content ?? '')
    expect(document.warning).toBeNull()
    expect(document.readOnly).toBe(false)
    expect(document.version).toBe(SQLNB_VERSION)
    expect(document.cells).toEqual([expect.objectContaining({ kind: 'sql', source: '' })])
    // The file is read once, only to learn the version the save has to present.
    expect(api.readFile).toHaveBeenCalledTimes(1)
  })

  it('walks past names that are already taken without saving into them', async () => {
    const taken = ['query-1.sqlnb', 'query-2.sqlnb']
    const { created, saved, result } = make('', 'empty', taken)
    const path = await result

    expect(path).toBe('query-3.sqlnb')
    expect(created).toEqual(['query-3.sqlnb'])
    // Two refusals happened before the success; the save belongs to the winner alone.
    expect(saved).toHaveLength(1)
    expect(saved[0]?.path).toBe('query-3.sqlnb')
  })

  it('seeds a table listing when the notebook is made beside a database', async () => {
    const { saved, result } = make('data', 'database')
    const path = await result

    expect(path).toBe('data/query-1.sqlnb')
    const document = parseSqlNotebook(saved[0]?.content ?? '')
    // One cell, and it is the query. It used to be preceded by an empty one, which made the first
    // thing the reader saw a blank row and pushed the query that reads their database down to the
    // second — against this module's own note, the README in both languages, and N0-P0-2.
    expect(document.cells.map(cell => cell.kind)).toEqual(['sql'])
    expect(document.cells[0]?.source).toContain('sqlite_master')
  })

  it('stops at the name budget rather than hammering the Host', async () => {
    const taken = Array.from({ length: SQL_NOTEBOOK_NAME_ATTEMPTS }, (_, index) => `query-${index + 1}.sqlnb`)
    const { created, saved, result } = make('', 'empty', taken)

    expect(await result).toBeNull()
    expect(created).toHaveLength(0)
    expect(saved).toHaveLength(0)
  })

  it('reports a failure that is not a taken name instead of retrying under other names', async () => {
    const failing = {
      createFile: vi.fn(() => Promise.reject(new WorkbenchApiError('WORKSPACE_ESCAPE', '不能访问工作区外的路径。'))),
      readFile: vi.fn(),
      saveFile: vi.fn(),
    } as unknown as WorkbenchApi

    await expect(createSqlNotebook({ api: failing, workspaceId: 'workspace-1', directory: '', seed: 'empty' }))
      .rejects.toThrow('不能访问工作区外的路径。')
    expect(failing.createFile).toHaveBeenCalledTimes(1)
  })
})
