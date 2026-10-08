/** 让官方侧栏底栏保持原生上下排列，只为停靠列标记 Settings 触发器。 */

export const SIDEBAR_SETTINGS_TRIGGER_ATTRIBUTE = 'data-dsh-workbench-sidebar-settings-trigger'

/**
 * The official Settings launcher is the dialog-popup button carried by the
 * seat's first row. The registrant wraps it in that trigger row and mounts the
 * whole Settings panel as a later sibling, so scoping the search to the first
 * row keeps a dialog control inside an open panel from being mistaken for the
 * launcher — which the dock would then hide. When an account launcher replaces
 * the gear it opens a menu rather than a dialog, so nothing is tagged and the
 * account row keeps its own geometry.
 */
const SETTINGS_TRIGGER_SELECTOR = "button[aria-haspopup='dialog']"

export interface SidebarFooterLogger {
  info(message: string): void
}

export interface SidebarFooterLayout {
  dispose(): void
}

/**
 * The foot keeps DSH's own geometry: the `sidebar.footer.action` seat (a
 * contributed widget such as a quota reader) stacks above the Settings seat.
 * The workbench owns neither row — its collapse toggles and Settings gear live
 * in the activity dock — so this only marks the official gear, which the dock
 * hides to avoid a duplicate and clicks to open Settings. No React node moves.
 */
export function createSidebarFooterLayout(logger: SidebarFooterLogger): SidebarFooterLayout {
  let settingsTrigger: HTMLButtonElement | null = null

  const clear = (): void => {
    settingsTrigger?.removeAttribute(SIDEBAR_SETTINGS_TRIGGER_ATTRIBUTE)
    settingsTrigger = null
  }

  const reconcile = (): void => {
    const settingsSeat = document.querySelector<HTMLElement>('[data-slot="sidebar.settings"]')
    const nextSettingsTrigger = findLauncher(settingsSeat)
    if (nextSettingsTrigger === settingsTrigger) return
    clear()
    settingsTrigger = nextSettingsTrigger
    if (settingsTrigger === null) return
    settingsTrigger.setAttribute(SIDEBAR_SETTINGS_TRIGGER_ATTRIBUTE, '')
    logger.info('workbench-layout: released the native sidebar foot to its stacked order and tagged the Settings launcher')
  }

  reconcile()
  const observer = new MutationObserver(reconcile)
  observer.observe(document.body, { childList: true, subtree: true })
  return {
    dispose: () => {
      observer.disconnect()
      clear()
    },
  }
}

/** The launcher lives in the seat's first row, never in the panel after it. */
function findLauncher(seat: HTMLElement | null | undefined): HTMLButtonElement | null {
  const row = seat?.firstElementChild
  if (!(row instanceof HTMLElement)) return null
  const candidate = row.matches(SETTINGS_TRIGGER_SELECTOR) ? row : row.querySelector(SETTINGS_TRIGGER_SELECTOR)
  return candidate instanceof HTMLButtonElement ? candidate : null
}
