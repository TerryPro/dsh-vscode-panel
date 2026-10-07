// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import {
  clampDiffSplitRatio,
  readDiffSplitRatio,
  saveDiffSplitRatio,
} from '../src/client/git/git-diff-split.ts'

/** Mirrors the private storage key; kept literal so a rename surfaces as a test failure. */
const STORAGE_KEY = 'dsh-workbench:diff-split-ratio'

describe('clampDiffSplitRatio', () => {
  it('bounds a fraction to the usable band and defaults non-finite input to half', () => {
    expect(clampDiffSplitRatio(0.5)).toBe(0.5)
    expect(clampDiffSplitRatio(0.05)).toBe(0.2)
    expect(clampDiffSplitRatio(0.95)).toBe(0.8)
    expect(clampDiffSplitRatio(Number.NaN)).toBe(0.5)
  })
})

describe('readDiffSplitRatio / saveDiffSplitRatio', () => {
  beforeEach(() => { localStorage.clear() })

  it('defaults to half when nothing is stored', () => {
    expect(readDiffSplitRatio()).toBe(0.5)
  })

  it('round-trips a stored ratio', () => {
    saveDiffSplitRatio(0.68)
    expect(readDiffSplitRatio()).toBeCloseTo(0.68)
  })

  it('clamps an out-of-range stored value on read', () => {
    localStorage.setItem(STORAGE_KEY, '5')
    expect(readDiffSplitRatio()).toBe(0.8)
  })

  it('falls back to half for unparsable storage', () => {
    localStorage.setItem(STORAGE_KEY, 'not-a-number')
    expect(readDiffSplitRatio()).toBe(0.5)
  })
})
