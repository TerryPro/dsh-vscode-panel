// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { shapeColumns, shapeRow, shapeValue } from '../src/host/sql-values.ts'
import { SQL_LIMITS } from '../src/shared/sql-protocol.ts'

/**
 * `node:sqlite` hands over three value kinds that a plain `JSON.stringify` corrupts, and only
 * one of the three raises an error. The gate that runs on the host runtime
 * (`npm run test:sql`) measures the driver itself; this suite covers the shaping decision that
 * lives above it, which is pure and so needs no driver.
 *
 * The assertions land on the serialized form rather than the intermediate object on purpose:
 * what would silently break the user's grid is the JSON that leaves the host.
 */
describe('shapeValue', () => {
  it('keeps an in-range BigInt as a number so ordinary integers stay sortable', () => {
    expect(shapeValue(42n).value).toBe(42)
    expect(shapeValue(-7n).value).toBe(-7)
    expect(shapeValue(0n).value).toBe(0)
  })

  it('carries an out-of-range BigInt as a string instead of rounding it', () => {
    // Measured: `Number(9007199254740993n)` is 9007199254740992, i.e. the last digit is gone
    // and nothing says so. A string keeps every digit.
    expect(shapeValue(9007199254740993n).value).toBe('9007199254740993')
    expect(shapeValue(-9007199254740993n).value).toBe('-9007199254740993')
    // The boundary itself is exactly representable, so it must stay a number.
    expect(shapeValue(BigInt(Number.MAX_SAFE_INTEGER)).value).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('keeps null as null', () => {
    expect(shapeValue(null).value).toBeNull()
    expect(shapeValue(undefined).value).toBeNull()
  })

  it('writes an overflowed float as text, not as the null JSON would give', () => {
    // Measured on the host: `SELECT 9e999` arrives as JS Infinity, and
    // JSON.stringify({v: Infinity}) is `{"v":null}` — which is exactly what a real NULL looks
    // like in the grid. Sign is kept so -Infinity stays distinguishable too.
    const positive = shapeValue(Number.POSITIVE_INFINITY)
    const negative = shapeValue(Number.NEGATIVE_INFINITY)
    expect(positive.value).toBe('Infinity')
    expect(negative.value).toBe('-Infinity')
    expect(JSON.stringify({ v: positive.value })).not.toBe(JSON.stringify({ v: null }))
    expect(shapeValue(Number.NaN).value).toBe('NaN')
  })

  it('clips a long string and reports that it did', () => {
    const long = 'x'.repeat(SQL_LIMITS.maxValueChars + 500)
    const shaped = shapeValue(long)
    expect(shaped.truncated).toBe(true)
    expect(typeof shaped.value === 'string' && shaped.value.length).toBe(SQL_LIMITS.maxValueChars)
  })

  it('leaves a string at exactly the cap untouched', () => {
    const edge = 'y'.repeat(SQL_LIMITS.maxValueChars)
    const shaped = shapeValue(edge)
    expect(shaped.truncated).toBe(false)
    expect(shaped.value).toBe(edge)
  })

  it('encodes a BLOB as base64 instead of the object JSON would invent for it', () => {
    // Measured: JSON.stringify of a Uint8Array is `{"0":1,"1":2,"2":3}` — valid JSON, and
    // byte-for-byte data loss as far as the grid is concerned.
    const raw = new Uint8Array([1, 2, 250])
    expect(JSON.stringify({ b: raw })).toBe('{"b":{"0":1,"1":2,"2":250}}')
    const shaped = shapeValue(raw)
    expect(shaped.value).toEqual({ base64: 'AQL6', byteLength: 3, truncated: false })
  })

  it('clips an oversized BLOB but still reports its true length', () => {
    const big = new Uint8Array(SQL_LIMITS.maxBlobBytes + 10)
    const shaped = shapeValue(big)
    // Narrow on the shape actually expected: a `SqlBlobValue` is the only object this function
    // returns, and testing `.byteLength` through a union the compiler still sees as
    // `number | string | null | SqlBlobValue` would hide a wrong return type instead of catching it.
    if (typeof shaped.value !== 'object' || shaped.value === null) {
      throw new Error(`expected a blob envelope, got ${JSON.stringify(shaped.value)}`)
    }
    expect(shaped.value.byteLength).toBe(big.byteLength)
    expect(shaped.value.truncated).toBe(true)
    expect(shaped.truncated).toBe(true)
    expect(Buffer.from(shaped.value.base64, 'base64').byteLength).toBe(SQL_LIMITS.maxBlobBytes)
  })

  it('produces values that never throw under JSON.stringify', () => {
    // The whole point of the module: `sendJson` is the one exit, and a BigInt there takes the
    // entire request down (measured: `Do not know how to serialize a BigInt`).
    const samples = [42n, 9007199254740993n, Number.POSITIVE_INFINITY, new Uint8Array([9]), null, 'text']
    for (const sample of samples) {
      expect(() => JSON.stringify(shapeValue(sample).value)).not.toThrow()
    }
  })
})

describe('shapeColumns', () => {
  it('numbers duplicate names while keeping what SQLite reported', () => {
    const columns = shapeColumns([
      { name: 'a', type: 'INTEGER' },
      { name: 'a', type: 'INTEGER' },
      { name: 'a', type: null },
    ])
    expect(columns.map(c => c.label)).toEqual(['a', 'a_2', 'a_3'])
    expect(columns.every(c => c.name === 'a')).toBe(true)
  })

  it('omits the type for an expression column instead of inventing one', () => {
    // Measured: `columns()` reports type null for `SELECT 1 AS x`, and an empty string for a
    // column declared with no type. Neither should reach the header as a blank row of text.
    expect(shapeColumns([{ name: 'x', type: null }])[0]).toEqual({ label: 'x', name: 'x' })
    expect(shapeColumns([{ name: 'y', type: '' }])[0]).toEqual({ label: 'y', name: 'y' })
    expect(shapeColumns([{ name: 'z', type: 'TEXT' }])[0]?.type).toBe('TEXT')
  })
})

describe('shapeRow', () => {
  it('keeps every value in its own column position', () => {
    // Regression: an earlier revision bucketed scalars apart from BLOB envelopes and
    // reassembled the row afterwards, which could not recover positions at all — a BLOB in
    // column 2 would surface under the header of column 1.
    const shaped = shapeRow(['name', new Uint8Array([1, 2]), 7n, null])
    expect(shaped.row).toEqual(['name', { base64: 'AQI=', byteLength: 2, truncated: false }, 7, null])
    expect(shaped.truncated).toBe(0)
  })

  it('counts clipped cells per row so the block can total them', () => {
    const long = 'x'.repeat(SQL_LIMITS.maxValueChars + 1)
    const shaped = shapeRow([long, 'fine', new Uint8Array(SQL_LIMITS.maxBlobBytes + 1), long])
    expect(shaped.truncated).toBe(3)
    expect(shaped.row.length).toBe(4)
  })

  it('keeps a row of driver objects shorter than its column count no wider', () => {
    // Row width comes from the driver, so an empty statement yields an empty row rather than
    // a row that looks like one blank cell.
    expect(shapeRow([]).row).toEqual([])
  })
})
