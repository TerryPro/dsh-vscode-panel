/**
 * Which notebook the SQL surfaces are about.
 *
 * Both the sidebar panel and the collapsed rail need this answer, and neither should have to import
 * the other to get it, so it lives on its own — the same shape as `terminal-status.ts` and
 * `kernel-registry.ts`: a pure reader over the workbench snapshot, with no view around it.
 */

import type { WorkbenchFileTab, WorkbenchState } from '../model/controller.ts'
import { isSqlNotebookPath } from './sql-notebook-document.ts'

/**
 * The SQL notebook on screen: the active tab when it is a `.sqlnb`, otherwise the last one still
 * open.
 *
 * Tabs keep the order they were opened in, so "the last `.sqlnb`" is the most recently opened one —
 * what a reader who switched to the SQL view while the editor shows something else means. With no
 * notebook open this is null, and callers say so rather than guessing at "the only connection in
 * this workspace", which is something the Host does not have.
 */
export function activeSqlNotebook(state: WorkbenchState): WorkbenchFileTab | null {
  const active = state.tabs.find(tab => tab.id === state.activeTabId)
  if (active?.kind === 'file' && isSqlNotebookPath(active.path)) return active
  for (const tab of [...state.tabs].reverse()) {
    if (tab.kind === 'file' && isSqlNotebookPath(tab.path)) return tab
  }
  return null
}
