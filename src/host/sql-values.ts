/**
 * Turning `node:sqlite` values into something that survives `JSON.stringify`.
 *
 * This module exists because of three measured ways the driver's natural values corrupt a
 * response *without any error being raised*:
 *
 *   1. With `readBigInts` on — which the Host must enable, because the default read throws
 *      outright on any integer past 2^53-1 — **every** INTEGER comes back as BigInt, even 42,
 *      and `JSON.stringify` on a BigInt throws.
 *   2. A BLOB is a `Uint8Array`, and `JSON.stringify` turns it into `{"0":1,"1":2}`, which is
 *      valid JSON and complete garbage.
 *   3. `SELECT 9e999` hands over JS `Infinity`, and `JSON.stringify` writes it as `null` —
 *      so an overflow becomes indistinguishable from a genuine NULL in the grid.
 *
 * Only the first throws loudly, which is the least dangerous of the three. Numbers stay
 * numbers whenever they are exactly representable, so the panel is not asked to parse strings
 * for ordinary integers.
 */

import type { SqlBlobValue, SqlColumn, SqlRow, SqlValue } from '../shared/sql-protocol.ts'
import { SQL_LIMITS } from '../shared/sql-protocol.ts'

/** One column as the driver describes it. `type` is null for expressions (`SELECT 1+1`). */
export interface DriverColumn {
  name: string
  type: string | null
}

/** A value exactly as `node:sqlite` returns it, before this module makes it JSON-safe. */
export type DriverValue = null | number | bigint | string | Uint8Array | undefined

/** BigInts past this range cannot be carried as JS numbers without silently losing digits. */
const SAFE_INTEGER_MAX = BigInt(Number.MAX_SAFE_INTEGER)
const SAFE_INTEGER_MIN = BigInt(Number.MIN_SAFE_INTEGER)

/**
 * One driver value, made safe to serialize.
 *
 * Returns the value plus whether this cell clipped something, because the caller counts
 * truncations per block rather than per value.
 */
export function shapeValue(value: DriverValue): { value: SqlValue | SqlBlobValue; truncated: boolean } {
  if (value === null || value === undefined) return { value: null, truncated: false }
  if (typeof value === 'bigint') {
    // Within the safe range the number is exact, so hand the panel a number: `42` is what
    // the user expects to see, and sorting or arithmetic on it stays possible.
    if (value <= SAFE_INTEGER_MAX && value >= SAFE_INTEGER_MIN) {
      return { value: Number(value), truncated: false }
    }
    // Outside it, a JS number would silently round. A string keeps every digit, and the
    // panel renders it as text — an honest loss of "is this a number" in exchange for the
    // value itself being right.
    return { value: value.toString(), truncated: false }
  }
  if (typeof value === 'number') {
    // Measured: an overflowed float arrives as Infinity, which JSON would write as null and
    // therefore merge with real NULLs. Keeping the sign is what makes the two distinguishable.
    if (Number.isFinite(value)) return { value, truncated: false }
    if (Number.isNaN(value)) return { value: 'NaN', truncated: false }
    return { value: value > 0 ? 'Infinity' : '-Infinity', truncated: false }
  }
  if (typeof value === 'string') {
    if (value.length <= SQL_LIMITS.maxValueChars) return { value, truncated: false }
    return { value: value.slice(0, SQL_LIMITS.maxValueChars), truncated: true }
  }
  if (value instanceof Uint8Array) {
    // Base64 rather than raw bytes: the same transport the image preview already uses
    // (`workspace-backend.ts` reads bytes and encodes base64), so nothing new is invented here.
    const clipped = value.byteLength > SQL_LIMITS.maxBlobBytes
    const kept = clipped ? value.subarray(0, SQL_LIMITS.maxBlobBytes) : value
    return {
      value: { base64: Buffer.from(kept).toString('base64'), byteLength: value.byteLength, truncated: clipped },
      truncated: clipped,
    }
  }
  // Nothing else is known to arrive. Falling back to null rather than `String(value)` keeps
  // a surprise from being smuggled into the grid as plausible-looking text.
  return { value: null, truncated: true }
}

/**
 * Column headers, with duplicate names disambiguated.
 *
 * The driver's object rows key by name, so `SELECT a, a FROM t` loses a value before this
 * code ever sees it (ADR 0005 forces array rows). Names still arrive duplicated, and two
 * identical headers would make a click-to-copy ambiguous, so the second and later ones gain
 * a suffix. `name` keeps what SQLite reported.
 */
export function shapeColumns(columns: readonly DriverColumn[]): SqlColumn[] {
  const seen = new Map<string, number>()
  return columns.map((column) => {
    const count = (seen.get(column.name) ?? 0) + 1
    seen.set(column.name, count)
    return {
      label: count === 1 ? column.name : `${column.name}_${count}`,
      name: column.name,
      ...(column.type === null || column.type === '' ? {} : { type: column.type }),
    }
  })
}

/**
 * One row, in column order, with the number of cells this row had to clip.
 *
 * Pushed straight through, one cell at a time: a row is positional data, and a BLOB has to
 * stay in its own column or the grid shows the wrong value under the wrong header. An earlier
 * revision sorted cells into two buckets and tried to reassemble them afterwards, which could
 * not recover the original positions at all.
 */
export function shapeRow(row: readonly DriverValue[]): { row: SqlRow; truncated: number } {
  const shaped: SqlRow = []
  let truncated = 0
  for (const cell of row) {
    const value = shapeValue(cell)
    if (value.truncated) truncated += 1
    shaped.push(value.value)
  }
  return { row: shaped, truncated }
}
