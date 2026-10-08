// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import {
  clampJsonSplitRatio,
  JSON_SPLIT_MAX,
  JSON_SPLIT_MIN,
  readJsonGrid,
  readJsonSplitRatio,
  saveJsonGrid,
  saveJsonSplitRatio,
} from '../src/client/json/json-split.ts'

/** Mirrors the private storage key; kept literal so a rename surfaces as a failure. */
const STORAGE_KEY = 'dsh-workbench:json-split-ratio'
const GRID_KEY = 'dsh-workbench:json-grid'

describe('clampJsonSplitRatio', () => {
  it('bounds a width fraction and defaults non-finite input', () => {
    expect(clampJsonSplitRatio(0.4)).toBe(0.4)
    expect(clampJsonSplitRatio(0)).toBe(JSON_SPLIT_MIN)
    expect(clampJsonSplitRatio(1)).toBe(JSON_SPLIT_MAX)
    expect(clampJsonSplitRatio(Number.NaN)).toBe(0.5)
  })
})

describe('readJsonSplitRatio / saveJsonSplitRatio', () => {
  beforeEach(() => { localStorage.clear() })

  it('starts at half the width', () => {
    expect(readJsonSplitRatio()).toBe(0.5)
  })

  it('round-trips through storage', () => {
    saveJsonSplitRatio(0.35)
    expect(localStorage.getItem(STORAGE_KEY)).toBe('0.35')
    expect(readJsonSplitRatio()).toBe(0.35)
  })

  it('clamps what it remembers', () => {
    saveJsonSplitRatio(0.95)
    expect(readJsonSplitRatio()).toBe(JSON_SPLIT_MAX)
  })

  it('falls back to half on unparsable content', () => {
    localStorage.setItem(STORAGE_KEY, 'wide')
    expect(readJsonSplitRatio()).toBe(0.5)
  })
})

describe('readJsonGrid / saveJsonGrid', () => {
  beforeEach(() => { localStorage.clear() })

  it('draws the grid until the reader says otherwise', () => {
    expect(readJsonGrid()).toBe(true)
    saveJsonGrid(false)
    expect(localStorage.getItem(GRID_KEY)).toBe('0')
    expect(readJsonGrid()).toBe(false)
    saveJsonGrid(true)
    expect(readJsonGrid()).toBe(true)
  })

  it('treats unknown stored values as on', () => {
    localStorage.setItem(GRID_KEY, 'perhaps')
    expect(readJsonGrid()).toBe(true)
  })
})
