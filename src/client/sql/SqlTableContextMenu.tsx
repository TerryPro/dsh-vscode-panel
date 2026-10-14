/**
 * Right-click menu for a table or view row in the SQL sidebar's schema tree.
 *
 * The double-click that inserts a `SELECT *` stayed (ADR 0008's surface split), but a gesture
 * nobody can see is a gesture nobody uses, and the row already says so in its own tooltip. The
 * menu is the discoverable half: the same insert as a named row, plus the three reads the panel
 * can offer without owning anything — the name as text, the name quoted for typing into a
 * statement, and the column names the reader is about to hand-write into a `SELECT`.
 *
 * Shaped like `CsvContextMenu` on purpose: the same `Menu` primitive, the same anchored-rect
 * portal, so a menu opened from the sidebar is not a different animal from one opened from a
 * grid or a tab.
 */

import { Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'

export type SqlTableMenuAction = 'insert-select' | 'insert-name' | 'copy-name' | 'copy-columns'

/** Where the menu was opened: the row it targets and the rect anchoring it. */
export interface SqlTableMenuTarget {
  table: string
  rect: DOMRect
}

interface SqlTableContextMenuProps {
  target: SqlTableMenuTarget | null
  /** Resolved from the locale by the panel; the menu never reaches for the dictionary itself. */
  labels: {
    insertSelect: string
    insertTableName: string
    copyTableName: string
    copyColumnNames: string
  }
  /**
   * Whether the copy-columns row can answer right now.
   *
   * A row whose columns were read and came back empty has nothing to copy, and offering it would
   * be a click that silently does nothing. An unread table is *not* disabled: the panel loads on
   * the spot, because "I have not looked yet" is not the reader's problem.
   */
  columnsKnownEmpty: boolean
  onClose: () => void
  onSelect: (action: SqlTableMenuAction, table: string) => void
}

export function SqlTableContextMenu({ target, labels, columnsKnownEmpty, onClose, onSelect }: SqlTableContextMenuProps) {
  return (
    <Menu
      open={target !== null}
      onClose={onClose}
      items={target === null ? [] : menuItems(labels, columnsKnownEmpty)}
      onSelect={(id) => {
        onClose()
        if (target !== null && isSqlTableMenuAction(id)) onSelect(id, target.table)
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
  labels: SqlTableContextMenuProps['labels'],
  columnsKnownEmpty: boolean,
): MenuEntry[] {
  return [
    { id: 'insert-select', label: labels.insertSelect },
    { id: 'insert-name', label: labels.insertTableName },
    { type: 'separator', id: 'sql-table-copy-separator' },
    { id: 'copy-name', label: labels.copyTableName },
    { id: 'copy-columns', label: labels.copyColumnNames, disabled: columnsKnownEmpty },
  ]
}

const SQL_TABLE_MENU_ACTIONS: readonly SqlTableMenuAction[] = [
  'insert-select', 'insert-name', 'copy-name', 'copy-columns',
]

function isSqlTableMenuAction(id: string): id is SqlTableMenuAction {
  return (SQL_TABLE_MENU_ACTIONS as readonly string[]).includes(id)
}
