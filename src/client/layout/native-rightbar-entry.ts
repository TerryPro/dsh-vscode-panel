/** 把官方「展开右侧栏」按钮变成收回原生右栏的入口：中栏占着席位时先让位。 */

/** Stable official marker on the conversation header's expand control (`ExpandButton`). */
export const NATIVE_RIGHTBAR_EXPAND_SELECTOR = 'button[data-sidebar-right-expand]'

export interface NativeRightbarEntryController {
  store: { getSnapshot(): { editorExpanded: boolean } }
  /** Collapse the middle editor, which releases `rightbar.session` to DSH's own seat. */
  toggleEditor(): void
}

export interface NativeRightbarEntryLogger {
  info(message: string): void
}

/**
 * DSH puts one button in the conversation header as the way into its right
 * Sidebar, and that button is *always* there while the workbench holds the
 * right-column seat: the native seat is the only thing that opens a Session
 * surface, so with it shadowed the button's own test (`layout.expanded`) can only
 * ever read false. The reader therefore sees a live-looking control that paints
 * nothing — the store flips, but no occupant draws the panel.
 *
 * Capturing that press and folding the middle editor first is what turns the dead
 * control into the entry: releasing the seat lets DSH's `RightbarSeat` mount
 * against the store state its own handler is about to write, so the panel appears
 * on the click that used to do nothing.
 *
 * The listener is capture-phase and never cancels the event, because the official
 * `onClick` is the part that actually expands the panel; this only runs the yield
 * ahead of it. While the editor is already collapsed the seat is not held, so the
 * button is DSH's alone and this stands down.
 */
export function installNativeRightbarEntry(
  controller: NativeRightbarEntryController,
  logger: NativeRightbarEntryLogger,
  documentObject: Pick<Document, 'addEventListener' | 'removeEventListener'> = document,
): () => void {
  const onClick = (event: MouseEvent): void => {
    if (event.button !== 0) return
    if (!(event.target instanceof Element)) return
    if (event.target.closest(NATIVE_RIGHTBAR_EXPAND_SELECTOR) === null) return
    if (!controller.store.getSnapshot().editorExpanded) return
    controller.toggleEditor()
    logger.info('workbench-layout: folded the middle editor to hand the native right Sidebar its expand button')
  }

  documentObject.addEventListener('click', onClick, true)
  return () => { documentObject.removeEventListener('click', onClick, true) }
}
