// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MermaidSplitDivider } from '../src/client/mermaid/MermaidSplitDivider.tsx'

afterEach(() => { cleanup() })

function separator(view: ReturnType<typeof render>): HTMLElement {
  return view.getByRole('separator')
}

describe('MermaidSplitDivider', () => {
  it('exposes the current ratio and clamp bounds through ARIA', () => {
    const view = render(<MermaidSplitDivider ratio={0.5} onRatio={vi.fn()} label="RESIZE" />)
    const handle = separator(view)
    expect(handle.getAttribute('aria-valuenow')).toBe('50')
    expect(handle.getAttribute('aria-valuemin')).toBe('20')
    expect(handle.getAttribute('aria-valuemax')).toBe('80')
  })

  it('nudges the ratio with arrow keys and reports the clamped value', () => {
    const onRatio = vi.fn()
    const view = render(<MermaidSplitDivider ratio={0.5} onRatio={onRatio} label="RESIZE" />)
    fireEvent.keyDown(separator(view), { key: 'ArrowRight' })
    expect(onRatio.mock.calls.at(-1)?.[0]).toBeCloseTo(0.55)
    fireEvent.keyDown(separator(view), { key: 'ArrowLeft', shiftKey: true })
    expect(onRatio.mock.calls.at(-1)?.[0]).toBeCloseTo(0.4)
    fireEvent.keyDown(separator(view), { key: 'Home' })
    expect(onRatio).toHaveBeenLastCalledWith(0.5)
  })

  it('clamps a keyboard nudge to the injected band', () => {
    const onRatio = vi.fn()
    const clamp = (value: number): number => Math.min(0.7, Math.max(0.3, value))
    const view = render(<MermaidSplitDivider ratio={0.7} onRatio={onRatio} label="RESIZE" clamp={clamp} />)
    fireEvent.keyDown(separator(view), { key: 'ArrowRight' })
    expect(onRatio).toHaveBeenLastCalledWith(0.7)
    expect(separator(view).getAttribute('aria-valuemax')).toBe('70')
  })

  it('ignores keys that are not resize arrows', () => {
    const onRatio = vi.fn()
    const view = render(<MermaidSplitDivider ratio={0.5} onRatio={onRatio} label="RESIZE" />)
    fireEvent.keyDown(separator(view), { key: 'Enter' })
    expect(onRatio).not.toHaveBeenCalled()
  })
})
