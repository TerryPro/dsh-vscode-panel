// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { zh } from '../src/client/core/locales.ts'
import { SqlNotebookSurface, type SqlNotebookLabels } from '../src/client/sql/SqlNotebookSurface.tsx'
import { parseSqlNotebook, SQLNB_VERSION } from '../src/client/sql/sql-notebook-document.ts'

// CodeMirror cannot run in jsdom; a textarea keeps the cell editor assertable, and echoing
// the grammar path back lets the test see which language each cell asked for.
vi.mock('../src/client/editor/CodeEditor.tsx', () => ({
  CodeEditor: ({ value, onChange, ariaLabel, path }: {
    value: string
    ariaLabel: string
    onChange: (value: string) => void
    path?: string
  }) => (
    <textarea
      aria-label={ariaLabel}
      value={value}
      data-lang-path={path}
      onChange={event => { onChange(event.target.value) }}
    />
  ),
}))

afterEach(() => { cleanup() })

const labels: SqlNotebookLabels = {
  save: zh['notebook.save'],
  saveDirty: zh['notebook.saveDirty'],
  saveClean: zh['notebook.saveClean'],
  saving: zh['notebook.saving'],
  addSqlCell: zh['sqlnotebook.addSqlCell'],
  addMarkdownCell: zh['sqlnotebook.addMarkdownCell'],
  insertSqlBelow: zh['sqlnotebook.insertSqlBelow'],
  insertMarkdownBelow: zh['sqlnotebook.insertMarkdownBelow'],
  deleteCell: zh['sqlnotebook.deleteCell'],
  moveUp: zh['sqlnotebook.moveUp'],
  moveDown: zh['sqlnotebook.moveDown'],
  changeKind: zh['sqlnotebook.changeKind'],
  sqlCell: zh['sqlnotebook.sqlCell'],
  markdownCell: zh['sqlnotebook.markdownCell'],
  rawCell: zh['sqlnotebook.rawCell'],
  degradedCell: zh['sqlnotebook.degradedCell'],
  degradedNotice: zh['sqlnotebook.degradedNotice'],
  blankNotebook: zh['sqlnotebook.blankNotebook'],
  emptyNotebook: zh['sqlnotebook.emptyNotebook'],
  invalidJson: zh['sqlnotebook.invalidJson'],
  missingCells: zh['sqlnotebook.missingCells'],
  unsupportedVersion: zh['sqlnotebook.unsupportedVersion'],
  addFirstCell: zh['sqlnotebook.addFirstCell'],
}

/**
 * A `.sqlnb` written the way the surface writes one: four-space indent and a trailing
 * newline, both of which a round trip has to keep.
 */
function notebookDraft(cells: unknown[], version = SQLNB_VERSION): string {
  return `${JSON.stringify({ version, cells }, null, 4)}\n`
}

type SurfaceProps = Parameters<typeof SqlNotebookSurface>[0]

function open(draft: string, overrides: Partial<SurfaceProps> = {}) {
  const onEdit = vi.fn()
  const onSave = vi.fn()
  const props: SurfaceProps = {
    path: 'analysis/query.sqlnb',
    draft,
    editable: true,
    dirty: false,
    saving: false,
    onEdit,
    onSave,
    labels,
    ...overrides,
  }
  return { ...render(<SqlNotebookSurface {...props} />), onEdit, onSave }
}

describe('SqlNotebookSurface', () => {
  it('shows one editable row per cell, each in the grammar its kind speaks', () => {
    const view = open(notebookDraft([
      { kind: 'sql', source: 'SELECT 1' },
      { kind: 'markdown', source: '# Title' },
    ]))
    const sqlCell = view.getByRole('textbox', { name: 'sqlnb-0 sql' })
    const markdownCell = view.getByRole('textbox', { name: 'sqlnb-1 markdown' })
    expect((sqlCell as HTMLTextAreaElement).value).toBe('SELECT 1')
    expect((markdownCell as HTMLTextAreaElement).value).toBe('# Title')
    // A SQL cell is highlighted by the notebook's own path, which is why `sqlnb` maps to
    // SQL; a Markdown cell has to borrow `.md` or its headings would read as SQL.
    expect(sqlCell.getAttribute('data-lang-path')).toBe('analysis/query.sqlnb')
    expect(markdownCell.getAttribute('data-lang-path')).toBe('analysis/query.sqlnb.md')
  })

  it('writes a typed edit back as file text, keeping the document’s own formatting', () => {
    const view = open(notebookDraft([{ kind: 'sql', source: 'SELECT 1' }]))
    fireEvent.change(view.getByRole('textbox', { name: 'sqlnb-0 sql' }), { target: { value: 'SELECT 2\nFROM t' } })

    expect(view.onEdit).toHaveBeenCalledTimes(1)
    const written = view.onEdit.mock.calls[0]?.[0] as string
    expect(parseSqlNotebook(written).cells[0]?.source).toBe('SELECT 2\nFROM t')
    // The indent and trailing newline come from the file, not from this build's default.
    expect(written.startsWith('{\n    "version"')).toBe(true)
    expect(written.endsWith('}\n')).toBe(true)
  })

  it('deletes the cell the row names and leaves the rest in order', () => {
    const view = open(notebookDraft([
      { kind: 'sql', source: 'SELECT 1' },
      { kind: 'sql', source: 'SELECT 2' },
      { kind: 'sql', source: 'SELECT 3' },
    ]))
    fireEvent.click(view.getAllByRole('button', { name: labels.deleteCell })[1] as HTMLElement)

    const written = view.onEdit.mock.calls[0]?.[0] as string
    expect(parseSqlNotebook(written).cells.map(cell => cell.source)).toEqual(['SELECT 1', 'SELECT 3'])
  })

  it('moves a cell up one row without re-typing its neighbours', () => {
    const view = open(notebookDraft([
      { kind: 'sql', source: 'SELECT 1' },
      { kind: 'markdown', source: '# Title' },
    ]))
    // Row one's "up" is disabled but still rendered, so the query reaches both rows.
    fireEvent.click(view.getAllByRole('button', { name: labels.moveUp })[1] as HTMLElement)

    const written = view.onEdit.mock.calls[0]?.[0] as string
    const cells = parseSqlNotebook(written).cells
    expect(cells.map(cell => cell.source)).toEqual(['# Title', 'SELECT 1'])
    expect(cells.map(cell => cell.kind)).toEqual(['markdown', 'sql'])
  })

  it('re-types a cell through the kind picker', () => {
    const view = open(notebookDraft([{ kind: 'sql', source: '# Title' }]))
    fireEvent.change(view.getByRole('combobox', { name: labels.changeKind }) as HTMLElement, { target: { value: 'markdown' } })

    const written = view.onEdit.mock.calls[0]?.[0] as string
    expect(parseSqlNotebook(written).cells[0]?.kind).toBe('markdown')
  })

  it('adds a cell at the end, keeping the ones above it', () => {
    const view = open(notebookDraft([{ kind: 'sql', source: 'SELECT 1' }]))
    fireEvent.click(view.getByRole('button', { name: labels.addMarkdownCell }))

    const written = view.onEdit.mock.calls[0]?.[0] as string
    const cells = parseSqlNotebook(written).cells
    expect(cells).toHaveLength(2)
    expect(cells[1]?.kind).toBe('markdown')
    expect(cells[1]?.source).toBe('')
  })

  it('turns a new empty file into a valid document when the first cell is added', () => {
    // The file tree creates zero bytes; refusing the first cell over the missing skeleton
    // would deny the reader the very action that makes the file a notebook.
    const view = open('')
    expect(view.getByText(labels.blankNotebook)).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: labels.addFirstCell }))

    const written = view.onEdit.mock.calls[0]?.[0] as string
    const document = parseSqlNotebook(written)
    expect(document.version).toBe(SQLNB_VERSION)
    expect(document.cells).toEqual([
      expect.objectContaining({ kind: 'sql', source: '', degraded: false }),
    ])
  })

  it('shows a file whose version it does not know as read-only, and says which one', () => {
    const view = open(notebookDraft([{ kind: 'sql', source: 'SELECT 1' }], SQLNB_VERSION + 1))
    expect(view.getByRole('status')?.textContent).toContain(labels.unsupportedVersion)
    // The content is still shown — as text the surface will not rewrite.
    expect(view.queryByRole('textbox')).toBeNull()
    expect(view.getByText('SELECT 1')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: labels.deleteCell }))
    expect(view.onEdit).not.toHaveBeenCalled()
  })

  it('points at the source view when the file is not valid JSON', () => {
    const view = open('{"version": 1, "cells": [')
    expect(view.getByRole('status')?.textContent).toContain(labels.invalidJson)
    expect(view.queryByRole('textbox')).toBeNull()
    expect((view.getByRole('button', { name: labels.addSqlCell }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows a cell of an unknown kind as read-only text and names it', () => {
    const view = open(notebookDraft([
      { kind: 'sql', source: 'SELECT 1' },
      { kind: 'vector', source: 'ANN SEARCH' },
    ]))
    // The recognised cell keeps its editor; the unknown one is text, marked as such.
    expect(view.getByRole('textbox', { name: 'sqlnb-0 sql' })).toBeTruthy()
    expect(view.queryByRole('textbox', { name: 'sqlnb-1 raw' })).toBeNull()
    expect(view.getAllByText(labels.degradedCell)).toHaveLength(1)
    expect(view.getByRole('status')?.textContent).toContain(labels.degradedNotice)
    expect(view.getByText('ANN SEARCH')).toBeTruthy()
  })

  it('lets a degraded cell still be moved or deleted, since its node is copied untouched', () => {
    const view = open(notebookDraft([
      { kind: 'sql', source: 'SELECT 1' },
      { kind: 'vector', source: 'ANN SEARCH' },
    ]))
    const deleteButtons = view.getAllByRole('button', { name: labels.deleteCell })
    expect((deleteButtons[1] as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(deleteButtons[1] as HTMLElement)

    const written = view.onEdit.mock.calls[0]?.[0] as string
    expect(parseSqlNotebook(written).cells.map(cell => cell.source)).toEqual(['SELECT 1'])
  })

  it('keeps structural buttons dark while an external change is unresolved, but still takes typing', () => {
    const view = open(notebookDraft([{ kind: 'sql', source: 'SELECT 1' }]), { editable: false })
    expect((view.getByRole('button', { name: labels.insertSqlBelow }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(view.getByRole('textbox', { name: 'sqlnb-0 sql' }), { target: { value: 'SELECT 2' } })
    expect(view.onEdit).toHaveBeenCalledTimes(1)
  })

  it('saves through the callback the shell hands it, and reports what the button would do', () => {
    const view = open(notebookDraft([{ kind: 'sql', source: 'SELECT 1' }]), { dirty: true })
    const save = view.getByRole('button', { name: labels.save }) as HTMLButtonElement
    expect(save.title).toBe(labels.saveDirty)
    fireEvent.click(save)
    expect(view.onSave).toHaveBeenCalledTimes(1)
  })
})
