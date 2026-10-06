import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const sourceRoot = fileURLToPath(new URL('../src', import.meta.url))

/**
 * `--dsw-*` names DSH ships in its design-token palette for 0.2.0-rc.2 but that
 * other DSH builds once carried. Referencing one costs the whole declaration:
 * an unresolved `var()` makes the property fall back to its inherited/initial
 * value, so `color: var(--dsw-alias-label-quaternary)` renders ordinary body
 * text instead of muted text and silently loses the intent.
 */
const RETIRED_TOKENS = [
  '--dsw-alias-brand-border',
  '--dsw-alias-label-error',
  '--dsw-alias-label-quaternary',
  '--dsw-static-cyan-400',
  '--dsw-static-cyan-600',
  '--dsw-static-gray-100',
  '--dsw-static-gray-1000',
  '--dsw-static-green-600',
  '--dsw-static-purple-400',
  '--dsw-static-purple-600',
  '--dsw-static-yellow-400',
  '--dsw-static-yellow-600',
]

async function readSources(): Promise<{ path: string; text: string }[]> {
  const sources: { path: string; text: string }[] = []
  for (const entry of await readdir(sourceRoot, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.(?:css|ts|tsx)$/u.test(entry.name)) continue
    const path = join(entry.parentPath, entry.name)
    sources.push({ path, text: await readFile(path, 'utf8') })
  }
  return sources
}

describe('DSH design-token contract', () => {
  it('never references a token the installed DSH palette does not declare', async () => {
    const offenders: string[] = []
    for (const source of await readSources()) {
      for (const token of RETIRED_TOKENS) {
        if (source.text.includes(token)) offenders.push(`${source.path}: ${token}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('keeps plugin-owned custom properties inside the plugin namespace', async () => {
    const offenders: string[] = []
    for (const source of await readSources()) {
      // Declaring a --dsw-* name, in CSS or through the CSSOM, would squat on
      // the host palette and break whenever DSH defines the same name.
      if (/^\s*--dsw-[a-z0-9-]+\s*:/mu.test(source.text)) offenders.push(`${source.path}: declares --dsw-*`)
      if (/setProperty\(\s*['"`]--dsw-/u.test(source.text)) offenders.push(`${source.path}: writes --dsw-*`)
    }
    expect(offenders).toEqual([])
  })
})
