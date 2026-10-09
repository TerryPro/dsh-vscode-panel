/** The one terminal-name resolution shared by every surface that labels a terminal. */

import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkbenchTerminalTab } from '../model/workbench-types.ts'

/**
 * What a terminal is called: the name the user gave it, else `Terminal N`.
 *
 * The sidebar row, the collapsed rail, the editor tab strip, and the terminal's
 * own accessible label all resolve through here so a renamed terminal is called
 * the same thing everywhere at once, and never one name in one panel and its
 * old number in another.
 */
export function terminalName(
  tab: WorkbenchTerminalTab,
  t: TranslateNS<'workbench'>,
): string {
  return tab.title ?? t('terminal.name', { index: String(tab.sequence) })
}
