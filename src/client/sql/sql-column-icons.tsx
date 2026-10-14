/**
 * Build the column-icon row that sits in front of the column name.
 *
 * The set of glyphs is fixed: a primary key, a unique-index mark, a foreign-key chain, in that
 * order. A column can carry any subset of the three; an absent fact is an absent glyph, not a
 * dimmed one — saying "we don't know" with a half-opacity icon is the same as saying it, and
 * the panel does not know until the host tells it.
 *
 * The icon size is the column row's own row-height minus a hair, so the four icons and the
 * column text sit on the same baseline. A 14px glyph in a 22px row is the proportion the rest
 * of the tree uses for its table / view cylinder, so the column line does not look like a
 * different drawing.
 */
import type { ReactNode } from 'react'
import type { SqlColumnEntry } from '../../shared/sql-protocol.ts'
import { IconForeignKey16, IconPrimaryKey16, IconUnique16 } from './SqlIcon.tsx'

export function columnLeadingIcons(column: SqlColumnEntry): ReactNode {
  const nodes: ReactNode[] = []
  if (column.primaryKey) {
    nodes.push(
      <span key="pk" className="sqlColumnIcon sqlColumnIconPk" title={PK_TOOLTIP}>
        <IconPrimaryKey16 size={12} />
      </span>,
    )
  }
  if (column.unique === true) {
    nodes.push(
      <span key="uq" className="sqlColumnIcon sqlColumnIconUq" title={UNIQUE_TOOLTIP}>
        <IconUnique16 size={12} />
      </span>,
    )
  }
  if (column.foreignKey !== undefined) {
    nodes.push(
      <span key="fk" className="sqlColumnIcon sqlColumnIconFk" title={foreignKeyTooltip(column.foreignKey)}>
        <IconForeignKey16 size={12} />
      </span>,
    )
  }
  return <>{nodes}</>
}

/**
 * Tooltip text for the foreign-key icon, built from the parts the protocol carries.
 *
 * The destination is a `table` (required) and an optional `column`. Showing the bare table
 * name when the column is unknown is honest — the host did not give us a column to point at,
 * so we say so, and a reader who needs the precise target can run `PRAGMA foreign_key_list`.
 */
function foreignKeyTooltip(fk: NonNullable<SqlColumnEntry['foreignKey']>): string {
  return fk.column === undefined ? `→ ${fk.table}` : `→ ${fk.table}.${fk.column}`
}

// Tooltips are kept as constants rather than going through the locale dictionary because the
// column row is a pure sub-component without the panel's `t` prop, and the glyph's meaning is
// a property of the column, not a translatable verb.
const PK_TOOLTIP = 'Primary key'
const UNIQUE_TOOLTIP = 'Unique'
