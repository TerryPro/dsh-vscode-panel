// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import {
  clampMermaidSplitRatio,
  readMermaidSplitRatio,
  saveMermaidSplitRatio,
} from '../src/client/mermaid/mermaid-split.ts'

/** Mirrors the private storage key; kept literal so a rename surfaces as a failure. */
const STORAGE_KEY = 'dsh-workbench:mermaid-split-ratio'

describe('clampMermaidSplitRatio', () => {
  it('bounds a fraction to the usable band and defaults non-finite input to half', () => {
    expect(clampMermaidSplitRatio(0.5)).toBe(0.5)
    expect(clampMermaidSplitRatio(0.05)).toBe(0.2)
    expect(clampMermaidSplitRatio(0.95)).toBe(0.8)
    expect(clampMermaidSplitRatio(Number.NaN)).toBe(0.5)
  })
})

describe('readMermaidSplitRatio / saveMermaidSplitRatio', () => {
  beforeEach(() => { localStorage.clear() })

  it('defaults to half when nothing is stored', () => {
    expect(readMermaidSplitRatio()).toBe(0.5)
  })

  it('round-trips a stored ratio', () => {
    saveMermaidSplitRatio(0.7)
    expect(readMermaidSplitRatio()).toBeCloseTo(0.7)
  })

  it('clamps an out-of-range stored value on read', () => {
    localStorage.setItem(STORAGE_KEY, '5')
    expect(readMermaidSplitRatio()).toBe(0.8)
  })

  it('falls back to half for unparsable storage', () => {
    localStorage.setItem(STORAGE_KEY, 'nope')
    expect(readMermaidSplitRatio()).toBe(0.5)
  })
})
