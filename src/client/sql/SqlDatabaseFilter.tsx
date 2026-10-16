/**
 * The database filter above the SQL panel's notebook list.
 *
 * ## Why this is not a `<select>`
 *
 * The first version was a native `<select>`, and it never sat right in the list. The reason is
 * structural: a `<select>`'s popup is drawn by the platform, outside the document, so it cannot
 * take `--dsw-*` tokens at all — it inherits the operating system's palette, its own row height
 * and its own focus ring. No amount of styling the closed control fixes what opens out of it. It
 * is also the only one in this repository: every other dropdown here is `Menu` (the tab menu, the
 * CSV grid's, the schema tree's right-click menu), which draws *inside* the document and therefore
 * themes like everything else.
 *
 * ## Shape
 *
 * A quiet trigger row, not a form field: the panel already has a header, and a bordered control
 * underneath it reads as a second, competing header. So the trigger paints no box of its own — it
 * is a full-width button that tints on hover, exactly like `DisclosureRow`'s title, and states the
 * current filter with `PathLabel` (subdued directories, primary filename, tail preserved on
 * overflow). The list it opens is the same `Menu` the rest of the panel uses.
 *
 * "All databases" and "No database recorded" are rows of that menu rather than a separate control:
 * they are values of the same choice, and splitting them across two widgets is how a reader ends up
 * with a dropdown showing one thing and a chip showing another.
 */

import { useMemo, useRef, useState } from 'react'
import { Menu, PathLabel, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconSqlNotebookAddOutline16 } from '../files/CreateEntryIcons.tsx'
import { SQL_FILTER_ALL, SQL_FILTER_UNASSOCIATED } from './sql-workspace-cache.ts'
import css from './sql-panel.module.css'

export interface SqlDatabaseFilterLabels {
  /** Names the control for screen readers; also the trigger's tooltip. */
  filter: string
  all: string
  unassociated: string
  /** Heading above the database rows, so the two fixed rows read as a different class. */
  databases: string
  /** Names the create action; also its tooltip. */
  create: string
}

interface SqlDatabaseFilterProps {
  value: string
  /** The databases the walk found, already reduced to what the menu should offer. */
  databases: ReadonlyArray<{ path: string, name: string }>
  disabled: boolean
  /** Whether creating on the current pick is possible (a real database is selected). */
  canCreate: boolean
  onChange: (value: string) => void
  onCreate: () => void
  labels: SqlDatabaseFilterLabels
}

export function SqlDatabaseFilter({
  value,
  databases,
  disabled,
  canCreate,
  onChange,
  onCreate,
  labels,
}: SqlDatabaseFilterProps) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)

  const items = useMemo<MenuEntry[]>(() => {
    const rows: MenuEntry[] = [
      { id: SQL_FILTER_ALL, label: labels.all },
      { id: SQL_FILTER_UNASSOCIATED, label: labels.unassociated },
    ]
    if (databases.length > 0) {
      // A heading rather than a separator: the reader needs to know the rows below are files, and
      // a bare hairline between "no database recorded" and a path does not say that.
      rows.push({ type: 'label', id: 'sql-filter-databases', text: labels.databases })
      for (const database of databases) {
        rows.push({ id: database.path, label: <PathLabel path={database.path} /> })
      }
    }
    return rows
  }, [databases, labels.all, labels.databases, labels.unassociated])

  /** What the trigger says: the current pick, in the same voice as the rows that offered it. */
  const readout = value === SQL_FILTER_ALL
    ? labels.all
    : value === SQL_FILTER_UNASSOCIATED
      ? labels.unassociated
      : null

  return (
    <div className={css.databaseFilter}>
      <Menu
        open={open}
        onClose={() => { setOpen(false) }}
        items={items}
        selectedId={value}
        align="start"
        portal
        onSelect={(id) => {
          setOpen(false)
          onChange(id)
        }}
        anchor={(
          <button
            ref={trigger}
            type="button"
            className={css.filterTrigger}
            disabled={disabled}
            aria-label={labels.filter}
            aria-haspopup="menu"
            aria-expanded={open}
            title={labels.filter}
            onClick={() => { setOpen(previous => !previous) }}
          >
            {readout === null
              // A real database: the same rendering the menu rows use, so the closed control and
              // the row that set it look like the same value rather than two descriptions of it.
              ? <PathLabel path={value} className={css.filterTriggerPath} />
              : <span className={css.filterTriggerText}>{readout}</span>}
            <IconChevronDownOutlineRegular size={12} className={css.filterChevron} />
          </button>
        )}
      />
      <button
        type="button"
        className={css.filterCreate}
        disabled={!canCreate}
        aria-label={labels.create}
        title={labels.create}
        onClick={onCreate}
      >
        {/* The file tree's own "new SQL notebook" glyph: this control is about notebooks
            specifically, and a bare plus would only say "add something". */}
        <IconSqlNotebookAddOutline16 size={14} />
      </button>
    </div>
  )
}
