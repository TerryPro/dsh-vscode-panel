// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readJsonCollapsed, saveJsonCollapsed } from '../src/client/json/json-collapse.ts'

/** Mirrors the private key prefix; kept literal so a rename surfaces as a failure. */
const KEY_PREFIX = 'dsh-workbench:json-collapse:'

describe('readJsonCollapsed / saveJsonCollapsed', () => {
  beforeEach(() => { localStorage.clear() })

  it('reports nothing remembered for a fresh file', () => {
    expect(readJsonCollapsed('config.json')).toBeNull()
  })

  it('round-trips a folded set under the file-keyed entry', () => {
    saveJsonCollapsed('config.json', new Set(['$.meta', '$.items[2]']))
    expect(localStorage.getItem(`${KEY_PREFIX}config.json`)).toBe('["$.meta","$.items[2]"]')
    expect(readJsonCollapsed('config.json')).toEqual(new Set(['$.meta', '$.items[2]']))
  })

  it('keeps files apart', () => {
    saveJsonCollapsed('a.json', new Set(['$.a']))
    saveJsonCollapsed('b.json', new Set(['$.b']))
    expect(readJsonCollapsed('a.json')).toEqual(new Set(['$.a']))
    expect(readJsonCollapsed('b.json')).toEqual(new Set(['$.b']))
  })

  it('survives an empty set', () => {
    saveJsonCollapsed('open.json', new Set())
    expect(readJsonCollapsed('open.json')).toEqual(new Set())
  })

  it('falls back to null on malformed or non-string content', () => {
    localStorage.setItem(`${KEY_PREFIX}broken.json`, '{not json')
    expect(readJsonCollapsed('broken.json')).toBeNull()
    localStorage.setItem(`${KEY_PREFIX}shaped.json`, '{"a": 1}')
    expect(readJsonCollapsed('shaped.json')).toBeNull()
    localStorage.setItem(`${KEY_PREFIX}mixed.json`, '["$.ok", 7, null]')
    expect(readJsonCollapsed('mixed.json')).toEqual(new Set(['$.ok']))
  })

  it('drops the write when storage refuses', () => {
    const failing = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    expect(() => { saveJsonCollapsed('big.json', new Set(['$.a'])) }).not.toThrow()
    failing.mockRestore()
  })
})
