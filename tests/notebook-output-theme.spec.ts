/**
 * The notebook stylesheet's colour contract.
 *
 * CSS has no other guard, and both rules below were violated in shipped code: a
 * traceback was unreadable because the block behind it was painted with a solid state
 * colour, and the ANSI palette was a wall of hard-coded hex that followed the operating
 * system rather than the shell's own theme.
 */
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const raw = await readFile(new URL('../src/client/notebook/notebook.module.css', import.meta.url), 'utf8')
// Comments explain the old failures by name, so they must not be read as live CSS.
const css = raw.replace(/\/\*[\s\S]*?\*\//gu, '')

/**
 * One rule body for a selector.
 *
 * A selector can appear twice — inside a shared group (followed by a comma) and as its
 * own rule (followed by the brace). The dedicated rule is the one carrying the rule the
 * contract is about, so it wins; a selector that only ever appears in a group falls back
 * to that group.
 */
function ruleBody(selector: string): string {
  const open = css.search(new RegExp(`\\${selector}\\s*\\{`, 'u'))
  const group = open >= 0 ? open : css.search(new RegExp(`\\${selector}\\s*,`, 'u'))
  if (group < 0) throw new Error(`no rule for ${selector}`)
  const brace = css.indexOf('{', group)
  const close = css.indexOf('}', brace)
  return css.slice(brace + 1, close)
}

describe('notebook output colours', () => {
  it('marks stderr and a failed cell with a tint and an edge, not a solid fill', () => {
    // ipykernel colours traceback *text* with ANSI reds, greens, and yellows, and that
    // palette is designed for an ordinary background. A solid warning/error fill put
    // red-on-pink text at the bottom of every traceback.
    for (const selector of ['.outputStderr', '.outputError']) {
      const body = ruleBody(selector)
      expect(body, selector).toContain('color-mix')
      // A `state-*-secondary` token is a saturated fill, meant for small badges.
      expect(body, selector).not.toMatch(/state-(?:warn|error)-secondary/u)
      expect(body, selector).toContain('border-inline-start-color')
    }
  })

  it('keeps every output block the same width by giving all of them an edge', () => {
    // Only the marked blocks set a colour, so without a transparent edge on the rest a
    // stderr block would sit 2px wider than the stdout above it in the same output.
    expect(ruleBody('.outputStdout')).toMatch(/border-inline-start:\s*2px solid transparent/u)
  })

  it('derives the ANSI palette from DSH tokens instead of hard-coding it', () => {
    // The workbench's terminals resolve their theme from these same tokens, so the same
    // traceback colour has to read identically in a notebook and in a terminal tab.
    const root = ruleBody('.root')
    const derived = ['--dsh-ansi-red', '--dsh-ansi-green', '--dsh-ansi-yellow', '--dsh-ansi-blue',
      '--dsh-ansi-black', '--dsh-ansi-white', '--dsh-ansi-bright-red', '--dsh-ansi-bright-white']
    for (const token of derived) {
      const line = root.split('\n').find(entry => entry.trim().startsWith(`${token}:`))
      expect(line, token).toBeDefined()
      expect(line, token).toContain('var(--dsw-')
    }
    // A fixed hex for black or white is invisible in one of the two themes, which is the
    // exact failure a media query on the operating system cannot cover when DSH themes
    // itself.
    expect(css).not.toMatch(/prefers-color-scheme/u)
  })

  it('does not let the result prompt override its own baseline alignment', () => {
    // `.outputResultLine` aligns its children on the text baseline so `Out[2]:` sits on
    // the value's first line. A bare `align-self` on the label beats that inherited
    // value and silently un-aligns the pair — invisible in jsdom, which runs no layout
    // engine, so it is asserted structurally.
    const label = ruleBody('.outputResultLabel')
    expect(label).not.toContain('align-self')
    // Stretching is still wrong for the label sitting alone above a block result, so
    // that case is handled by a scoped rule instead.
    expect(ruleBody('.outputRich > .outputResultLabel')).toContain('align-self: flex-start')
  })

  it('clips the cell so a full-bleed row cannot break its rounded corner', () => {
    // The header paints a full-width background, and a child's square corner is drawn
    // over the parent's rounded one, which left every cell's top corners visibly
    // unclosed. Clipping the cell fixes the invariant once rather than chasing a
    // radius onto each row that happens to fill the width.
    const cell = ruleBody('.cell')
    expect(cell).toContain('border-radius')
    expect(cell).toMatch(/overflow:\s*hidden/u)
  })

  it('draws a rule between a cell and its output', () => {
    // The header already rules below itself; without the matching rule above the
    // output, a result sat on the cell's own background and read as more source code.
    expect(ruleBody('.cellOutputs')).toMatch(/border-block-start:\s*1px solid/u)
  })

  it('keeps the palette variables the renderer actually emits', () => {
    // `ansiToHtml` writes `var(--dsh-ansi-*)` into inline styles; a renamed token would
    // silently fall through to the literal fallback and drift from the theme.
    const defined = [...css.matchAll(/(--dsh-ansi-[a-z0-9-]+)\s*:/gu)].map(match => match[1])
    for (const name of ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
      'bright-black', 'bright-red', 'bright-green', 'bright-yellow', 'bright-blue',
      'bright-magenta', 'bright-cyan', 'bright-white',
      'bg-black', 'bg-red', 'bg-green', 'bg-yellow', 'bg-blue', 'bg-magenta', 'bg-cyan', 'bg-white']) {
      expect(defined, `--dsh-ansi-${name}`).toContain(`--dsh-ansi-${name}`)
    }
  })
})
