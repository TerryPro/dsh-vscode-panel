import { useMemo } from 'react'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { detectEditorLineEnding } from './editor-line-endings.ts'
import { languageLabelForPath } from './editor-languages.ts'
import type { EditorCursorState } from './CodeEditor.tsx'
import css from '../Workbench.module.css'

export interface EditorStatusBarProps {
  cursor: EditorCursorState
  path: string
  content: string
  t: TranslateNS<'workbench'>
  /** View toggles (word wrap, inline diff) pinned to the right of the strip. */
  actions?: ReactNode
  /** Hide the caret position/selection readout when no editable surface is shown (e.g. preview). */
  showPosition?: boolean
}

/** Bottom information strip: caret position, selection, indent, encoding, EOL, language. */
export function EditorStatusBar({ cursor, path, content, t, actions, showPosition = true }: EditorStatusBarProps) {
  const language = useMemo(() => languageLabelForPath(path), [path])
  const eol = useMemo(() => lineEndingLabel(detectEditorLineEnding(content)), [content])
  const indent = useMemo(() => detectIndent(content), [content])

  return (
    <div className={css.editorStatusBar} role="contentinfo">
      {showPosition && (
        <span className={css.editorStatusBarItem}>
          {t('editor.statusPosition', { line: String(cursor.line), column: String(cursor.column) })}
        </span>
      )}
      {showPosition && cursor.selectedChars > 0 && (
        <span className={css.editorStatusBarItem}>
          {cursor.selectedLines > 1
            ? t('editor.statusSelectedLines', { count: String(cursor.selectedLines) })
            : t('editor.statusSelected', { count: String(cursor.selectedChars) })}
        </span>
      )}
      <span className={css.editorStatusBarSpacer} />
      <span className={css.editorStatusBarItem}>
        {indent.type === 'tab'
          ? t('editor.statusIndentTabs', { size: String(indent.size) })
          : t('editor.statusIndentSpaces', { size: String(indent.size) })}
      </span>
      <span className={css.editorStatusBarItem}>{t('editor.statusEncoding')}</span>
      <span className={css.editorStatusBarItem}>{eol}</span>
      <span className={css.editorStatusBarItem}>{language}</span>
      {actions !== undefined && (
        <span className={css.editorStatusBarActions}>{actions}</span>
      )}
    </div>
  )
}

function lineEndingLabel(ending: '\n' | '\r\n' | '\r'): string {
  return ending === '\r\n' ? 'CRLF' : ending === '\r' ? 'CR' : 'LF'
}

function detectIndent(content: string): { type: 'space' | 'tab'; size: number } {
  for (const line of content.split('\n')) {
    const match = /^[ \t]+/u.exec(line)
    if (match === null) continue
    if (match[0][0] === '\t') return { type: 'tab', size: match[0].length }
    return { type: 'space', size: match[0].length }
  }
  return { type: 'space', size: 2 }
}
