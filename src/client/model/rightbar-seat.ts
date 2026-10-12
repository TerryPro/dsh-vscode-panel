/** 中栏可见性驱动的原生右栏席位持有：持有期间遮蔽官方 RightbarSeat，让位时交还。 */

/**
 * `rightbar.session` is a **single** slot: its lowest-priority live registrant is
 * its only renderer. The workbench editor registers there at `priority: -100`
 * because that seat is the only session-scoped hole the AppFrame places in its own
 * right column, and taking it necessarily shadows DSH's own `RightbarSeat` — which
 * is the entire native right Sidebar: its dock panel, its guide/file/browser/
 * terminal tabs, its divider, and the `openRightbar` report that makes the frame
 * reserve a track at all.
 *
 * That shadow is only ever justified while there is a middle column on screen to
 * fill with the editor. So the holder below keeps the registration for exactly as
 * long as the controller says the editor is visible, and disposes it otherwise —
 * disposing returns the cell to the official seat, and the native right Sidebar
 * comes back fully usable (its own width report, divider and shortcuts included).
 */
export interface RightbarSeatRegistration {
  /** Register the workbench editor into the seat and return its disposer. */
  register(): () => void
}

export interface RightbarSeatHost {
  attachRightbarShadow(setActive: (active: boolean) => void): () => void
}

export interface RightbarSeatLogger {
  info(message: string): void
}

/**
 * Bind the editor's seat to the middle column's visibility.
 *
 * The host seeds its first callback from the current state, so mounting during an
 * already-collapsed Session yields the seat immediately instead of shadowing a
 * column nobody can see; the last line of that yield is the reason this is a
 * function and not a plain `register()` at plugin load.
 */
export function holdRightbarSeatWhileEditorVisible(
  controller: RightbarSeatHost,
  seat: RightbarSeatRegistration,
  logger: RightbarSeatLogger,
): () => void {
  let dispose: (() => void) | undefined
  const setActive = (active: boolean): void => {
    if (active && dispose === undefined) {
      dispose = seat.register()
      logger.info('workbench-layout: took rightbar.session for the middle editor')
    } else if (!active && dispose !== undefined) {
      dispose()
      dispose = undefined
      logger.info('workbench-layout: released rightbar.session to the native right Sidebar')
    }
  }
  const detach = controller.attachRightbarShadow(setActive)
  return () => {
    detach()
    dispose?.()
    dispose = undefined
  }
}
