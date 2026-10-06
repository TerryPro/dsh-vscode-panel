/** 独立于官方侧栏的常驻活动栏：固定停靠列 + 应用根节点让出宽度。 */

export const ACTIVITY_DOCK_ATTRIBUTE = 'data-dsh-workbench-activity-dock'

/** Width reserved for the dock; applied as inline padding on the AppFrame grid. */
const DOCK_WIDTH_PX = '48px'

export interface ActivityDockLogger {
  info(message: string): void
}

export interface ActivityDockMount {
  dispose(): void
}

/**
 * Mount a viewport-fixed activity bar as its own column, outside the official
 * AppFrame grid and outside the collapsible sidebar, so it stays visible in
 * every fold state. The application root is padded so no official content is
 * covered; no official React node is moved.
 */
export function createActivityDockMount(
  className: string,
  onTarget: (target: HTMLElement | null) => void,
  logger: ActivityDockLogger,
): ActivityDockMount {
  let appRoot: HTMLElement | null = null
  let frame: HTMLElement | null = null
  let host: HTMLElement | null = null
  let previousFramePadding: string | null = null

  const clear = (): void => {
    if (appRoot === null && host === null && frame === null) return
    onTarget(null)
    host?.remove()
    appRoot?.removeAttribute(ACTIVITY_DOCK_ATTRIBUTE)
    if (frame !== null && previousFramePadding !== null) {
      if (previousFramePadding === '') frame.style.removeProperty('padding-left')
      else frame.style.paddingLeft = previousFramePadding
    }
    appRoot = null
    frame = null
    host = null
    previousFramePadding = null
  }

  const reconcile = (): void => {
    const shellOverlay = document.querySelector<HTMLElement>('[data-shell-overlay]')
    const nextFrame = shellOverlay?.parentElement ?? null
    const nextRoot = nextFrame?.parentElement ?? null
    if (nextFrame === null || nextRoot === null) {
      clear()
      return
    }
    if (appRoot === nextRoot && frame === nextFrame && host?.isConnected === true) return

    clear()
    appRoot = nextRoot
    frame = nextFrame
    // Pad the grid container itself so its columns always clear the fixed dock,
    // independent of containing-block or positioning details of any ancestor.
    previousFramePadding = nextFrame.style.paddingLeft
    nextFrame.style.paddingLeft = DOCK_WIDTH_PX
    host = document.createElement('div')
    host.className = className
    appRoot.setAttribute(ACTIVITY_DOCK_ATTRIBUTE, '')
    appRoot.insertBefore(host, appRoot.firstChild)
    onTarget(host)
    logger.info('workbench-layout: mounted the independent activity dock beside the AppFrame')
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
