/**
 * The database filter above the SQL panel's notebook list.
 *
 * One box with two segments, split by a hairline: the left half picks which database the list is
 * filtered to, the right half creates a notebook on it. They belong in one control because they
 * are the same question asked twice — "which database am I working on" — and the create action is
 * only meaningful for the database the left half is showing.
 *
 * ## Why this is not a `<select>`
 *
 * The first version was a native `<select>`, and it never sat right. The reason is structural: a
 * `<select>`'s popup is drawn by the platform, outside the document, so it cannot take `--dsw-*`
 * tokens at all — it inherits the operating system's palette, row height and focus ring. No amount
 * of styling the closed control fixes what opens out of it. It is also the only one in this
 * repository: every other dropdown here is `Menu` (the tab menu, the CSV grid's, the schema tree's
 * right-click menu), which draws *inside* the document and therefore themes like everything else.
 *
 * ## The two halves
 *
 * The left half is a `Menu` trigger — the same primitive as every other dropdown here, so it
 * brings its own keyboard walk, selected-row marking and focus return. The right half is a plain
 * button, disabled until a real database is chosen, because "all databases" and "no database
 * recorded" are not places a file can be created.
 *
 * "All databases" and "no database recorded" are rows of the same menu rather than a separate
 * control: they are values of the one choice, and splitting them across two widgets is how a
 * reader ends up with a dropdown saying one thing and a chip saying another.
 */

import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Menu, PathLabel, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconChevronDownOutlineRegular, IconPlusOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconSqlNotebookOutline16 } from '../files/CreateEntryIcons.tsx'
import { SQL_FILTER_ALL, SQL_FILTER_UNASSOCIATED } from './sql-workspace-cache.ts'
import css from './sql-panel.module.css'

export interface SqlDatabaseFilterLabels {
  /** Names the picker for screen readers; also its tooltip. */
  filter: string
  all: string
  unassociated: string
  /** Heading above the database rows, so the two fixed rows read as a different class. */
  databases: string
  /**
   * The create segment's visible text.
   *
   * Short ("New") because it shares a 28px row with the picker, while `createTitle` carries the
   * full sentence for the tooltip and the accessible name — a segment labelled only "New" would
   * not say what is being created.
   */
  create: string
  createTitle: string
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
  const readout: ReactNode = value === SQL_FILTER_ALL
    ? <span className={css.filterTriggerText}>{labels.all}</span>
    : value === SQL_FILTER_UNASSOCIATED
      ? <span className={css.filterTriggerText}>{labels.unassociated}</span>
      // A real database: the same rendering the menu rows use, so the closed control and the row
      // that set it look like the same value rather than two descriptions of it.
      : <PathLabel path={value} className={css.filterTriggerPath} />

  return (
    <div className={css.databaseFilter} data-disabled={disabled || undefined}>
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
            type="button"
            className={css.filterPicker}
            disabled={disabled}
            aria-label={labels.filter}
            aria-haspopup="menu"
            aria-expanded={open}
            title={labels.filter}
            onClick={() => { setOpen(previous => !previous) }}
          >
            {/* The database cylinder, in the brand colour — the same mark the file tree uses for
                a `.sqlnb`, so the control says what it is about before the text does. It stays
                put when the value changes: it labels the control, not the choice. */}
            <IconSqlNotebookOutline16 size={15} className={css.filterMark} />
            {readout}
            <IconChevronDownOutlineRegular size={12} className={css.filterChevron} />
          </button>
        )}
      />
      <button
        type="button"
        className={css.filterCreate}
        disabled={!canCreate}
        aria-label={labels.createTitle}
        title={labels.createTitle}
        onClick={onCreate}
      >
        {/* A bare plus rather than the cylinder-with-plus: the cylinder is already the left half's
            mark, and repeating it here would read as a second, identical control. */}
        <IconPlusOutlineMedium size={14} className={css.filterCreateGlyph} />
        <span className={css.filterCreateText}>{labels.create}</span>
      </button>
    </div>
  )
}
