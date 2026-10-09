// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createPanelBackSeatLayout,
} from '../src/client/layout/panel-back-seat-layout.ts'
import { PANEL_BACK_SEAT_ATTRIBUTE } from '../src/client/layout/editor-layout-contract.ts'

/** The official page root plus its list-view action row, as the shell renders them. */
function pluginPanelFixture(): { toolbar: HTMLElement } {
  const page = document.createElement('div')
  page.setAttribute('data-plugin-panel', 'true')
  const head = document.createElement('header')
  head.setAttribute('data-window-drag', 'true')
  const toolbar = document.createElement('div')
  toolbar.className = 'fO69Vq_toolbar'
  const refresh = document.createElement('button')
  toolbar.append(refresh)
  head.appendChild(toolbar)
  page.appendChild(head)
  document.body.appendChild(page)
  return { toolbar }
}

function seat(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[${PANEL_BACK_SEAT_ATTRIBUTE}]`)
}

describe('插件页返回席位', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it('把席位插到页面自身动作之前，并标记为拖拽区反例', () => {
    const { toolbar } = pluginPanelFixture()
    const onSeat = vi.fn()
    const layout = createPanelBackSeatLayout(onSeat, { info: vi.fn() })

    const created = seat()
    expect(created).not.toBeNull()
    expect(created?.parentElement).toBe(toolbar)
    expect(toolbar.firstElementChild).toBe(created)
    // The row is a window-drag band, so the seat must carry the shell's recall marker.
    expect(created?.hasAttribute('data-window-drag-recall')).toBe(true)
    expect(onSeat).toHaveBeenCalledWith(created)

    layout.dispose()
    expect(seat()).toBeNull()
    expect(onSeat).toHaveBeenLastCalledWith(null)
  })

  it('页面切换视图导致头部重建后重新挂载席位', async () => {
    const first = pluginPanelFixture()
    const onSeat = vi.fn()
    const layout = createPanelBackSeatLayout(onSeat, { info: vi.fn() })
    const original = seat()
    expect(original).not.toBeNull()

    // The Plugins page swaps its whole header between list and detail views.
    first.toolbar.parentElement?.remove()
    first.toolbar.remove()
    await Promise.resolve()
    const second = pluginPanelFixture()
    await Promise.resolve()
    // MutationObserver is asynchronous; flush it through a real task boundary.
    await new Promise(resolve => { setTimeout(resolve, 0) })

    const remounted = seat()
    expect(remounted).not.toBeNull()
    expect(remounted).not.toBe(original)
    expect(remounted?.parentElement).toBe(second.toolbar)
    layout.dispose()
  })

  it('没有插件页时不创建席位', () => {
    const onSeat = vi.fn()
    const layout = createPanelBackSeatLayout(onSeat, { info: vi.fn() })
    expect(seat()).toBeNull()
    expect(onSeat).not.toHaveBeenCalled()
    layout.dispose()
  })
})
