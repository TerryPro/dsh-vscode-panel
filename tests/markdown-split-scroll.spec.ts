// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachSplitScrollSync, syncScrollProportionally } from '../src/client/markdown/markdown-split-scroll.ts'

afterEach(() => { vi.unstubAllGlobals() })

describe('syncScrollProportionally', () => {
  it('mirrors the source scroll ratio onto the target', () => {
    const source = { scrollTop: 50, scrollHeight: 200, clientHeight: 100 }
    const target = { scrollTop: 0, scrollHeight: 300, clientHeight: 100 }
    syncScrollProportionally(source, target)
    expect(target.scrollTop).toBe(100)
  })

  it('clamps the ratio so the target never overshoots', () => {
    const source = { scrollTop: 500, scrollHeight: 200, clientHeight: 100 }
    const target = { scrollTop: 0, scrollHeight: 300, clientHeight: 100 }
    syncScrollProportionally(source, target)
    expect(target.scrollTop).toBe(200)
  })

  it('leaves the target untouched when either pane has no scroll range', () => {
    const source = { scrollTop: 20, scrollHeight: 100, clientHeight: 100 }
    const target = { scrollTop: 7, scrollHeight: 300, clientHeight: 100 }
    syncScrollProportionally(source, target)
    expect(target.scrollTop).toBe(7)
  })
})

describe('attachSplitScrollSync', () => {
  function scrollable(scrollHeight: number, clientHeight: number): HTMLDivElement {
    const element = document.createElement('div')
    Object.defineProperty(element, 'scrollHeight', { configurable: true, value: scrollHeight })
    Object.defineProperty(element, 'clientHeight', { configurable: true, value: clientHeight })
    element.scrollTop = 0
    document.body.append(element)
    return element
  }

  it('scrolling one pane drives the other and suppresses the echo until release', () => {
    const raf: { release?: () => void } = {}
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { raf.release = callback; return 1 })
    const a = scrollable(200, 100)
    const b = scrollable(300, 100)
    const detach = attachSplitScrollSync(a, b)

    a.scrollTop = 50
    a.dispatchEvent(new Event('scroll'))
    expect(b.scrollTop).toBe(100)

    // The echo from b is dropped while the one-frame lock is held.
    b.scrollTop = 0
    b.dispatchEvent(new Event('scroll'))
    expect(a.scrollTop).toBe(50)

    raf.release?.()
    b.scrollTop = 200
    b.dispatchEvent(new Event('scroll'))
    expect(a.scrollTop).toBe(100)

    detach()
    a.remove()
    b.remove()
  })

  it('stops syncing once unsubscribed', () => {
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { callback(); return 1 })
    const a = scrollable(200, 100)
    const b = scrollable(300, 100)
    const detach = attachSplitScrollSync(a, b)
    detach()

    a.scrollTop = 50
    a.dispatchEvent(new Event('scroll'))
    expect(b.scrollTop).toBe(0)
    a.remove()
    b.remove()
  })
})
