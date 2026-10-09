/** 终端状态栏的内容：只呈现宿主确实报告的事实。 */

import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { TerminalBinding, WorkbenchTerminalTab } from '../model/workbench-types.ts'
import { shellDisplayName } from './shell-display.ts'

export interface TerminalStatusSegment {
  readonly key: string
  readonly label: string
  readonly value: string
  /** Tooltip text, when the value is abbreviated for the row. */
  readonly title?: string
}

/**
 * The facts the Host reports about one terminal process, as status-bar segments.
 *
 * Every segment is a mirror of official view state rather than something this
 * window guesses:
 *
 * - the shell the Host resolved, which also names a restored process whose
 *   opening choice was made in another window;
 * - the PTY grid, which is what the process actually sees;
 * - the *launch* directory. The Host documents that a shell changing directory
 *   never updates `cwd`, so this is labelled as the start directory on purpose —
 *   calling it "current directory" would be a claim the data cannot support.
 *
 * A segment is dropped rather than shown as empty, so a terminal that has not
 * allocated yet yields no line at all instead of a row of placeholders.
 */
export function terminalStatusSegments(
  tab: WorkbenchTerminalTab,
  t: TranslateNS<'workbench'>,
): TerminalStatusSegment[] {
  const segments: TerminalStatusSegment[] = []
  if (tab.shellName !== undefined) {
    segments.push({
      key: 'shell',
      label: t('terminal.statusShell'),
      value: shellDisplayName(tab.shellName),
    })
  }
  const runtime = tab.runtime
  if (runtime !== undefined) {
    segments.push({
      key: 'size',
      label: t('terminal.statusSize'),
      value: `${runtime.cols}×${runtime.rows}`,
    })
    if (runtime.cwd !== '') {
      segments.push({
        key: 'cwd',
        label: t('terminal.statusCwd'),
        value: runtime.cwd,
        title: runtime.cwd,
      })
    }
  }
  return segments
}

/**
 * The phase the Host reports for one terminal, in the shared vocabulary.
 *
 * A tab with no Session to address its process through reports `unclaimed` rather
 * than a phase, exactly as the status dot does: nothing has confirmed a process,
 * so nothing may claim one. The sidebar row, the collapsed rail, and the editor's
 * bottom strip all resolve through here so the three never disagree.
 */
export function terminalPhaseLabel(
  tab: WorkbenchTerminalTab,
  binding: TerminalBinding,
  t: TranslateNS<'workbench'>,
): string {
  if (binding === 'noSession') return t('terminal.unclaimed')
  switch (tab.status) {
    case 'connecting': return t('terminal.connecting')
    case 'running': return t('terminal.running')
    case 'exited': return t('terminal.exited')
    case 'error': return t('terminal.failed')
  }
}

/**
 * Whether the process ended, as a trailing note on the status line.
 *
 * Only an exited or failed process reports a code, and a running one must not
 * borrow the wording: the row already carries the live phase.
 */
export function terminalExitNote(
  tab: WorkbenchTerminalTab,
  t: TranslateNS<'workbench'>,
): string | undefined {
  const runtime = tab.runtime
  if (runtime === undefined) return undefined
  if (tab.status !== 'exited' && tab.status !== 'error') return undefined
  return t('terminal.statusExit', { code: String(runtime.exitCode ?? 0) })
}
