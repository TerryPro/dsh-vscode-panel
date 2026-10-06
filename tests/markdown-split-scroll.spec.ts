import { describe, expect, it } from 'vitest'
import { syncScrollProportionally } from '../src/client/markdown-split-scroll.ts'

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
