// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CsvTable, type CsvTableLabels } from '../src/client/csv/CsvTable.tsx'
import { parseCsv } from '../src/client/csv/csv-parse.ts'

// Replace DSH's native Menu with a plain list so context-menu items are assertable.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconEditOutlineMedium: () => null,
  IconTrashOutlineMedium: () => null,
  Menu: (props: { open?: boolean; items?: { id: string; label?: string; disabled?: boolean }[]; onSelect?: (id: string) => void }) =>
    props.open === true
      ? (
        <div role="menu">
          {(props.items ?? []).filter(item => item.label !== undefined).map(item => (
            <button key={item.id} role="menuitem" disabled={item.disabled} onClick={() => { props.onSelect?.(item.id) }}>{item.label}</button>
          ))}
        </div>
      )
      : null,
}))

const labels: CsvTableLabels = {
  empty: 'EMPTY',
  noMatches: 'NO_MATCHES',
  filter: 'FILTER',
  rowNumber: '#',
  sortNone: 'NONE',
  sortAscending: 'ASC',
  sortDescending: 'DESC',
  editHint: 'EDIT_HINT',
  editLocked: 'EDIT_LOCKED',
  renameHint: 'RENAME',
  editCell: 'EDIT_CELL',
  renameColumn: 'RENAME_COL',
  insertRowAbove: 'INSERT_ROW_ABOVE',
  insertRowBelow: 'INSERT_ROW_BELOW',
  insertColumnLeft: 'INSERT_COL_LEFT',
  insertColumnRight: 'INSERT_COL_RIGHT',
  summary: 'SUMMARY',
  addRow: 'ADD_ROW',
  deleteRow: 'DELETE_ROW',
  addColumn: 'ADD_COL',
  deleteColumn: 'DEL_COL',
  clearContents: 'CLEAR',
  undo: 'UNDO',
  redo: 'REDO',
  resize: 'RESIZE',
  truncated: count => `TRUNCATED ${count}`,
  rowCount: (shown, total) => `${shown}/${total}`,
  selectedCells: count => `SEL_${count}`,
}

function bodyRows(container: HTMLElement): HTMLTableRowElement[] {
  return Array.from(container.querySelectorAll('tbody tr'))
}

function firstColumn(container: HTMLElement): string[] {
  // The row-number gutter is a <th>; the first <td> is always the first data column.
  return bodyRows(container).map(row => row.querySelector('td')?.textContent ?? '')
}

/** Parse the last committed document back into comparable column/row strings. */
function lastCommit(onEdit: ReturnType<typeof vi.fn>): { columns: string[]; rows: string[] } {
  const text = onEdit.mock.calls.at(-1)?.[0] as string
  const doc = parseCsv(text)
  return { columns: doc.columns.map(c => c), rows: doc.rows.map(row => row.join('|')) }
}

afterEach(() => { cleanup() })

describe('CsvTable (read-only)', () => {
  it('renders a frozen gutter plus one header cell per column', () => {
    const { getAllByRole, getByRole } = render(<CsvTable source={'name,score\nAlice,30\nBob,5'} labels={labels} />)
    expect(getAllByRole('columnheader').map(th => th.textContent)).toEqual(['#', 'name', 'score'])
    expect(getByRole('table')).toBeTruthy()
  })

  it('numbers each data row starting at one', () => {
    const { container } = render(<CsvTable source={'name\nAlice\nBob\nCara'} labels={labels} />)
    expect(bodyRows(container).map(row => row.querySelector('th')?.textContent)).toEqual(['1', '2', '3'])
  })

  it('shows the empty state when nothing parses', () => {
    const { getByText, queryAllByRole } = render(<CsvTable source="" labels={labels} />)
    expect(getByText('EMPTY')).toBeTruthy()
    expect(queryAllByRole('columnheader')).toHaveLength(0)
  })

  it('filters rows and reports the live count', () => {
    const view = render(<CsvTable source={'name,score\nAlice,30\nBob,5\nCara,20'} labels={labels} />)
    expect(view.getByText('3/3')).toBeTruthy()
    fireEvent.change(view.getByRole('searchbox'), { target: { value: 'ar' } })
    expect(firstColumn(view.container)).toEqual(['Cara'])
    expect(view.getByText('1/3')).toBeTruthy()
  })

  it('shows the no-matches message when a filter excludes every row', () => {
    const view = render(<CsvTable source={'name\nAlice\nBob'} labels={labels} />)
    fireEvent.change(view.getByRole('searchbox'), { target: { value: 'zzz' } })
    expect(view.getByText('NO_MATCHES')).toBeTruthy()
  })

  it('sorts a numeric column ascending then descending as its header is clicked', () => {
    const view = render(<CsvTable source={'name,score\nAlice,30\nBob,5\nCara,20'} labels={labels} />)
    const scoreButton = view.getAllByRole('columnheader')[2]!.querySelector('button')!
    fireEvent.click(scoreButton)
    expect(firstColumn(view.container)).toEqual(['Bob', 'Cara', 'Alice'])
    fireEvent.click(view.getAllByRole('columnheader')[2]!.querySelector('button')!)
    expect(firstColumn(view.container)).toEqual(['Alice', 'Cara', 'Bob'])
  })

  it('stays read-only (no editor, no toolbar) without an onEdit handler', () => {
    const view = render(<CsvTable source={'name\nAlice'} labels={labels} />)
    expect(view.queryByRole('toolbar')).toBeNull()
    fireEvent.doubleClick(bodyRows(view.container)[0]!.querySelector('td')!)
    expect(view.queryByRole('textbox')).toBeNull()
  })
})

describe('CsvTable (editing)', () => {
  it('commits a re-serialized document when a cell is edited', () => {
    const onEdit = vi.fn()
    const view = render(<CsvTable source={'name,score\nAlice,30\nBob,5'} labels={labels} path="t.csv" onEdit={onEdit} />)
    const scoreCell = bodyRows(view.container)[0]!.querySelectorAll('td')[1]!
    expect(scoreCell.getAttribute('title')).toBe('EDIT_HINT')

    fireEvent.doubleClick(scoreCell)
    fireEvent.change(view.getByRole('textbox'), { target: { value: '99' } })
    fireEvent.keyDown(view.getByRole('textbox'), { key: 'Enter' })

    expect(lastCommit(onEdit)).toEqual({ columns: ['name', 'score'], rows: ['Alice|99', 'Bob|5'] })
  })

  it('seeds the cell editor with the cell\'s own current value, not a stale draft', () => {
    const onEdit = vi.fn()
    const view = render(<CsvTable source={'a,b\n11,22\n33,44'} labels={labels} path="t.csv" onEdit={onEdit} />)
    fireEvent.doubleClick(bodyRows(view.container)[0]!.querySelectorAll('td')[0]!)
    expect((view.getByRole('textbox') as HTMLInputElement).value).toBe('11')
    fireEvent.change(view.getByRole('textbox'), { target: { value: 'X' } })
    fireEvent.keyDown(view.getByRole('textbox'), { key: 'Enter' })

    view.rerender(<CsvTable source={'a,b\nX,22\n33,44'} labels={labels} path="t.csv" onEdit={onEdit} />)
    fireEvent.doubleClick(bodyRows(view.container)[1]!.querySelectorAll('td')[0]!)
    expect((view.getByRole('textbox') as HTMLInputElement).value).toBe('33')
  })

  it('cancels an edit on Escape without committing', () => {
    const onEdit = vi.fn()
    const view = render(<CsvTable source={'name\nAlice'} labels={labels} path="t.csv" onEdit={onEdit} />)
    fireEvent.doubleClick(bodyRows(view.container)[0]!.querySelector('td')!)
    fireEvent.change(view.getByRole('textbox'), { target: { value: 'zzz' } })
    fireEvent.keyDown(view.getByRole('textbox'), { key: 'Escape' })
    expect(onEdit).not.toHaveBeenCalled()
    expect(view.queryByRole('textbox')).toBeNull()
  })

  it('renames a column through its header label', () => {
    const onEdit = vi.fn()
    const view = render(<CsvTable source={'a,b\n1,2'} labels={labels} path="t.csv" onEdit={onEdit} />)
    const label = view.getAllByRole('columnheader')[1]!.querySelector('span')!
    fireEvent.doubleClick(label)
    const input = view.getByLabelText('RENAME')
    fireEvent.change(input, { target: { value: 'z' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(lastCommit(onEdit).columns).toEqual(['z', 'b'])
  })

  it('appends a row and a column from the toolbar', () => {
    const onEdit = vi.fn()
    const view = render(<CsvTable source={'a,b\n1,2'} labels={labels} path="t.csv" onEdit={onEdit} />)
    fireEvent.click(view.getByRole('button', { name: 'ADD_ROW' }))
    expect(lastCommit(onEdit).rows).toEqual(['1|2', '|'])

    fireEvent.click(view.getByRole('button', { name: 'ADD_COL' }))
    expect(lastCommit(onEdit).columns).toEqual(['a', 'b', ''])
  })

  it('deletes the selected row, then the selected column', () => {
    const onEdit = vi.fn()
    const view = render(<CsvTable source={'a,b\n1,2\n3,4'} labels={labels} path="t.csv" onEdit={onEdit} />)
    fireEvent.mouseDown(bodyRows(view.container)[0]!.querySelector('td')!) // anchor a[0,0]
    fireEvent.click(view.getByRole('button', { name: 'DELETE_ROW' }))
    expect(lastCommit(onEdit).rows).toEqual(['3|4'])

    // Deleting clears the selection; re-anchor on the first cell before removing a column.
    fireEvent.mouseDown(bodyRows(view.container)[0]!.querySelector('td')!)
    fireEvent.click(view.getByRole('button', { name: 'DEL_COL' }))
    expect(lastCommit(onEdit).columns).toEqual(['b'])
  })

  it('selects a whole column when its header is clicked, then deletes it', () => {
    const onEdit = vi.fn()
    const view = render(<CsvTable source={'a,b\n1,2\n3,4'} labels={labels} path="t.csv" onEdit={onEdit} />)
    fireEvent.click(view.getAllByRole('columnheader')[2]!) // column 'b'
    fireEvent.click(view.getByRole('button', { name: 'DEL_COL' }))
    expect(lastCommit(onEdit).columns).toEqual(['a'])
    expect(lastCommit(onEdit).rows).toEqual(['1', '3'])
  })

  it('selects a whole row from the gutter and clears its contents', () => {
    const onEdit = vi.fn()
    const view = render(<CsvTable source={'a,b\n1,2\n3,4'} labels={labels} path="t.csv" onEdit={onEdit} />)
    fireEvent.click(bodyRows(view.container)[0]!.querySelector('th')!) // row gutter of row 1
    fireEvent.click(view.getByRole('button', { name: 'CLEAR' }))
    expect(lastCommit(onEdit).rows).toEqual(['|', '3|4'])
  })

  it('selects all cells with Ctrl+A and clears the whole body', () => {
    const onEdit = vi.fn()
    const view = render(<CsvTable source={'a,b\n1,2\n3,4'} labels={labels} path="t.csv" onEdit={onEdit} />)
    fireEvent.keyDown(view.getByLabelText('EDIT_HINT') ?? view.container, { key: 'a', ctrlKey: true })
    fireEvent.click(view.getByRole('button', { name: 'CLEAR' }))
    expect(lastCommit(onEdit).rows).toEqual(['|', '|'])
  })

  it('pastes a rectangular block at the selected cell', () => {
    const onEdit = vi.fn()
    const view = render(<CsvTable source={'a,b\n1,2'} labels={labels} path="t.csv" onEdit={onEdit} />)
    const root = view.container.querySelector('[data-csv-table]')!
    fireEvent.mouseDown(bodyRows(view.container)[0]!.querySelector('td')!) // anchor at row 0, col 0

    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', { value: { getData: () => 'x,y\np,q' } })
    fireEvent(root, paste)

    expect(lastCommit(onEdit).rows).toEqual(['x|y', 'p|q'])
  })

  it('locks editing while a sort is active', () => {
    const onEdit = vi.fn()
    const view = render(<CsvTable source={'a\n2\n1'} labels={labels} path="t.csv" onEdit={onEdit} />)
    fireEvent.click(view.getAllByRole('columnheader')[1]!.querySelector('button')!)
    expect(view.getByText('EDIT_LOCKED')).toBeTruthy()
    expect(view.queryByRole('toolbar')).toBeNull()
    fireEvent.doubleClick(bodyRows(view.container)[0]!.querySelector('td')!)
    expect(view.queryByRole('textbox')).toBeNull()
  })

  it('undoes the last committed change', () => {
    const onEdit = vi.fn()
    let text = 'name\nAlice'
    const view = render(<CsvTable source={text} labels={labels} path="t.csv" onEdit={v => { text = v; onEdit(v) }} />)
    fireEvent.doubleClick(bodyRows(view.container)[0]!.querySelector('td')!)
    fireEvent.change(view.getByRole('textbox'), { target: { value: 'Bob' } })
    fireEvent.keyDown(view.getByRole('textbox'), { key: 'Enter' })
    text = 'name\nBob'
    view.rerender(<CsvTable source={text} labels={labels} path="t.csv" onEdit={v => { text = v; onEdit(v) }} />)
    fireEvent.click(view.getByRole('button', { name: 'UNDO' }))
    expect(onEdit).toHaveBeenLastCalledWith('name\nAlice')
  })

  it('opens a right-click cell menu and runs an insert-below action', () => {
    const onEdit = vi.fn()
    const view = render(<CsvTable source={'a,b\n1,2'} labels={labels} path="t.csv" onEdit={onEdit} />)
    fireEvent.contextMenu(bodyRows(view.container)[0]!.querySelector('td')!)
    expect(view.getByRole('menuitem', { name: 'INSERT_ROW_BELOW' })).toBeTruthy()
    fireEvent.click(view.getByRole('menuitem', { name: 'INSERT_ROW_BELOW' }))
    expect(lastCommit(onEdit).rows).toEqual(['1|2', '|'])
  })

  it('offers column actions from the header context menu', () => {
    const onEdit = vi.fn()
    const view = render(<CsvTable source={'a,b\n1,2'} labels={labels} path="t.csv" onEdit={onEdit} />)
    fireEvent.contextMenu(view.getAllByRole('columnheader')[1]!)
    fireEvent.click(view.getByRole('menuitem', { name: 'INSERT_COL_RIGHT' }))
    expect(lastCommit(onEdit).columns).toEqual(['a', '', 'b'])
  })
})
