/**
 * Creating a `.sqlnb` from the file tree.
 *
 * Three entries want the same thing — the tree's new-notebook rows, a database file being
 * opened, and the context menu's "open in a SQL notebook" — so the name search and the
 * first write live here instead of in each click handler.
 *
 * The file is written on disk *before* the tab opens. Going through the tab instead
 * (create, open, set the draft, leave it dirty) would hand the reader an unsaved notebook
 * they never asked for, and a notebook that was never saved is a notebook that vanishes on
 * reload with nothing pointing at it.
 */

import { WorkbenchApiError, type WorkbenchApi } from '../model/api.ts'
import { childWorkspacePath } from '../../shared/path-policy.ts'
import { createSqlNotebookForDatabase, createSqlNotebookSkeleton } from './sql-notebook-document.ts'

/** The stem a tree-created notebook takes; only the counter differs between creations. */
export const SQL_NOTEBOOK_STEM = 'query'

/**
 * How many names one click may try.
 *
 * The counter is what makes a collision harmless — `createFile` refuses an existing name
 * with `FS_ALREADY_EXISTS` and the next one is tried — but a directory where every name is
 * taken has to stop somewhere, and a bounded loop says so instead of hammering the Host.
 */
export const SQL_NOTEBOOK_NAME_ATTEMPTS = 50

/** What the new notebook's first cell contains. */
export type SqlNotebookSeed =
  /** One empty SQL cell: a notebook created from nothing. */
  | 'empty'
  /** A query that lists the tables: a notebook created beside a database file. */
  | 'database'

/** The path written, or null when every generated name was already taken. */
export async function createSqlNotebook(args: {
  api: WorkbenchApi
  workspaceId: string
  /** Workspace-relative directory the notebook is created in; '' is the workspace root. */
  directory: string
  seed: SqlNotebookSeed
}): Promise<string | null> {
  const content = args.seed === 'database' ? createSqlNotebookForDatabase(undefined) : createSqlNotebookSkeleton()
  for (let attempt = 1; attempt <= SQL_NOTEBOOK_NAME_ATTEMPTS; attempt += 1) {
    const path = childWorkspacePath(args.directory, `${SQL_NOTEBOOK_STEM}-${attempt}.sqlnb`)
    try {
      await args.api.createFile(args.workspaceId, path)
    } catch (error) {
      // Only a taken name moves on; a permission or missing-parent failure is reported as
      // itself, because retrying it would just fail fifty times under a different name.
      if (error instanceof WorkbenchApiError && error.code === 'FS_ALREADY_EXISTS') continue
      throw error
    }
    const created = await args.api.readFile(args.workspaceId, path)
    await args.api.saveFile(args.workspaceId, path, content, created.version)
    return path
  }
  return null
}
