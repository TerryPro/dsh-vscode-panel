// @vitest-environment jsdom

import { useRef } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SplitDivider } from '../src/client/editor/SplitDivider.tsx'
import type { EditorSplitOrientation } from '../src/client/model/controller.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete document.documentElement.dataset.dshSplitDragging
})

describe('分栏拖拽把手', () => {
  it('暴露 separator 语义并反映当前比例与方向', () => {
    const handle = renderDivider({ orientation: 'horizontal', ratio: 0.5 })
    expect(handle.getAttribute('role')).toBe('separator')
    expect(handle.getAttribute('aria-orientation')).toBe('vertical')
    expect(handle.getAttribute('aria-valuenow')).toBe('50')
    expect(handle.getAttribute('aria-label')).toBe('Resize split')
  })

  it('用方向键按步长调整比例，Shift 加速，并钳制在 [0.2, 0.8]', () => {
    const onCommit = vi.fn()
    const handle = renderDivider({ orientation: 'horizontal', ratio: 0.5, onCommit })

    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(onCommit).toHaveBeenLastCalledWith(expect.closeTo(0.52, 5))

    fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true })
    expect(onCommit).toHaveBeenLastCalledWith(expect.closeTo(0.6, 5))

    fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true })
    expect(onCommit).toHaveBeenLastCalledWith(expect.closeTo(0.4, 5))
  })

  it('忽略与分栏方向垂直的方向键', () => {
    const onCommit = vi.fn()
    const handle = renderDivider({ orientation: 'horizontal', ratio: 0.5, onCommit })
    fireEvent.keyDown(handle, { key: 'ArrowUp' })
    fireEvent.keyDown(handle, { key: 'ArrowDown' })
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('超出上限时把提交值钳制回边界', () => {
    const onCommit = vi.fn()
    const handle = renderDivider({ orientation: 'horizontal', ratio: 0.8, onCommit })
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(onCommit).toHaveBeenLastCalledWith(0.8)
  })

  it('双击复位到 0.5', () => {
    const onCommit = vi.fn()
    const handle = renderDivider({ orientation: 'horizontal', ratio: 0.7, onCommit })
    fireEvent.doubleClick(handle)
    expect(onCommit).toHaveBeenLastCalledWith(0.5)
  })

  it('拖拽时锁定 body、按指针位置提交比例，抬起后解锁', () => {
    syncFrames()
    const onCommit = vi.fn()
    const { handle, container } = renderDividerWithRefs({ orientation: 'horizontal', ratio: 0.5, onCommit })
    stubGeometry(container, handle)
    stubPointerCapture(handle)

    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 500 })
    expect(document.documentElement.dataset.dshSplitDragging).toBe('horizontal')

    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 600 })
    expect(onCommit).toHaveBeenLastCalledWith(600 / 992)

    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 600 })
    expect(document.documentElement.dataset.dshSplitDragging).toBeUndefined()
  })

  it('非主键按下不进入拖拽', () => {
    const onCommit = vi.fn()
    const { handle, container } = renderDividerWithRefs({ orientation: 'horizontal', ratio: 0.5, onCommit })
    stubGeometry(container, handle)
    stubPointerCapture(handle)

    fireEvent.pointerDown(handle, { button: 1, pointerId: 1 })
    expect(document.documentElement.dataset.dshSplitDragging).toBeUndefined()
  })

  it('窗口尺寸变化时按把手当前位置重新提交比例', () => {
    syncFrames()
    const onCommit = vi.fn()
    const { handle, container } = renderDividerWithRefs({ orientation: 'horizontal', ratio: 0.5, onCommit })
    stubGeometry(container, handle)

    fireEvent(window, new Event('resize'))
    expect(onCommit).toHaveBeenLastCalledWith(500 / 992)
  })
})

interface DividerOptions {
  orientation: EditorSplitOrientation
  ratio: number
  onCommit?: (ratio: number) => void
  label?: string
}

function Harness({ orientation, ratio, onCommit, label = 'Resize split' }: DividerOptions) {
  const containerRef = useRef<HTMLDivElement>(null)
  return (
    <div ref={containerRef} data-testid="container">
      <SplitDivider
        orientation={orientation}
        ratio={ratio}
        containerRef={containerRef}
        onCommit={onCommit ?? (() => {})}
        label={label}
      />
    </div>
  )
}

function renderDivider(options: DividerOptions): HTMLElement {
  const view = render(<Harness {...options} />)
  return view.getByRole('separator')
}

function renderDividerWithRefs(options: DividerOptions): { handle: HTMLElement; container: HTMLElement } {
  const view = render(<Harness {...options} />)
  return { handle: view.getByRole('separator'), container: view.getByTestId('container') }
}

function stubGeometry(container: HTMLElement, handle: HTMLElement): void {
  container.getBoundingClientRect = () => rect(0, 0, 1000, 400)
  handle.getBoundingClientRect = () => rect(500, 0, 8, 400)
  Object.defineProperty(handle, 'offsetWidth', { configurable: true, value: 8 })
  Object.defineProperty(handle, 'offsetHeight', { configurable: true, value: 400 })
}

function stubPointerCapture(handle: HTMLElement): void {
  let captured = false
  handle.setPointerCapture = () => { captured = true }
  handle.hasPointerCapture = () => captured
  handle.releasePointerCapture = () => { captured = false }
}

function syncFrames(): void {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
  vi.stubGlobal('cancelAnimationFrame', () => {})
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left, top, width, height,
    right: left + width, bottom: top + height,
    x: left, y: top,
    toJSON: () => ({}),
  } as DOMRect
}
