import { describe, expect, it } from 'vitest'
import {
  appendColumn,
  appendRow,
  clearCells,
  columnKind,
  deleteColumn,
  deleteColumns,
  deleteRow,
  deleteRows,
  insertColumn,
  insertRow,
  pasteRegion,
  renameColumn,
  setCell,
  summarizeColumn,
  toGrid,
} from '../src/client/csv/csv-edit.ts'

const grid = () => toGrid(['a', 'b'], [['1', '2'], ['3', '4']])

describe('toGrid', () => {
  it('rectangularizes ragged rows to the widest column count', () => {
    const g = toGrid(['a', 'b', 'c'], [['1'], ['2', '3', '4', '5']])
    expect(g.columns).toEqual(['a', 'b', 'c', ''])
    expect(g.rows).toEqual([['1', '', '', ''], ['2', '3', '4', '5']])
  })
})

describe('setCell / renameColumn', () => {
  it('replaces an in-bounds cell and leaves the original grid untouched', () => {
    const source = grid()
    const next = setCell(source, 0, 1, 'X')
    expect(next.rows[0]).toEqual(['1', 'X'])
    expect(source.rows[0]).toEqual(['1', '2'])
  })

  it('is a no-op for out-of-range coordinates', () => {
    const source = grid()
    expect(setCell(source, 5, 0, 'x')).toBe(source)
    expect(renameColumn(source, 9, 'z')).toBe(source)
  })

  it('renames one header', () => {
    expect(renameColumn(grid(), 0, 'name').columns).toEqual(['name', 'b'])
  })
})

describe('row operations', () => {
  it('inserts an empty row at an index and clamps past the end', () => {
    expect(insertRow(grid(), 1).rows).toEqual([['1', '2'], ['', ''], ['3', '4']])
    expect(insertRow(grid(), 99).rows).toHaveLength(3)
    expect(insertRow(grid(), -2).rows).toEqual([['', ''], ['1', '2'], ['3', '4']])
  })

  it('appends a row and deletes one', () => {
    expect(appendRow(grid()).rows).toEqual([['1', '2'], ['3', '4'], ['', '']])
    expect(deleteRow(grid(), 0).rows).toEqual([['3', '4']])
  })

  it('leaves the grid intact for an invalid delete index', () => {
    const source = grid()
    expect(deleteRow(source, -1)).toBe(source)
    expect(deleteRow(source, 2)).toBe(source)
  })
})

describe('column operations', () => {
  it('inserts a column, extending every row', () => {
    const next = insertColumn(grid(), 1)
    expect(next.columns).toEqual(['a', '', 'b'])
    expect(next.rows).toEqual([['1', '', '2'], ['3', '', '4']])
  })

  it('appends a column at the end', () => {
    expect(appendColumn(grid(), 'c').columns).toEqual(['a', 'b', 'c'])
  })

  it('deletes a column but refuses to remove the last one', () => {
    expect(deleteColumn(grid(), 0).columns).toEqual(['b'])
    const single = toGrid(['only'], [['x']])
    expect(deleteColumn(single, 0)).toBe(single)
  })
})

describe('pasteRegion', () => {
  it('fills a block at the anchor and grows the table when it overflows', () => {
    const next = pasteRegion(grid(), 1, 1, [['p', 'q'], ['r', 's']])
    expect(next.rows).toEqual([['1', '2', ''], ['3', 'p', 'q'], ['', 'r', 's']])
  })

  it('is a no-op for an empty block', () => {
    const source = grid()
    expect(pasteRegion(source, 0, 0, [])).toBe(source)
  })
})

describe('range operations', () => {
  it('clears every cell inside the rectangle', () => {
    const next = clearCells(toGrid(['a', 'b'], [['1', '2'], ['3', '4'], ['5', '6']]), 0, 1, 1, 1)
    expect(next.rows).toEqual([['1', ''], ['3', ''], ['5', '6']])
  })

  it('deletes an inclusive row range', () => {
    const next = deleteRows(toGrid(['a'], [['1'], ['2'], ['3'], ['4']]), 1, 2)
    expect(next.rows).toEqual([['1'], ['4']])
  })

  it('deletes an inclusive column range but keeps at least one column', () => {
    expect(deleteColumns(toGrid(['a', 'b', 'c'], [['1', '2', '3']]), 0, 1).columns).toEqual(['c'])
    const single = toGrid(['a', 'b'], [['1', '2']])
    expect(deleteColumns(single, 0, 1)).toBe(single)
  })
})

describe('columnKind / summarizeColumn', () => {
  it('classifies number, date and mixed columns', () => {
    expect(columnKind([['1'], ['2.5'], ['-3']], 0)).toBe('number')
    expect(columnKind([['2026-01-02'], ['2026-12-31']], 0)).toBe('date')
    expect(columnKind([['1'], ['x']], 0)).toBe('text')
    expect(columnKind([[''], ['']], 0)).toBe('text')
  })

  it('aggregates a numeric column', () => {
    const summary = summarizeColumn([['10'], [''], ['20'], ['30']], 0)
    expect(summary.kind).toBe('number')
    expect(summary.filled).toBe(3)
    expect(summary.sum).toBe(60)
    expect(summary.min).toBe(10)
    expect(summary.max).toBe(30)
    expect(summary.mean).toBe(20)
  })

  it('omits stats for non-numeric columns', () => {
    const summary = summarizeColumn([['a'], ['b']], 0)
    expect(summary.kind).toBe('text')
    expect(summary.filled).toBe(2)
    expect(summary.sum).toBeUndefined()
  })
})
