/**
 * Right-click context menu for the editable CSV grid, built on DSH's native Menu
 * so it matches the file tree's menus. The offered actions depend on whether the
 * pointer landed on a data cell, a column header, or a row-number gutter.
 */

import { IconEditOutlineMedium, IconTrashOutlineMedium, Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactNode } from 'react'
import {
  IconClear16,
  IconInsertColumnLeft16,
  IconInsertColumnRight16,
  IconInsertRowAbove16,
  IconInsertRowBelow16,
  IconRedo16,
  IconUndo16,
} from './CsvIcons.tsx'

export type CsvMenuAction =
  | 'edit'
  | 'rename'
  | 'insert-row-above'
  | 'insert-row-below'
  | 'delete-row'
  | 'insert-col-left'
  | 'insert-col-right'
  | 'delete-col'
  | 'clear'
  | 'undo'
  | 'redo'

/** Where the context menu was opened and which cell/column it targets. */
export interface CsvMenuTarget {
  readonly kind: 'cell' | 'header' | 'row'
  readonly row: number
  readonly col: number
  readonly rect: DOMRect
}

/** The subset of table copy the menu needs, resolved by the caller from the locale. */
export interface CsvMenuLabels {
  editCell: string
  renameColumn: string
  insertRowAbove: string
  insertRowBelow: string
  deleteRow: string
  insertColumnLeft: string
  insertColumnRight: string
  deleteColumn: string
  clearContents: string
  undo: string
  redo: string
}

interface CsvContextMenuProps {
  target: CsvMenuTarget | null
  labels: CsvMenuLabels
  canUndo: boolean
  canRedo: boolean
  singleColumn: boolean
  onClose: () => void
  onSelect: (action: CsvMenuAction) => void
}

const icon = (node: ReactNode): ReactNode => node

export function CsvContextMenu({ target, labels, canUndo, canRedo, singleColumn, onClose, onSelect }: CsvContextMenuProps) {
  return (
    <Menu
      open={target !== null}
      onClose={onClose}
      items={target === null ? [] : menuItems(target.kind, labels, canUndo, canRedo, singleColumn)}
      onSelect={(id) => {
        onClose()
        if (isCsvMenuAction(id)) onSelect(id)
      }}
      getAnchorRect={() => target?.rect ?? null}
      dense
      compact
      portal
      anchor={<span aria-hidden="true" />}
    />
  )
}

function menuItems(
  kind: CsvMenuTarget['kind'],
  labels: CsvMenuLabels,
  canUndo: boolean,
  canRedo: boolean,
  singleColumn: boolean,
): MenuEntry[] {
  const history: MenuEntry[] = [
    { type: 'separator', id: 'csv-history-sep' },
    { id: 'clear', label: labels.clearContents, icon: icon(<IconClear16 size={14} />) },
    { id: 'undo', label: labels.undo, icon: icon(<IconUndo16 size={14} />), disabled: !canUndo },
    { id: 'redo', label: labels.redo, icon: icon(<IconRedo16 size={14} />), disabled: !canRedo },
  ]
  const rowOps: MenuEntry[] = [
    { id: 'insert-row-above', label: labels.insertRowAbove, icon: icon(<IconInsertRowAbove16 size={14} />) },
    { id: 'insert-row-below', label: labels.insertRowBelow, icon: icon(<IconInsertRowBelow16 size={14} />) },
    { id: 'delete-row', label: labels.deleteRow, icon: icon(<IconTrashOutlineMedium size={14} />), danger: true },
  ]
  const columnOps: MenuEntry[] = [
    { id: 'insert-col-left', label: labels.insertColumnLeft, icon: icon(<IconInsertColumnLeft16 size={14} />) },
    { id: 'insert-col-right', label: labels.insertColumnRight, icon: icon(<IconInsertColumnRight16 size={14} />) },
    { id: 'delete-col', label: labels.deleteColumn, icon: icon(<IconTrashOutlineMedium size={14} />), danger: true, disabled: singleColumn },
  ]

  if (kind === 'header') {
    return [
      { id: 'rename', label: labels.renameColumn, icon: icon(<IconEditOutlineMedium size={14} />) },
      { type: 'separator', id: 'csv-column-sep' },
      ...columnOps,
      ...history,
    ]
  }
  if (kind === 'row') {
    return [...rowOps, ...history]
  }
  return [
    { id: 'edit', label: labels.editCell, icon: icon(<IconEditOutlineMedium size={14} />) },
    { type: 'separator', id: 'csv-row-sep' },
    ...rowOps,
    { type: 'separator', id: 'csv-column-sep' },
    ...columnOps,
    ...history,
  ]
}

const CSV_MENU_ACTIONS: readonly CsvMenuAction[] = [
  'edit', 'rename', 'insert-row-above', 'insert-row-below', 'delete-row',
  'insert-col-left', 'insert-col-right', 'delete-col', 'clear', 'undo', 'redo',
]

function isCsvMenuAction(id: string): id is CsvMenuAction {
  return (CSV_MENU_ACTIONS as readonly string[]).includes(id)
}
