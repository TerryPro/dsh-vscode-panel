// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import {
  clampCsvSplitRatio,
  readCsvSplitRatio,
  saveCsvSplitRatio,
} from '../src/client/csv/csv-split.ts'

/** Mirrors the private storage key; kept literal so a rename surfaces as a failure. */
const STORAGE_KEY = 'dsh-workbench:csv-split-ratio'

describe('clampCsvSplitRatio', () => {
  it('bounds a fraction to the usable band and defaults non-finite input to half', () => {
    expect(clampCsvSplitRatio(0.5)).toBe(0.5)
    expect(clampCsvSplitRatio(0.05)).toBe(0.2)
    expect(clampCsvSplitRatio(0.95)).toBe(0.8)
    expect(clampCsvSplitRatio(Number.NaN)).toBe(0.5)
  })
})

describe('readCsvSplitRatio / saveCsvSplitRatio', () => {
  beforeEach(() => { localStorage.clear() })

  it('defaults to half when nothing is stored', () => {
    expect(readCsvSplitRatio()).toBe(0.5)
  })

  it('round-trips a stored ratio', () => {
    saveCsvSplitRatio(0.7)
    expect(readCsvSplitRatio()).toBeCloseTo(0.7)
  })

  it('clamps an out-of-range stored value on read', () => {
    localStorage.setItem(STORAGE_KEY, '5')
    expect(readCsvSplitRatio()).toBe(0.8)
  })

  it('falls back to half for unparsable storage', () => {
    localStorage.setItem(STORAGE_KEY, 'nope')
    expect(readCsvSplitRatio()).toBe(0.5)
  })
})
