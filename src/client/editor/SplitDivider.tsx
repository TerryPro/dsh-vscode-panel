/** Draggable separator that resizes the two split editor panes. */

import { useEffect, useRef } from 'react'
import type { EditorSplitOrientation } from '../model/controller.ts'
import css from './editor.module.css'

interface SplitDividerProps {
  orientation: EditorSplitOrientation
  ratio: number
  containerRef: React.RefObject<HTMLDivElement>
  onCommit: (ratio: number) => void
  label: string
}

const SPLIT_RATIO_MIN = 0.2
const SPLIT_RATIO_MAX = 0.8

function clampSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5
  return Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, ratio))
}

export function SplitDivider({ orientation, ratio, containerRef, onCommit, label }: SplitDividerProps) {
  const handleRef = useRef<HTMLDivElement>(null)
  const frame = useRef<number | null>(null)
  const pending = useRef<number | null>(null)

  const commit = (next: number): void => {
    pending.current = clampSplitRatio(next)
    if (frame.current !== null) return
    const requestFrame = window.requestAnimationFrame?.bind(window) ?? ((callback: () => void) => setTimeout(callback, 16) as unknown as number)
    frame.current = requestFrame(() => {
      frame.current = null
      const value = pending.current
      if (value !== null) onCommit(value)
    })
  }

  const fit = (): void => {
    const container = containerRef.current
    const handle = handleRef.current
    if (container === null || handle === null) return
    const rect = container.getBoundingClientRect()
    if (orientation === 'horizontal') {
      const usable = Math.max(1, rect.width - handle.offsetWidth)
      commit((handle.getBoundingClientRect().left - rect.left) / usable)
    } else {
      const usable = Math.max(1, rect.height - handle.offsetHeight)
      commit((handle.getBoundingClientRect().top - rect.top) / usable)
    }
  }
  const fitRef = useRef(fit)
  fitRef.current = fit

  const lockBody = (): void => {
    document.documentElement.dataset.dshSplitDragging = orientation
  }
  const unlockBody = (): void => {
    delete document.documentElement.dataset.dshSplitDragging
  }

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    lockBody()
  }
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId) !== true) return
    const container = containerRef.current
    if (container === null) return
    event.preventDefault()
    const rect = container.getBoundingClientRect()
    const handle = event.currentTarget.getBoundingClientRect()
    const pointer = orientation === 'horizontal' ? event.clientX : event.clientY
    const start = orientation === 'horizontal' ? rect.left : rect.top
    const thickness = orientation === 'horizontal' ? handle.width : handle.height
    const usable = (orientation === 'horizontal' ? rect.width : rect.height) - thickness
    commit((pointer - start) / Math.max(1, usable))
  }
  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId) === true) {
      event.currentTarget.releasePointerCapture?.(event.pointerId)
    }
    unlockBody()
  }

  useEffect(() => {
    const handle = handleRef.current
    if (handle === null) return undefined
    const storeRatio = (): number => pending.current ?? clampSplitRatio(ratio)
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.target !== handle && !handle.contains(event.target as Node)) return
      const horizontalKeys = event.key === 'ArrowLeft' || event.key === 'ArrowRight'
      const verticalKeys = event.key === 'ArrowUp' || event.key === 'ArrowDown'
      if (orientation === 'horizontal' ? !horizontalKeys : !verticalKeys) return
      const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown'
      const delta = (event.shiftKey ? 0.1 : 0.02) * (forward ? 1 : -1)
      event.preventDefault()
      onCommit(clampSplitRatio(storeRatio() + delta))
    }
    window.addEventListener('keydown', onKeyDown)
    const onResize = (): void => { fitRef.current() }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onResize)
      delete document.documentElement.dataset.dshSplitDragging
      if (frame.current !== null) {
        if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(frame.current)
        else clearTimeout(frame.current as unknown as ReturnType<typeof setTimeout>)
        frame.current = null
      }
    }
  }, [containerRef, onCommit, ratio])

  return (
    <div
      ref={handleRef}
      className={css.editorSplitDivider}
      role="separator"
      tabIndex={0}
      aria-orientation={orientation === 'horizontal' ? 'vertical' : 'horizontal'}
      aria-label={label}
      title={label}
      aria-valuenow={Math.round(ratio * 100)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => { onCommit(0.5) }}
    />
  )
}
