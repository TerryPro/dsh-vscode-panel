// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { parseNotebook } from '../src/client/notebook/notebook-document.ts'
import { buildNotebookOutline } from '../src/client/notebook/notebook-outline.ts'

const nb = (cells: unknown[]) => JSON.stringify({
  cells,
  metadata: { language_info: { name: 'python' } },
  nbformat: 4,
  nbformat_minor: 5,
})

const code = (id: string, source: string) => ({
  cell_type: 'code', id, source, outputs: [], execution_count: null, metadata: {},
})

const markdown = (id: string, source: string) => ({
  cell_type: 'markdown', id, source, metadata: {},
})

describe('notebook outline', () => {
  it('lists the headings of every markdown cell with the cell each one lives in', () => {
    // The reader navigates a long notebook by its structure, so a row has to name not
    // just the heading but the cell it jumps to: a heading without its cell is a list
    // the reader cannot act on.
    const document = parseNotebook(nb([
      markdown('m1', '# Setup\n\nsome prose'),
      code('c1', 'x = 1'),
      markdown('m2', '## Load data\n### From S3'),
    ]))
    expect(buildNotebookOutline(document)).toEqual([
      { index: 0, level: 1, text: 'Setup', cellId: 'm1' },
      { index: 1, level: 2, text: 'Load data', cellId: 'm2' },
      { index: 2, level: 3, text: 'From S3', cellId: 'm2' },
    ])
  })

  it('ignores markup that only looks like a heading inside fenced code', () => {
    // A code block full of `# comments` is not a table of contents: the extractor the
    // notebook reuses already knows fences, and the notebook must not re-learn the rule.
    const document = parseNotebook(nb([
      markdown('m1', '# Real\n\n```python\n# fake\n```\n\n## Also real'),
    ]))
    expect(buildNotebookOutline(document).map(entry => entry.text)).toEqual(['Real', 'Also real'])
  })

  it('skips cells with nothing to show', () => {
    // An empty cell is not structure; a row for it would be an anchor to nowhere.
    const document = parseNotebook(nb([code('c1', '   '), markdown('m1', '')]))
    expect(buildNotebookOutline(document)).toEqual([])
  })

  it('leaves code cells out, including the ones that start with a comment', () => {
    // The outline is a table of contents, not a list of steps: a code cell's first line is
    // a statement or a `# comment` in that language, and neither is a heading the reader is
    // scanning for. Cells stay navigable through the cell list and folding.
    const document = parseNotebook(nb([
      code('c1', 'df = load("x.csv")\nprint(df)'),
      code('c2', '# not a heading\n# neither is this'),
    ]))
    expect(buildNotebookOutline(document)).toEqual([])
  })

  it('leaves raw cells out too', () => {
    // Raw is source as well; its content is prose the reader wrote outside the Markdown
    // cells, and lifting its first line into the outline would name a heading that is
    // rendered nowhere.
    const document = parseNotebook(nb([
      { cell_type: 'raw', id: 'r1', source: '# looks like a heading\nmake deploy', metadata: {} },
    ]))
    expect(buildNotebookOutline(document)).toEqual([])
  })
})
