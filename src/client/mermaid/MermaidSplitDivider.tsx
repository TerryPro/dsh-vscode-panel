/** A draggable vertical divider between the Mermaid source editor and its preview. */

import { useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { clampMermaidSplitRatio } from './mermaid-split.ts'
import css from './mermaid.module.css'

export interface MermaidSplitDividerProps {
  /** Current editor-pane width fraction (0–1); the drag starts from here. */
  ratio: number
  /** Reports a new fraction as the handle is dragged. */
  onRatio: (ratio: number) => void
  /** Accessible label describing the resize action. */
  label: string
}

/**
 * Resize handle that maps the pointer's horizontal movement to an editor/preview
 * width fraction. It reads the enclosing flex row's live width so the ratio stays
 * correct across window resizes, and clamps the result so neither pane collapses.
 */
export function MermaidSplitDivider({ ratio, onRatio, label }: MermaidSplitDividerProps) {
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
    onRatio(clampMermaidSplitRatio(drag.startRatio + (event.clientX - drag.startX) / drag.width))
  }

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (dragRef.current === null) return
    dragRef.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
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
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    />
  )
}
