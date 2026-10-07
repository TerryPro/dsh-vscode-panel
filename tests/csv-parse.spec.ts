import { describe, expect, it } from 'vitest'
import {
  CSV_RENDER_MAX_ROWS,
  columnIsNumeric,
  compareCsvValues,
  detectDelimiter,
  filterCsvRows,
  parseCsv,
  sortCsvRows,
} from '../src/client/csv/csv-parse.ts'

describe('detectDelimiter', () => {
  it('picks the most frequent candidate separator on the first line', () => {
    expect(detectDelimiter('a,b,c\n1,2,3')).toBe(',')
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t')
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';')
    expect(detectDelimiter('a|b|c\n1|2|3')).toBe('|')
  })

  it('ignores delimiters that appear inside quoted cells', () => {
    expect(detectDelimiter('"a,b",c\nd,e')).toBe(',')
  })

  it('defaults to a comma when no candidate separator is present', () => {
    expect(detectDelimiter('onlyone\nvalue')).toBe(',')
  })
})

describe('parseCsv', () => {
  it('treats the first record as the header and keeps the rest as rows', () => {
    const doc = parseCsv('name,age\nAda,36\nBob,41')
    expect(doc.columns).toEqual(['name', 'age'])
    expect(doc.rows).toEqual([['Ada', '36'], ['Bob', '41']])
    expect(doc.totalRows).toBe(2)
    expect(doc.truncated).toBe(false)
  })

  it('unwraps quoted fields, honoring embedded delimiters, newlines and escaped quotes', () => {
    const doc = parseCsv('a,b\n"say ""hi""","x,y"\n"line1\nline2",z')
    expect(doc.rows[0]).toEqual(['say "hi"', 'x,y'])
    expect(doc.rows[1]).toEqual(['line1\nline2', 'z'])
  })

  it('normalizes CRLF and lone CR endings and drops the trailing-newline phantom row', () => {
    expect(parseCsv('a,b\r\n1,2\r\n').rows).toEqual([['1', '2']])
    expect(parseCsv('a,b\r1,2').rows).toEqual([['1', '2']])
  })

  it('strips a leading byte-order mark and skips blank lines', () => {
    const doc = parseCsv('\uFEFFa,b\n\n1,2\n\n')
    expect(doc.columns).toEqual(['a', 'b'])
    expect(doc.rows).toEqual([['1', '2']])
  })

  it('pads ragged rows to the widest column count', () => {
    const doc = parseCsv('a,b,c\n1,2\n3,4,5,6')
    expect(doc.columns).toEqual(['a', 'b', 'c', ''])
    expect(doc.rows[0]).toEqual(['1', '2', '', ''])
    expect(doc.rows[1]).toEqual(['3', '4', '5', '6'])
  })

  it('honors an explicit delimiter override', () => {
    const doc = parseCsv('a\tb\tc\n1\t2\t3', { delimiter: '\t' })
    expect(doc.delimiter).toBe('\t')
    expect(doc.columns).toEqual(['a', 'b', 'c'])
  })

  it('returns an empty document for blank input', () => {
    expect(parseCsv('')).toEqual({ delimiter: ',', columns: [], rows: [], totalRows: 0, truncated: false })
    expect(parseCsv('   \n\n')).toMatchObject({ columns: [], rows: [] })
  })

  it('caps rendered rows and reports the truncated total', () => {
    const header = 'id\n'
    const body = Array.from({ length: 10 }, (_, i) => String(i)).join('\n')
    const doc = parseCsv(`${header}${body}`, { maxRows: 3 })
    expect(doc.rows).toHaveLength(3)
    expect(doc.totalRows).toBe(10)
    expect(doc.truncated).toBe(true)
  })

  it('exposes the default render cap through the constant', () => {
    expect(CSV_RENDER_MAX_ROWS).toBeGreaterThan(0)
  })
})

describe('compareCsvValues', () => {
  it('compares numerically when both cells are numbers', () => {
    expect(compareCsvValues('2', '10')).toBeLessThan(0)
    expect(compareCsvValues('-5', '3')).toBeLessThan(0)
    expect(compareCsvValues('1e3', '999')).toBeGreaterThan(0)
    expect(compareCsvValues(' 4 ', '4')).toBe(0)
  })

  it('falls back to a natural, digit-aware string comparison', () => {
    expect(compareCsvValues('item2', 'item10')).toBeLessThan(0)
    expect(compareCsvValues('apple', 'Banana')).toBeLessThan(0)
  })
})

describe('sortCsvRows', () => {
  const rows = [['b', '3'], ['a', '1'], ['c', '2']] as const

  it('sorts ascending and descending by the selected column', () => {
    expect(sortCsvRows(rows, 0, 'asc').map(r => r[0])).toEqual(['a', 'b', 'c'])
    expect(sortCsvRows(rows, 1, 'desc').map(r => r[1])).toEqual(['3', '2', '1'])
  })

  it('is stable for equal keys, preserving original order', () => {
    const input = [['x', '1'], ['y', '1'], ['z', '1']] as const
    expect(sortCsvRows(input, 1, 'asc').map(r => r[0])).toEqual(['x', 'y', 'z'])
  })

  it('returns a copy unchanged for a negative column index', () => {
    expect(sortCsvRows(rows, -1, 'asc')).toEqual(rows)
  })
})

describe('columnIsNumeric', () => {
  it('is true only when a column has a value and all values are numeric', () => {
    expect(columnIsNumeric([['1'], ['2'], ['3']], 0)).toBe(true)
    expect(columnIsNumeric([['1'], [''], ['3']], 0)).toBe(true)
    expect(columnIsNumeric([['1'], ['x']], 0)).toBe(false)
    expect(columnIsNumeric([[''], ['']], 0)).toBe(false)
  })

  it('returns false for an out-of-range column', () => {
    expect(columnIsNumeric([['1']], 5)).toBe(false)
  })
})

describe('filterCsvRows', () => {
  const rows = [['Alice', '30'], ['Bob', '5'], ['Cara', '20']] as const

  it('returns the input untouched for a blank or whitespace query', () => {
    expect(filterCsvRows(rows, '')).toBe(rows)
    expect(filterCsvRows(rows, '   ')).toBe(rows)
  })

  it('keeps rows whose any cell matches case-insensitively', () => {
    expect(filterCsvRows(rows, 'ar').map(r => r[0])).toEqual(['Cara'])
    expect(filterCsvRows(rows, 'a').map(r => r[0])).toEqual(['Alice', 'Cara'])
  })

  it('matches on numeric cells by their text too', () => {
    expect(filterCsvRows(rows, '20').map(r => r[0])).toEqual(['Cara'])
  })

  it('returns nothing when no cell matches', () => {
    expect(filterCsvRows(rows, 'zzz')).toEqual([])
  })
})
