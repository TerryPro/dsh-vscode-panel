// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPanelRuleLayout } from '../src/client/layout/panel-rule-layout.ts'
import {
  EDITOR_COLLAPSED_ATTRIBUTE,
  EDITOR_ROOT_ATTRIBUTE,
  PANEL_HEADER_ATTRIBUTE,
  PANEL_HEADER_HEIGHT_PROPERTY,
  PANEL_RULE_ANCHOR_ATTRIBUTE,
  PANEL_RULE_ATTRIBUTE,
  PANEL_RULE_OVERLAY_ATTRIBUTE,
  PANEL_RULE_SECTION_ATTRIBUTE,
} from '../src/client/layout/editor-layout-contract.ts'

afterEach(() => { document.body.innerHTML = '' })

/**
 * No sidebar rule can be a border on its own section: the shell's `.regionArea`
 * clips overflow and reclaims only 4px of the sidebar's 12px inline padding on
 * the left, so the line stops 8px short of the column edge. These cases pin the
 * geometry of the overlays the layout appends to the frame instead.
 */
describe('侧栏面板分隔线实测', () => {
  /**
   * The header is a real toolbar now: it draws its own seam, so the layout contributes only the
   * height that puts that seam on the tab bar's bottom edge. Publishing a rule for it as well would
   * paint a second line over the border it already draws.
   */
  it('sizes the header to the tab bar without painting a rule over its own seam', () => {
    const { frame } = fixture({
      frame: rect(0, 0, 1440, 900),
      column: rect(48, 0, 300, 900),
      header: rect(60, 6, 276, 34),
      // The tab bar is 38px plus its own 1px border-bottom.
      anchor: rect(360, 0, 640, 39),
    })

    createPanelRuleLayout(frame, { info: vi.fn() })

    // No overlay at all: the only section-like row here is the header, and it owns its seam.
    expect(rules(frame)).toHaveLength(0)
    // The header spans to the tab bar's bottom edge: 39 - 6.
    expect(style(frame, PANEL_HEADER_HEIGHT_PROPERTY)).toBe('33px')
    expect(frame.hasAttribute(PANEL_RULE_ATTRIBUTE)).toBe(true)
  })

  /**
   * The reported bug: the commit box's own border could never reach the column's
   * left edge, so the line is measured from the box and painted on the frame.
   */
  it('closes a section at its own bottom edge, full column width', () => {
    const { frame, section } = fixture({
      frame: rect(0, 0, 1440, 900),
      column: rect(48, 0, 300, 900),
      header: rect(60, 6, 276, 34),
      anchor: rect(360, 0, 640, 39),
      section: rect(60, 200, 276, 90),
    })

    createPanelRuleLayout(frame, { info: vi.fn() })

    // Only the section gets a rule; the header is skipped even though it carries its own marker.
    expect(rules(frame)).toHaveLength(1)
    expect(rules(frame)[0]).toEqual({ left: '48px', top: '289px', width: '300px' })
    // The overlay replaces a border that could not close, so the box keeps the
    // row it reserved for it.
    expect(section.style.borderBottom).toBe('')
  })

  /**
   * The reported bug: with no file open, the panel header lost its rule and the whole body jumped
   * up the moment the last tab was closed.
   *
   * `WorkbenchEditor` renders its empty state instead of `EditorPane` when no file is open, so the
   * tab bar the header closes against is absent from the DOM — not zero-width, simply not there.
   * The header's height and its seam are one measurement, so withdrawing the measurement also
   * withdrew the height and the header fell back to its natural size, moving every row beneath it.
   *
   * The header therefore keeps the height the tab bar *would* have had, measured from the middle
   * column's own root: `.editorHeader` is 38px with a 1px bottom border, and that root is the node
   * the tab bar lives in. Asserted as the same number a rendered tab bar produces, which is what
   * makes the two states indistinguishable.
   */
  it('keeps the header height when no file is open and there is no tab bar', () => {
    const { frame, anchor } = fixture({
      frame: rect(0, 0, 1440, 900),
      column: rect(48, 0, 300, 900),
      header: rect(60, 6, 276, 34),
      // The middle column's root, and the tab bar's own box inside it (38px + 1px border).
      editor: rect(360, 0, 640, 900),
      anchor: rect(360, 0, 640, 39),
      section: rect(60, 200, 276, 90),
    })
    anchor.remove()

    createPanelRuleLayout(frame, { info: vi.fn() })

    // The section's rule survives; the header contributes none.
    expect(rules(frame)).toHaveLength(1)
    expect(rules(frame)[0]).toEqual({ left: '48px', top: '289px', width: '300px' })
    expect(frame.hasAttribute(PANEL_RULE_ATTRIBUTE)).toBe(true)
    // 39px from the middle column's top, less the header's own 6px top offset — the same '33px'
    // the tab-bar case publishes, which is the point: closing the last file must not resize
    // anything.
    expect(style(frame, PANEL_HEADER_HEIGHT_PROPERTY)).toBe('33px')
  })

  /**
   * The base for that fallback is the middle column's root, not the sidebar column's.
   *
   * Nothing makes the two columns share a top edge — the shell insets the sidebar — so deriving the
   * edge from the sidebar's own box makes the header that much too short, and its seam lands above
   * the tab bar's. This case is the one the original fixtures could not express: they hung the
   * anchor off the frame directly and gave both columns the same origin, where the wrong arithmetic
   * and the right one agree.
   */
  it('measures the fallback edge from the middle column, not the sidebar column', () => {
    const { frame, anchor } = fixture({
      frame: rect(0, 0, 1440, 900),
      // The sidebar starts 2px lower than the editor column.
      column: rect(48, 2, 300, 898),
      header: rect(60, 8, 276, 34),
      editor: rect(360, 0, 640, 900),
      anchor: rect(360, 0, 640, 39),
    })
    anchor.remove()

    createPanelRuleLayout(frame, { info: vi.fn() })

    // 39 from the middle column's top, less the header's own 8px — NOT 39 from the sidebar's
    // 2px-lower top, which would give 29 and leave the seam 4px above the tab bar's.
    expect(style(frame, PANEL_HEADER_HEIGHT_PROPERTY)).toBe('31px')
  })

  /**
   * A collapsed middle column is a different state from an empty one: it *renders* the editor and
   * folds it away, so its anchor exists and measures zero width. Nothing on screen offers an edge
   * to align with, so the header keeps DSH's natural height and the rule is withdrawn — the
   * fallback above is for a missing tab bar, not for a folded column.
   */
  it('withdraws the header rule when the middle column is collapsed', () => {
    const { frame, anchor } = fixture({
      frame: rect(0, 0, 1440, 900),
      column: rect(48, 0, 300, 900),
      header: rect(60, 6, 276, 34),
      anchor: rect(360, 0, 0, 39),
      section: rect(60, 200, 276, 90),
    })
    expect(anchor.getBoundingClientRect().width).toBe(0)

    createPanelRuleLayout(frame, { info: vi.fn() })

    expect(rules(frame)).toHaveLength(1)
    expect(rules(frame)[0]).toEqual({ left: '48px', top: '289px', width: '300px' })
    expect(frame.hasAttribute(PANEL_RULE_ATTRIBUTE)).toBe(false)
    expect(style(frame, PANEL_HEADER_HEIGHT_PROPERTY)).toBe('')
  })

  /**
   * Rounding a measured height to whole CSS pixels moves the header's seam by up to half a pixel,
   * which at a fractional display scale is a whole device row: the two halves of one seam would land
   * on different rows and read as broken. This is the regression that made the sidebar line look
   * heavier, and it survives the header taking over its own seam — the height is still measured.
   */
  it('publishes fractional geometry without rounding to whole pixels', () => {
    const { frame } = fixture({
      frame: rect(0, 0, 1440, 900),
      column: rect(48.5, 0, 300.25, 900),
      header: rect(60, 6.25, 276, 34),
      anchor: rect(360, 0, 640, 39.5),
      section: rect(60, 200.5, 276, 90),
    })

    createPanelRuleLayout(frame, { info: vi.fn() })

    expect(rules(frame)[0]).toEqual({ left: '48.5px', top: '289.5px', width: '300.25px' })
    expect(style(frame, PANEL_HEADER_HEIGHT_PROPERTY)).toBe('33.25px')
  })

  it('draws nothing while the middle column is hidden', () => {
    const { frame } = fixture({
      frame: rect(0, 0, 1440, 900),
      column: rect(48, 0, 300, 900),
      header: rect(60, 6, 276, 34),
      // A collapsed column reports no width: the measurement is meaningless.
      anchor: rect(360, 0, 0, 39),
    })

    const layout = createPanelRuleLayout(frame, { info: vi.fn() })

    expect(rules(frame)).toHaveLength(0)
    expect(frame.hasAttribute(PANEL_RULE_ATTRIBUTE)).toBe(false)
    expect(style(frame, PANEL_HEADER_HEIGHT_PROPERTY)).toBe('')
    layout.dispose()
  })

  it('clears overlays and geometry on dispose', () => {
    const { frame } = fixture({
      frame: rect(0, 0, 1440, 900),
      column: rect(48, 0, 300, 900),
      header: rect(60, 6, 276, 34),
      anchor: rect(360, 0, 640, 39),
      section: rect(60, 200, 276, 90),
    })

    const layout = createPanelRuleLayout(frame, { info: vi.fn() })
    expect(rules(frame)).toHaveLength(1)
    layout.dispose()

    expect(rules(frame)).toHaveLength(0)
    expect(frame.hasAttribute(PANEL_RULE_ATTRIBUTE)).toBe(false)
    expect(style(frame, PANEL_HEADER_HEIGHT_PROPERTY)).toBe('')
  })

  it('is marked by the exact attributes the components render', () => {
    // The components carry these markers as JSX literals, so a renamed constant
    // would silently stop the measurement from finding anything.
    const marked = {
      'src/client/files/FileTree.tsx': PANEL_HEADER_ATTRIBUTE,
      'src/client/git/GitRepositoryToolbar.tsx': PANEL_HEADER_ATTRIBUTE,
      'src/client/terminal/TerminalPanel.tsx': PANEL_HEADER_ATTRIBUTE,
      'src/client/notebook/KernelPanel.tsx': PANEL_HEADER_ATTRIBUTE,
      'src/client/sql/SqlPanel.tsx': PANEL_HEADER_ATTRIBUTE,
      'src/client/editor/EditorPane.tsx': PANEL_RULE_ANCHOR_ATTRIBUTE,
      'src/client/git/GitPanel.tsx': PANEL_RULE_SECTION_ATTRIBUTE,
    } as const
    for (const [path, attribute] of Object.entries(marked)) {
      const source = readFileSync(resolve(process.cwd(), path), 'utf8')
      expect(source, `${path} must carry [${attribute}]`).toContain(`${attribute}=""`)
    }
  })

  /**
   * The seam under a panel header is drawn once, by the shared `[panel-header]` rule in
   * `layout-styles.ts`, which every marked panel gets for free. A panel that also declared a bottom
   * border on its own header would draw a second line — the reported bug this replaces, when the
   * SQL panel's own `border-block-end` landed next to the measured overlay.
   *
   * So the marked panels' stylesheets must still carry no bottom border: the rule is now shared
   * rather than painted from outside, but a per-panel copy of it is still a duplicate. Every marked
   * stylesheet is read because this is a property of the marker, not of any one panel.
   */
  it('leaves the seam to the shared header rule rather than drawing its own', () => {
    const headers = [
      ['src/client/files/files.module.css', 'panelHeader'],
      ['src/client/git/git.module.css', 'panelHeader'],
      ['src/client/terminal/terminal.module.css', 'panelHeader'],
      ['src/client/notebook/kernel-panel.module.css', 'panelHeader'],
      ['src/client/sql/sql-panel.module.css', 'panelHeader'],
    ] as const
    for (const [path, selector] of headers) {
      const stylesheet = readFileSync(resolve(process.cwd(), path), 'utf8')
      const block = (stylesheet.match(
        new RegExp(`\\.${selector} \\{[\\s\\S]*?\\n\\}`, 'u'),
      ) ?? [])[0]
      expect(block, `${path} must declare .${selector}`).toBeDefined()
      expect(block, `${path} .${selector} must not draw its own rule`).not.toMatch(
        /border(?:-block-end|-bottom)?:/u,
      )
    }

    // And the shared rule is what draws it, with the tab bar's own declaration.
    const css = readFileSync(resolve(process.cwd(), 'src/client/layout/layout-styles.ts'), 'utf8')
    const headerRule = (css.match(/PANEL_HEADER_ATTRIBUTE\}\] \{[\s\S]*?\n\}/u) ?? [])[0]
    expect(headerRule, 'the shared header rule must paint the seam').toBeDefined()
    expect(headerRule).toContain('border-bottom: 1px solid var(--dsw-alias-border-l1)')
    expect(headerRule).toContain('background: var(--dsw-alias-bg-layer-1)')
    // No stacking context: the Git and terminal menus are rendered inside this row.
    expect(headerRule).not.toMatch(/isolation|z-index|position: relative/u)
  })

  it('draws each rule with the tab bar border declaration', () => {
    // Same primitive, width, and colour as `.editorHeader`'s border-bottom: the
    // engine quantises both alike, so neither half can render heavier.
    const css = readFileSync(resolve(process.cwd(), 'src/client/layout/layout-styles.ts'), 'utf8')
    // Blocks are matched whole because their bodies interpolate `${...}`, whose
    // closing brace ends any `[^}]` run early.
    const overlay = (css.match(/PANEL_RULE_OVERLAY_ATTRIBUTE\}\] \{[\s\S]*?\n\}/gu) ?? [])[0]
    expect(overlay).toBeDefined()
    expect(overlay).toContain('height: 0;')
    expect(overlay).toContain('border-bottom: 1px solid var(--dsw-alias-border-l1)')
    expect(overlay).not.toContain('background:')
  })
})

interface FixtureRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

interface RuleBox {
  readonly left: string
  readonly top: string
  readonly width: string
}

function rect(x: number, y: number, width: number, height: number): FixtureRect {
  return { x, y, width, height }
}

function fixture(
  boxes: Partial<Record<'frame' | 'column' | 'header' | 'anchor' | 'section' | 'editor', FixtureRect>>,
) {
  const frame = document.createElement('div')
  const column = document.createElement('div')
  const header = document.createElement('div')
  header.setAttribute(PANEL_HEADER_ATTRIBUTE, '')
  column.appendChild(header)
  const section = document.createElement('div')
  section.setAttribute(PANEL_RULE_SECTION_ATTRIBUTE, '')
  column.append(header, section)
  // The middle column's root, with the tab bar inside it — the real nesting. The header closes
  // against an edge *inside this column*, so the fallback path needs this node to stand in for it
  // when there is no tab bar; a fixture that hung the anchor off the frame directly could not tell
  // the two columns' origins apart, which is the mistake the fallback originally made.
  const editor = document.createElement('div')
  editor.setAttribute(EDITOR_ROOT_ATTRIBUTE, '')
  const anchor = document.createElement('header')
  anchor.setAttribute(PANEL_RULE_ANCHOR_ATTRIBUTE, '')
  editor.appendChild(anchor)
  frame.append(column, editor)
  document.body.appendChild(frame)
  measure(frame, boxes.frame)
  measure(column, boxes.column)
  measure(header, boxes.header)
  measure(editor, boxes.editor ?? boxes.anchor)
  measure(anchor, boxes.anchor)
  measure(section, boxes.section)
  return { frame, column, header, anchor, section, editor }
}

/** The overlays the layout published, in document order. */
function rules(frame: HTMLElement): RuleBox[] {
  return Array.from(frame.children)
    .filter((child): child is HTMLElement =>
      child instanceof HTMLElement && child.hasAttribute(PANEL_RULE_OVERLAY_ATTRIBUTE))
    .map(overlay => ({
      left: overlay.style.left,
      top: overlay.style.top,
      width: overlay.style.width,
    }))
}

function measure(element: HTMLElement, box: FixtureRect | undefined): void {
  if (box === undefined) {
    vi.spyOn(element, 'getBoundingClientRect').mockImplementation(() => emptyRect())
    return
  }
  vi.spyOn(element, 'getBoundingClientRect').mockImplementation(() => ({
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    top: box.y,
    left: box.x,
    right: box.x + box.width,
    bottom: box.y + box.height,
    toJSON: () => ({}),
  }))
}

function emptyRect(): DOMRect {
  return {
    x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}),
  }
}

function style(element: HTMLElement, property: string): string {
  return element.style.getPropertyValue(property)
}
