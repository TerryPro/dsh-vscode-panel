/**
 * Build the trailing badge row that sits to the right of the column name.
 *
 * The badges are short Chinese labels in a tinted pill: 主键 / 非空 / 唯一 / 外键 / 自增. A
 * column can carry any subset; an absent fact is an absent pill, not a dimmed one — saying
 * "we don't know" with a half-opacity label is the same as saying it, and the panel does not
 * know until the host tells it.
 *
 * The order is fixed (PK, NotNull, Unique, FK, AutoIncrement) so two columns with the same
 * facts line up to the same column of pills and a reader can scan the list top-to-bottom.
 * The icons-only version this replaces used to lead with PK; a reader who learned the old
 * shape should see the labels in the same order.
 */
import type { ReactNode } from 'react'
import type { SqlColumnEntry } from '../../shared/sql-protocol.ts'
import css from './sql-panel.module.css'

export interface SqlColumnBadgeLabels {
  primaryKey: string
  notNull: string
  unique: string
  foreignKey: string
  autoIncrement: string
}

export function columnBadges(column: SqlColumnEntry, labels: SqlColumnBadgeLabels): ReactNode {
  const nodes: ReactNode[] = []
  if (column.primaryKey) {
    nodes.push(
      <span key="pk" className={css.columnBadgePk} title={labels.primaryKey}>{labels.primaryKey}</span>,
    )
  }
  if (column.notNull) {
    // The "NotNull" pill mirrors the table's NOT NULL constraint; a reader sees the same
    // meaning whether the column is a PK or not, and we keep the pill in both cases.
    // Removing the pill on PK would hide a real constraint from readers who do not
    // remember that PK implies not-null.
    nodes.push(
      <span key="nn" className={css.columnBadgeNotNull} title={labels.notNull}>{labels.notNull}</span>,
    )
  }
  if (column.unique === true) {
    nodes.push(
      <span key="uq" className={css.columnBadgeUnique} title={labels.unique}>{labels.unique}</span>,
    )
  }
  if (column.foreignKey !== undefined) {
    nodes.push(
      <span key="fk" className={css.columnBadgeForeignKey} title={foreignKeyBadgeTooltip(column.foreignKey, labels.foreignKey)}>
        {labels.foreignKey}
      </span>,
    )
  }
  if (column.autoIncrement === true) {
    nodes.push(
      <span key="ai" className={css.columnBadgeAutoIncrement} title={labels.autoIncrement}>{labels.autoIncrement}</span>,
    )
  }
  return <>{nodes}</>
}

/**
 * Tooltip for the FK pill. Built from the same parts the protocol carries; the bare table
 * name when the column is unknown is honest — the host did not give us a column to point at,
 * so we say so, and a reader who needs the precise target can run `PRAGMA foreign_key_list`.
 */
function foreignKeyBadgeTooltip(fk: NonNullable<SqlColumnEntry['foreignKey']>, label: string): string {
  return fk.column === undefined ? `${label} → ${fk.table}` : `${label} → ${fk.table}.${fk.column}`
}
