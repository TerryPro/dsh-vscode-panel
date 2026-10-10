/**
 * Notebook path recognition.
 *
 * Like the other structured views (CSV, Mermaid, JSON), the workbench decides
 * from the file's extension alone: the Host still reads `.ipynb` as plain text and
 * knows nothing about notebooks, so nothing here has a server-side twin to keep in
 * sync.
 */

import { basename } from '../../shared/path-name.ts'

/** Extensions the workbench opens as an interactive notebook. */
export const NOTEBOOK_EXTENSIONS = ['ipynb'] as const

/** Whether this workspace path is a Jupyter notebook. */
export function isNotebookPath(path: string | undefined): boolean {
  if (path === undefined) return false
  const name = basename(path).toLowerCase()
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return false
  return (NOTEBOOK_EXTENSIONS as readonly string[]).includes(name.slice(dot + 1))
}
