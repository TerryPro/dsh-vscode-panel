import { describe, expect, it } from 'vitest'
import type { NotebookOutputItem } from '../src/shared/notebook-protocol.ts'
import {
  applyNotebookMutation,
  createCellId,
  createNotebookSkeleton,
  emptyCell,
  joinNotebookText,
  NotebookEditError,
  notebookCellLanguage,
  notebookIsBlank,
  notebookOutputFromRecord,
  notebookOutputToRecord,
  parseNotebook,
  serializeNotebook,
  splitNotebookLines,
} from '../src/client/notebook/notebook-document.ts'

/** A notebook in the exact shape `jupyter nbformat` writes: 1-space indent, list sources. */
const SAMPLE = [
  '{',
  ' "cells": [',
  '  {',
  '   "cell_type": "code",',
  '   "execution_count": 3,',
  '   "id": "alpha",',
  '   "metadata": {},',
  '   "outputs": [',
  '    {',
  '     "name": "stdout",',
  '     "output_type": "stream",',
  '     "text": [',
  '      "hi\\n"',
  '     ]',
  '    }',
  '   ],',
  '   "source": [',
  '    "x = 1\\n",',
  '    "print(x)"',
  '   ]',
  '  },',
  '  {',
  '   "cell_type": "markdown",',
  '   "id": "beta",',
  '   "metadata": {},',
  '   "source": "# Title"',
  '  }',
  ' ],',
  ' "metadata": {',
  '  "kernelspec": {',
  '   "display_name": "Python 3",',
  '   "language": "python",',
  '   "name": "python3"',
  '  },',
  '  "language_info": {',
  '   "name": "python",',
  '   "version": "3.12.0"',
  '  }',
  ' },',
  ' "nbformat": 4,',
  ' "nbformat_minor": 5',
  '}',
  '',
].join('\n')

describe('notebook parsing', () => {
  it('reads cells, sources, and outputs from a real nbformat document', () => {
    const document = parseNotebook(SAMPLE)
    expect(document.warning).toBeNull()
    expect(document.cells).toHaveLength(2)
    expect(document.cells[0]?.kind).toBe('code')
    expect(document.cells[0]?.source).toBe('x = 1\nprint(x)')
    expect(document.cells[0]?.sourceIsList).toBe(true)
    expect(document.cells[0]?.executionCount).toBe(3)
    expect(document.cells[0]?.outputs).toEqual([{ kind: 'stream', name: 'stdout', text: 'hi\n' }])
    expect(document.cells[1]?.kind).toBe('markdown')
    expect(document.language).toBe('python')
  })

  it('detects the file\'s own indent, line endings, trailing newline, and BOM', () => {
    const crlf = '{\r\n "cells": [],\r\n "nbformat": 4\r\n}'
    // No trailing newline after the closing brace, which is what `crlf` actually is.
    expect(parseNotebook(crlf).format).toEqual({ indent: ' ', newline: '\r\n', trailingNewline: false, bom: false })
    expect(parseNotebook('\uFEFF{\n\t"cells": [],\n\t"nbformat": 4\n}').format).toEqual({
      indent: '\t', newline: '\n', trailingNewline: false, bom: true,
    })
    expect(parseNotebook('{\n "cells": [],\n "nbformat": 4\n}\n').format.trailingNewline).toBe(true)
    expect(parseNotebook('{\n "cells": [],\n "nbformat": 4}').format.trailingNewline).toBe(false)
  })

  it('never throws on unusable content and reports why', () => {
    expect(parseNotebook('not json').warning).toBe('invalid-json')
    expect(parseNotebook('[1,2]').warning).toBe('invalid-json')
    expect(parseNotebook('{"nbformat":4}').warning).toBe('missing-cells')
    expect(parseNotebook('{"nbformat":3,"cells":[]}').warning).toBe('unsupported-format')
    expect(parseNotebook('{"nbformat":4,"cells":[]}').warning).toBeNull()
  })

  it('synthesizes ids for pre-4.5 notebooks and skips unreadable cell entries', () => {
    const document = parseNotebook('{"nbformat":4,"nbformat_minor":0,"cells":[null,{"cell_type":"code","source":"a=1"},{"id":"","source":"b"}]}')
    expect(document.cells.map(cell => cell.id)).toEqual(['dsh-cell-1', 'dsh-cell-2'])
    expect(document.cells[1]?.sourceIsList).toBe(false)
  })

  it('marks a document too large to edit as cells', () => {
    const huge = `{"nbformat":4,"cells":[{"cell_type":"code","id":"a","source":"${'x'.repeat(9 * 1024 * 1024)}"}]}`
    expect(parseNotebook(huge).oversized).toBe(true)
    expect(parseNotebook('{"nbformat":4,"cells":[]}').oversized).toBe(false)
  })
})

describe('notebook serialization', () => {
  it('round-trips an untouched document byte for byte', () => {
    const document = parseNotebook(SAMPLE)
    expect(serializeNotebook(JSON.parse(SAMPLE), document.format)).toBe(SAMPLE)
  })

  it('keeps CRLF, a BOM, tab indent, and an absent trailing newline', () => {
    const source = '\uFEFF{\r\n\t"cells": [],\r\n\t"nbformat": 4\r\n}'
    const document = parseNotebook(source)
    // `JSON.parse` does not accept a BOM, which is exactly why the parser strips one
    // before parsing and re-adds it on the way out.
    const tree = JSON.parse(source.slice(1)) as Record<string, unknown>
    expect(serializeNotebook(tree, document.format)).toBe(source)
  })

  it('joins and splits Jupyter\'s string-or-list source form', () => {
    expect(joinNotebookText(['a\n', 'b'])).toBe('a\nb')
    expect(joinNotebookText('a')).toBe('a')
    expect(joinNotebookText(undefined)).toBe('')
    expect(splitNotebookLines('a\nb')).toEqual(['a\n', 'b'])
    expect(splitNotebookLines('')).toEqual([])
    // Every line keeps its newline except the last, which is nbformat's own rule.
    expect(splitNotebookLines('a\nb\n')).toEqual(['a\n', 'b\n'])
  })
})

describe('notebook mutations preserve the document', () => {
  it('keeps unknown top-level and cell keys, and cell metadata', () => {
    const source = JSON.stringify({
      cells: [{ cell_type: 'code', id: 'a', source: '', outputs: [], execution_count: null, metadata: { tags: ['keep'] }, some_future_field: 42 }],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
      nbconvert_filters: { exclude: true },
      // eslint-disable-next-line no-restricted-syntax
    }, null, 1) + '\n'
    const next = applyNotebookMutation(source, { op: 'set-source', cellId: 'a', source: 'print(1)' })
    const parsed = JSON.parse(next) as Record<string, unknown>
    expect(parsed['nbconvert_filters']).toEqual({ exclude: true })
    const cell = (parsed['cells'] as Record<string, unknown>[])[0]
    expect(cell?.['some_future_field']).toBe(42)
    expect(cell?.['metadata']).toEqual({ tags: ['keep'] })
  })

  it('writes source back in the shape the cell already used', () => {
    const listNotebook = '{"nbformat":4,"cells":[{"cell_type":"code","id":"a","source":["x = 1\\n"],"outputs":[],"execution_count":null,"metadata":{}}],"metadata":{}}'
    const stringNotebook = '{"nbformat":4,"cells":[{"cell_type":"code","id":"a","source":"x = 1","outputs":[],"execution_count":null,"metadata":{}}],"metadata":{}}'
    const listNext = JSON.parse(applyNotebookMutation(listNotebook, { op: 'set-source', cellId: 'a', source: 'y = 2\nz' })) as { cells: { source: unknown }[] }
    const stringNext = JSON.parse(applyNotebookMutation(stringNotebook, { op: 'set-source', cellId: 'a', source: 'y = 2\nz' })) as { cells: { source: unknown }[] }
    expect(listNext.cells[0]?.source).toEqual(['y = 2\n', 'z'])
    expect(stringNext.cells[0]?.source).toBe('y = 2\nz')
  })

  it('inserts relative to a cell, and appends when no cell is named', () => {
    const next = JSON.parse(applyNotebookMutation(SAMPLE, { op: 'insert', cellId: 'alpha', before: true, kind: 'markdown' })) as {
      cells: { cell_type: string; id: string }[]
    }
    expect(next.cells.map(cell => cell.cell_type)).toEqual(['markdown', 'code', 'markdown'])
    const appended = JSON.parse(applyNotebookMutation(SAMPLE, { op: 'insert', cellId: null, before: false, kind: 'code' })) as {
      cells: { cell_type: string }[]
    }
    expect(appended.cells.at(-1)?.cell_type).toBe('code')
    // A new code cell has the shape nbformat requires, including an empty output list.
    const created = appended.cells.at(-1) as Record<string, unknown>
    expect(created).toMatchObject({ cell_type: 'code', execution_count: null, outputs: [] })
    expect(typeof created['id']).toBe('string')
  })

  it('refuses to insert beside a cell that is gone', () => {
    expect(() => applyNotebookMutation(SAMPLE, { op: 'insert', cellId: 'missing', before: true, kind: 'code' }))
      .toThrow(/the notebook changed/u)
  })

  it('moves, deletes, and no-ops at the edges', () => {
    const moved = JSON.parse(applyNotebookMutation(SAMPLE, { op: 'move', cellId: 'beta', direction: -1 })) as { cells: { id: string }[] }
    expect(moved.cells.map(cell => cell.id)).toEqual(['beta', 'alpha'])
    // Moving the first cell up is a no-op rather than an error: the button is disabled,
    // but a stale click must not corrupt the file.
    const unchanged = applyNotebookMutation(SAMPLE, { op: 'move', cellId: 'alpha', direction: -1 })
    expect(unchanged).toBe(SAMPLE)
    const deleted = JSON.parse(applyNotebookMutation(SAMPLE, { op: 'delete', cellId: 'beta' })) as { cells: { id: string }[] }
    expect(deleted.cells.map(cell => cell.id)).toEqual(['alpha'])
    expect(applyNotebookMutation(SAMPLE, { op: 'delete', cellId: 'ghost' })).toBe(SAMPLE)
  })

  it('changes a cell kind and adjusts only the fields that kind owns', () => {
    const toMarkdown = JSON.parse(applyNotebookMutation(SAMPLE, { op: 'set-kind', cellId: 'alpha', kind: 'markdown' })) as {
      cells: Record<string, unknown>[]
    }
    expect(toMarkdown.cells[0]).not.toHaveProperty('outputs')
    expect(toMarkdown.cells[0]).not.toHaveProperty('execution_count')
    const backToCode = JSON.parse(applyNotebookMutation(SAMPLE, { op: 'set-kind', cellId: 'beta', kind: 'code' })) as {
      cells: Record<string, unknown>[]
    }
    expect(backToCode.cells[1]).toMatchObject({ cell_type: 'code', outputs: [], execution_count: null })
  })

  it('splits at an offset and merges the cell below', () => {
    const split = JSON.parse(applyNotebookMutation(SAMPLE, { op: 'split', cellId: 'alpha', offset: 6 })) as {
      cells: { id: string; source: string[] | string; outputs: unknown[] }[]
    }
    expect(split.cells[0]?.source).toEqual(['x = 1\n'])
    expect(split.cells[1]?.source).toEqual(['print(x)'])
    expect(split.cells[0]?.id).toBe('alpha')
    expect(split.cells[1]?.id).not.toBe('alpha')
    // The tail cell starts clean: an output belongs to the code that produced it.
    expect(split.cells[1]?.outputs).toEqual([])

    const merged = JSON.parse(applyNotebookMutation(SAMPLE, { op: 'merge-down', cellId: 'alpha' })) as {
      cells: { id: string; source: string[]; outputs: unknown[] }[]
    }
    expect(merged.cells).toHaveLength(1)
    expect(joinNotebookText(merged.cells[0]?.source)).toBe('x = 1\nprint(x)\n# Title')
    expect(merged.cells[0]?.outputs).toHaveLength(1)
  })

  it('records outputs and the prompt number together, and clears both', () => {
    const withOutput = applyNotebookMutation(SAMPLE, {
      op: 'set-outputs',
      cellId: 'alpha',
      outputs: [{ kind: 'execute_result', executionCount: 4, data: { 'text/plain': '42' }, metadata: {} }],
    })
    const recorded = applyNotebookMutation(withOutput, { op: 'set-execution-count', cellId: 'alpha', executionCount: 4 })
    const parsed = JSON.parse(recorded) as { cells: { outputs: Record<string, unknown>[]; execution_count: number }[] }
    expect(parsed.cells[0]?.execution_count).toBe(4)
    expect(parsed.cells[0]?.outputs[0]).toEqual({
      output_type: 'execute_result',
      execution_count: 4,
      data: { 'text/plain': '42' },
      metadata: {},
    })

    const cleared = JSON.parse(applyNotebookMutation(recorded, { op: 'clear-outputs', cellId: 'alpha' })) as {
      cells: { outputs: unknown[]; execution_count: unknown }[]
    }
    expect(cleared.cells[0]?.outputs).toEqual([])
    expect(cleared.cells[0]?.execution_count).toBeNull()

    const clearedAll = JSON.parse(applyNotebookMutation(recorded, { op: 'clear-all-outputs' })) as {
      cells: { outputs: unknown[]; execution_count: unknown }[]
    }
    expect(clearedAll.cells[0]?.outputs).toEqual([])
    expect(clearedAll.cells[0]?.execution_count).toBeNull()
  })

  it('writes stream output back as nbformat\'s list of lines', () => {
    const next = JSON.parse(applyNotebookMutation(SAMPLE, {
      op: 'append-output',
      cellId: 'alpha',
      item: { kind: 'stream', name: 'stdout', text: 'a\nb\n' },
    })) as { cells: { outputs: Record<string, unknown>[] }[] }
    expect(next.cells[0]?.outputs.at(-1)).toEqual({ output_type: 'stream', name: 'stdout', text: ['a\n', 'b\n'] })
  })

  it('rejects a mutation on content that is not a notebook', () => {
    expect(() => applyNotebookMutation('{}', { op: 'delete', cellId: 'a' })).toThrow(/no cells/u)
    expect(() => applyNotebookMutation('[1]', { op: 'delete', cellId: 'a' })).toThrow(/not a JSON object/u)
  })

  it('names a cell language from its own metadata before the document default', () => {
    const document = parseNotebook(JSON.stringify({
      cells: [
        { cell_type: 'code', id: 'a', source: '', metadata: { language: 'sql' } },
        { cell_type: 'code', id: 'b', source: '', metadata: { jupyter: { source: 'r' } } },
        { cell_type: 'code', id: 'c', source: '', metadata: {} },
      ],
      metadata: { language_info: { name: 'python' } },
      nbformat: 4,
    }))
    expect(notebookCellLanguage(document, document.cells[0]!)).toBe('sql')
    expect(notebookCellLanguage(document, document.cells[1]!)).toBe('r')
    expect(notebookCellLanguage(document, document.cells[2]!)).toBe('python')
  })

  it('round-trips every output kind through the nbformat record shape', () => {
    // Typed as the union rather than `as const`: a readonly literal does not satisfy
    // the mutable item type, and the point of the test is the round trip.
    const items: NotebookOutputItem[] = [
      { kind: 'stream', name: 'stderr', text: 'x' },
      { kind: 'execute_result', executionCount: 1, data: { 'text/plain': '1' }, metadata: {} },
      { kind: 'display_data', data: { 'image/png': 'AA' }, metadata: {} },
      { kind: 'update_display_data', data: {}, metadata: {} },
      { kind: 'error', ename: 'E', evalue: 'v', traceback: ['a'] },
    ]
    for (const item of items) {
      const parsed = notebookOutputFromRecord(notebookOutputToRecord(item))
      expect(parsed).toEqual(item)
    }
    expect(notebookOutputFromRecord({ output_type: 'unknown' })).toBeNull()
    expect(notebookOutputFromRecord('x')).toBeNull()
  })

  it('reads the kernelspec the file names for auto-connect', () => {
    // Auto-connect honours this so a notebook saved against `ir` opens on R rather than
    // on whatever the workspace lists first. A real nbformat document names `python3`.
    expect(parseNotebook(SAMPLE).kernelspecName).toBe('python3')
    const named = JSON.stringify({
      cells: [],
      metadata: { kernelspec: { name: 'ir', display_name: 'R', language: 'R' } },
      nbformat: 4,
      nbformat_minor: 5,
    })
    expect(parseNotebook(named).kernelspecName).toBe('ir')
    // A file with no kernelspec yields '', so auto-connect falls back to the Host's guess.
    expect(parseNotebook('{"nbformat":4,"cells":[],"metadata":{}}').kernelspecName).toBe('')
  })

  it('generates unique-looking cell ids and empty cells per kind', () => {
    expect(createCellId()).toMatch(/^dsh-[a-z0-9]+$/u)
    expect(emptyCell('markdown')).toMatchObject({ cell_type: 'markdown', source: [] })
    expect(emptyCell('raw')).not.toHaveProperty('outputs')
  })

  it('seeds a blank file with a valid notebook on its first cell', () => {
    // A notebook made from the file tree starts as an empty file; the cell surface has
    // no JSON tree to insert into, so its first action has to create the document.
    expect(notebookIsBlank('')).toBe(true)
    expect(notebookIsBlank('  \n ')).toBe(true)
    expect(notebookIsBlank('{"cells":[]}')).toBe(false)
    const seeded = createNotebookSkeleton('code')
    expect(notebookIsBlank(seeded)).toBe(false)
    const document = parseNotebook(seeded)
    expect(document.warning).toBeNull()
    expect(document.cells).toHaveLength(1)
    expect(document.cells[0]?.kind).toBe('code')
    expect(document.nbformat).toBe(4)
    expect(JSON.parse(seeded).metadata.kernelspec).toBeDefined()
    // The skeleton is valid input for every later mutation, including the raw kinds.
    // Each skeleton mints its own cell id, so one string is reused throughout.
    const rawSkeleton = createNotebookSkeleton('raw')
    const fromRaw = parseNotebook(rawSkeleton)
    const rawId = fromRaw.cells[0]?.id ?? ''
    expect(fromRaw.cells[0]?.kind).toBe('raw')
    const seededId = document.cells[0]!.id
    expect(seededId).not.toBe(rawId)
    expect(applyNotebookMutation(seeded, { op: 'set-source', cellId: seededId, source: 'x = 1' }))
      .toContain('x = 1')
    expect(applyNotebookMutation(rawSkeleton, { op: 'set-kind', cellId: rawId, kind: 'code' }))
      .toContain('"cell_type": "code"')
  })

  it('refuses to mutate unreadable notebook text with a typed error', () => {
    // The surface calls this from click handlers; a raw SyntaxError would crash the
    // panel where a NotebookEditError is a refused edit.
    expect(() => applyNotebookMutation('not json', { op: 'insert', cellId: null, before: false, kind: 'code' }))
      .toThrow(NotebookEditError)
    expect(() => applyNotebookMutation('[1,2]', { op: 'delete', cellId: 'a' }))
      .toThrow(NotebookEditError)
  })
})
