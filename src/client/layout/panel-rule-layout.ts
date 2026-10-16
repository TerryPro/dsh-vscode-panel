/** 侧栏面板分隔线：绘制在 AppFrame 上的覆盖层，几何全部实测。 */

import {
  EDITOR_COLLAPSED_ATTRIBUTE,
  EDITOR_ROOT_ATTRIBUTE,
  PANEL_HEADER_ATTRIBUTE,
  PANEL_HEADER_HEIGHT_PROPERTY,
  PANEL_RULE_ANCHOR_ATTRIBUTE,
  PANEL_RULE_ATTRIBUTE,
  PANEL_RULE_OVERLAY_ATTRIBUTE,
  PANEL_RULE_SECTION_ATTRIBUTE,
} from './editor-layout-contract.ts'

/** The rule continues a 1px border-bottom, so it is one CSS pixel thick. */
const RULE_THICKNESS_PX = 1

/**
 * The header row's height when there is no tab bar to measure.
 *
 * The middle column renders `EditorPane` — and with it the tab bar the header closes against —
 * only while a file is open; with no tabs it early-returns to the empty state, so there is no
 * anchor to measure. The header must not change height when that happens: the reader watches the
 * panel's whole body jump up the moment they close their last file, and the rule under the title
 * disappear with it.
 *
 * So the edge falls back to the one the tab bar *would* have offered, built from the same pair of
 * declarations the tab bar uses (`editor.module.css`): `.editorHeader` is `height: 38px` plus a
 * `1px` bottom border.
 *
 * The base is the **middle column's** top, not the sidebar column's. The two do not share an
 * origin — the shell insets the sidebar — so deriving the edge from the sidebar's own box drops
 * the rule by that inset while the measured path, which reads the real tab bar inside the middle
 * column, stays put. The height survives either way (the same offset cancels between the edge and
 * the header's own top), which is exactly why the symptom was a line sitting low on an otherwise
 * correct layout.
 */
const TAB_BAR_HEIGHT_PX = 38
const TAB_BAR_BORDER_PX = 1
const TAB_BAR_OUTER_HEIGHT_PX = TAB_BAR_HEIGHT_PX + TAB_BAR_BORDER_PX

export interface PanelRuleLogger {
  info(message: string): void
}

export interface PanelRuleLayout {
  reconcile(): void
  dispose(): void
}

interface MeasuredRule {
  readonly left: number
  readonly top: number
  readonly width: number
}

/**
 * Close the sidebar panel sections across the column's full width.
 *
 * No rule can be a border on its own section: the shell's `.regionArea` clips
 * overflow and reclaims only 4px of the sidebar's 12px inline padding on the
 * left, so a border drawn in there stops 8px short of the column edge — the
 * visible gap, and a negative margin cannot cross the clip either. Rules are
 * therefore painted by overlay elements appended to the AppFrame, which already
 * contains the columns, is not clipped, and stacks above every column fill
 * without replacing the macOS vibrancy gradients or creating a containing block
 * for the sidebar's absolutely-positioned commit-graph lanes.
 *
 * Two kinds are measured independently, because each is lost in a different
 * state:
 *
 * - the panel header closes against the middle column's tab bar, which is what
 *   makes the two halves of one seam collinear. It needs the tab bar, so it
 *   disappears with a collapsed middle column;
 * - a section, such as the commit box, simply closes its own bottom edge and is
 *   independent of the middle column entirely.
 *
 * Values are published at full measured precision. Rounding to whole CSS pixels
 * would move a line by up to half a pixel, which at a fractional display scale
 * is a whole device row: the two halves of one seam would land on different rows
 * and read as broken.
 */
export function createPanelRuleLayout(
  frame: HTMLElement,
  logger: PanelRuleLogger,
): PanelRuleLayout {
  let scheduled = false
  let reported: string | undefined

  const overlays = (): HTMLElement[] =>
    Array.from(frame.children).filter(
      (child): child is HTMLElement =>
        child instanceof HTMLElement && child.hasAttribute(PANEL_RULE_OVERLAY_ATTRIBUTE),
    )

  /** The frame child that owns an element, rather than a positional assumption. */
  const columnOf = (element: HTMLElement): HTMLElement | undefined =>
    Array.from(frame.children).find(
      child => child instanceof HTMLElement && child.contains(element),
    ) as HTMLElement | undefined

  /**
   * A rule spanning `column`'s full width, positioned in **viewport coordinates**.
   *
   * Not offsets inside the frame, because the frame is deliberately not a containing block —
   * making it one would capture the sidebar's absolutely-positioned commit-graph lanes (see the
   * overlay rule in `layout-styles.ts`). Without that, an absolutely-positioned overlay resolves
   * `top` against whichever ancestor *is* positioned, and arithmetic that assumed the frame's own
   * padding box cannot know that ancestor's origin.
   *
   * Measured: with the frame sitting 2px below the viewport origin, the computed offset landed the
   * rule 2px above the seam it continues — in *both* the open-file and the empty-editor states,
   * because the mistake is in the origin both paths share rather than in either branch. That is
   * also why no case here caught it: every fixture puts the frame at the viewport origin, where the
   * two origins coincide and the wrong arithmetic gives the right answer.
   *
   * The overlays are `position: fixed` for the same reason: it makes the viewport the containing
   * block, so these numbers are used as written, on any platform, padding or zoom.
   */
  const measure = (
    owner: HTMLElement,
    column: HTMLElement,
    bottomEdge: number,
  ): MeasuredRule | undefined => {
    const columnBox = column.getBoundingClientRect()
    if (columnBox.width <= 0 || owner.getBoundingClientRect().width <= 0) return undefined
    const left = columnBox.left
    const top = bottomEdge - RULE_THICKNESS_PX
    if (!(left >= 0) || !(top >= 0)) return undefined
    return { left, top, width: columnBox.width }
  }

  const solve = (): void => {
    const header = frame.querySelector<HTMLElement>(`[${PANEL_HEADER_ATTRIBUTE}]`)
    const anchor = frame.querySelector<HTMLElement>(`[${PANEL_RULE_ANCHOR_ATTRIBUTE}]`)
    const rules: MeasuredRule[] = []

    const headerRule = measureHeader(header, anchor)
    if (headerRule !== undefined) rules.push(headerRule.rule)
    for (const section of Array.from(
      frame.querySelectorAll<HTMLElement>(`[${PANEL_RULE_SECTION_ATTRIBUTE}]`),
    )) {
      if (section === header) continue
      const column = columnOf(section)
      const rule = column === undefined
        ? undefined
        : measure(section, column, section.getBoundingClientRect().bottom)
      if (rule !== undefined) rules.push(rule)
    }

    apply(rules)

    /* The header row is only resized once its own rule exists, so it never
       collapses against a measurement that was released, and the section rules
       keep working while the middle column is folded away. */
    if (headerRule === undefined) {
      frame.removeAttribute(PANEL_RULE_ATTRIBUTE)
      frame.style.removeProperty(PANEL_HEADER_HEIGHT_PROPERTY)
    } else {
      setProperty(frame, PANEL_HEADER_HEIGHT_PROPERTY, length(headerRule.headerHeight))
      frame.setAttribute(PANEL_RULE_ATTRIBUTE, '')
    }

    const signature = rules.map(rule => `${rule.left}/${rule.top}/${rule.width}`).join(' ')
    if (reported !== undefined && signature !== reported) {
      logger.info(`workbench-layout: re-measured the sidebar panel rules at ${signature}`)
    }
    reported = signature
  }

  /**
   * The header's rule, aligned to the tab bar's bottom edge rather than its own,
   * plus the header height that edge implies.
   *
   * Undefined only when the geometry cannot be trusted at all — no header, no column, a column
   * with no width. Two states that both lack a *tab bar* are handled differently, because they
   * mean different things:
   *
   * - **No file is open.** `WorkbenchEditor` renders its empty state instead of `EditorPane`, so
   *   the anchor is absent from the DOM. The header still falls back to the height the tab bar
   *   would have had, so closing the last file does not resize the panel header or drop its rule
   *   and make the whole body jump.
   * - **The middle column is collapsed.** The anchor is still rendered but measures zero width, so
   *   it offers an edge nothing can meet. The header keeps DSH's natural height here (the rule is
   *   withdrawn): the column it was aligning to is gone, so there is nothing to align with.
   */
  const measureHeader = (
    header: HTMLElement | null,
    anchor: HTMLElement | null,
  ): { rule: MeasuredRule; headerHeight: number } | undefined => {
    if (header === null) return undefined
    const column = columnOf(header)
    if (column === undefined) return undefined

    if (anchor === null) {
      // No tab bar in the DOM: the empty editor. A collapsed middle column is *not* this case —
      // it renders the editor and folds it away, so its anchor exists and is handled below by the
      // zero-width check.
      if (frame.hasAttribute(EDITOR_COLLAPSED_ATTRIBUTE)) return undefined
      // The base is the middle column's own root, not the sidebar column's. Both are children of
      // the frame, but nothing makes them share a top edge: the sidebar is inset by the shell, so
      // a sidebar-derived edge sits that much lower than the tab bar the rule is meant to continue.
      // The editor root is the right base because the tab bar lives inside it — and it is present
      // in this state too (`EditorShared`'s empty state carries the same marker), so the fallback
      // measures the same column the measured path does, just without the tab bar in it.
      const editor = frame.querySelector<HTMLElement>(`[${EDITOR_ROOT_ATTRIBUTE}]`)
      if (editor === null) return undefined
      const columnBox = column.getBoundingClientRect()
      const editorBox = editor.getBoundingClientRect()
      if (columnBox.width <= 0 || editorBox.width <= 0) return undefined
      const bottomEdge = editorBox.top + TAB_BAR_OUTER_HEIGHT_PX
      const rule = measure(header, column, bottomEdge)
      const headerHeight = bottomEdge - header.getBoundingClientRect().top
      if (rule === undefined || !(headerHeight > 0)) return undefined
      return { rule, headerHeight }
    }

    const anchorBox = anchor.getBoundingClientRect()
    // A collapsed middle column still reports the tab bar's height but no width,
    // so the edge it offers cannot be met by anything.
    if (anchorBox.width <= 0) return undefined
    const rule = measure(header, column, anchorBox.bottom)
    const headerHeight = anchorBox.bottom - header.getBoundingClientRect().top
    if (rule === undefined || !(headerHeight > 0)) return undefined
    return { rule, headerHeight }
  }

  /**
   * Reconcile the overlay pool with the measured rules.
   *
   * Geometry lives on the elements rather than in shared custom properties
   * because a pseudo-element can only ever carry one line and the panel has
   * several. An overlay exists exactly while its rule is valid, so the CSS that
   * styles them needs no gate of its own.
   */
  const apply = (wanted: readonly MeasuredRule[]): void => {
    const existing = overlays()
    for (const extra of existing.slice(wanted.length)) extra.remove()
    for (let index = existing.length; index < wanted.length; index += 1) {
      const created = document.createElement('div')
      created.setAttribute(PANEL_RULE_OVERLAY_ATTRIBUTE, '')
      frame.appendChild(created)
    }
    const current = overlays()
    wanted.forEach((rule, index) => {
      const overlay = current[index]
      if (overlay === undefined) return
      setStyle(overlay, 'left', length(rule.left))
      setStyle(overlay, 'top', length(rule.top))
      setStyle(overlay, 'width', length(rule.width))
    })
  }

  const observe = (): void => {
    if (resizes === undefined) return
    const next = [
      frame,
      ...Array.from(frame.querySelectorAll<HTMLElement>(
        `[${PANEL_HEADER_ATTRIBUTE}], [${PANEL_RULE_ANCHOR_ATTRIBUTE}], [${PANEL_RULE_SECTION_ATTRIBUTE}]`,
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

  /* Mounts and unmounts of the marked nodes arrive as child-list records. Frame
     attributes are deliberately not observed: this layout writes them, so it
     would feed itself. Overlay nodes are filtered out for the same reason — they
     are this layout's own output, and `apply` writes a given overlay only when
     its geometry actually changed, so the extra pass settles at once. Box changes
     arrive from the resize observer instead, re-armed after every measurement
     because either column can resize on its own; a display-scale change alters
     the CSS viewport too, so it lands here as well. */
  const mutations = new MutationObserver(records => {
    if (records.every(isOwnOutput)) return
    schedule()
  })
  mutations.observe(frame, { childList: true, subtree: true })
  const resizes = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule)
  let watched: readonly HTMLElement[] = []

  reconcile()

  return {
    reconcile: schedule,
    dispose: () => {
      mutations.disconnect()
      resizes?.disconnect()
      for (const overlay of overlays()) overlay.remove()
      frame.removeAttribute(PANEL_RULE_ATTRIBUTE)
      frame.style.removeProperty(PANEL_HEADER_HEIGHT_PROPERTY)
      reported = undefined
    },
  }
}

function isOwnOutput(record: MutationRecord): boolean {
  const isOverlay = (node: Node): boolean =>
    node instanceof HTMLElement && node.hasAttribute(PANEL_RULE_OVERLAY_ATTRIBUTE)
  return Array.from(record.addedNodes).every(isOverlay)
    && Array.from(record.removedNodes).every(isOverlay)
}

/** Keep the measured sub-pixel precision; see the note on the layout function. */
function length(value: number): string {
  return `${Number(value.toFixed(4))}px`
}

function setProperty(element: HTMLElement, property: string, value: string): void {
  if (element.style.getPropertyValue(property) === value) return
  element.style.setProperty(property, value)
}

function setStyle(element: HTMLElement, property: 'left' | 'top' | 'width', value: string): void {
  if (element.style[property] === value) return
  element.style[property] = value
}
