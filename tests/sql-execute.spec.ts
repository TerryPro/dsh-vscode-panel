// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { ExecutableDatabase, ExecutableStatement } from '../src/host/sql-execute.ts'
import { classifySqlFailure, runCell } from '../src/host/sql-execute.ts'
import { SQL_LIMITS } from '../src/shared/sql-protocol.ts'

/**
 * A script-driven stand-in for the driver.
 *
 * It does not re-implement SQL parsing: each case states exactly what `prepare()` reported —
 * the text it consumed, the columns it described, the rows it yielded, or the error it threw —
 * which is the measured contract from `npm run test:sql`. Everything asserted here is therefore
 * about `runCell`'s decisions (where to advance, when to stop, what to report), not about SQL.
 */
interface Step {
  /** Verbatim prefix of the text handed to prepare(), as the driver's sourceSQL would be. */
  consumed?: string
  columns?: { name: string; type: string | null }[]
  rows?: readonly unknown[][]
  /** Thrown by prepare(). `nothingLeft` mirrors ERR_INVALID_STATE on a comment-only tail. */
  prepareThrows?: Error | 'nothingLeft'
  /** Thrown while stepping rows, which is when an authorization or constraint failure appears. */
  iterateThrows?: Error
  changes?: number
}

function fakeDatabase(steps: Step[]): ExecutableDatabase & { calls: string[]; released: number[] } {
  const calls: string[] = []
  const released: number[] = []
  let index = 0
  return {
    calls,
    released,
    prepare(sql: string): ExecutableStatement {
      calls.push(sql)
      const step = steps[index]
      index += 1
      if (step === undefined) {
        throw new TypeError('fake driver ran out of scripted statements — the loop asked for more')
      }
      if (step.prepareThrows !== undefined) {
        if (step.prepareThrows === 'nothingLeft') {
          throw Object.assign(new Error('statement has been finalized'), { code: 'ERR_INVALID_STATE' })
        }
        throw step.prepareThrows
      }
      const consumed = step.consumed ?? sql
      const rows = step.rows ?? []
      const columns = step.columns ?? []
      return {
        sourceSQL: consumed,
        columns: () => columns,
        setReadBigInts: vi.fn(),
        setReturnArrays: vi.fn(),
        run: () => {
          if (step.iterateThrows !== undefined) throw step.iterateThrows
          return { changes: step.changes ?? 0, lastInsertRowid: 1 }
        },
        iterate() {
          let cursor = 0
          const iterator = {
            [Symbol.iterator]() { return iterator },
            next(): IteratorResult<readonly unknown[]> {
              if (step.iterateThrows !== undefined && cursor === 0) throw step.iterateThrows
              if (cursor >= rows.length) return { done: true, value: undefined as never }
              const row = rows[cursor]
              cursor += 1
              if (row === undefined) return { done: true, value: undefined as never }
              return { done: false, value: row }
            },
            return(): IteratorResult<readonly unknown[]> {
              // Counted because an abandoned scan holding its read transaction is a measured
              // hazard: the row cap and the deadline must both release it.
              released.push(cursor)
              return { done: true, value: undefined as never }
            },
          }
          return iterator
        },
      } as unknown as ExecutableStatement
    },
  }
}

const err = (message: string, code = 'ERR_SQLITE_ERROR'): Error => Object.assign(new Error(message), { code })

describe('runCell — statement loop', () => {
  it('produces one block per statement and advances by the consumed prefix', async () => {
    const db = fakeDatabase([
      { consumed: 'SELECT 1 AS a;', columns: [{ name: 'a', type: null }], rows: [[1]] },
      { consumed: ' SELECT 2 AS b;', columns: [{ name: 'b', type: null }], rows: [[2]] },
    ])
    const run = await runCell(db, 'SELECT 1 AS a; SELECT 2 AS b;', { rowLimit: 1000 })
    expect(run.blocks.map(block => block.rows.length)).toEqual([1, 1])
    expect(run.blocks[0]?.columns[0]?.name).toBe('a')
    expect(run.blocks[1]?.columns[0]?.name).toBe('b')
    // The second prepare must have received only the remainder: advancing by anything else would
    // re-run the first statement, which for an INSERT is a real data accident.
    expect(db.calls[1]).toBe(' SELECT 2 AS b;')
  })

  it('treats a trailing comment or blank tail as the end of the cell, not as an error', async () => {
    // Measured: prepare() on comment-only text throws ERR_INVALID_STATE "statement has been
    // finalized". Painting that as a user error would mark every cell ending in a comment red.
    const db = fakeDatabase([
      { consumed: 'SELECT 1 AS a;', columns: [{ name: 'a', type: null }], rows: [[1]] },
      { prepareThrows: 'nothingLeft' },
    ])
    const run = await runCell(db, 'SELECT 1 AS a; -- note\n', { rowLimit: 1000 })
    expect(run.blocks).toHaveLength(1)
    expect(run.blocks[0]?.error).toBeUndefined()
  })

  it('stops without advancing when the consumed text is not a prefix of the input', async () => {
    // Defensive branch: if a future runtime ever normalizes sourceSQL instead of echoing a
    // slice, slicing by its length would skip or repeat user text. Stopping loses work loudly;
    // continuing would run a statement twice.
    const db = fakeDatabase([{ consumed: 'SELECT 9 AS nope', columns: [{ name: 'a', type: null }], rows: [] }])
    const run = await runCell(db, 'SELECT 1 AS a;', { rowLimit: 1000 })
    expect(run.blocks).toHaveLength(0)
    expect(db.calls).toHaveLength(1)
  })

  it('reports at most one failing block and stops the cell there', async () => {
    // 遇错即停: statement 2 fails, statement 3 must never be attempted, and the block already
    // produced for statement 1 stays visible.
    const db = fakeDatabase([
      { consumed: 'INSERT INTO t VALUES (1);', columns: [], rows: [], changes: 1 },
      { consumed: 'SELECT * FROM missing;', prepareThrows: err('no such table: missing') },
    ])
    const run = await runCell(db, 'INSERT INTO t VALUES (1); SELECT * FROM missing; INSERT INTO t VALUES (3)', { rowLimit: 1000 })
    expect(run.blocks).toHaveLength(2)
    expect(run.blocks[0]?.changes).toBe(1)
    expect(run.blocks[1]?.error?.code).toBe('SQL_OBJECT_NOT_FOUND')
    expect(db.calls).toHaveLength(2)
  })
})

describe('runCell — row cap and deadline', () => {
  it('flags truncation from the one extra row it probes, and never shows that row', async () => {
    const rows = Array.from({ length: 5 }, (_unused, i) => [i])
    const db = fakeDatabase([{ consumed: 'SELECT i FROM t', columns: [{ name: 'i', type: 'INTEGER' }], rows }])
    const run = await runCell(db, 'SELECT i FROM t', { rowLimit: 3 })
    expect(run.blocks[0]?.rows).toHaveLength(3)
    expect(run.blocks[0]?.truncated).toBe(true)
    expect(run.blocks[0]?.rowLimit).toBe(3)
    // The scan was abandoned, not drained: an unfinished iterate() holds its read transaction.
    expect(db.released.length).toBeGreaterThan(0)
  })

  it('does not flag truncation when the rows exactly fill the cap', async () => {
    const rows = Array.from({ length: 3 }, (_unused, i) => [i])
    const db = fakeDatabase([{ consumed: 'SELECT i FROM t', columns: [{ name: 'i', type: 'INTEGER' }], rows }])
    const run = await runCell(db, 'SELECT i FROM t', { rowLimit: 3 })
    expect(run.blocks[0]?.truncated).toBe(false)
    expect(run.blocks[0]?.rows).toHaveLength(3)
  })

  it('keeps the rows it already fetched when the deadline stops the scan', async () => {
    // Measured: the deadline can only be observed between chunks, since a statement already
    // stepping cannot be interrupted on this runtime. Whatever arrived is still worth showing —
    // discarding it would make a long scan look like a failed one.
    let clock = 0
    const rows = Array.from({ length: SQL_LIMITS.rowChunk * 3 }, (_unused, i) => [i])
    const db = fakeDatabase([{ consumed: 'SELECT i FROM t', columns: [{ name: 'i', type: 'INTEGER' }], rows }])
    const run = await runCell(db, 'SELECT i FROM t', {
      rowLimit: 10_000,
      deadlineMs: 50,
      now: () => clock,
      yieldToEventLoop: async () => { clock += 30 },
    })
    expect(run.blocks[0]?.stoppedByDeadline).toBe(true)
    expect(run.blocks[0]?.rows.length).toBeGreaterThan(0)
    expect(run.blocks[0]?.truncated).toBe(false)
  })

  it('stops taking rows at the next chunk when the reader cancels', async () => {
    // The cancel flag is read at the same await points as the deadline, because those are the only
    // places the host thread comes back. What the scan had already fetched stays in the block:
    // this loop's job is to stop pulling, not to decide what the panel shows for a cancelled cell.
    let checks = 0
    const rows = Array.from({ length: SQL_LIMITS.rowChunk * 4 }, (_unused, i) => [i])
    const db = fakeDatabase([
      { consumed: 'SELECT i FROM t', columns: [{ name: 'i', type: 'INTEGER' }], rows },
      { consumed: ' SELECT 2 AS b', columns: [{ name: 'b', type: null }], rows: [[2]] },
    ])
    const run = await runCell(db, 'SELECT i FROM t; SELECT 2 AS b', {
      rowLimit: 10_000,
      // Checked at both ends of a chunk: once when the cell starts and once when the loop hands
      // the thread back. The third ask is the first one at the second boundary.
      isCancelled: () => { checks += 1; return checks >= 3 },
    })

    expect(run.blocks).toHaveLength(1)
    expect(run.blocks[0]?.rows).toHaveLength(SQL_LIMITS.rowChunk * 2)
    // Not truncated: the cap stopped nothing, the reader did.
    expect(run.blocks[0]?.truncated).toBe(false)
    // The abandoned scan released its iterator, which is the hazard the cancel exists to end: an
    // unfinished scan keeps its read transaction, and that keeps the file occupied.
    expect(db.released).toHaveLength(1)
    expect(db.calls).toHaveLength(1)
  })

  it('does not start the next statement once the reader has cancelled', async () => {
    // A cancel landing between statements ends the cell instead of beginning the next one: the
    // reader asked this cell to stop, and the cell is its statements.
    let checks = 0
    const db = fakeDatabase([
      { consumed: 'SELECT 1 AS a;', columns: [{ name: 'a', type: null }], rows: [[1]] },
      { consumed: ' SELECT 2 AS b;', columns: [{ name: 'b', type: null }], rows: [[2]] },
    ])
    const run = await runCell(db, 'SELECT 1 AS a; SELECT 2 AS b;', {
      rowLimit: 1000,
      isCancelled: () => { checks += 1; return checks > 1 },
    })

    expect(run.blocks).toHaveLength(1)
    expect(run.blocks[0]?.rows).toHaveLength(1)
    expect(db.calls).toHaveLength(1)
    expect(checks).toBe(2)
  })

  it('yields the event loop between chunks rather than holding the host thread', async () => {
    // The whole reason the execution shape exists: one measured synchronous query left a real
    // host route waiting 4336 ms. A fake clock proves the awaits happened; counting them proves
    // the loop is chunked rather than draining in one go.
    const yields = vi.fn(async () => {})
    const rows = Array.from({ length: SQL_LIMITS.rowChunk * 2 + 1 }, (_unused, i) => [i])
    const db = fakeDatabase([{ consumed: 'SELECT i FROM t', columns: [{ name: 'i', type: 'INTEGER' }], rows }])
    await runCell(db, 'SELECT i FROM t', { rowLimit: 10_000, yieldToEventLoop: yields })
    expect(yields.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('does not yield when the result fits inside one chunk', async () => {
    const yields = vi.fn(async () => {})
    const db = fakeDatabase([{ consumed: 'SELECT 1 AS a', columns: [{ name: 'a', type: null }], rows: [[1]] }])
    await runCell(db, 'SELECT 1 AS a', { rowLimit: 10_000, yieldToEventLoop: yields })
    expect(yields).not.toHaveBeenCalled()
  })
})

describe('runCell — column cap and duplicate names', () => {
  it('drops columns past the width cap and counts them', async () => {
    const wide = SQL_LIMITS.maxColumns + 10
    const columns = Array.from({ length: wide }, (_unused, i) => ({ name: `c${i}`, type: 'INTEGER' }))
    const rows = [Array.from({ length: wide }, (_unused, i) => i)]
    const db = fakeDatabase([{ consumed: 'SELECT * FROM wide', columns, rows }])
    const run = await runCell(db, 'SELECT * FROM wide', { rowLimit: 100 })
    expect(run.blocks[0]?.columns).toHaveLength(SQL_LIMITS.maxColumns)
    expect(run.blocks[0]?.columnsDropped).toBe(10)
    // The row must be cut to the same width, or a kept value would surface under the wrong header.
    expect(run.blocks[0]?.rows[0]).toHaveLength(SQL_LIMITS.maxColumns)
  })

  it('numbers duplicate headers while keeping the names SQLite reported', async () => {
    // Measured: `SELECT a, a FROM t` reports two columns both named a, and an object row would
    // have collapsed them into one value before this code ever saw it.
    const db = fakeDatabase([{
      consumed: 'SELECT a, a FROM t',
      columns: [{ name: 'a', type: 'INTEGER' }, { name: 'a', type: 'INTEGER' }],
      rows: [[1, 2]],
    }])
    const run = await runCell(db, 'SELECT a, a FROM t', { rowLimit: 100 })
    expect(run.blocks[0]?.columns.map(c => c.label)).toEqual(['a', 'a_2'])
    expect(run.blocks[0]?.rows[0]).toEqual([1, 2])
  })

  it('turns a statement with no result set into a change count rather than an empty grid', async () => {
    // Measured: columns() is empty for DDL and for BEGIN/COMMIT, which is how the loop tells a
    // changed-database statement from a query without calling it an error.
    const db = fakeDatabase([{ consumed: 'UPDATE t SET a = 1 WHERE 0', columns: [], rows: [], changes: 0 }])
    const run = await runCell(db, 'UPDATE t SET a = 1 WHERE 0', { rowLimit: 100 })
    expect(run.blocks[0]?.changes).toBe(0)
    expect(run.blocks[0]?.rows).toEqual([])
    expect(run.blocks[0]?.error).toBeUndefined()
  })
})

describe('classifySqlFailure', () => {
  it('refuses a message that names the database file, since responses stay relative', () => {
    const absolute = '/home/dev/data/app.db'
    const failure = classifySqlFailure(err(`unable to open database file: ${absolute}`), absolute)
    expect(failure.code).toBe('SQL_PATH_UNAVAILABLE')
    expect(failure.message).not.toContain(absolute)
    // Also catches a drive-letter path even when it is not the path we opened with.
    expect(classifySqlFailure(err('cannot open C:\\\\Users\\\\dev\\\\x.db')).code).toBe('SQL_PATH_UNAVAILABLE')
  })

  it('names the denial kinds the panel has to explain differently', () => {
    expect(classifySqlFailure(err('not authorized')).code).toBe('SQL_AUTHORIZATION_DENIED')
    expect(classifySqlFailure(err('authorization denied')).code).toBe('SQL_AUTHORIZATION_DENIED')
    expect(classifySqlFailure(err('attempt to write a readonly database')).code).toBe('SQL_READ_ONLY')
    expect(classifySqlFailure(err('database is locked')).code).toBe('SQL_DATABASE_LOCKED')
    expect(classifySqlFailure(err('no such table: gigs')).code).toBe('SQL_OBJECT_NOT_FOUND')
    expect(classifySqlFailure(err('near "SELEKT": syntax error')).code).toBe('SQL_STATEMENT_FAILED')
  })

  it('keeps the syntax line readable because SQLite reports no position', () => {
    // Measured: there is no line or column in the driver's error, so this one line is all the
    // precision the UI gets, and it must not be dressed up as a position.
    expect(classifySqlFailure(err('near "SELEKT": syntax error')).message).toBe('near "SELEKT": syntax error')
  })

  it('collapses a multi-line message onto its first line', () => {
    expect(classifySqlFailure(err('first line\nsecond line')).message).toBe('first line')
  })
})
