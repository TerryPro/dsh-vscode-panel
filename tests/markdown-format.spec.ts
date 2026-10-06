// @vitest-environment jsdom

import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'
import { buildMarkdownEdit, markdownEditingExtensions, runMarkdownCommand, type MarkdownCommandKind } from '../src/client/markdown/markdown-format.ts'

/** Apply an edit to its source text, the way CodeMirror would, for readable assertions. */
function apply(text: string, from: number, to: number, kind: MarkdownCommandKind): string {
  const edit = buildMarkdownEdit(text, from, to, kind)
  return text.slice(0, edit.from) + edit.insert + text.slice(edit.to)
}

describe('buildMarkdownEdit', () => {
  it('wraps a selection and keeps it selected', () => {
    const edit = buildMarkdownEdit('text', 0, 4, 'bold')
    expect(edit).not.toBeNull()
    expect(apply('text', 0, 4, 'bold')).toBe('**text**')
    expect(edit?.anchor).toBe(0)
    expect(edit?.head).toBe(8)
  })

  it('unwraps an already wrapped selection', () => {
    expect(apply('**text**', 0, 8, 'bold')).toBe('text')
  })

  it('removes markup surrounding the cursor, not just a wrapped selection', () => {
    const edit = buildMarkdownEdit('**', 1, 1, 'italic')
    expect(apply('**', 1, 1, 'italic')).toBe('')
    expect(edit.anchor).toBe(0)
    expect(edit.head).toBe(0)
  })

  it('inserts empty markup with the cursor inside when nothing is selected', () => {
    const edit = buildMarkdownEdit('ab', 1, 1, 'italic')
    expect(apply('ab', 1, 1, 'italic')).toBe('a**b')
    expect(edit?.anchor).toBe(2)
    expect(edit?.head).toBe(2)
  })

  it('wraps inline code', () => {
    expect(apply('val', 0, 3, 'code')).toBe('`val`')
  })

  it('builds a link and selects the url placeholder', () => {
    const edit = buildMarkdownEdit('docs', 0, 4, 'link')
    expect(apply('docs', 0, 4, 'link')).toBe('[docs](url)')
    const text = '[docs](url)'
    expect(text.slice(edit?.anchor, edit?.head)).toBe('url')
  })

  it('inserts a table template at the cursor', () => {
    const result = apply('', 0, 0, 'table')
    expect(result.startsWith('| Column | Column |')).toBe(true)
    expect(result).toContain('| ------ | ------ |')
  })

  it('adds a bullet marker to each non-empty selected line', () => {
    expect(apply('one\ntwo', 0, 7, 'bulletList')).toBe('- one\n- two')
  })

  it('toggles the bullet marker off when lines are already listed', () => {
    expect(apply('- one\n- two', 0, 11, 'bulletList')).toBe('one\ntwo')
  })

  it('leaves blank lines untouched inside a bulleted region', () => {
    expect(apply('one\n\ntwo', 0, 9, 'bulletList')).toBe('- one\n\n- two')
  })
})

describe('runMarkdownCommand on a live editor', () => {
  let view: EditorView | undefined
  afterEach(() => { view?.destroy(); view = undefined })

  function makeEditor(doc: string, from: number, to: number): EditorView {
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc,
        selection: { anchor: from, head: to },
        extensions: [markdownEditingExtensions],
      }),
    })
    return view
  }

  it('applies bold and restores the wrapped selection', () => {
    const editor = makeEditor('text', 0, 4)
    expect(runMarkdownCommand(editor, 'bold')).toBe(true)
    expect(editor.state.doc.toString()).toBe('**text**')
    const selection = editor.state.selection.main
    expect([selection.from, selection.to]).toEqual([0, 8])
  })

  it('the Mod-b keybinding routes through the markdown keymap', () => {
    const editor = makeEditor('text', 0, 4)
    editor.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true }))
    expect(editor.state.doc.toString()).toBe('**text**')
  })
})
