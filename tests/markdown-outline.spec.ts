import { describe, expect, it } from 'vitest'
import { extractMarkdownOutline } from '../src/client/markdown-outline.ts'

describe('extractMarkdownOutline', () => {
  it('collects ATX headings with their level and a document-order index', () => {
    const outline = extractMarkdownOutline('# Title\n\ntext\n\n## Section\n### Sub')
    expect(outline).toEqual([
      { level: 1, text: 'Title', index: 0 },
      { level: 2, text: 'Section', index: 1 },
      { level: 3, text: 'Sub', index: 2 },
    ])
  })

  it('recognises setext headings underlined with = and -', () => {
    const outline = extractMarkdownOutline('Primary\n=======\n\nSecondary\n---------')
    expect(outline).toEqual([
      { level: 1, text: 'Primary', index: 0 },
      { level: 2, text: 'Secondary', index: 1 },
    ])
  })

  it('ignores heading-looking lines inside fenced code blocks', () => {
    const outline = extractMarkdownOutline('# Real\n\n```\n# fake\n## fake\n~~~\n# still fake\n```\n\n## Also real')
    expect(outline.map(entry => entry.text)).toEqual(['Real', 'Also real'])
  })

  it('trims trailing hashes and strips inline markdown from heading text', () => {
    const outline = extractMarkdownOutline('## **Bold** heading with `code` ##\n### [Link](https://example.com) tail')
    expect(outline).toEqual([
      { level: 2, text: 'Bold heading with code', index: 0 },
      { level: 3, text: 'Link tail', index: 1 },
    ])
  })

  it('skips empty heading markers and returns nothing for plain text', () => {
    expect(extractMarkdownOutline('##\njust a paragraph\nmore text')).toEqual([])
  })

  it('does not treat a standalone thematic break as a setext heading', () => {
    expect(extractMarkdownOutline('some text\n\n---\n\nmore text')).toEqual([])
  })
})
