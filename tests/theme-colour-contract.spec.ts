/**
 * The workbench's colour contract with DSH's theme.
 *
 * Two failures live here, and the second is the reason the first was possible.
 *
 * 1. **A chip painted with two saturated state colours.** DSH ships
 *    `--dsw-alias-state-*-primary` and `-secondary` as *fills* and `-label` as a mid-tone ink;
 *    it ships no low-alpha chip background. The workbench filled that gap by pairing two of
 *    the saturated ones, which measured 1.46:1 for the warning pill — "已折叠 1 个结果块"
 *    arrived as orange-on-orange — and 1.00:1 for the error pill in the dark theme, where
 *    `state-error-primary` and `state-error-secondary` are the same rgb(242, 90, 90). The pill
 *    naming a cell's failure was invisible.
 *
 * 2. **Tokens DSH never defined.** Rules named `--dsw-alias-state-confirm-bg`,
 *    `-info-label`, `-error-bg`, `-selection-bg`, `-success-label`, `-control-hover`,
 *    `-focus-ring`, `-button-primary-foreground` and `-fill-hover`. A custom property that does
 *    not exist makes the declaration invalid at computed-value time, so each of these silently
 *    stopped doing its job: the column marks fell back to a fixed GitHub palette that never
 *    flipped with the theme (1.9–2.4:1 in dark), the read-only and writable tier pills lost
 *    their backgrounds and looked identical, the filter field lost every sign of focus, and
 *    the Settings save button's label came out the same colour as its own fill — near-black on
 *    near-black in the light theme, near-white on near-white in the dark one.
 *
 * Asserted against the stylesheets because jsdom applies no CSS: nothing else in the suite can
 * see a colour at all, and neither can a DOM test. Whoever widens either rule has to argue with
 * a failing test rather than with a screenshot.
 */
import { readFileSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/** Every `--dsw-alias-state-*` token the shipped theme actually defines. */
const SHIPPED_STATE_TOKENS = new Set([
  '--dsw-alias-state-business-primary',
  '--dsw-alias-state-business-tertiary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-error-secondary',
  '--dsw-alias-state-idle-primary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-success-secondary',
  '--dsw-alias-state-success-tertiary',
  '--dsw-alias-state-warn-label',
  '--dsw-alias-state-warn-primary',
  '--dsw-alias-state-warn-secondary',
  '--dsw-alias-state-warn-tertiary',
])

/**
 * Tokens the workbench used to name and DSH has never defined.
 *
 * A hand-written allowlist of what *is* valid cannot be maintained from here — the theme lives
 * in another package — but this denylist is exactly the set that shipped broken, and each entry
 * is a rule that silently stopped working. A new invented token shows up as an unread chip in
 * review; a resurrected one fails here.
 */
const INVENTED_TOKENS = [
  '--dsw-alias-state-confirm-bg',
  '--dsw-alias-state-confirm-label',
  '--dsw-alias-state-info-bg',
  '--dsw-alias-state-info-label',
  '--dsw-alias-state-error-bg',
  '--dsw-alias-state-error-label',
  '--dsw-alias-state-warn-bg',
  '--dsw-alias-state-selection-bg',
  '--dsw-alias-state-success-label',
  '--dsw-alias-button-primary-foreground',
  '--dsw-alias-button-primary-fill-hover',
  '--dsw-alias-control-hover',
  '--dsw-alias-focus-ring',
]

function cssFiles(): string[] {
  const root = resolve(process.cwd(), 'src/client')
  const found: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) found.push(...cssFilesIn(path))
    else if (entry.name.endsWith('.css')) found.push(path)
  }
  return found.sort()
}

function cssFilesIn(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...cssFilesIn(path))
    else if (entry.name.endsWith('.css')) found.push(path)
  }
  return found
}

/** Rule bodies of a stylesheet with its comments stripped, so prose cannot satisfy an assertion. */
function bodies(file: string): { path: string; css: string; rules: Array<{ selector: string; body: string }> } {
  const raw = readFileSync(file, 'utf8')
  const css = raw.replace(/\/\*[\s\S]*?\*\//gu, '')
  const rules: Array<{ selector: string; body: string }> = []
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    rules.push({ selector: (match[1] ?? '').trim(), body: match[2] ?? '' })
  }
  return { path: file, css, rules }
}

/**
 * The rule that carries a selector's own declarations.
 *
 * A selector can appear twice: in a shared base group (`.notice, .noticeError`) and as its own
 * rule that overrides it (`.noticeError`). The dedicated rule is the one holding the tone, so it
 * wins; falling back to the group is what a base-plus-variant stylesheet asks for.
 */
function ruleFor(sheet: ReturnType<typeof bodies>, selector: string): { selector: string; body: string } | undefined {
  return sheet.rules.find(rule => rule.selector === selector)
    ?? sheet.rules.find(rule => rule.selector.split(',').some(part => part.trim() === selector))
}

describe('workbench colour contract', () => {
  it('names only state tokens the shipped theme defines', () => {
    const offenders: string[] = []
    for (const file of cssFiles()) {
      // Comments name the dead tokens to explain why they are gone; only live CSS may not.
      const used = [...bodies(file).css.matchAll(/(--dsw-alias-state-[a-z0-9-]+)/gu)].map(match => match[1]!)
      for (const token of new Set(used)) {
        if (!SHIPPED_STATE_TOKENS.has(token)) offenders.push(`${file.slice(process.cwd().length + 1)}: ${token}`)
      }
    }
    // The failure mode is invisible rather than loud, so the message has to say what to do:
    // either the token is real and belongs in the list above, or the rule needs a token that is.
    expect(offenders, `invented --dsw-alias-state-* tokens (invalid at computed-value time):\n${offenders.join('\n')}`).toEqual([])
  })

  it('does not name a token DSH has never defined', () => {
    const offenders: string[] = []
    for (const file of cssFiles()) {
      const raw = bodies(file).css
      for (const token of INVENTED_TOKENS) {
        if (raw.includes(`var(${token}`)) offenders.push(`${file.slice(process.cwd().length + 1)}: ${token}`)
      }
    }
    expect(offenders, `invented tokens, invalid at computed-value time:\n${offenders.join('\n')}`).toEqual([])
  })

  it('never fills a chip with one saturated state colour and inks it with another', () => {
    // The exact shape that produced 1.46:1 and 1.00:1. A `state-*-secondary` fill is a small
    // solid indicator — a dot, an edge — and is correct there; under text it is not.
    const offenders: string[] = []
    for (const file of cssFiles()) {
      for (const rule of bodies(file).rules) {
        if (!/background:\s*var\(--dsw-alias-state-[a-z-]+-secondary\)/u.test(rule.body)) continue
        if (/color:\s*var\(--dsw-alias-state-/u.test(rule.body)) {
          offenders.push(`${file.slice(process.cwd().length + 1)}: ${rule.selector}`)
        }
      }
    }
    expect(offenders, `saturated fill under saturated ink:\n${offenders.join('\n')}`).toEqual([])
  })

  it('defines the chip tone layer from shipped tokens only', () => {
    const global = bodies(resolve(process.cwd(), 'src/client/styles/global.module.css'))
    const declarations = [...global.css.matchAll(/(--dsh-workbench-chip-[a-z-]+):\s*([^;]+);/gu)]
    const names = declarations.map(match => match[1]!)
    for (const tone of ['warn', 'error', 'success', 'info']) {
      expect(names).toContain(`--dsh-workbench-chip-${tone}-bg`)
      expect(names).toContain(`--dsh-workbench-chip-${tone}-fg`)
    }
    for (const declaration of declarations) {
      const name = declaration[1]!
      const value = declaration[2]!
      // A chip token that reached outside the palette would not follow a theme change, which is
      // the whole reason the tone layer exists.
      for (const ref of [...value.matchAll(/var\((--[a-z0-9-]+)[),]/gu)].map(match => match[1]!)) {
        const known = SHIPPED_STATE_TOKENS.has(ref) || ref === '--dsw-alias-label-primary'
        expect(known, `${name} references ${ref}`).toBe(true)
      }
    }
  })

  it('routes the folded-results pill through the chip tokens', () => {
    // The report that started this: the badge in a folded cell's header was unreadable.
    const sql = bodies(resolve(process.cwd(), 'src/client/sql/sql-notebook.module.css'))
    const badge = sql.rules.find(rule => rule.selector === '.cellBadge')
    expect(badge, '.cellBadge must exist').toBeDefined()
    expect(badge!.body).toContain('--dsh-workbench-chip-warn-bg')
    expect(badge!.body).toContain('--dsh-workbench-chip-warn-fg')
    expect(badge!.body).not.toMatch(/state-warn-secondary/u)
  })

  it('keeps every error banner on the chip tokens rather than a solid error fill', () => {
    // Four stylesheets carried the same failure at 1.37:1 / 1.00:1, under three different
    // selector names because each surface named its own rule.
    const banners: Array<[string, string]> = [
      ['src/client/editor/editor.module.css', '.error'],
      ['src/client/files/files.module.css', '.error'],
      ['src/client/git/git.module.css', '.error'],
      ['src/client/sql/sql-notebook.module.css', '.noticeError'],
      ['src/client/sql/sql-notebook.module.css', '.resultError'],
    ]
    for (const [relative, selector] of banners) {
      const sheet = bodies(resolve(process.cwd(), relative))
      const rule = ruleFor(sheet, selector)
      expect(rule, `${relative} must declare ${selector}`).toBeDefined()
      expect(rule!.body, `${relative}: ${selector}`).toContain('--dsh-workbench-chip-error-bg')
      expect(rule!.body, `${relative}: ${selector}`).toContain('--dsh-workbench-chip-error-fg')
      expect(rule!.body, `${relative}: ${selector}`).not.toMatch(/state-error-secondary/u)
    }
  })

  it('gives the five column marks distinguishable treatments', () => {
    // DSH's state palette has four hues for five marks, so PK takes the platform's solid tone
    // rather than reaching outside the theme for a fifth.
    const panel = bodies(resolve(process.cwd(), 'src/client/sql/sql-panel.module.css'))
    const pk = panel.rules.find(rule => rule.selector === '.columnBadgePk')
    expect(pk, '.columnBadgePk must exist').toBeDefined()
    expect(pk!.body).toContain('background: var(--dsw-alias-label-primary)')
    for (const selector of ['.columnBadgeNotNull', '.columnBadgeUnique', '.columnBadgeForeignKey', '.columnBadgeAutoIncrement']) {
      const rule = panel.rules.find(entry => entry.selector === selector)
      expect(rule, `${selector} must exist`).toBeDefined()
      expect(rule!.body, `${selector} must use a chip token`).toMatch(/--dsh-workbench-chip-[a-z]+-(bg|fg)/u)
    }
  })
})
