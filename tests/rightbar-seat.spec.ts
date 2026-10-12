import { describe, expect, it, vi } from 'vitest'
import { holdRightbarSeatWhileEditorVisible } from '../src/client/model/rightbar-seat.ts'

/**
 * Regression cover for the bug this module exists to fix: the workbench editor
 * registers into `rightbar.session` (a *single* slot, lowest priority wins), so as
 * long as that registration stood, DSH's native right Sidebar could never render
 * — no dock panel, no guide tabs, no divider, and no way to bring it back.
 *
 * The assertions land on the seat's real output face (register/dispose), not on an
 * internal flag, because "the native Sidebar is visible again" is exactly the
 * absence of this plugin's registration.
 */
describe('rightbar.session seat holding', () => {
  it('takes the seat only while the middle editor is on screen and gives it back when collapsed', () => {
    const dispose = vi.fn()
    const register = vi.fn(() => dispose)
    const host = shadowHost()
    const logger = { info: vi.fn() }

    const release = holdRightbarSeatWhileEditorVisible(host, { register }, logger)

    expect(register).toHaveBeenCalledOnce()
    expect(dispose).not.toHaveBeenCalled()

    host.collapse()
    expect(dispose).toHaveBeenCalledOnce()
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('released rightbar.session'))

    host.expand()
    expect(register).toHaveBeenCalledTimes(2)
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('took rightbar.session'))

    release()
    expect(dispose).toHaveBeenCalledTimes(2)
  })

  // The host seeds its first callback from the current editor state, so mounting
  // during an already-collapsed Session must not register at all — otherwise the
  // native Sidebar stays shadowed by an editor column nobody can even see.
  it('never takes the seat when the editor is already collapsed at mount', () => {
    const register = vi.fn(() => vi.fn())
    const host = shadowHost(false)

    holdRightbarSeatWhileEditorVisible(host, { register }, { info: vi.fn() })

    expect(register).not.toHaveBeenCalled()
  })

  // One registration per held period: a repeated "expanded" notification must not
  // stack duplicate shadowing entries into the single slot, where the second one
  // at the same priority would throw.
  it('ignores repeated expand notifications', () => {
    const register = vi.fn(() => vi.fn())
    const host = shadowHost()

    holdRightbarSeatWhileEditorVisible(host, { register }, { info: vi.fn() })
    host.expand()

    expect(register).toHaveBeenCalledOnce()
  })

  it('stops following the controller once released', () => {
    const register = vi.fn(() => vi.fn())
    const host = shadowHost()
    const release = holdRightbarSeatWhileEditorVisible(host, { register }, { info: vi.fn() })

    release()
    host.collapse()
    host.expand()

    expect(register).toHaveBeenCalledOnce()
  })
})

/**
 * @param expanded - the state the seat is mounted into; the real controller
 *   reports it immediately, so the holder must not assume "visible at mount".
 */
function shadowHost(expanded = true) {
  let setActive: ((active: boolean) => void) | undefined
  return {
    attachRightbarShadow(callback: (active: boolean) => void) {
      setActive = callback
      callback(expanded)
      return () => { setActive = undefined }
    },
    collapse(): void { setActive?.(false) },
    expand(): void { setActive?.(true) },
  }
}
