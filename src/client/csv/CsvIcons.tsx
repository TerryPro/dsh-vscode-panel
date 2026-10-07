/** Excel-flavoured 16px line icons for the CSV grid's structural edits. */

import type { ReactNode } from 'react'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'

function Svg({ size = 16, className, dataIcon, children }: IconProps & { dataIcon: string; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-icon={dataIcon}
    >
      {children}
    </svg>
  )
}

/** Rows as horizontal bars with an up arrow: insert a row above the selection. */
export function IconInsertRowAbove16(props: IconProps) {
  return (
    <Svg {...props} dataIcon="insert-row-above">
      <path d="M8 1.4v3.4M6.2 3.1 8 1.3l1.8 1.8" />
      <path d="M3 8h10M3 10.7h10M3 13.4h10" />
    </Svg>
  )
}

/** Rows with a down arrow beneath: insert a row below the selection. */
export function IconInsertRowBelow16(props: IconProps) {
  return (
    <Svg {...props} dataIcon="insert-row-below">
      <path d="M3 2.6h10M3 5.3h10M3 8h10" />
      <path d="M8 14.6v-3.4M6.2 12.9 8 14.7l1.8-1.8" />
    </Svg>
  )
}

/** Two solid rows with a dashed middle row: delete the selected row. */
export function IconDeleteRow16(props: IconProps) {
  return (
    <Svg {...props} dataIcon="delete-row">
      <path d="M3 3.5h10M3 12.5h10" />
      <rect x="2.5" y="6.5" width="11" height="3" rx="1" strokeDasharray="1.6 1.6" />
    </Svg>
  )
}

/** Columns as vertical bars with a left arrow: insert a column to the left. */
export function IconInsertColumnLeft16(props: IconProps) {
  return (
    <Svg {...props} dataIcon="insert-column-left">
      <path d="M1.4 8h3.4M3.1 6.2 1.3 8l1.8 1.8" />
      <path d="M8 3v10M10.7 3v10M13.4 3v10" />
    </Svg>
  )
}

/** Columns with a right arrow: insert a column to the right. */
export function IconInsertColumnRight16(props: IconProps) {
  return (
    <Svg {...props} dataIcon="insert-column-right">
      <path d="M2.6 3v10M5.3 3v10M8 3v10" />
      <path d="M14.6 8h-3.4M12.9 6.2 14.7 8l-1.8 1.8" />
    </Svg>
  )
}

/** Two solid columns with a dashed middle column: delete the selected column. */
export function IconDeleteColumn16(props: IconProps) {
  return (
    <Svg {...props} dataIcon="delete-column">
      <path d="M3.5 3v10M12.5 3v10" />
      <rect x="6.5" y="2.5" width="3" height="11" rx="1" strokeDasharray="1.6 1.6" />
    </Svg>
  )
}

/** A counter-clockwise arrow: undo the last change. */
export function IconUndo16(props: IconProps) {
  return (
    <Svg {...props} dataIcon="undo">
      <path d="M6 5.2h4.4a3.4 3.4 0 0 1 0 6.8H7" />
      <path d="M8.3 2.8 5.8 5.2l2.5 2.4" />
    </Svg>
  )
}

/** A clockwise arrow: redo the last undone change. */
export function IconRedo16(props: IconProps) {
  return (
    <Svg {...props} dataIcon="redo">
      <path d="M10 5.2H5.6a3.4 3.4 0 0 0 0 6.8H9" />
      <path d="M7.7 2.8l2.5 2.4-2.5 2.4" />
    </Svg>
  )
}

/** An eraser: clear the contents of the current selection. */
export function IconClear16(props: IconProps) {
  return (
    <Svg {...props} dataIcon="clear">
      <path d="M6.5 13.5H13.5" />
      <path d="M4.2 11.3 8.9 6.6a1.6 1.6 0 0 1 2.3 0l1.7 1.7a1.6 1.6 0 0 1 0 2.3l-3.4 3.4H6.2l-2-2a1.4 1.4 0 0 1 0-0.7Z" />
      <path d="M8.2 7.3 12 11.1" />
    </Svg>
  )
}

/**
 * A sort indicator: two stacked chevrons. Unsorted shows both faintly so the
 * affordance is always visible; ascending/descending highlights one direction.
 */
export function SortIndicator16({
  direction = 'none',
  size = 14,
  className,
}: IconProps & { direction?: 'none' | 'ascending' | 'descending' }) {
  const up = direction === 'ascending' ? 1 : direction === 'none' ? 0.5 : 0.22
  const down = direction === 'descending' ? 1 : direction === 'none' ? 0.5 : 0.22
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      data-icon="sort"
    >
      <path d="M8 2.4 11.2 6.4H4.8L8 2.4Z" opacity={up} />
      <path d="M8 13.6 4.8 9.6h6.4L8 13.6Z" opacity={down} />
    </svg>
  )
}
