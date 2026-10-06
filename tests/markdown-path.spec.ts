import { describe, expect, it } from 'vitest'
import { isMarkdownPath } from '../src/markdown-path.ts'

describe('isMarkdownPath', () => {
  it.each(['README.md', 'notes.markdown', 'guide.mdown', 'old.mkd', 'page.mdx'])('recognizes %s', path => {
    expect(isMarkdownPath(path)).toBe(true)
  })

  it('is case-insensitive and accepts Windows separators', () => {
    expect(isMarkdownPath('docs\\GUIDE.MD')).toBe(true)
  })

  it('rejects non-Markdown, extension-less, and dotfile paths', () => {
    expect(isMarkdownPath('src/a.ts')).toBe(false)
    expect(isMarkdownPath('LICENSE')).toBe(false)
    expect(isMarkdownPath('.gitignore')).toBe(false)
    expect(isMarkdownPath(undefined)).toBe(false)
  })
})
