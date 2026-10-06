import { useEffect, useRef } from 'react'
import { Compartment, EditorState, Transaction, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { unifiedMergeView } from '@codemirror/merge'
import {
  detectEditorLineEnding,
  normalizeEditorText,
  restoreEditorLineEndings,
  type EditorLineEnding,
} from './editor-line-endings.ts'
import { dshEditorSetup } from './editor-setup.ts'
import { languageForPath } from './editor-languages.ts'
import { editorThemeExtensions, inlineDiffTheme } from './editor-theme.ts'
import { markdownEditingExtensions } from '../markdown/markdown-format.ts'
import css from '../Workbench.module.css'
import { isMarkdownPath } from '../../shared/markdown-path.ts'
import {
  DEFAULT_GIT_LINE_LABELS,
  gitLineDecorations,
  type GitLineDecorationCallbacks,
  type GitLineDecorationLabels,
} from '../git/git-line-decorations.ts'
import type { GitHunkPeekStorageOperation } from '../git/git-hunk-peek-resize.ts'

export interface CodeEditorProps {
  value: string
  onChange: (value: string, source: CodeEditorChangeSource) => void
  ariaLabel: string
  path?: string
  gitOriginal?: string
  inlineDiff?: boolean
  wrap?: boolean
  gitLabels?: GitLineDecorationLabels
  onGitHunkOpen?: () => void
  onGitHunkResize?: (width: number) => void
  onGitHunkResizeStorageError?: (operation: GitHunkPeekStorageOperation) => void
  onGitHunkDismissOutside?: () => void
  onViewReady?: (view: EditorView | null) => void
  onCursorChange?: (cursor: EditorCursorState) => void
}

export type CodeEditorChangeSource = 'input' | 'git-revert'

/** Caret / selection summary surfaced to the editor status bar. */
export interface EditorCursorState {
  line: number
  column: number
  selectedChars: number
  selectedLines: number
}

const BASE_FONT_PX = 13
const MIN_FONT_PX = 10
const MAX_FONT_PX = 28

function clampFont(px: number): number {
  return Math.min(MAX_FONT_PX, Math.max(MIN_FONT_PX, px))
}

function fontTheme(px: number) {
  return EditorView.theme({ '&': { fontSize: `${px}px` } })
}

function cursorInfo(state: EditorState): EditorCursorState {
  const { main } = state.selection
  const line = state.doc.lineAt(main.head)
  const anchor = Math.min(main.from, main.to)
  const head = Math.max(main.from, main.to)
  return {
    line: line.number,
    column: main.head - line.from + 1,
    selectedChars: head - anchor,
    selectedLines: main.empty ? 0 : state.doc.lineAt(head).number - state.doc.lineAt(anchor).number + 1,
  }
}

/**
 * The Git change overlay for the editable buffer, selected by `inlineDiff`:
 * - `true`  → VS Code-style inline coloured blocks (added green, removed red)
 *   via `unifiedMergeView`.
 * - `false` → the "final result" view: nothing drawn, just the current buffer.
 * - unset   → the compact gutter markers with the click-to-peek diff (library
 *   default, kept for callers that do not opt into either explicit mode).
 */
function gitChangeView(
  inlineDiff: boolean | undefined,
  gitOriginal: string | undefined,
  labels: GitLineDecorationLabels,
  callbacks: GitLineDecorationCallbacks,
): Extension {
  if (inlineDiff === true && gitOriginal !== undefined) {
    return [
      inlineDiffTheme,
      unifiedMergeView({
        original: gitOriginal,
        allowInlineDiffs: true,
        highlightChanges: true,
        syntaxHighlightDeletions: true,
        diffConfig: { timeout: 800 },
        gutter: true,
        mergeControls: false,
      }),
    ]
  }
  if (inlineDiff === false) return []
  return gitLineDecorations(gitOriginal ?? null, labels, callbacks)
}

/** CodeMirror surface themed entirely through DSH design tokens. */
export function CodeEditor({
  value,
  onChange,
  ariaLabel,
  path,
  gitOriginal,
  inlineDiff,
  wrap,
  gitLabels,
  onGitHunkOpen,
  onGitHunkResize,
  onGitHunkResizeStorageError,
  onGitHunkDismissOutside,
  onViewReady,
  onCursorChange,
}: CodeEditorProps) {
  const parent = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const lineEndingRef = useRef<EditorLineEnding>(detectEditorLineEnding(value))
  const syncingRef = useRef(false)
  const gitChanges = useRef(new Compartment())
  const language = useRef(new Compartment())
  const wrapping = useRef(new Compartment())
  const fontThemeCompartment = useRef(new Compartment())
  const fontPx = useRef(BASE_FONT_PX)
  const onGitHunkOpenRef = useRef(onGitHunkOpen)
  const onGitHunkResizeRef = useRef(onGitHunkResize)
  const onGitHunkResizeStorageErrorRef = useRef(onGitHunkResizeStorageError)
  const onGitHunkDismissOutsideRef = useRef(onGitHunkDismissOutside)
  const onViewReadyRef = useRef(onViewReady)
  const onCursorChangeRef = useRef(onCursorChange)
  const gitCallbacks = useRef<GitLineDecorationCallbacks>({
    onHunkOpen: () => { onGitHunkOpenRef.current?.() },
    onHunkResize: width => { onGitHunkResizeRef.current?.(width) },
    onHunkResizeStorageError: operation => { onGitHunkResizeStorageErrorRef.current?.(operation) },
    onHunkDismissOutside: () => { onGitHunkDismissOutsideRef.current?.() },
  })
  onChangeRef.current = onChange
  onGitHunkOpenRef.current = onGitHunkOpen
  onGitHunkResizeRef.current = onGitHunkResize
  onGitHunkResizeStorageErrorRef.current = onGitHunkResizeStorageError
  onGitHunkDismissOutsideRef.current = onGitHunkDismissOutside
  onViewReadyRef.current = onViewReady
  onCursorChangeRef.current = onCursorChange
  lineEndingRef.current = detectEditorLineEnding(value)

  useEffect(() => {
    if (parent.current === null) return
    const applyZoom = (next: number): boolean => {
      const editor = view.current
      const px = clampFont(next)
      if (editor === null || px === fontPx.current) return true
      fontPx.current = px
      editor.dispatch({ effects: fontThemeCompartment.current.reconfigure(fontTheme(px)) })
      return true
    }
    const editor = new EditorView({
      parent: parent.current,
      state: EditorState.create({
        doc: normalizeEditorText(value),
        extensions: [
          dshEditorSetup,
          wrapping.current.of(wrap === false ? [] : EditorView.lineWrapping),
          EditorView.contentAttributes.of({ 'aria-label': ariaLabel }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !syncingRef.current) {
              const source = update.transactions.some(transaction => (
                transaction.annotation(Transaction.userEvent) === 'input.git-revert'
              )) ? 'git-revert' : 'input'
              onChangeRef.current(
                restoreEditorLineEndings(update.state.doc.toString(), lineEndingRef.current),
                source,
              )
            }
            if (update.selectionSet || update.docChanged) {
              onCursorChangeRef.current?.(cursorInfo(update.state))
            }
          }),
          keymap.of([
            { key: 'Mod-=', preventDefault: true, run: () => applyZoom(fontPx.current + 1) },
            { key: 'Mod-+', preventDefault: true, run: () => applyZoom(fontPx.current + 1) },
            { key: 'Mod--', preventDefault: true, run: () => applyZoom(fontPx.current - 1) },
            { key: 'Mod-0', preventDefault: true, run: () => applyZoom(BASE_FONT_PX) },
          ]),
          fontThemeCompartment.current.of(fontTheme(fontPx.current)),
          editorThemeExtensions,
          language.current.of(languageForPath(path) ?? []),
          ...(isMarkdownPath(path) ? [markdownEditingExtensions] : []),
          gitChanges.current.of(gitChangeView(
            inlineDiff,
            gitOriginal,
            gitLabels ?? DEFAULT_GIT_LINE_LABELS,
            gitCallbacks.current,
          )),
        ],
      }),
    })
    view.current = editor
    onViewReadyRef.current?.(editor)
    onCursorChangeRef.current?.(cursorInfo(editor.state))
    return () => {
      view.current = null
      onViewReadyRef.current?.(null)
      editor.destroy()
    }
  }, [ariaLabel])

  useEffect(() => {
    const editor = view.current
    if (editor === null) return
    const current = editor.state.doc.toString()
    const normalized = normalizeEditorText(value)
    if (current === normalized) return
    syncingRef.current = true
    try {
      editor.dispatch({ changes: { from: 0, to: current.length, insert: normalized } })
    } finally {
      syncingRef.current = false
    }
  }, [value])

  useEffect(() => {
    const editor = view.current
    if (editor === null) return
    editor.dispatch({
      effects: gitChanges.current.reconfigure(gitChangeView(
        inlineDiff,
        gitOriginal,
        gitLabels ?? DEFAULT_GIT_LINE_LABELS,
        gitCallbacks.current,
      )),
    })
  }, [gitLabels, gitOriginal, inlineDiff])

  useEffect(() => {
    const editor = view.current
    if (editor === null) return
    editor.dispatch({
      effects: wrapping.current.reconfigure(wrap === false ? [] : EditorView.lineWrapping),
    })
  }, [wrap])

  return <div ref={parent} className={css.codeEditorHost} />
}
