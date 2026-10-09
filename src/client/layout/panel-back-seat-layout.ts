/** 在官方「插件」页头部工具条里开辟一个返回会话的挂载席位。 */

import { PANEL_BACK_SEAT_ATTRIBUTE } from './editor-layout-contract.ts'

/** Official marker on the Plugins page root, shared by its list and detail views. */
const PLUGIN_PANEL_SELECTOR = '[data-plugin-panel]'

/**
 * The list view's action row, addressed by its stable CSS-modules suffix: it
 * holds the page's own refresh and add actions, and the exit joins them there.
 * The detail view is deliberately left alone — it already carries a back
 * crumb — so the dock keeps supplying that view's way out to the Conversation.
 */
const TOOLBAR_SELECTOR = '[class*="_toolbar"]'

/** The shell's reverse marker for a window-drag band; the seat sits inside one. */
const WINDOW_DRAG_RECALL_ATTRIBUTE = 'data-window-drag-recall'

export interface PanelBackSeatLogger {
  info(message: string): void
}

export interface PanelBackSeatLayout {
  dispose(): void
}

/**
 * Publish a mount seat at the head of the Plugins page's own action row so the
 * missing way back to the Conversation reads as one of that page's actions.
 *
 * DSH's sidebar panel rows only ever *select* a global panel — their handler is
 * `selectPanel(id)`, never `selectPanel(null)` — and the Plugins page contributes
 * no header slot (its only contributions are `plugins.item`, `plugins.detail.*`,
 * `plugins.row.config` and `plugins.bundle.config`), so the page cannot leave
 * itself. The row also sits inside a `data-window-drag` band, which on macOS
 * becomes `-webkit-app-region: drag` and would swallow every click, so the seat
 * carries the shell's own `data-window-drag-recall` marker to stay clickable.
 */
export function createPanelBackSeatLayout(
  onSeat: (seat: HTMLElement | null) => void,
  logger: PanelBackSeatLogger,
): PanelBackSeatLayout {
  let seat: HTMLElement | null = null
  let announced = false

  const clear = (): void => {
    if (seat === null) return
    onSeat(null)
    seat.remove()
    seat = null
  }

  const reconcile = (): void => {
    const toolbar = document.querySelector<HTMLElement>(
      `${PLUGIN_PANEL_SELECTOR} ${TOOLBAR_SELECTOR}`,
    )
    if (toolbar === null) {
      clear()
      announced = false
      return
    }
    // The page swaps its whole header between views, so a detached seat means the
    // list view is gone and leaving it unmounted is enough.
    if (seat !== null && !seat.isConnected) seat = null
    if (seat !== null && seat.parentElement === toolbar) return
    clear()
    seat = document.createElement('div')
    seat.setAttribute(PANEL_BACK_SEAT_ATTRIBUTE, '')
    seat.setAttribute(WINDOW_DRAG_RECALL_ATTRIBUTE, '')
    toolbar.insertBefore(seat, toolbar.firstChild)
    onSeat(seat)
    if (announced) return
    announced = true
    logger.info('workbench-layout: opened a back-to-conversation seat in the Plugins page header')
  }

  reconcile()
  // Own writes are idempotent: a reconcile that finds the seat already in place
  // mutates nothing, so this observer cannot feed itself.
  const observer = new MutationObserver(reconcile)
  observer.observe(document.body, { childList: true, subtree: true })
  return {
    dispose: () => {
      observer.disconnect()
      clear()
    },
  }
}
