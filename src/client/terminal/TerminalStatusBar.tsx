/** 中栏终端标签底部的状态条，与编辑器状态条同一几何与词汇。 */

import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { TerminalBinding, WorkbenchTerminalTab } from '../model/controller.ts'
import { terminalDot } from './terminal-dot.ts'
import { terminalExitNote, terminalPhaseLabel, terminalStatusSegments } from './terminal-status.ts'
import css from './terminal.module.css'

export interface TerminalStatusBarProps {
  tab: WorkbenchTerminalTab
  binding: TerminalBinding
  t: TranslateNS<'workbench'>
}

/**
 * Render one terminal's Host-reported facts as a bottom strip, so a focused
 * terminal answers the same questions the editor's strip answers for a file.
 *
 * Every value is a mirror of official view state through the shared helpers, so
 * the strip, the sidebar row, and the tab/rail dots can never disagree about one
 * terminal. The phase leads with its own dot; the facts the Host reported follow
 * as bare values — the labels they carry in the sidebar's denser line become the
 * tooltip instead, which keeps the strip readable at a narrow pane. A fact the
 * Host has not reported is dropped rather than shown as a placeholder, so a
 * terminal that has not allocated yet leaves the strip empty instead of lying.
 */
export function TerminalStatusBar({ tab, binding, t }: TerminalStatusBarProps) {
  const segments = terminalStatusSegments(tab, t)
  const exitNote = terminalExitNote(tab, t)
  return (
    <div className={css.terminalStatusBar} role="contentinfo">
      <span className={css.terminalStatusBarPhase}>
        <span className={css.terminalStatusBarDot} data-status={terminalDot(tab, binding)} aria-hidden />
        {terminalPhaseLabel(tab, binding, t)}
      </span>
      {segments.map(segment => (
        <span
          key={segment.key}
          className={css.terminalStatusBarItem}
          data-shrink={segment.key === 'cwd' || undefined}
          title={segment.title ?? `${segment.label}: ${segment.value}`}
        >
          {segment.value}
        </span>
      ))}
      <span className={css.terminalStatusBarSpacer} />
      {exitNote !== undefined && (
        <span className={css.terminalStatusBarExit} data-status={tab.status}>{exitNote}</span>
      )}
    </div>
  )
}
