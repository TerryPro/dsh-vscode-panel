import { describe, expect, it } from 'vitest'
import { delimiterForCsvPath, isCsvPath } from '../src/client/csv/csv-path.ts'

describe('isCsvPath', () => {
  it('recognizes csv and tsv by extension, case-insensitively', () => {
    expect(isCsvPath('data.csv')).toBe(true)
    expect(isCsvPath('data.tsv')).toBe(true)
    expect(isCsvPath('REPORT.CSV')).toBe(true)
    expect(isCsvPath('nested/dir/table.tsv')).toBe(true)
  })

  it('normalizes Windows separators before matching the file name', () => {
    expect(isCsvPath('C:\\workspace\\exports\\sheet.csv')).toBe(true)
  })

  it('rejects non-table files, bare names, dotfiles and near-miss suffixes', () => {
    expect(isCsvPath(undefined)).toBe(false)
    expect(isCsvPath('README.md')).toBe(false)
    expect(isCsvPath('notes.txt')).toBe(false)
    expect(isCsvPath('data.csvx')).toBe(false)
    expect(isCsvPath('Makefile')).toBe(false)
    expect(isCsvPath('.csv')).toBe(false)
  })
})

describe('delimiterForCsvPath', () => {
  it('forces the extension-authoritative delimiter for table files', () => {
    expect(delimiterForCsvPath('data.csv')).toBe(',')
    expect(delimiterForCsvPath('export.TSV')).toBe('\t')
    expect(delimiterForCsvPath('nested/dir/table.tsv')).toBe('\t')
  })

  it('returns undefined so non-table paths fall back to sniffing', () => {
    expect(delimiterForCsvPath(undefined)).toBeUndefined()
    expect(delimiterForCsvPath('README.md')).toBeUndefined()
    expect(delimiterForCsvPath('.csv')).toBeUndefined()
  })
})
