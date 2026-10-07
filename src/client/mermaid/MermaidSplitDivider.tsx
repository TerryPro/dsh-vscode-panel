/** A draggable vertical divider between a source editor and its live preview pane. */

import { useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { clampMermaidSplitRatio } from './mermaid-split.ts'
import css from './mermaid.module.css'

export interface MermaidSplitDividerProps {
  /** Current editor-pane width fraction (0–1); the drag and keyboard start here. */
  ratio: number
  /** Reports a new fraction as the handle is dragged or nudged. */
  onRatio: (ratio: number) => void
  /** Accessible label describing the resize action. */
  label: string
  /** Clamps the fraction to this view's usable band; defaults to the Mermaid range. */
  clamp?: (value: number) => number
}

/** Fraction step applied per arrow key, larger with Shift held. */
const KEY_STEP = 0.05
const KEY_STEP_LARGE = 0.1

/**
 * Resize handle that maps the pointer's horizontal movement (or arrow keys) to an
 * editor/preview width fraction. It reads the enclosing flex row's live width so
 * the ratio stays correct across window resizes, and clamps via the injected
 * `clamp` so neither pane collapses and the caller owns the single clamp source.
 */
export function MermaidSplitDivider({ ratio, onRatio, label, clamp = clampMermaidSplitRatio }: MermaidSplitDividerProps) {
  const ref = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ startX: number; startRatio: number; width: number } | null>(null)

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    const container = ref.current?.parentElement
    if (container === null || container === undefined) return
    const width = container.getBoundingClientRect().width
    if (width <= 0) return
    dragRef.current = { startX: event.clientX, startRatio: ratio, width }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (drag === null) return
    onRatio(clamp(drag.startRatio + (event.clientX - drag.startX) / drag.width))
  }

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (dragRef.current === null) return
    dragRef.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const step = (event.shiftKey ? KEY_STEP_LARGE : KEY_STEP)
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault()
      onRatio(clamp(ratio - step))
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault()
      onRatio(clamp(ratio + step))
    } else if (event.key === 'Home') {
      event.preventDefault()
      onRatio(clamp(0.5))
    }
  }

  return (
    <div
      ref={ref}
      className={css.mermaidSplitDivider}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title={label}
      tabIndex={0}
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuemin={Math.round(clamp(0) * 100)}
      aria-valuemax={Math.round(clamp(1) * 100)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
    />
  )
}
