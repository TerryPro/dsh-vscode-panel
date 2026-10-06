import { deleteMarkupBackward, insertNewlineContinueMarkup } from '@codemirror/lang-markdown'
import { Prec, Transaction, type Extension } from '@codemirror/state'
import { EditorView, keymap, type KeyBinding } from '@codemirror/view'

export type MarkdownCommandKind = 'bold' | 'italic' | 'code' | 'link' | 'table' | 'bulletList'

export interface MarkdownEdit {
  from: number
  to: number
  insert: string
  anchor: number
  head: number
}

interface Wrap {
  open: string
  close: string
}

const WRAPS: Record<'bold' | 'italic' | 'code', Wrap> = {
  bold: { open: '**', close: '**' },
  italic: { open: '*', close: '*' },
  code: { open: '`', close: '`' },
}

const TABLE_TEMPLATE = '| Column | Column |\n| ------ | ------ |\n| Cell   | Cell   |\n'

/**
 * Compute a single-document edit for a Markdown command from plain offsets.
 * Kept free of CodeMirror types so it can be unit-tested without a DOM.
 */
export function buildMarkdownEdit(text: string, from: number, to: number, kind: MarkdownCommandKind): MarkdownEdit {
  switch (kind) {
    case 'bold': return wrapEdit(text, from, to, WRAPS.bold)
    case 'italic': return wrapEdit(text, from, to, WRAPS.italic)
    case 'code': return wrapEdit(text, from, to, WRAPS.code)
    case 'link': return linkEdit(text, from, to)
    case 'table': return tableEdit(from, to)
    case 'bulletList': return bulletEdit(text, from, to)
  }
}

function wrapEdit(text: string, from: number, to: number, wrap: Wrap): MarkdownEdit {
  const { open, close } = wrap
  const selected = text.slice(from, to)
  if (selected.length >= open.length + close.length && selected.startsWith(open) && selected.endsWith(close)) {
    const inner = selected.slice(open.length, selected.length - close.length)
    return { from, to, insert: inner, anchor: from, head: from + inner.length }
  }
  const before = text.slice(Math.max(0, from - open.length), from)
  const after = text.slice(to, to + close.length)
  if (before === open && after === close) {
    const start = from - open.length
    const end = to + close.length
    return { from: start, to: end, insert: selected, anchor: start, head: start + selected.length }
  }
  if (selected.length === 0) {
    return { from, to, insert: open + close, anchor: from + open.length, head: from + open.length }
  }
  return {
    from,
    to,
    insert: open + selected + close,
    anchor: from,
    head: from + open.length + selected.length + close.length,
  }
}

function linkEdit(text: string, from: number, to: number): MarkdownEdit {
  const selected = text.slice(from, to)
  const insert = `[${selected}](url)`
  const urlStart = from + 1 + selected.length + 2
  return { from, to, insert, anchor: urlStart, head: urlStart + 3 }
}

function tableEdit(from: number, to: number): MarkdownEdit {
  const end = from + TABLE_TEMPLATE.length
  return { from, to, insert: TABLE_TEMPLATE, anchor: end, head: end }
}

function bulletEdit(text: string, from: number, to: number): MarkdownEdit {
  const lineStart = text.lastIndexOf('\n', from - 1) + 1
  const nextBreak = text.indexOf('\n', to)
  const lineEnd = nextBreak === -1 ? text.length : nextBreak
  const lines = text.slice(lineStart, lineEnd).split('\n')
  const nonEmpty = lines.filter(line => line.trim() !== '')
  const marker = '- '
  const alreadyListed = nonEmpty.length > 0 && nonEmpty.every(line => line.startsWith(marker))
  const newLines = lines.map((line) => {
    if (line.trim() === '') return line
    return alreadyListed ? line.slice(marker.length) : marker + line
  })
  const insert = newLines.join('\n')
  return { from: lineStart, to: lineEnd, insert, anchor: lineStart, head: lineStart + insert.length }
}

/** Apply a Markdown command to a live editor view; returns whether it handled the call. */
export function runMarkdownCommand(view: EditorView, kind: MarkdownCommandKind): boolean {
  const { from, to } = view.state.selection.main
  const edit = buildMarkdownEdit(view.state.doc.toString(), from, to, kind)
  view.dispatch({
    changes: { from: edit.from, to: edit.to, insert: edit.insert },
    selection: { anchor: edit.anchor, head: edit.head },
    annotations: Transaction.userEvent.of('input'),
    effects: EditorView.scrollIntoView(edit.anchor, { y: 'nearest' }),
  })
  view.focus()
  return true
}

/**
 * Markdown-specific bindings: formatting shortcuts plus list/quote continuation
 * on Enter. Bound at high precedence so they win over the stock `basicSetup`
 * keymap, while unhandled keys (Enter outside markup) fall through unchanged.
 */
export const markdownEditingExtensions: Extension = Prec.high(keymap.of([
  { key: 'Mod-b', preventDefault: true, run: view => runMarkdownCommand(view, 'bold') },
  { key: 'Mod-i', preventDefault: true, run: view => runMarkdownCommand(view, 'italic') },
  { key: 'Mod-e', preventDefault: true, run: view => runMarkdownCommand(view, 'code') },
  { key: 'Mod-k', preventDefault: true, run: view => runMarkdownCommand(view, 'link') },
  { key: 'Mod-Shift-l', preventDefault: true, run: view => runMarkdownCommand(view, 'bulletList') },
  { key: 'Mod-Shift-t', preventDefault: true, run: view => runMarkdownCommand(view, 'table') },
  { key: 'Enter', run: insertNewlineContinueMarkup },
  { key: 'Backspace', run: deleteMarkupBackward },
] as readonly KeyBinding[]))
