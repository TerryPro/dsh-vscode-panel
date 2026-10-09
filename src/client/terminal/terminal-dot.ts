/** The one status-dot vocabulary shared by every surface that shows a terminal. */

import type { TerminalBinding, TerminalDot, WorkbenchTerminalTab } from '../model/workbench-types.ts'

/**
 * Resolve what a tab's status dot may claim.
 *
 * A tab with no Session to address its process through has nothing confirmed, so
 * the dot reports `unclaimed` rather than repeating a phase no view ever answered.
 * There is no longer a "belongs to another Session" case: a tab keeps being driven
 * through the Session that allocated it, so its real phase stays observable across
 * a Session switch. The sidebar row, the collapsed rail, and the editor tab strip
 * all resolve through here so the three never disagree about the same terminal.
 */
export function terminalDot(tab: WorkbenchTerminalTab, binding: TerminalBinding): TerminalDot {
  return binding === 'ready' ? tab.status : 'unclaimed'
}
