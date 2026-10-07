// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import {
  CSV_COLUMN_MAX_WIDTH,
  CSV_COLUMN_MIN_WIDTH,
  clampColumnWidth,
  readCsvColumnWidths,
  saveCsvColumnWidths,
} from '../src/client/csv/csv-column-widths.ts'

/** Mirrors the private key prefix; kept literal so a rename surfaces as a failure. */
const KEY_PREFIX = 'dsh-workbench:csv-col-widths:'

describe('clampColumnWidth', () => {
  it('bounds a pixel width and defaults non-finite input', () => {
    expect(clampColumnWidth(200)).toBe(200)
    expect(clampColumnWidth(1)).toBe(CSV_COLUMN_MIN_WIDTH)
    expect(clampColumnWidth(99999)).toBe(CSV_COLUMN_MAX_WIDTH)
    expect(clampColumnWidth(Number.NaN)).toBe(160)
  })
})

describe('readCsvColumnWidths / saveCsvColumnWidths', () => {
  beforeEach(() => { localStorage.clear() })

  it('defaults to an empty list when nothing is stored', () => {
    expect(readCsvColumnWidths('data.csv')).toEqual([])
  })

  it('round-trips widths per file', () => {
    saveCsvColumnWidths('data.csv', [120, 300])
    saveCsvColumnWidths('other.csv', [80])
    expect(readCsvColumnWidths('data.csv')).toEqual([120, 300])
    expect(readCsvColumnWidths('other.csv')).toEqual([80])
  })

  it('clamps stored values on write and ignores malformed entries on read', () => {
    saveCsvColumnWidths('a.csv', [10, 99999, 200])
    expect(readCsvColumnWidths('a.csv')).toEqual([CSV_COLUMN_MIN_WIDTH, CSV_COLUMN_MAX_WIDTH, 200])
    localStorage.setItem(KEY_PREFIX + 'bad.csv', 'not-json')
    expect(readCsvColumnWidths('bad.csv')).toEqual([])
    localStorage.setItem(KEY_PREFIX + 'obj.csv', '{"x":1}')
    expect(readCsvColumnWidths('obj.csv')).toEqual([])
  })
})
