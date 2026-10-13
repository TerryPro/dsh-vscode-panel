import { describe, expect, it } from 'vitest'
import { quotedSqlIdentifier, selectAllFrom } from '../src/client/sql/sql-schema-tree.ts'

describe('quotedSqlIdentifier', () => {
  it('quotes an ordinary name so a keyword or a space works', () => {
    expect(quotedSqlIdentifier('city')).toBe('"city"')
    // `select` and `order` are keywords, and a name is allowed to be one.
    expect(quotedSqlIdentifier('select')).toBe('"select"')
    expect(quotedSqlIdentifier('order details')).toBe('"order details"')
  })

  it('doubles the quote instead of stripping it', () => {
    // Sanitizing a name would silently query a *different* table when both exist; doubling the
    // quote is SQLite's own escape, so the statement means the table the reader double-clicked.
    expect(quotedSqlIdentifier('a"b')).toBe('"a""b"')
    expect(quotedSqlIdentifier('""')).toBe('""""""')
  })
})

describe('selectAllFrom', () => {
  it('takes the connection’s own row cap, so the cell is not asked for rows it would drop', () => {
    expect(selectAllFrom('city', 1000)).toBe('SELECT * FROM "city" LIMIT 1000')
  })

  it('keeps a quoted name quoted in the statement', () => {
    expect(selectAllFrom('odd"name', 500)).toBe('SELECT * FROM "odd""name" LIMIT 500')
  })
})
