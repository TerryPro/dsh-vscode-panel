// @vitest-environment node
import { constants as SQLITE } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { authorizeSqlCall, isQueryableTableName } from '../src/host/sql-guards.ts'

/**
 * The authorizer is the only fence between a user's `.db` file and the rest of the machine, so
 * its cases are asserted one by one against the decision function rather than through a live
 * database. `npm run test:sql` proves the same rules hold when the driver calls them; this suite
 * proves the rules themselves did not drift.
 *
 * Assertions compare against the named constants on purpose: `SQLITE_DENY` and
 * `SQLITE_CREATE_INDEX` are both the number 1 (measured), so any test that wrote `=== 1` would
 * pass for the wrong reason, exactly as the code must never reverse-lookup a value into a name.
 */
describe('authorizeSqlCall — cross-file fence (measured: readOnly does not stop ATTACH)', () => {
  for (const access of ['read-only', 'writable'] as const) {
    it(`denies ATTACH and DETACH in the ${access} tier`, () => {
      expect(authorizeSqlCall(SQLITE.SQLITE_ATTACH, '/somewhere/other.db', null, null, access)).toBe(SQLITE.SQLITE_DENY)
      expect(authorizeSqlCall(SQLITE.SQLITE_DETACH, 'other', null, null, access)).toBe(SQLITE.SQLITE_DENY)
    })

    it(`denies anything naming a schema the user did not open in the ${access} tier`, () => {
      expect(authorizeSqlCall(SQLITE.SQLITE_READ, 'secret', 'ssn', 'attached', access)).toBe(SQLITE.SQLITE_DENY)
      expect(authorizeSqlCall(SQLITE.SQLITE_SELECT, null, null, 'attached', access)).toBe(SQLITE.SQLITE_DENY)
    })

    it(`still allows main and the untied cases in the ${access} tier`, () => {
      expect(authorizeSqlCall(SQLITE.SQLITE_READ, 't', 'a', 'main', access)).toBe(SQLITE.SQLITE_OK)
      // count(*) reaches the callback with dbName null: refusing null would refuse plain reads.
      expect(authorizeSqlCall(SQLITE.SQLITE_READ, 't', '', null, access)).toBe(SQLITE.SQLITE_OK)
      expect(authorizeSqlCall(SQLITE.SQLITE_SELECT, null, null, null, access)).toBe(SQLITE.SQLITE_OK)
    })
  }
})

describe('authorizeSqlCall — the read-only tier keeps the scratch workflow (measured)', () => {
  it('allows creating, filling and dropping TEMP objects', () => {
    // Measured: CREATE TEMP TABLE works on a readOnly handle, and it arrives as several calls
    // (create + an INSERT against sqlite_temp_master + a ROWID read), all with dbName 'temp'.
    expect(authorizeSqlCall(SQLITE.SQLITE_CREATE_TEMP_TABLE, 'scratch', null, 'temp', 'read-only')).toBe(SQLITE.SQLITE_OK)
    expect(authorizeSqlCall(SQLITE.SQLITE_CREATE_TABLE, 'scratch', null, 'temp', 'read-only')).toBe(SQLITE.SQLITE_OK)
    expect(authorizeSqlCall(SQLITE.SQLITE_INSERT, 'sqlite_temp_master', null, 'temp', 'read-only')).toBe(SQLITE.SQLITE_OK)
    expect(authorizeSqlCall(SQLITE.SQLITE_DROP_TABLE, 'scratch', null, 'temp', 'read-only')).toBe(SQLITE.SQLITE_OK)
  })

  it('refuses writes into the database file itself', () => {
    for (const action of [SQLITE.SQLITE_INSERT, SQLITE.SQLITE_UPDATE, SQLITE.SQLITE_DELETE, SQLITE.SQLITE_CREATE_TABLE, SQLITE.SQLITE_DROP_TABLE]) {
      expect(authorizeSqlCall(action, 't', null, 'main', 'read-only')).toBe(SQLITE.SQLITE_DENY)
    }
  })

  it('leaves those same writes allowed in the writable tier', () => {
    expect(authorizeSqlCall(SQLITE.SQLITE_INSERT, 't', null, 'main', 'writable')).toBe(SQLITE.SQLITE_OK)
    expect(authorizeSqlCall(SQLITE.SQLITE_CREATE_TABLE, 't', null, 'main', 'writable')).toBe(SQLITE.SQLITE_OK)
  })

  it('does not refuse a read in the read-only tier', () => {
    expect(authorizeSqlCall(SQLITE.SQLITE_SELECT, null, null, 'main', 'read-only')).toBe(SQLITE.SQLITE_OK)
    expect(authorizeSqlCall(SQLITE.SQLITE_TRANSACTION, 'BEGIN', null, null, 'read-only')).toBe(SQLITE.SQLITE_OK)
  })
})

describe('authorizeSqlCall — PRAGMA rules', () => {
  it('refuses query_only in both forms, because ON silently destroys TEMP (measured)', () => {
    expect(authorizeSqlCall(SQLITE.SQLITE_PRAGMA, 'query_only', 'ON', null, 'read-only')).toBe(SQLITE.SQLITE_DENY)
    // The read form carries no argument; allowing it invites the user to set it elsewhere.
    expect(authorizeSqlCall(SQLITE.SQLITE_PRAGMA, 'query_only', null, null, 'read-only')).toBe(SQLITE.SQLITE_DENY)
  })

  it('refuses wal_checkpoint in the no-argument form that still writes -wal (measured)', () => {
    expect(authorizeSqlCall(SQLITE.SQLITE_PRAGMA, 'wal_checkpoint', null, null, 'writable')).toBe(SQLITE.SQLITE_DENY)
    expect(authorizeSqlCall(SQLITE.SQLITE_PRAGMA, 'wal_checkpoint', 'TRUNCATE', null, 'writable')).toBe(SQLITE.SQLITE_DENY)
  })

  it('refuses writable_schema', () => {
    expect(authorizeSqlCall(SQLITE.SQLITE_PRAGMA, 'writable_schema', '1', null, 'writable')).toBe(SQLITE.SQLITE_DENY)
  })

  it('allows reading journal_mode but refuses changing it', () => {
    // Reading journal_mode is how the panel learns a file is WAL and can warn about the
    // -wal/-shm residue up front. A blanket refusal once lived here and silenced that warning.
    expect(authorizeSqlCall(SQLITE.SQLITE_PRAGMA, 'journal_mode', null, null, 'read-only')).toBe(SQLITE.SQLITE_OK)
    expect(authorizeSqlCall(SQLITE.SQLITE_PRAGMA, 'journal_mode', 'WAL', null, 'writable')).toBe(SQLITE.SQLITE_DENY)
  })

  it('allows the schema reads the tree runs on', () => {
    for (const name of ['table_info', 'index_list', 'foreign_key_list', 'database_list']) {
      expect(authorizeSqlCall(SQLITE.SQLITE_PRAGMA, name, 't', null, 'read-only')).toBe(SQLITE.SQLITE_OK)
    }
  })

  it('refuses session-state knobs only when they are assigned', () => {
    expect(authorizeSqlCall(SQLITE.SQLITE_PRAGMA, 'cache_size', null, null, 'read-only')).toBe(SQLITE.SQLITE_OK)
    expect(authorizeSqlCall(SQLITE.SQLITE_PRAGMA, 'cache_size', '-2000', null, 'read-only')).toBe(SQLITE.SQLITE_DENY)
    expect(authorizeSqlCall(SQLITE.SQLITE_PRAGMA, 'mmap_size', '10', null, 'writable')).toBe(SQLITE.SQLITE_DENY)
  })
})

describe('isQueryableTableName', () => {
  it('accepts the awkward names real databases use, because the name is bound as a parameter', () => {
    // An earlier revision also rejected quotes, brackets, spaces and `%`. Those are legal SQLite
    // table names, and the columns query binds the name rather than pasting it, so rejecting
    // them only hid tables from the user.
    for (const name of ['order', 'my table', 'a"b', 'a[b]', 'a%b', '表名', 't2']) {
      expect(isQueryableTableName(name)).toBe(true)
    }
  })

  it('rejects only what the driver could not carry anyway', () => {
    expect(isQueryableTableName('')).toBe(false)
    expect(isQueryableTableName('a\u0000b')).toBe(false)
    expect(isQueryableTableName('x'.repeat(1025))).toBe(false)
    expect(isQueryableTableName(42)).toBe(false)
    expect(isQueryableTableName(undefined)).toBe(false)
    expect(isQueryableTableName(null)).toBe(false)
  })
})
