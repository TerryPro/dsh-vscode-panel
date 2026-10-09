import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/core/locales.ts'

/**
 * The workbench ships both dictionaries and the UI only ever asks for a key by
 * name, so a key present in one and missing from the other silently renders the
 * raw key or an undefined string in the other language. Nothing else in the suite
 * reads both objects, which is how this could drift at all.
 */
describe('workbench locale parity', () => {
  it('declares exactly the same keys in both dictionaries', () => {
    const chinese = Object.keys(zh).sort()
    const english = Object.keys(en).sort()
    expect(english).toEqual(chinese)
  })

  it('never leaves a value empty', () => {
    for (const [name, dictionary] of [['zh', zh], ['en', en]] as const) {
      for (const [key, value] of Object.entries(dictionary)) {
        expect(value, `${name}[${key}]`).not.toBe('')
        expect(value.trim(), `${name}[${key}]`).toBe(value)
      }
    }
  })

  /**
   * Interpolation is done by hand in the UI, so a placeholder missing from one
   * language shows the user a literal `{code}` rather than failing loudly.
   */
  it('uses the same placeholders in both languages for every key', () => {
    const placeholders = (template: string): string[] =>
      [...template.matchAll(/\{(\w+)\}/g)].map(match => match[1]!).sort()
    for (const key of Object.keys(zh) as (keyof typeof zh)[]) {
      expect(placeholders(en[key]), key).toEqual(placeholders(zh[key]))
    }
  })
})
