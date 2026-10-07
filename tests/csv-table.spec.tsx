// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CsvTable, type CsvTableLabels } from '../src/client/csv/CsvTable.tsx'

const labels: CsvTableLabels = {
  empty: 'EMPTY',
  noMatches: 'NO_MATCHES',
  filter: 'FILTER',
  rowNumber: '#',
  sortNone: 'NONE',
  sortAscending: 'ASC',
  sortDescending: 'DESC',
  truncated: count => `TRUNCATED ${count}`,
  rowCount: (shown, total) => `${shown}/${total}`,
}

function firstDataColumn(container: HTMLElement): string[] {
  // The row-number gutter is a <th>; the first <td> is always the first data column.
  return Array.from(container.querySelectorAll('tbody tr'))
    .map(row => row.querySelector('td')?.textContent ?? '')
}

afterEach(() => { cleanup() })

describe('CsvTable', () => {
  it('renders a frozen gutter plus one header cell per column', () => {
    const { getAllByRole, getByRole } = render(<CsvTable source={'name,score\nAlice,30\nBob,5'} labels={labels} />)
    expect(getAllByRole('columnheader').map(th => th.textContent)).toEqual(['#', 'name', 'score'])
    expect(getByRole('table')).toBeTruthy()
    expect(getAllByRole('row')).toHaveLength(3)
  })

  it('numbers each data row starting at one', () => {
    const { getAllByRole } = render(<CsvTable source={'name\nAlice\nBob\nCara'} labels={labels} />)
    const gutter = getAllByRole('row').slice(1).map(row => row.querySelector('th')?.textContent)
    expect(gutter).toEqual(['1', '2', '3'])
  })

  it('shows the empty state instead of a grid when there is no data at all', () => {
    const { getByText, queryAllByRole } = render(<CsvTable source="" labels={labels} />)
    expect(getByText('EMPTY')).toBeTruthy()
    expect(queryAllByRole('columnheader')).toHaveLength(0)
  })

  it('sorts a numeric column ascending then descending as its header is clicked', () => {
    const view = render(<CsvTable source={'name,score\nAlice,30\nBob,5\nCara,20'} labels={labels} />)
    // Index 0 is the row-number gutter; the score column header is the third cell.
    const scoreHeader = view.getAllByRole('columnheader')[2]!
    const scoreButton = scoreHeader.querySelector('button')!

    fireEvent.click(scoreButton)
    expect(scoreHeader.getAttribute('aria-sort')).toBe('ascending')
    expect(firstDataColumn(view.container)).toEqual(['Bob', 'Cara', 'Alice'])

    fireEvent.click(scoreButton)
    expect(scoreHeader.getAttribute('aria-sort')).toBe('descending')
    expect(firstDataColumn(view.container)).toEqual(['Alice', 'Cara', 'Bob'])

    fireEvent.click(scoreButton)
    expect(scoreHeader.getAttribute('aria-sort')).toBe('none')
    expect(firstDataColumn(view.container)).toEqual(['Alice', 'Bob', 'Cara'])
  })

  it('filters rows to those matching the query and reports the count', () => {
    const view = render(<CsvTable source={'name,score\nAlice,30\nBob,5\nCara,20'} labels={labels} />)
    const box = view.getByRole('searchbox')
    expect(view.getByText('3/3')).toBeTruthy()

    fireEvent.change(box, { target: { value: 'ar' } })
    expect(firstDataColumn(view.container)).toEqual(['Cara'])
    expect(view.getByText('1/3')).toBeTruthy()
  })

  it('shows the no-matches message when a filter excludes every row', () => {
    const view = render(<CsvTable source={'name\nAlice\nBob'} labels={labels} />)
    fireEvent.change(view.getByRole('searchbox'), { target: { value: 'zzz' } })
    expect(view.getByText('NO_MATCHES')).toBeTruthy()
  })

  it('marks a fully numeric column and leaves a text column unmarked', () => {
    const { getAllByRole } = render(<CsvTable source={'name,score\nAlice,30\nBob,5'} labels={labels} />)
    const [nameCell, scoreCell] = Array.from(getAllByRole('row')[1]!.querySelectorAll('td'))
    expect(nameCell?.getAttribute('data-numeric')).toBeNull()
    expect(scoreCell?.getAttribute('data-numeric')).toBe('true')
  })

  it('honors an explicit tab delimiter so a comma-bearing TSV splits on tabs', () => {
    const view = render(<CsvTable source={'name\tcity\nAda\t"London, UK"'} labels={labels} delimiter={'\t'} />)
    expect(view.getAllByRole('columnheader').map(th => th.textContent)).toEqual(['#', 'name', 'city'])
    expect(firstDataColumn(view.container)).toEqual(['Ada'])
  })

  it('omits the split marker on the standalone table', () => {
    const { container } = render(<CsvTable source="a,b\n1,2" labels={labels} />)
    expect(container.querySelector('[data-csv-table]')?.getAttribute('data-split')).toBeNull()
  })

  it('flags the split variant so the divider styling can apply', () => {
    const { container } = render(<CsvTable source="a,b\n1,2" labels={labels} split />)
    expect(container.querySelector('[data-csv-table]')?.getAttribute('data-split')).toBe('true')
  })
})
