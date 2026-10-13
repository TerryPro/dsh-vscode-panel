import { describe, expect, it } from 'vitest'
import {
  SQLNB_VERSION,
  SqlNotebookEditError,
  applySqlNotebookEdit,
  createSqlNotebookForDatabase,
  createSqlNotebookSkeleton,
  editSqlNotebook,
  isSqlNotebookPath,
  parseSqlNotebook,
  serializeSqlNotebook,
} from '../src/client/sql/sql-notebook-document.ts'

/**
 * The `.sqlnb` document rules, asserted on the pure functions that own them.
 *
 * The two rules that matter most are negative, so most of this suite is about what the code must
 * NOT do: it must never throw on a broken file (the view has to show what it found), and it must
 * never rewrite a file it does not understand (ADR 0003's "never auto-repair", because a silent
 * rewrite turns the user's own bytes into whatever this build happens to expect).
 */

const doc = (cells: unknown[], version = SQLNB_VERSION): string =>
  JSON.stringify({ version, cells }, null, 2) + '\n'

describe('isSqlNotebookPath', () => {
  it('recognises the extension on a workspace-relative path', () => {
    expect(isSqlNotebookPath('notes/a.sqlnb')).toBe(true)
    expect(isSqlNotebookPath('a.SQLNB')).toBe(true)
  })

  it('refuses everything else, including a file merely named sqlnb', () => {
    expect(isSqlNotebookPath(undefined)).toBe(false)
    expect(isSqlNotebookPath('sqlnb')).toBe(false)
    expect(isSqlNotebookPath('a.ipynb')).toBe(false)
    expect(isSqlNotebookPath('a.sql')).toBe(false)
  })
})

describe('parseSqlNotebook — never throws', () => {
  // Every one of these is a click-handler input; a thrown error would take the panel down instead
  // of showing the reader what is wrong with their file.
  const broken = ['', '   ', '{not json', '[1,2,3]', '"just a string"', 'null', '123', '{}', '{"cells":{}}']
  for (const text of broken) {
    it(`reads ${JSON.stringify(text.slice(0, 18))} into a document without throwing`, () => {
      const parsed = parseSqlNotebook(text)
      expect(Array.isArray(parsed.cells)).toBe(true)
    })
  }

  it('names why a non-JSON file cannot be understood', () => {
    expect(parseSqlNotebook('{oops').warning).toBe('invalid-json')
    expect(parseSqlNotebook('[1]').warning).toBe('not-an-object')
    expect(parseSqlNotebook('{"version":1}').warning).toBe('missing-cells')
  })

  it('marks an unreadable file read-only', () => {
    expect(parseSqlNotebook('{oops').readOnly).toBe(true)
    expect(parseSqlNotebook('{"version":99,"cells":[]}').readOnly).toBe(true)
  })

  it('treats the zero-byte file the tree creates as blank, not broken', () => {
    // Creating the file first and adding the first cell afterwards is how notebooks already
    // work, so an empty file must stay writable — otherwise a brand-new notebook could never be
    // given its first cell.
    const parsed = parseSqlNotebook('')
    expect(parsed.blank).toBe(true)
    expect(parsed.warning).toBeNull()
    expect(parsed.readOnly).toBe(false)
  })

  it('downgrades an unknown cell kind to read-only raw text rather than sql', () => {
    // Re-typing an unrecognized cell as sql would run content the author never meant to run.
    const parsed = parseSqlNotebook(doc([{ kind: 'shell', source: 'rm -rf /' }]))
    expect(parsed.cells[0]?.kind).toBe('raw')
    expect(parsed.cells[0]?.degraded).toBe(true)
    expect(parsed.degradedIndexes).toEqual([0])
    // It is still shown, not dropped.
    expect(parsed.cells[0]?.source).toBe('rm -rf /')
  })

  it('keeps a non-object cell visible instead of silently deleting it on the next edit', () => {
    const parsed = parseSqlNotebook(doc(['just a string']))
    expect(parsed.cells).toHaveLength(1)
    expect(parsed.cells[0]?.degraded).toBe(true)
    expect(parsed.degradedIndexes).toEqual([0])
  })

  it('shows an unknown-version file cell by cell when its shape is readable', () => {
    // Hiding content the user asked to look at is worse than showing it read-only; only the
    // write is refused, which the edit test below covers.
    const parsed = parseSqlNotebook(doc([{ kind: 'sql', source: 'SELECT 1' }], 99))
    expect(parsed.warning).toBe('unsupported-version')
    expect(parsed.readOnly).toBe(true)
    expect(parsed.cells[0]?.source).toBe('SELECT 1')
  })

  it('accepts both source shapes the file may use', () => {
    expect(parseSqlNotebook(doc([{ kind: 'sql', source: ['SELECT ', '1'] }])).cells[0]?.source).toBe('SELECT 1')
    expect(parseSqlNotebook(doc([{ kind: 'sql', source: 'SELECT 1' }])).cells[0]?.source).toBe('SELECT 1')
  })

  it('preserves unknown cell and document keys through a parse', () => {
    const parsed = parseSqlNotebook(JSON.stringify({ version: 1, extra: 7, cells: [{ kind: 'sql', source: '', mine: true }] }, null, 2))
    const round = serializeSqlNotebook(JSON.parse(`{"version":1,"extra":7,"cells":[{"kind":"sql","source":"","mine":true}]}`), parsed.format)
    expect(round).toContain('"extra": 7')
    expect(round).toContain('"mine": true')
  })

  it('gives each cell an id derived from its index', () => {
    const parsed = parseSqlNotebook(doc([{ kind: 'sql', source: 'a' }, { kind: 'sql', source: 'b' }]))
    expect(parsed.cells.map(cell => cell.id)).toEqual(['sqlnb-0', 'sqlnb-1'])
  })
})

describe('editSqlNotebook — never auto-repair', () => {
  const touch = (value: Record<string, unknown>): void => {
    const cells = value['cells'] as Record<string, unknown>[]
    cells.push({ kind: 'sql', source: 'SELECT 1' })
  }

  it('refuses to rewrite a file that is not valid JSON', () => {
    expect(() => editSqlNotebook('{half a file', touch)).toThrow(SqlNotebookEditError)
    try {
      editSqlNotebook('{half a file', touch)
    } catch (error) {
      expect((error as SqlNotebookEditError).code).toBe('SQLNB_INVALID_JSON')
    }
  })

  it('refuses a newer version instead of downgrading the user file to what this build knows', () => {
    try {
      editSqlNotebook(doc([{ kind: 'sql', source: '' }], 99), touch)
      expect.unreachable('a version this build does not know must not be written')
    } catch (error) {
      expect(error).toBeInstanceOf(SqlNotebookEditError)
      expect((error as SqlNotebookEditError).code).toBe('SQLNB_UNSUPPORTED_VERSION')
    }
  })

  it('refuses an object with no cells list rather than inventing one over it', () => {
    expect(() => editSqlNotebook('{"version":1}', touch)).toThrow(SqlNotebookEditError)
  })

  it('turns the blank file into a valid document on the first edit', () => {
    // The exception to the rule above, and the reason it is spelled out: an empty file is not a
    // corrupt one, and refusing here would block a brand-new notebook's very first cell.
    const written = editSqlNotebook('', touch)
    expect(parseSqlNotebook(written).readOnly).toBe(false)
    expect(parseSqlNotebook(written).cells).toHaveLength(1)
  })

  it('keeps the file indentation, newline style, BOM and trailing newline it found', () => {
    // The BOM is built by code point, never pasted as a literal: an invisible character in a
    // test file is invisible in the failure message too.
    const crlfBom = `${String.fromCharCode(0xFEFF)}{\r\n  "version": 1,\r\n  "cells": []\r\n}\r\n`
    const written = editSqlNotebook(crlfBom, touch)
    expect(written.charCodeAt(0)).toBe(0xFEFF)
    expect(written).toContain('\r\n')
    expect(written.endsWith('\r\n')).toBe(true)
    expect(written).toContain('\n    ')
  })
})

describe('applySqlNotebookEdit', () => {
  const three = doc([
    { kind: 'sql', source: 'SELECT 1' },
    { kind: 'markdown', source: '# hi' },
    { kind: 'sql', source: 'SELECT 3' },
  ])

  it('rewrites one cell without reflowing the rest', () => {
    const written = applySqlNotebookEdit(three, { type: 'source', index: 1, source: '# edited' })
    const cells = parseSqlNotebook(written).cells
    expect(cells[1]?.source).toBe('# edited')
    expect(cells[0]?.source).toBe('SELECT 1')
    expect(cells[2]?.source).toBe('SELECT 3')
  })

  it('writes a list-form source back as a list', () => {
    // A file that stored its source line-by-line must keep doing so, or editing one cell dirties
    // every line of the document in the diff.
    const listDoc = JSON.stringify({ version: 1, cells: [{ kind: 'sql', source: ['SELECT ', '1'] }] }, null, 2)
    const written = applySqlNotebookEdit(listDoc, { type: 'source', index: 0, source: 'SELECT 2\nFROM t' })
    const cell = JSON.parse(written).cells[0] as { source: unknown }
    expect(Array.isArray(cell.source)).toBe(true)
    expect(parseSqlNotebook(written).cells[0]?.source).toBe('SELECT 2\nFROM t')
  })

  it('inserts after the named cell', () => {
    const written = applySqlNotebookEdit(three, { type: 'insertAfter', index: 0, kind: 'sql' })
    const cells = parseSqlNotebook(written).cells
    expect(cells).toHaveLength(4)
    expect(cells[1]?.source).toBe('')
    expect(cells[2]?.source).toBe('# hi')
  })

  it('removes one cell and re-derives ids from the new order', () => {
    const written = applySqlNotebookEdit(three, { type: 'remove', index: 1 })
    const cells = parseSqlNotebook(written).cells
    expect(cells.map(cell => cell.source)).toEqual(['SELECT 1', 'SELECT 3'])
    // Ids are positional, so they must track the cells that remain rather than keep the old ones.
    expect(cells.map(cell => cell.id)).toEqual(['sqlnb-0', 'sqlnb-1'])
  })

  it('moves a cell and clamps an out-of-range destination to the end', () => {
    const moved = parseSqlNotebook(applySqlNotebookEdit(three, { type: 'move', from: 0, to: 2 })).cells
    expect(moved.map(cell => cell.source)).toEqual(['# hi', 'SELECT 3', 'SELECT 1'])
    // After removing the last cell only two remain, so a destination of 99 clamps to "the end" —
    // which means the order comes back unchanged rather than the cell vanishing or the edit
    // throwing at a drag handler.
    const clamped = parseSqlNotebook(applySqlNotebookEdit(three, { type: 'move', from: 2, to: 99 })).cells
    expect(clamped.map(cell => cell.source)).toEqual(['SELECT 1', '# hi', 'SELECT 3'])
    // A negative destination clamps to the front instead of splicing at -1.
    const front = parseSqlNotebook(applySqlNotebookEdit(three, { type: 'move', from: 2, to: -5 })).cells
    expect(front.map(cell => cell.source)).toEqual(['SELECT 3', 'SELECT 1', '# hi'])
  })

  it('changes a cell kind', () => {
    const written = applySqlNotebookEdit(three, { type: 'kind', index: 0, kind: 'markdown' })
    expect(parseSqlNotebook(written).cells[0]?.kind).toBe('markdown')
  })

  it('ignores an edit whose cell index no longer exists', () => {
    // A drag racing a delete is a real sequence; the file must come back untouched rather than
    // throwing at a click handler.
    const written = applySqlNotebookEdit(three, { type: 'source', index: 42, source: 'gone' })
    expect(parseSqlNotebook(written).cells).toHaveLength(3)
  })
})

describe('skeletons', () => {
  it('creates a new notebook as one version and one empty SQL cell', () => {
    const parsed = parseSqlNotebook(createSqlNotebookSkeleton())
    expect(parsed.readOnly).toBe(false)
    expect(parsed.warning).toBeNull()
    expect(parsed.cells).toHaveLength(1)
    expect(parsed.cells[0]?.kind).toBe('sql')
    expect(parsed.cells[0]?.source).toBe('')
  })

  it('seeds a double-clicked database with a query that reads it', () => {
    const parsed = parseSqlNotebook(createSqlNotebookForDatabase('orders'))
    expect(parsed.cells).toHaveLength(2)
    expect(parsed.cells[1]?.source).toBe('SELECT * FROM "orders" LIMIT 100')
  })

  it('falls back to listing tables when no table name is known', () => {
    const parsed = parseSqlNotebook(createSqlNotebookForDatabase(undefined))
    expect(parsed.cells[1]?.source).toContain('sqlite_master')
  })

  it('doubles a quote in a table name so the seeded query stays valid', () => {
    // A schema can legitimately contain a quoted identifier; the first query must not be the
    // thing that looks broken.
    const parsed = parseSqlNotebook(createSqlNotebookForDatabase('we"ird'))
    expect(parsed.cells[1]?.source).toBe('SELECT * FROM "we""ird" LIMIT 100')
  })
})
