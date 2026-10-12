/**
 * The SQL notebook's authorizer decision, kept apart from the driver call that installs it.
 *
 * Why a pure function: the callback is the only fence between a user's `.db` file and the rest
 * of the machine, and its rules are a table of cases rather than a flow. Testing them against
 * `node:sqlite` would need a live database per case; testing the decision directly means every
 * case is one call, and the spec can assert the measured traps individually.
 *
 * Three measured facts drive the shape here (host runtime, `npm run test:sql` covers the driver
 * side of the same claims):
 *
 *   - `readOnly` is not the fence. A read-only connection happily `ATTACH`es another file; the
 *     write is refused, but the *read* of a database nobody chose is not. So ATTACH is denied by
 *     name here, in both tiers.
 *   - Authorization codes collide with action codes: `SQLITE_DENY` and `SQLITE_CREATE_INDEX` are
 *     both 1, `SQLITE_IGNORE` and `SQLITE_CREATE_TABLE` are both 2. Every comparison below reads
 *     a named constant. A future reader must not "simplify" this to numeric ranges, and must not
 *     reverse-lookup a code into a name for logging.
 *   - A callback that returns a boolean fails *every* statement, not just the denied one. The
 *     return type is therefore `number` and the branches return constants only.
 */

import { constants as SQLITE } from 'node:sqlite'
import type { SqlAccess } from '../shared/sql-protocol.ts'

/**
 * PRAGMAs refused whatever their argument looks like.
 *
 * `wal_checkpoint` earns its place by having a no-argument form that still writes to the `-wal`
 * file, so an argument-based rule would miss it. `query_only` earns its place by being the one
 * setting that quietly destroys the read-only tier's usefulness: measured, once it is ON a
 * read-only connection can no longer `CREATE TEMP TABLE`, which is the core scratch workflow.
 *
 * `journal_mode` is deliberately NOT here. Reading it (`PRAGMA journal_mode`, no argument) is
 * how the panel learns a file is WAL and can therefore warn about `-wal`/`-shm` residue before
 * the user is surprised by it; refusing the read would be refusing our own diagnostic. Changing
 * it is refused, which the assignment rule below handles.
 */
const DENIED_ALWAYS = new Set([
  'query_only',
  'writable_schema',
  'wal_checkpoint',
  'page_size',
  'auto_vacuum',
  'encoding',
  'integrity_check',
  'optimize',
  'data_store_directory',
  'temp_store_directory',
])

/**
 * PRAGMAs that are only a problem when assigned to.
 *
 * Reading them is how the panel and the tree work: `PRAGMA journal_mode` with no argument is
 * the only way to learn whether a file needs the WAL caveat, and `table_info`/`foreign_key_list`
 * drive the schema tree. Measured, both forms reach this callback with the same action code and
 * differ only by the second argument, which is why the assignment check is here at all.
 */
const DENIED_WHEN_SET = new Set([
  'journal_mode',
  'user_version',
  'schema_version',
  'application_id',
  'locking_mode',
  'page_count',
  'cache_size',
  'mmap_size',
  'journal_size_limit',
  'wal_autocheckpoint',
  'foreign_keys',
])

/** Actions that change stored data. Which schema they touch decides whether they are allowed. */
const DATA_WRITE_ACTIONS = new Set<number>([
  SQLITE.SQLITE_INSERT,
  SQLITE.SQLITE_UPDATE,
  SQLITE.SQLITE_DELETE,
  SQLITE.SQLITE_CREATE_TABLE,
  SQLITE.SQLITE_CREATE_INDEX,
  SQLITE.SQLITE_CREATE_VIEW,
  SQLITE.SQLITE_CREATE_TRIGGER,
  SQLITE.SQLITE_ALTER_TABLE,
  SQLITE.SQLITE_DROP_TABLE,
  SQLITE.SQLITE_DROP_INDEX,
  SQLITE.SQLITE_DROP_VIEW,
  SQLITE.SQLITE_DROP_TRIGGER,
  SQLITE.SQLITE_REINDEX,
  SQLITE.SQLITE_ANALYZE,
])

export type AuthorizerDecision = typeof SQLITE.SQLITE_OK | typeof SQLITE.SQLITE_DENY

/**
 * Whether the workbench allows one SQLite action.
 *
 * `dbName` is null for statements that are not tied to a schema (a bare `SELECT count(*)` reads
 * with no database named at all — measured), so null is never treated as "some other database".
 */
export function authorizeSqlCall(
  actionCode: number,
  arg1: string | null,
  arg2: string | null,
  dbName: string | null,
  access: SqlAccess,
): AuthorizerDecision {
  // A named database outside the two the user chose. This is what stops an attached file from
  // being read through, and it also catches writes into a schema nobody opened.
  if (typeof dbName === 'string' && dbName !== 'main' && dbName !== 'temp') return SQLITE.SQLITE_DENY

  if (actionCode === SQLITE.SQLITE_ATTACH || actionCode === SQLITE.SQLITE_DETACH) {
    return SQLITE.SQLITE_DENY
  }

  if (actionCode === SQLITE.SQLITE_PRAGMA) {
    const name = (arg1 ?? '').toLowerCase()
    if (DENIED_ALWAYS.has(name)) return SQLITE.SQLITE_DENY
    // arg2 non-null is the assignment form. `PRAGMA cache_size` reads, `PRAGMA cache_size=2000`
    // writes a connection state the workbench did not ask for.
    if (arg2 !== null && DENIED_WHEN_SET.has(name)) return SQLITE.SQLITE_DENY
    return SQLITE.SQLITE_OK
  }

  if (access === 'read-only' && DATA_WRITE_ACTIONS.has(actionCode)) {
    // The temporary schema is where scratch work belongs: creating and filling a TEMP table is
    // measured to work on a read-only handle, and it is the workflow the tier exists for.
    if (dbName === 'temp') return SQLITE.SQLITE_OK
    // `CREATE TEMP TABLE` fires an INSERT against `sqlite_temp_master` with dbName 'temp', which
    // the line above already released. Anything naming main is a real write.
    if (dbName === null || dbName === 'main') return SQLITE.SQLITE_DENY
  }

  return SQLITE.SQLITE_OK
}

/**
 * A table name the schema tree may be asked to describe.
 *
 * This is a request-sanity check, not an injection guard. The columns query binds the name as a
 * parameter (`pragma_table_info($name)` — measured to accept named parameters, unlike the
 * positional `?` form that forced an earlier note to talk about interpolating identifiers), so
 * the name never reaches SQL text. Quoting characters, spaces and `%` are all legal in real
 * SQLite table names and must not be rejected here.
 *
 * What is refused: not a string, empty, a NUL (no filesystem or driver will carry one), or a
 * length no genuine table has — those otherwise reach the driver and come back as an
 * unhelpful "no such table" the panel would have to translate anyway.
 */
export function isQueryableTableName(name: unknown): name is string {
  if (typeof name !== 'string') return false
  if (name === '' || name.includes('\0')) return false
  return name.length <= 1024
}
