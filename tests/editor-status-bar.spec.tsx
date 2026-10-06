// @vitest-environment jsdom

import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { EditorStatusBar } from '../src/client/editor/EditorStatusBar.tsx'
import { zh } from '../src/client/locales.ts'

function t(key: keyof typeof zh, values?: Record<string, string>): string {
  const template: string = zh[key]
  if (values === undefined) return template
  return Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, value), template)
}

describe('EditorStatusBar', () => {
  it('shows caret position, indent, encoding, EOL and language', () => {
    const view = render(
      <EditorStatusBar
        cursor={{ line: 3, column: 7, selectedChars: 0, selectedLines: 0 }}
        path="src/a.ts"
        content={'line one\n  indented\n'}
        t={t as never}
      />,
    )
    const text = view.container.textContent ?? ''
    expect(text).toContain('行 3，列 7')
    expect(text).toContain('空格: 2')
    expect(text).toContain('UTF-8')
    expect(text).toContain('LF')
    expect(text).toContain('TypeScript')
    expect(text).not.toContain('已选择')
  })

  it('reports the selection when text is highlighted', () => {
    const view = render(
      <EditorStatusBar
        cursor={{ line: 1, column: 1, selectedChars: 12, selectedLines: 0 }}
        path="notes.txt"
        content={'plain\r\n'}
        t={t as never}
      />,
    )
    const text = view.container.textContent ?? ''
    expect(text).toContain('已选择 12 个字符')
    expect(text).toContain('CRLF')
    expect(text).toContain('Plain Text')
  })
})
