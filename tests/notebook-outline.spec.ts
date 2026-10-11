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
      { index: 1, level: 1, text: 'x = 1', cellId: 'c1' },
      { index: 2, level: 2, text: 'Load data', cellId: 'm2' },
      { index: 3, level: 3, text: 'From S3', cellId: 'm2' },
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

  it('labels a code cell by its first line that has content', () => {
    // Leading blank lines are the shape a hand-run notebook actually accumulates — a
    // reader who cleared a cell keeps the newline — and a row reading `''` would be an
    // entry that names nothing.
    const document = parseNotebook(nb([code('c1', '\n\n  df = load("x.csv")  \nprint(df)')]))
    expect(buildNotebookOutline(document)).toEqual([
      { index: 0, level: 1, text: 'df = load("x.csv")', cellId: 'c1' },
    ])
  })

  it('gives a raw cell a row too, because it is part of the document', () => {
    // Raw cells carry prose and scripts the reader placed deliberately; leaving them out
    // of the outline would make the panel a map with holes in it.
    const document = parseNotebook(nb([{ cell_type: 'raw', id: 'r1', source: 'make deploy', metadata: {} }]))
    expect(buildNotebookOutline(document)).toEqual([
      { index: 0, level: 1, text: 'make deploy', cellId: 'r1' },
    ])
  })
})
