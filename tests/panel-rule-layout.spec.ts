// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPanelRuleLayout } from '../src/client/layout/panel-rule-layout.ts'
import {
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
  it('closes the panel header across the column against the tab bar', () => {
    const { frame } = fixture({
      frame: rect(0, 0, 1440, 900),
      column: rect(48, 0, 300, 900),
      header: rect(60, 6, 276, 34),
      // The tab bar is 38px plus its own 1px border-bottom.
      anchor: rect(360, 0, 640, 39),
    })

    createPanelRuleLayout(frame, { info: vi.fn() })

    const [rule] = rules(frame)
    // Offsets are relative to the frame's padding box; the rule occupies the
    // tab bar's last row, so its top is the bottom edge minus 1px.
    expect(rule).toEqual({ left: '48px', top: '38px', width: '300px' })
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

    const [, commitRule] = rules(frame)
    expect(commitRule).toEqual({ left: '48px', top: '289px', width: '300px' })
    // The overlay replaces a border that could not close, so the box keeps the
    // row it reserved for it.
    expect(section.style.borderBottom).toBe('')
  })

  it('keeps the section rule when the middle column has no tab bar', () => {
    const { frame, anchor } = fixture({
      frame: rect(0, 0, 1440, 900),
      column: rect(48, 0, 300, 900),
      header: rect(60, 6, 276, 34),
      section: rect(60, 200, 276, 90),
    })
    anchor.remove()

    createPanelRuleLayout(frame, { info: vi.fn() })

    // The header rule needs the tab bar; the commit box does not.
    expect(rules(frame)).toHaveLength(1)
    expect(rules(frame)[0]).toEqual({ left: '48px', top: '289px', width: '300px' })
    expect(frame.hasAttribute(PANEL_RULE_ATTRIBUTE)).toBe(false)
    expect(style(frame, PANEL_HEADER_HEIGHT_PROPERTY)).toBe('')
  })

  /**
   * Rounding a measured offset to whole CSS pixels moves the line by up to half a
   * pixel, which at a fractional display scale is a whole device row: the two
   * halves of one seam would land on different rows and read as broken. This is
   * the regression that made the sidebar line look heavier.
   */
  it('publishes fractional geometry without rounding to whole pixels', () => {
    const { frame } = fixture({
      frame: rect(0, 0, 1440, 900),
      column: rect(48.5, 0, 300.25, 900),
      header: rect(60, 6.25, 276, 34),
      anchor: rect(360, 0, 640, 39.5),
    })

    createPanelRuleLayout(frame, { info: vi.fn() })

    expect(rules(frame)[0]).toEqual({ left: '48.5px', top: '38.5px', width: '300.25px' })
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
    expect(rules(frame)).toHaveLength(2)
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
      'src/client/editor/EditorPane.tsx': PANEL_RULE_ANCHOR_ATTRIBUTE,
      'src/client/git/GitPanel.tsx': PANEL_RULE_SECTION_ATTRIBUTE,
    } as const
    for (const [path, attribute] of Object.entries(marked)) {
      const source = readFileSync(resolve(process.cwd(), path), 'utf8')
      expect(source, `${path} must carry [${attribute}]`).toContain(`${attribute}=""`)
    }
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
  boxes: Partial<Record<'frame' | 'column' | 'header' | 'anchor' | 'section', FixtureRect>>,
) {
  const frame = document.createElement('div')
  const column = document.createElement('div')
  const header = document.createElement('div')
  header.setAttribute(PANEL_HEADER_ATTRIBUTE, '')
  column.appendChild(header)
  const section = document.createElement('div')
  section.setAttribute(PANEL_RULE_SECTION_ATTRIBUTE, '')
  column.append(header, section)
  const anchor = document.createElement('header')
  anchor.setAttribute(PANEL_RULE_ANCHOR_ATTRIBUTE, '')
  frame.append(column, anchor)
  document.body.appendChild(frame)
  measure(frame, boxes.frame)
  measure(column, boxes.column)
  measure(header, boxes.header)
  measure(anchor, boxes.anchor)
  measure(section, boxes.section)
  return { frame, column, header, anchor, section }
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
