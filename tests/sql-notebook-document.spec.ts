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
  writeSqlCellResults,
  writeSqlNotebookConnection,
} from '../src/client/sql/sql-notebook-document.ts'
import type { SqlResultBlock, SqlRow } from '../src/shared/sql-protocol.ts'
import { sqlBlock } from './sql-block-fixture.ts'

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

/**
 * Version 2 (ADR 0007): the file also carries the connection and each cell's last results.
 *
 * These cases are about the two directions that matter — a v1 file must stay usable, and a v2 file
 * must round-trip its results exactly enough that reopening a notebook shows what the run produced.
 */
describe('结果与连接记进文件', () => {
  const block = (overrides: Partial<SqlResultBlock> = {}): SqlResultBlock =>
    sqlBlock([{ label: 'id', name: 'id', type: 'INTEGER' }, { label: 'who', name: 'who' }], [[7, 'Tokyo']], overrides)

  it('writes one cell’s results and the prompt number, and reads them back', () => {
    const written = writeSqlCellResults(doc([{ kind: 'sql', source: 'SELECT 1' }]), 0, [block()], 3, 42)

    expect(written).not.toBeNull()
    const parsed = parseSqlNotebook(written ?? '')
    expect(parsed.cells[0]?.blocks).toHaveLength(1)
    expect(parsed.cells[0]?.blocks[0]?.rows).toEqual([[7, 'Tokyo']])
    expect(parsed.cells[0]?.blocks[0]?.columns).toEqual([
      { label: 'id', name: 'id', type: 'INTEGER' },
      { label: 'who', name: 'who' },
    ])
    expect(parsed.cells[0]?.executionCount).toBe(3)
    expect(parsed.cells[0]?.elapsedMs).toBe(42)
  })

  it('keeps every value shape a result can carry, including NULL and a BLOB envelope', () => {
    // The file is the only copy of a result once the tab closes, so a value this build can show must
    // survive the round trip: a NULL that came back as the text `null` would be a lie about data.
    const rows: SqlRow[] = [[null, ''], [12, 'NULL'], [3.5, { base64: 'eA==', byteLength: 12288, truncated: true }]]
    const written = writeSqlCellResults(doc([{ kind: 'sql', source: 'SELECT 1' }]), 0, [block({ rows })], 1, 1)

    expect(parseSqlNotebook(written ?? '').cells[0]?.blocks[0]?.rows).toEqual(rows)
  })

  it('keeps the cap facts a block has to admit', () => {
    const stored = block({ truncated: true, rowLimit: 1000, columnsDropped: 7, valuesTruncated: 3, stoppedByDeadline: true })
    const written = writeSqlCellResults(doc([{ kind: 'sql', source: 'SELECT 1' }]), 0, [stored], 1, 1)

    expect(parseSqlNotebook(written ?? '').cells[0]?.blocks[0]).toEqual(stored)
  })

  it('keeps a failed statement’s error and a write’s row count', () => {
    const failed = block({ columns: [], rows: [], error: { code: 'SQL_STATEMENT_FAILED', message: 'no such table: nope' } })
    const changed = block({ columns: [], rows: [], changes: 5 })
    const written = writeSqlCellResults(doc([{ kind: 'sql', source: 'x' }]), 0, [failed, changed], 1, 1)

    const blocks = parseSqlNotebook(written ?? '').cells[0]?.blocks ?? []
    expect(blocks[0]?.error?.message).toBe('no such table: nope')
    expect(blocks[1]?.changes).toBe(5)
  })

  it('drops the results and the prompt number together when they are cleared', () => {
    const withResults = writeSqlCellResults(doc([{ kind: 'sql', source: 'SELECT 1' }]), 0, [block()], 3, 42)
    const cleared = writeSqlCellResults(withResults ?? '', 0, [], null, null)

    // The keys are gone from the tree, not merely empty: a cell that never ran must not carry
    // `execution_count: null` in every diff.
    expect(cleared).not.toContain('results')
    expect(cleared).not.toContain('execution_count')
    expect(cleared).not.toContain('elapsed_ms')
    expect(parseSqlNotebook(cleared ?? '').cells[0]?.blocks).toEqual([])
  })

  it('reports no change when the results are already what the file holds', () => {
    // The runtime writes back after every run, so an unchanged write that returned new text would
    // mark a saved notebook dirty for a query that answered the same thing twice.
    const once = writeSqlCellResults(doc([{ kind: 'sql', source: 'SELECT 1' }]), 0, [block()], 1, 1)
    expect(writeSqlCellResults(once ?? '', 0, [block()], 1, 1)).toBeNull()
  })

  it('refuses to record a result in a file this build must not rewrite, keeping its bytes', () => {
    // ADR 0003's rule still holds for writes it applies to: a newer-than-us file is never rewritten,
    // and a failed record must not take the reader's bytes with it.
    expect(writeSqlCellResults(doc([{ kind: 'sql', source: '' }], 99), 0, [block()], 1, 1)).toBeNull()
    expect(writeSqlCellResults('{half a file', 0, [block()], 1, 1)).toBeNull()
  })

  it('records the connection, and reads it back with the default tier when it names none', () => {
    const written = writeSqlNotebookConnection(doc([{ kind: 'sql', source: '' }]), { path: 'demo.db', access: 'writable' })
    expect(parseSqlNotebook(written ?? '').connection).toEqual({ path: 'demo.db', access: 'writable' })

    const vague = JSON.stringify({ version: 2, connection: { path: 'demo.db' }, cells: [] })
    // A record with no tier takes the requirement's default rather than being carried into an open
    // request as `undefined`.
    expect(parseSqlNotebook(vague).connection).toEqual({ path: 'demo.db', access: 'read-only' })
  })

  it('treats a nonsense connection record as no record rather than as a broken file', () => {
    // The record is an optimisation for reopening. Punishing a hand-edited field by hiding the
    // reader's cells would be the wrong trade, and connecting to `undefined` would be worse.
    for (const connection of [7, 'demo.db', {}, { path: '' }, { path: 9 }, []]) {
      const parsed = parseSqlNotebook(JSON.stringify({ version: 2, connection, cells: [{ kind: 'sql', source: 'SELECT 1' }] }))
      expect(parsed.connection, `connection ${JSON.stringify(connection)}`).toBeNull()
      expect(parsed.readOnly).toBe(false)
      expect(parsed.warning).toBeNull()
      expect(parsed.cells[0]?.source).toBe('SELECT 1')
    }
  })

  it('drops a stored block whose shape is wrong instead of rendering a half table', () => {
    // Header and rows coming from different writes is the one failure a viewer must never show: it
    // looks like data. A block that cannot be read whole is dropped, which the reader can see.
    const parsed = parseSqlNotebook(JSON.stringify({
      version: 2,
      cells: [{
        kind: 'sql',
        source: 'SELECT 1',
        results: [
          { columns: [{ label: 'a' }], rows: [['ok']], rowLimit: 10, truncated: false, columnsDropped: 0, valuesTruncated: 0 },
          { columns: 'not a list', rows: [], rowLimit: 10, truncated: false, columnsDropped: 0, valuesTruncated: 0 },
          { columns: [{ label: 'a' }], rows: [['a', 'b', 'c']], rowLimit: 10, truncated: false, columnsDropped: 0, valuesTruncated: 0 },
          { columns: [{ label: 'a' }], rows: [[{ nope: true }]], rowLimit: 10, truncated: false, columnsDropped: 0, valuesTruncated: 0 },
        ],
      }],
    }))

    expect(parsed.cells[0]?.blocks).toHaveLength(2)
    expect(parsed.cells[0]?.blocks[0]?.rows).toEqual([['ok']])
    // A short row is a Host bug rather than a NULL, and the file keeps it as it arrived.
    expect(parsed.cells[0]?.blocks[1]?.rows).toEqual([['a', 'b', 'c']])
  })

  it('reads a version 1 file, and upgrades it on the first write', () => {
    // Every notebook written before ADR 0007 is a version 1 file. Refusing them would strand the
    // reader's existing notebooks; silently rewriting them on open would dirty them for nothing. The
    // upgrade happens on the first write that needs a v2 field.
    const v1 = doc([{ kind: 'sql', source: 'SELECT 1' }], 1)
    const parsed = parseSqlNotebook(v1)
    expect(parsed.readOnly).toBe(false)
    expect(parsed.warning).toBeNull()
    expect(parsed.connection).toBeNull()
    expect(parsed.cells[0]?.blocks).toEqual([])

    const upgraded = writeSqlCellResults(v1, 0, [block()], 1, 1)
    expect(JSON.parse(upgraded ?? '{}').version).toBe(2)
    expect(parseSqlNotebook(upgraded ?? '').cells[0]?.blocks).toHaveLength(1)
  })

  it('keeps a version 1 file untouched by a plain source edit until a v2 field is written', () => {
    // A reader typing in an old notebook must not see a version bump in the diff for an edit that
    // has nothing to do with results. The bump is the write path's, and this is what it costs.
    const written = applySqlNotebookEdit(doc([{ kind: 'sql', source: '' }], 1), { type: 'source', index: 0, source: 'SELECT 2' })
    expect(JSON.parse(written).version).toBe(2)
    expect(parseSqlNotebook(written).cells[0]?.source).toBe('SELECT 2')
  })

  it('drops a cell’s stored results when its kind stops being sql', () => {
    // A table under a text cell describes a query the cell no longer holds, and the run button for
    // it is gone. Keeping the blocks would show an answer to something the reader cannot re-run.
    const withResults = writeSqlCellResults(doc([{ kind: 'sql', source: 'SELECT 1' }]), 0, [block()], 1, 1)
    const retyped = applySqlNotebookEdit(withResults ?? '', { type: 'kind', index: 0, kind: 'markdown' })

    expect(parseSqlNotebook(retyped).cells[0]?.blocks).toEqual([])
  })

  it('clears every cell’s results at once', () => {
    const two = doc([{ kind: 'sql', source: 'a' }, { kind: 'sql', source: 'b' }])
    const first = writeSqlCellResults(two, 0, [block()], 1, 1)
    const both = writeSqlCellResults(first ?? '', 1, [block()], 2, 2)

    const cleared = applySqlNotebookEdit(both ?? '', { type: 'clearResults' })
    expect(parseSqlNotebook(cleared).cells.map(cell => cell.blocks)).toEqual([[], []])
  })

  it('preserves unknown document and cell keys alongside the new fields', () => {
    // The round trip's original promise has to survive the format change: a field this build does
    // not know is someone else's, and writing results must not drop it.
    const source = JSON.stringify({
      version: 2,
      extra: 7,
      connection: { path: 'demo.db', access: 'read-only' },
      cells: [{ kind: 'sql', source: 'SELECT 1', mine: true }],
    }, null, 2)
    const written = writeSqlCellResults(source, 0, [block()], 1, 1) ?? ''

    expect(written).toContain('"extra": 7')
    expect(written).toContain('"mine": true')
    expect(written).toContain('"demo.db"')
  })
})

describe('skeletons', () => {  it('creates a new notebook as one version and one empty SQL cell', () => {
    const parsed = parseSqlNotebook(createSqlNotebookSkeleton())
    expect(parsed.readOnly).toBe(false)
    expect(parsed.warning).toBeNull()
    expect(parsed.cells).toHaveLength(1)
    expect(parsed.cells[0]?.kind).toBe('sql')
    expect(parsed.cells[0]?.source).toBe('')
  })

  /**
   * The reported bug: a notebook opened from a `.db` started with a blank row.
   *
   * The seeded notebook carried an extra empty cell in front of the query, so the first thing the
   * reader saw was a blank line and the query that actually reads their database sat second. It also
   * contradicted every account of this behaviour: this module's own note ("an empty first cell is
   * the one start that teaches a reader nothing"), the note that the connection record is what keeps
   * "the first cell" from being a `SELECT` against nothing, the README in both languages ("its first
   * cell already lists that database's tables") and N0-P0-2 ("生成一条 SELECT ... LIMIT 首格").
   */
  it('seeds a double-clicked database with the query as the first cell, and nothing before it', () => {
    const parsed = parseSqlNotebook(createSqlNotebookForDatabase('orders'))
    expect(parsed.cells).toHaveLength(1)
    expect(parsed.cells[0]?.source).toBe('SELECT * FROM "orders" LIMIT 100')
  })

  it('falls back to listing tables when no table name is known', () => {
    const parsed = parseSqlNotebook(createSqlNotebookForDatabase(undefined))
    expect(parsed.cells).toHaveLength(1)
    expect(parsed.cells[0]?.source).toContain('sqlite_master')
  })

  it('doubles a quote in a table name so the seeded query stays valid', () => {
    // A schema can legitimately contain a quoted identifier; the first query must not be the
    // thing that looks broken.
    const parsed = parseSqlNotebook(createSqlNotebookForDatabase('we"ird'))
    expect(parsed.cells[0]?.source).toBe('SELECT * FROM "we""ird" LIMIT 100')
  })

  it('records the database in the seeded notebook, so reopening it reconnects', () => {
    const parsed = parseSqlNotebook(createSqlNotebookForDatabase(undefined, 'examples/demo.db'))
    expect(parsed.connection).toEqual({ path: 'examples/demo.db', access: 'read-only' })
  })
})
