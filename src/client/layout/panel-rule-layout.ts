/** 侧栏面板与中栏标签栏之间的连续分隔线：绘制在 AppFrame 上，几何全部实测。 */

import {
  PANEL_HEADER_ATTRIBUTE,
  PANEL_HEADER_HEIGHT_PROPERTY,
  PANEL_RULE_ANCHOR_ATTRIBUTE,
  PANEL_RULE_ATTRIBUTE,
  PANEL_RULE_LEFT_PROPERTY,
  PANEL_RULE_TOP_PROPERTY,
  PANEL_RULE_WIDTH_PROPERTY,
} from './editor-layout-contract.ts'

/** The rule continues the tab bar's 1px border-bottom. */
const RULE_THICKNESS_PX = 1

export interface PanelRuleLogger {
  info(message: string): void
}

export interface PanelRuleLayout {
  reconcile(): void
  dispose(): void
}

/**
 * Keep the sidebar's panel rule collinear with the middle column's tab bar.
 *
 * The rule cannot be a border on the panel header: the shell's `.regionArea`
 * clips overflow and reclaims only 4px of the sidebar's 12px inline padding on
 * the left, so a border drawn in there stops 8px short of the column edge — the
 * visible gap. It is therefore painted by a pseudo-element on the AppFrame, which
 * already contains the columns, leaves `::after` free, and stacks above every
 * column fill without replacing the macOS vibrancy gradients or creating a
 * containing block for the sidebar's absolutely-positioned commit-graph lanes.
 *
 * Left, width, top, and the matching header height are measured against the tab
 * bar the rule has to meet, so no host padding is assumed.
 *
 * Every value is published at full measured precision. Rounding to whole CSS
 * pixels would move the line by up to half a pixel, which at a fractional display
 * scale is a whole device row — the two halves of one rule would then snap to
 * different rows and the seam would read as broken.
 */
export function createPanelRuleLayout(
  frame: HTMLElement,
  logger: PanelRuleLogger,
): PanelRuleLayout {
  let scheduled = false
  let reported: string | undefined

  const clear = (): void => {
    frame.removeAttribute(PANEL_RULE_ATTRIBUTE)
    for (const property of [
      PANEL_RULE_LEFT_PROPERTY,
      PANEL_RULE_TOP_PROPERTY,
      PANEL_RULE_WIDTH_PROPERTY,
      PANEL_HEADER_HEIGHT_PROPERTY,
    ]) frame.style.removeProperty(property)
    reported = undefined
  }

  const solve = (): void => {
    const header = frame.querySelector<HTMLElement>(`[${PANEL_HEADER_ATTRIBUTE}]`)
    const anchor = frame.querySelector<HTMLElement>(`[${PANEL_RULE_ANCHOR_ATTRIBUTE}]`)
    // The column that owns the header, rather than a positional assumption: the
    // workbench itself appends drag handles to the frame.
    const column = Array.from(frame.children).find(child => child.contains(header))
    if (header === null || anchor === null || !(column instanceof HTMLElement)) {
      // No sidebar panel is mounted (the official sessions browser owns the
      // seat) or the middle column has no tab bar to meet: draw nothing.
      clear()
      return
    }
    const frameBox = frame.getBoundingClientRect()
    const columnBox = column.getBoundingClientRect()
    const headerBox = header.getBoundingClientRect()
    const anchorBox = anchor.getBoundingClientRect()
    // Absolute offsets inside the frame are relative to its padding box, so the
    // frame's own border must come off both axes.
    const left = columnBox.left - frameBox.left - frame.clientLeft
    // The overlay is given the tab bar's own geometry and the same
    // `border-bottom`, so the engine quantises both identically at any display
    // scale. Its border must straddle the same CSS edge the anchor's does, which
    // means positioning its content box one thickness above that edge.
    const top = anchorBox.bottom - frameBox.top - frame.clientTop - RULE_THICKNESS_PX
    // The header spans to the tab bar's bottom edge, so panel content below it
    // starts exactly where the middle column's content starts.
    const headerHeight = anchorBox.bottom - headerBox.top
    // A zero box means the panel or the middle column is hidden, and a negative
    // solve means the two no longer share an origin. Either way the measurement
    // cannot be trusted, so release rather than pin a stale line.
    if (columnBox.width <= 0 || headerBox.width <= 0 || anchorBox.width <= 0
      || !(left >= 0) || !(top >= 0) || !(headerHeight > 0)) {
      clear()
      return
    }
    const published = {
      [PANEL_RULE_LEFT_PROPERTY]: length(left),
      [PANEL_RULE_TOP_PROPERTY]: length(top),
      [PANEL_RULE_WIDTH_PROPERTY]: length(columnBox.width),
      [PANEL_HEADER_HEIGHT_PROPERTY]: length(headerHeight),
    }
    for (const [property, value] of Object.entries(published)) setProperty(frame, property, value)
    frame.setAttribute(PANEL_RULE_ATTRIBUTE, '')
    const signature = Object.values(published).join('/')
    if (reported !== undefined && signature !== reported) {
      logger.info(`workbench-layout: re-measured the sidebar panel rule at ${signature}`)
    }
    reported = signature
  }

  const observe = (): void => {
    if (resizes === undefined) return
    const next = [
      frame,
      ...Array.from(frame.querySelectorAll<HTMLElement>(
        `[${PANEL_HEADER_ATTRIBUTE}], [${PANEL_RULE_ANCHOR_ATTRIBUTE}]`,
      )),
    ]
    if (next.length === watched.length && next.every((node, index) => node === watched[index])) return
    for (const previous of watched) resizes.unobserve(previous)
    for (const node of next) resizes.observe(node)
    watched = next
  }

  const reconcile = (): void => {
    scheduled = false
    try {
      solve()
    } finally {
      // Track whatever the current geometry is, including the unmeasurable
      // states, so the next box change gets another chance to publish a rule.
      observe()
    }
  }

  const schedule = (): void => {
    if (scheduled) return
    scheduled = true
    window.requestAnimationFrame(reconcile)
  }

  /* Mounts and unmounts of the two marked nodes arrive as child-list records.
     Frame attributes are deliberately not observed: this layout writes them, so
     it would feed itself. Box changes arrive from the resize observer instead,
     re-armed after every measurement because either column can resize on its own;
     a display-scale change alters the CSS viewport too, so it lands here as well. */
  const mutations = new MutationObserver(schedule)
  mutations.observe(frame, { childList: true, subtree: true })
  const resizes = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule)
  let watched: readonly HTMLElement[] = []

  reconcile()

  return {
    reconcile: schedule,
    dispose: () => {
      mutations.disconnect()
      resizes?.disconnect()
      clear()
    },
  }
}

/** Keep the measured sub-pixel precision; see the note on the layout function. */
function length(value: number): string {
  return `${Number(value.toFixed(4))}px`
}

function setProperty(element: HTMLElement, property: string, value: string): void {
  if (element.style.getPropertyValue(property) === value) return
  element.style.setProperty(property, value)
}
