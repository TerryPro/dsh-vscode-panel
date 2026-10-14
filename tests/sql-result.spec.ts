import { describe, expect, it } from 'vitest'
import type { SqlResultBlock } from '../src/shared/sql-protocol.ts'
import { sqlBlock } from './sql-block-fixture.ts'
import {
  declaredTypeOf,
  describeSqlValue,
  formatBlobSize,
  isNumericColumn,
  sqlBlockNotices,
  sqlPageWindow,
  SQL_RESULT_PAGE_SIZE,
} from '../src/client/sql/sql-result.ts'

function block(overrides: Partial<SqlResultBlock> = {}): SqlResultBlock {
  return sqlBlock([{ label: 'x', name: 'x', type: 'INTEGER' }], [[1]], overrides)
}

describe('formatBlobSize', () => {
  it('reads in the unit a reader compares against the cap', () => {
    expect(formatBlobSize(0)).toBe('0 B')
    expect(formatBlobSize(512)).toBe('512 B')
    expect(formatBlobSize(1024)).toBe('1.0 KB')
    expect(formatBlobSize(12_288)).toBe('12.0 KB')
    expect(formatBlobSize(3 * 1024 * 1024)).toBe('3.0 MB')
  })

  it('falls back rather than printing a nonsense magnitude', () => {
    expect(formatBlobSize(-1)).toBe('0 B')
    expect(formatBlobSize(Number.NaN)).toBe('0 B')
    expect(formatBlobSize(Number.POSITIVE_INFINITY)).toBe('0 B')
  })
})

describe('describeSqlValue', () => {
  it('keeps a NULL, an empty string and the text NULL three different results', () => {
    expect(describeSqlValue(null)).toEqual({ kind: 'null' })
    expect(describeSqlValue('')).toEqual({ kind: 'empty' })
    expect(describeSqlValue('NULL')).toEqual({ kind: 'text', text: 'NULL' })
  })

  it('carries a normalized big integer through as the string the Host sent', () => {
    // The Host turns an out-of-range INTEGER into a decimal string precisely so this side
    // cannot lose digits; parsing it back into a Number here would undo that in one step.
    expect(describeSqlValue('9007199254740993')).toEqual({ kind: 'text', text: '9007199254740993' })
    expect(describeSqlValue(42)).toEqual({ kind: 'text', text: '42' })
    expect(describeSqlValue('Infinity')).toEqual({ kind: 'text', text: 'Infinity' })
  })

  it('shows bytes as their real length, and says when the length was not all sent', () => {
    expect(describeSqlValue({ base64: 'eA==', byteLength: 12_288, truncated: false }))
      .toEqual({ kind: 'blob', size: '12.0 KB', truncated: false })
    expect(describeSqlValue({ base64: 'eA==', byteLength: 65_536, truncated: true }))
      .toEqual({ kind: 'blob', size: '64.0 KB', truncated: true })
  })

  it('reads a missing value as a NULL rather than inventing one', () => {
    // A row shorter than `columns` is a bug in the transport, not a database answer. This
    // pins the current behaviour so the bug, if it ever appears, shows up as an empty cell
    // rather than as an exception inside the table.
    expect(describeSqlValue(undefined)).toEqual({ kind: 'null' })
  })
})

describe('sqlBlockNotices', () => {
  it('says nothing about a block that left nothing out', () => {
    expect(sqlBlockNotices(block())).toEqual([])
  })

  it('reports each cap as its own count, and the row cap as the limit that was in force', () => {
    expect(sqlBlockNotices(block({ truncated: true, rowLimit: 250 }))).toEqual([{ code: 'rows', limit: 250 }])
    expect(sqlBlockNotices(block({ columnsDropped: 7 }))).toEqual([{ code: 'columns', count: 7 }])
    expect(sqlBlockNotices(block({ valuesTruncated: 3 }))).toEqual([{ code: 'values', count: 3 }])
    expect(sqlBlockNotices(block({ stoppedByDeadline: true }))).toEqual([{ code: 'deadline' }])
  })

  it('tells a statement that wrote rows apart from one that found none', () => {
    expect(sqlBlockNotices(block({ columns: [], rows: [], changes: 3 }))).toEqual([{ code: 'changes', count: 3 }])
    expect(sqlBlockNotices(block({ columns: [], rows: [] }))).toEqual([{ code: 'empty' }])
    expect(sqlBlockNotices(block({ columns: [], rows: [], changes: 0 }))).toEqual([{ code: 'changes', count: 0 }])
  })

  it('lists every thing a wide, long, clipped scan left out at once', () => {
    const wide = block({
      truncated: true,
      columnsDropped: 136,
      valuesTruncated: 12,
      rows: [[1]],
      columns: [{ label: 'x', name: 'x' }],
    })
    expect(sqlBlockNotices(wide)).toEqual([
      { code: 'rows', limit: 1000 },
      { code: 'columns', count: 136 },
      { code: 'values', count: 12 },
    ])
  })
})

describe('declaredTypeOf', () => {
  it('names the type a column has, and says nothing when it has none', () => {
    expect(declaredTypeOf(block(), 0)).toBe('INTEGER')
    expect(declaredTypeOf(block({ columns: [{ label: 'x', name: 'x' }] }), 0)).toBeNull()
    expect(declaredTypeOf(block({ columns: [{ label: 'x', name: 'x', type: '' }] }), 0)).toBeNull()
    // A column index past the block is the same "we do not know" answer, not a crash.
    expect(declaredTypeOf(block(), 5)).toBeNull()
  })
})

/**
 * Which columns read as numeric, which decides only their alignment.
 *
 * The decision comes from the values rather than from the declared type because SQLite's type
 * system will not answer it: a column declared INTEGER can hold text, and an expression like
 * `1+1` declares nothing at all.
 */
describe('isNumericColumn', () => {
  const two = (rows: SqlResultBlock['rows']): SqlResultBlock =>
    sqlBlock([{ label: 'a', name: 'a' }, { label: 'b', name: 'b' }], rows)

  it('reads a column of numbers as numeric', () => {
    expect(isNumericColumn(two([[1, 'x'], [2, 'y']]), 0)).toBe(true)
    expect(isNumericColumn(two([[1, 'x'], [2, 'y']]), 1)).toBe(false)
  })

  it('counts a big integer the Host carried as a decimal string', () => {
    // The Host turns an out-of-range INTEGER into a string so no digit is lost. Refusing to align
    // it because its JavaScript type is `string` would pull a number out of its own column.
    expect(isNumericColumn(two([['9007199254740993', 'x']]), 0)).toBe(true)
    expect(isNumericColumn(two([['9007199254740993', 'x'], ['-12.5', 'y'], ['7e9', 'z']]), 0)).toBe(true)
  })

  it('stays numeric across a NULL, which is a missing value rather than a text one', () => {
    expect(isNumericColumn(two([[1, 'x'], [null, 'y'], [3, 'z']]), 0)).toBe(true)
  })

  it('is not numeric when any value is text, so a mixed column is not right-aligned', () => {
    expect(isNumericColumn(two([[1, 'x'], ['n/a', 'y']]), 0)).toBe(false)
    // A number with a thousands separator is a formatted string, not a number: the separator is
    // something this viewer deliberately never adds (see the note on `.result`).
    expect(isNumericColumn(two([['1,000'], ['2,000']]), 0)).toBe(false)
  })

  it('right-aligns scientific notation, which is a number the Host sent as text', () => {
    // `7e9` arrives as a string only because the column is TEXT; the CSV grid has always read it as
    // numeric, and refusing it here would leave one number column aligned two ways in two views.
    expect(isNumericColumn(two([['7e9'], ['1e999']]), 0)).toBe(true)
  })

  it('is not numeric for the overflow words the Host sends as strings', () => {
    // Measured against `shapeValue`: a float that overflows arrives as `'Infinity'`, and NaN as
    // `'NaN'`. Neither is a magnitude a reader can compare down a column, so the column that holds
    // one stays with the text columns.
    expect(isNumericColumn(two([[1.5], ['Infinity']]), 0)).toBe(false)
    expect(isNumericColumn(two([['NaN']]), 0)).toBe(false)
  })

  it('never right-aligns bytes: a BLOB has a size, not a magnitude', () => {
    const blob = { base64: 'eA==', byteLength: 1, truncated: false }
    expect(isNumericColumn(two([[blob, 1], [blob, 2]]), 0)).toBe(false)
  })

  it('is not numeric when there is nothing to read', () => {
    // An empty column, or one whose every row is NULL, has no evidence either way; aligning it as
    // numeric would be a guess dressed up as a decision.
    expect(isNumericColumn(sqlBlock([{ label: 'a', name: 'a' }], []), 0)).toBe(false)
    expect(isNumericColumn(sqlBlock([{ label: 'a', name: 'a' }], [[null]]), 0)).toBe(false)
  })
})

describe('sqlPageWindow', () => {
  const rows = (count: number): number[][] => Array.from({ length: count }, (_unused, index) => [index])

  it('shows fifty rows on a page, which is the number the reader is told', () => {
    const page = sqlPageWindow(rows(1000), 1)
    expect(SQL_RESULT_PAGE_SIZE).toBe(50)
    expect(page.rows).toHaveLength(50)
    expect(page.rows[0]?.[0]).toBe(0)
    expect(page.rows.at(-1)?.[0]).toBe(49)
    expect(page).toMatchObject({ from: 1, to: 50, pageCount: 20 })
  })

  it('walks the answer without gaps or overlaps between pages', () => {
    const all = rows(120)
    const first = sqlPageWindow(all, 1)
    const second = sqlPageWindow(all, 2)
    const third = sqlPageWindow(all, 3)
    // The seam is where a slicing bug shows: an off-by-one would drop row 50 or repeat it, and a
    // reader comparing two pages would see the table shift by one under them.
    expect(first.to).toBe(50)
    expect(second.from).toBe(51)
    expect(second.rows[0]?.[0]).toBe(50)
    expect(second.rows.at(-1)?.[0]).toBe(99)
    expect(third.from).toBe(101)
    expect(third.rows).toHaveLength(20)
    expect(third.to).toBe(120)
    expect(first.pageCount).toBe(3)
  })

  it('leaves a short answer as one page with both arrows at the ends', () => {
    const page = sqlPageWindow(rows(30), 1)
    expect(page).toMatchObject({ page: 1, pageCount: 1, from: 1, to: 30 })
    expect(page.rows).toHaveLength(30)
  })

  it('says where it is when there is nothing to show, without inventing a range', () => {
    const page = sqlPageWindow([], 1)
    // `pageCount` of 1 rather than 0 is what lets the view ask "more than one page?" without
    // treating an empty answer as a broken one.
    expect(page).toMatchObject({ page: 1, pageCount: 1, from: 0, to: 0 })
    expect(page.rows).toEqual([])
  })

  it('clamps a page the answer no longer has down to its last page', () => {
    // The normal path, not the error path: a reader on page 20 re-runs the statement and the
    // database answers with sixty rows. Rendered literally that is an empty table with arrows
    // pointing nowhere, on top of a result that is actually full.
    const page = sqlPageWindow(rows(60), 20)
    expect(page).toMatchObject({ page: 2, pageCount: 2, from: 51, to: 60 })
    expect(page.rows).toHaveLength(10)
  })

  it('clamps a nonsense page index rather than showing nothing', () => {
    expect(sqlPageWindow(rows(120), 0).page).toBe(1)
    expect(sqlPageWindow(rows(120), -5).page).toBe(1)
    expect(sqlPageWindow(rows(120), Number.NaN).page).toBe(1)
    expect(sqlPageWindow(rows(120), 99).page).toBe(3)
  })
})
