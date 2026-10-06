import { describe, expect, it } from 'vitest'
import { basename } from '../src/shared/path-name.ts'

describe('shared path basename', () => {
  it('returns the final segment of a slash-delimited path', () => {
    expect(basename('src/a.ts')).toBe('a.ts')
  })

  it('returns the whole string when there is no separator', () => {
    expect(basename('a.ts')).toBe('a.ts')
  })

  it('normalizes backslashes before taking the final segment', () => {
    expect(basename('src\\a.ts')).toBe('a.ts')
  })

  it('returns an empty string for a trailing separator', () => {
    expect(basename('dir/')).toBe('')
  })
})
