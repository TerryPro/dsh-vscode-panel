import { describe, expect, it } from 'vitest'
import type { SqlResultBlock } from '../src/shared/sql-protocol.ts'
import { sqlBlock } from './sql-block-fixture.ts'
import {
  declaredTypeOf,
  describeSqlValue,
  formatBlobSize,
  sqlBlockNotices,
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
