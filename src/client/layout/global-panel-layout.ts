/** 全局 main 面板（插件页、其它插件贡献的页面）打开时保持工作台编辑器存活。 */

import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'

/** Root layout store's panel selection source (`ctx.layout.panelInfo`). */
export type GlobalPanelSource = ObservableSnapshot<{ activePanelId: string | null }>

/** Set while a global `main` panel replaces the Conversation in the center column. */
export const GLOBAL_PANEL_ATTRIBUTE = 'data-dsh-workbench-global-panel'

/**
 * Marks the one official Session host whose workbench editor stays painted
 * while a global panel is open. The host is chosen while it is still visible,
 * so the claim survives the frame hiding every Session subtree.
 */
export const EDITOR_HOST_ATTRIBUTE = 'data-dsh-workbench-editor-host'

/** Stable official marker on each per-Session subtree of the right column. */
const SESSION_HOST_ATTRIBUTE = 'data-sidebar-right-session'

/** The official dock surface reuses the Session attribute one level deeper. */
const DOCK_PANEL_ATTRIBUTE = 'data-sidebar-right-panel'

export interface GlobalPanelLogger {
  info(message: string): void
}

export interface GlobalPanelLayout {
  dispose(): void
}

/**
 * A global `main` panel is DSH's own center-column surface: selecting it hides
 * the Conversation and every Session subtree of the right column. The workbench
 * keeps the middle editor alive by remembering which Session host was on screen
 * the moment before the panel opened and holding exactly that one open.
 */
export function createGlobalPanelLayout(
  frame: HTMLElement,
  panelInfo: GlobalPanelSource,
  logger: GlobalPanelLogger,
): GlobalPanelLayout {
  let panelActive = false
  let host: HTMLElement | null = null

  const reconcileHosts = (): void => {
    const column = frame.querySelector<HTMLElement>('[data-rightbar-col]')
    // Depth-independent: the official dock surface reuses the same Session
    // attribute on its own element, so excluding that marker leaves exactly the
    // per-Session subtrees, however many wrappers the occupant nests.
    const candidates = Array.from(column?.querySelectorAll<HTMLElement>(`[${SESSION_HOST_ATTRIBUTE}]`) ?? [])
      .filter(child => !child.hasAttribute(DOCK_PANEL_ATTRIBUTE))
    // While the Conversation is on screen DSH keeps exactly one host visible, so
    // that one is the editor's home and the claim follows it across Session swaps.
    const visible = candidates.find(candidate => !candidate.hasAttribute('hidden'))
    // Every host is hidden while a global panel owns the center column, and for
    // the frame in which a closing panel has already released the Conversation
    // but React has not un-hidden the subtree yet. The standing claim is the only
    // record of which subtree held the editor, so it survives both states and
    // moves only once that node is gone.
    const claimed = host !== null && host.isConnected && candidates.includes(host)
    const next = visible ?? (candidates.length === 0 ? null : claimed ? host : candidates[0] ?? null)
    if (next === null) {
      host?.removeAttribute(EDITOR_HOST_ATTRIBUTE)
      host = null
      return
    }
    if (next === host) return
    host?.removeAttribute(EDITOR_HOST_ATTRIBUTE)
    host = next
    host.setAttribute(EDITOR_HOST_ATTRIBUTE, '')
  }

  const reconcilePanel = (): void => {
    const next = panelInfo.getSnapshot().activePanelId !== null
    if (next === panelActive) return
    panelActive = next
    frame.toggleAttribute(GLOBAL_PANEL_ATTRIBUTE, next)
    reconcileHosts()
    logger.info(next
      ? 'workbench-layout: held the middle editor open beside the global main panel'
      : 'workbench-layout: released the middle editor back to the native conversation column')
  }

  reconcilePanel()
  reconcileHosts()
  const unsubscribePanel = panelInfo.subscribe(reconcilePanel)
  const observer = new MutationObserver(reconcileHosts)
  observer.observe(frame, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] })

  return {
    dispose: () => {
      unsubscribePanel()
      observer.disconnect()
      host?.removeAttribute(EDITOR_HOST_ATTRIBUTE)
      host = null
      frame.removeAttribute(GLOBAL_PANEL_ATTRIBUTE)
    },
  }
}
