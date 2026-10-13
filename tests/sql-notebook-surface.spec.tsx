// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { zh } from '../src/client/core/locales.ts'
import type { DirectoryListing, WorkspaceEntry } from '../src/shared/contracts.ts'
import type { SqlResultBlock } from '../src/shared/sql-protocol.ts'
import { SqlNotebookSurface, type SqlNotebookLabels } from '../src/client/sql/SqlNotebookSurface.tsx'
import type { SqlResultLabels } from '../src/client/sql/SqlResultBlockView.tsx'
import { SqlRuntime } from '../src/client/sql/sql-runtime.ts'
import { parseSqlNotebook, SQLNB_VERSION } from '../src/client/sql/sql-notebook-document.ts'

// The store package pulls zustand/immer, which are not installed for tests.
vi.mock('@deepseek-ai/dsh-client-store', () => ({
  createSnapshotStore: <T,>(initial: T) => {
    let state = initial
    const listeners = new Set<() => void>()
    return {
      getSnapshot: () => state,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      set: (next: T) => { state = next; listeners.forEach(listener => { listener() }) },
      update: (mutator: (draft: T) => void) => {
        const next = structuredClone(state)
        mutator(next)
        state = next
        listeners.forEach(listener => { listener() })
      },
    }
  },
}))

// CodeMirror cannot run in jsdom; a textarea keeps the cell editor assertable.
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

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  MarkdownText: ({ text }: { text: string }) => <div data-testid="markdown">{text}</div>,
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
  runCell: zh['sqlnotebook.runCell'],
  runAll: zh['sqlnotebook.runAll'],
  cancel: zh['sqlnotebook.cancel'],
  cancelLimit: zh['sqlnotebook.cancelLimit'],
  clearAllOutputs: zh['sqlnotebook.clearAllOutputs'],
  clearCellOutputs: zh['sqlnotebook.clearCellOutputs'],
  renderMarkdown: zh['sqlnotebook.renderMarkdown'],
  editMarkdown: zh['sqlnotebook.editMarkdown'],
  promptNumber: zh['sqlnotebook.promptNumber'],
  elapsed: ms => zh['sqlnotebook.elapsed'].replace('{ms}', String(ms)),
  statusRunning: zh['sqlnotebook.statusRunning'],
  statusQueued: zh['sqlnotebook.statusQueued'],
  statusError: zh['sqlnotebook.statusError'],
  statusCancelled: zh['sqlnotebook.statusCancelled'],
  database: zh['sqlnotebook.database'],
  memoryDatabase: zh['sqlnotebook.memoryDatabase'],
  connect: zh['sqlnotebook.connect'],
  disconnect: zh['sqlnotebook.disconnect'],
  connecting: zh['sqlnotebook.connecting'],
  notConnected: zh['sqlnotebook.notConnected'],
  noDatabase: zh['sqlnotebook.noDatabase'],
  readOnlyTier: zh['sqlnotebook.readOnlyTier'],
  writableTier: zh['sqlnotebook.writableTier'],
  tierLocked: zh['sqlnotebook.tierLocked'],
  rescan: zh['sqlnotebook.rescan'],
  scanTruncated: zh['sqlnotebook.scanTruncated'],
  scratchNotice: zh['sqlnotebook.scratchNotice'],
  runAllNotice: count => zh['sqlnotebook.runAllNotice'].replace('{count}', String(count)),
  confirm: zh['sqlnotebook.confirm'],
  notConnectedRefusal: zh['sqlnotebook.notConnectedRefusal'],
  emptyCellRefusal: zh['sqlnotebook.emptyCellRefusal'],
}

const resultLabels: SqlResultLabels = {
  nullValue: zh['sqlnotebook.nullValue'],
  emptyString: zh['sqlnotebook.emptyString'],
  blobTruncated: zh['sqlnotebook.blobTruncated'],
  declaredType: zh['sqlnotebook.declaredType'],
  rowsTruncated: limit => zh['sqlnotebook.rowsTruncated'].replace('{limit}', String(limit)),
  columnsDropped: count => zh['sqlnotebook.columnsDropped'].replace('{count}', String(count)),
  valuesTruncated: count => zh['sqlnotebook.valuesTruncated'].replace('{count}', String(count)),
  deadline: ms => zh['sqlnotebook.deadline'].replace('{ms}', String(ms)),
  changes: count => zh['sqlnotebook.changes'].replace('{count}', String(count)),
  emptyRows: zh['sqlnotebook.emptyRows'],
}

const markdownLabels = {} as never

function block(overrides: Partial<SqlResultBlock> = {}): SqlResultBlock {
  return {
    columns: [{ label: 'x', name: 'x', type: 'INTEGER' }],
    rows: [[1]],
    rowLimit: 1000,
    truncated: false,
    columnsDropped: 0,
    valuesTruncated: 0,
    ...overrides,
  }
}

/** A `.sqlnb` written the way the surface writes one: four-space indent, trailing newline. */
function notebookDraft(cells: unknown[], version = SQLNB_VERSION): string {
  return `${JSON.stringify({ version, cells }, null, 4)}\n`
}

interface Harness {
  view: ReturnType<typeof render>
  onEdit: ReturnType<typeof vi.fn>
  onSave: ReturnType<typeof vi.fn>
  api: {
    sqlOpen: ReturnType<typeof vi.fn>
    sqlExecute: ReturnType<typeof vi.fn>
    sqlClose: ReturnType<typeof vi.fn>
  }
  /** Pick the first database the scan offered and press connect. */
  connect: () => Promise<void>
}

function open(draft: string, options: {
  blocks?: SqlResultBlock[]
  executionCount?: number
  entries?: WorkspaceEntry[]
  /** Replaces the execute answer entirely, so a test can hold a run open. */
  execute?: () => Promise<{ path: string; blocks: SqlResultBlock[]; elapsedMs: number; executionCount: number }>
} = {}): Harness {
  const onEdit = vi.fn()
  const onSave = vi.fn()
  const api = {
    sqlOpen: vi.fn(() => Promise.resolve({
      path: 'demo.db', access: 'read-only' as const, sqliteVersion: '3.46.0', walSidecarExpected: false, rowLimit: 1000,
    })),
    sqlExecute: vi.fn(options.execute ?? (() => Promise.resolve({
      path: 'demo.db',
      blocks: options.blocks ?? [block()],
      elapsedMs: 42,
      executionCount: options.executionCount ?? 1,
    }))),
    sqlClose: vi.fn(() => Promise.resolve({ path: 'demo.db', closed: true, rolledBack: false })),
    sqlAbandon: vi.fn(() => Promise.resolve({ path: 'demo.db', scheduled: true })),
  }
  const runtime = new SqlRuntime(api as never, { info: vi.fn(), warn: vi.fn() }, { getDraft: () => draft })
  const root: DirectoryListing = { path: '', entries: options.entries ?? [{ name: 'demo.db', path: 'demo.db', kind: 'file' }], truncated: false }
  const listDirectory = vi.fn((path: string) => Promise.resolve(path === '' ? root : { path, entries: [], truncated: false }))
  const view = render(
    <SqlNotebookSurface
      tabId="file:query.sqlnb"
      workspaceId="workspace-1"
      path="query.sqlnb"
      draft={draft}
      editable
      dirty={false}
      saving={false}
      runtime={runtime}
      listDirectory={listDirectory as never}
      onEdit={onEdit}
      onSave={onSave}
      labels={labels}
      resultLabels={resultLabels}
      markdownLabels={markdownLabels}
    />,
  )
  async function connect(): Promise<void> {
    // The picker lists the workspace, so the row a reader picks is a path the scan found.
    const select = view.getByRole('combobox', { name: labels.database }) as HTMLSelectElement
    await waitFor(() => { expect(select.options.length).toBeGreaterThan(2) })
    fireEvent.change(select, { target: { value: 'demo.db' } })
    fireEvent.click(view.getByRole('button', { name: labels.connect }))
    await waitFor(() => { expect(api.sqlOpen).toHaveBeenCalled() })
  }
  return { view, onEdit, onSave, api, connect }
}

describe('SqlNotebookSurface 文档层', () => {
  it('shows one editable row per cell, each in the grammar its kind speaks', () => {
    const { view } = open(notebookDraft([
      { kind: 'sql', source: 'SELECT 1' },
      { kind: 'markdown', source: '# Title' },
    ]))
    const sqlCell = view.getByRole('textbox', { name: 'sqlnb-0 sql' })
    const markdownCell = view.getByRole('textbox', { name: 'sqlnb-1 markdown' })
    expect((sqlCell as HTMLTextAreaElement).value).toBe('SELECT 1')
    expect((markdownCell as HTMLTextAreaElement).value).toBe('# Title')
    expect(sqlCell.getAttribute('data-lang-path')).toBe('query.sqlnb')
    expect(markdownCell.getAttribute('data-lang-path')).toBe('query.sqlnb.md')
  })

  it('writes a typed edit back as file text, keeping the document’s own formatting', () => {
    const { view, onEdit } = open(notebookDraft([{ kind: 'sql', source: 'SELECT 1' }]))
    fireEvent.change(view.getByRole('textbox', { name: 'sqlnb-0 sql' }), { target: { value: 'SELECT 2\nFROM t' } })

    expect(onEdit).toHaveBeenCalledTimes(1)
    const written = onEdit.mock.calls[0]?.[0] as string
    expect(parseSqlNotebook(written).cells[0]?.source).toBe('SELECT 2\nFROM t')
    expect(written.startsWith('{\n    "version"')).toBe(true)
    expect(written.endsWith('}\n')).toBe(true)
  })

  it('deletes the cell the row names and leaves the rest in order', () => {
    const { view, onEdit } = open(notebookDraft([
      { kind: 'sql', source: 'SELECT 1' },
      { kind: 'sql', source: 'SELECT 2' },
      { kind: 'sql', source: 'SELECT 3' },
    ]))
    fireEvent.click(view.getAllByRole('button', { name: labels.deleteCell })[1] as HTMLElement)

    const written = onEdit.mock.calls[0]?.[0] as string
    expect(parseSqlNotebook(written).cells.map(cell => cell.source)).toEqual(['SELECT 1', 'SELECT 3'])
  })

  it('turns a new empty file into a valid document when the first cell is added', () => {
    const { view, onEdit } = open('')
    expect(view.getByText(labels.blankNotebook)).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: labels.addFirstCell }))

    const document = parseSqlNotebook(onEdit.mock.calls[0]?.[0] as string)
    expect(document.version).toBe(SQLNB_VERSION)
    expect(document.cells).toEqual([expect.objectContaining({ kind: 'sql', source: '' })])
  })

  it('shows a file whose version it does not know as read-only, and says which one', () => {
    const { view, onEdit } = open(notebookDraft([{ kind: 'sql', source: 'SELECT 1' }], SQLNB_VERSION + 1))
    expect(view.getByRole('status')?.textContent).toContain(labels.unsupportedVersion)
    expect(view.queryByRole('textbox')).toBeNull()
    expect(view.getByText('SELECT 1')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: labels.deleteCell }))
    expect(onEdit).not.toHaveBeenCalled()
  })

  it('points at the source view when the file is not valid JSON', () => {
    const { view } = open('{"version": 1, "cells": [')
    expect(view.getByRole('status')?.textContent).toContain(labels.invalidJson)
    expect(view.queryByRole('textbox')).toBeNull()
    expect((view.getByRole('button', { name: labels.addSqlCell }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows a cell of an unknown kind as read-only text and names it', () => {
    const { view } = open(notebookDraft([
      { kind: 'sql', source: 'SELECT 1' },
      { kind: 'vector', source: 'ANN SEARCH' },
    ]))
    expect(view.getByRole('textbox', { name: 'sqlnb-0 sql' })).toBeTruthy()
    expect(view.queryByRole('textbox', { name: 'sqlnb-1 raw' })).toBeNull()
    expect(view.getAllByText(labels.degradedCell)).toHaveLength(1)
    expect(view.getByText('ANN SEARCH')).toBeTruthy()
  })

  it('keeps structural buttons dark while an external change is unresolved, but still takes typing', () => {
    const draft = notebookDraft([{ kind: 'sql', source: 'SELECT 1' }])
    const harness = open(draft)
    cleanup()
    const onEdit = vi.fn()
    const runtime = new SqlRuntime({
      sqlOpen: vi.fn(), sqlExecute: vi.fn(), sqlClose: vi.fn(), sqlAbandon: vi.fn(),
    } as never, { info: vi.fn(), warn: vi.fn() }, { getDraft: () => draft })
    const view = render(
      <SqlNotebookSurface
        tabId="file:query.sqlnb"
        workspaceId="workspace-1"
        path="query.sqlnb"
        draft={draft}
        editable={false}
        dirty={false}
        saving={false}
        runtime={runtime}
        listDirectory={vi.fn(() => Promise.resolve({ path: '', entries: [], truncated: false })) as never}
        onEdit={onEdit}
        onSave={vi.fn()}
        labels={labels}
        resultLabels={resultLabels}
        markdownLabels={markdownLabels}
      />,
    )
    expect((view.getByRole('button', { name: labels.insertSqlBelow }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(view.getByRole('textbox', { name: 'sqlnb-0 sql' }), { target: { value: 'SELECT 2' } })
    expect(onEdit).toHaveBeenCalledTimes(1)
  })
})

describe('SqlNotebookSurface 连接与执行', () => {
  it('lists the workspace databases and opens the one the reader picks', async () => {
    const harness = open(notebookDraft([{ kind: 'sql', source: 'SELECT 1' }]))
    await harness.connect()

    expect(harness.api.sqlOpen).toHaveBeenCalledWith({
      workspaceId: 'workspace-1', notebook: 'query.sqlnb', path: 'demo.db', access: 'read-only',
    })
    // The readout answers with what the Host granted, in the same row the picker sits in.
    await harness.view.findByText('demo.db · 只读 · 1000')
  })

  it('offers an in-memory database beside the files', () => {
    const { view } = open(notebookDraft([{ kind: 'sql', source: 'SELECT 1' }]))
    expect(view.getByRole('combobox', { name: labels.database }).textContent).toContain(':memory:')
  })

  it('locks the tier once a handle is open, because changing it means reconnecting', async () => {
    const harness = open(notebookDraft([{ kind: 'sql', source: 'SELECT 1' }]))
    const tier = harness.view.getByRole('combobox', { name: labels.readOnlyTier }) as HTMLSelectElement
    expect(tier.disabled).toBe(false)
    await harness.connect()
    await waitFor(() => { expect(tier.disabled).toBe(true) })
    expect(tier.title).toBe(labels.tierLocked)
  })

  it('refuses to run a cell until a database is connected', () => {
    const { view } = open(notebookDraft([{ kind: 'sql', source: 'SELECT 1' }]))
    const run = view.getAllByRole('button', { name: labels.runCell })[0] as HTMLButtonElement
    expect(run.disabled).toBe(true)
    expect(run.title).toBe(labels.noDatabase)
  })

  it('runs a cell and shows the values, the declared types and the count', async () => {
    const harness = open(notebookDraft([{ kind: 'sql', source: 'SELECT 1' }]), {
      blocks: [block({ columns: [{ label: 'id', name: 'id', type: 'INTEGER' }, { label: 'who', name: 'who' }], rows: [[7, 'Tokyo']] })],
    })
    await harness.connect()
    fireEvent.click(harness.view.getAllByRole('button', { name: labels.runCell })[0] as HTMLElement)

    await harness.view.findByText('Tokyo')
    expect(harness.view.getByText('id')).toBeTruthy()
    // The declared type sits in its own header row, under the label it describes.
    expect(harness.view.getByText('INTEGER')).toBeTruthy()
    expect(harness.view.getByText('In[1]')).toBeTruthy()
    expect(harness.view.getByText(labels.elapsed(42))).toBeTruthy()
    // Running must not dirty the tab: the draft was never written.
    expect(harness.onEdit).not.toHaveBeenCalled()
  })

  it('keeps NULL, the empty string and the text NULL three different things', async () => {
    const harness = open(notebookDraft([{ kind: 'sql', source: 'SELECT 1' }]), {
      blocks: [block({
        columns: [{ label: 'a', name: 'a' }, { label: 'b', name: 'b' }, { label: 'c', name: 'c' }, { label: 'd', name: 'd' }],
        rows: [[null, '', 'NULL', { base64: 'eA==', byteLength: 12288, truncated: false }]],
      })],
    })
    await harness.connect()
    fireEvent.click(harness.view.getAllByRole('button', { name: labels.runCell })[0] as HTMLElement)

    const nullCell = await harness.view.findByText('∅')
    expect(nullCell.getAttribute('title')).toBe(resultLabels.nullValue)
    const emptyCell = harness.view.getByText('·')
    expect(emptyCell.getAttribute('title')).toBe(resultLabels.emptyString)
    expect(harness.view.getByText('NULL')).toBeTruthy()
    expect(harness.view.getByText(/BLOB · 12.0 KB/)).toBeTruthy()
  })

  it('says what the block left out, outside the table', async () => {
    const harness = open(notebookDraft([{ kind: 'sql', source: 'SELECT 1' }]), {
      blocks: [block({ truncated: true, rowLimit: 1000, columnsDropped: 7, valuesTruncated: 3 })],
    })
    await harness.connect()
    fireEvent.click(harness.view.getAllByRole('button', { name: labels.runCell })[0] as HTMLElement)

    await harness.view.findByText(resultLabels.rowsTruncated(1000))
    expect(harness.view.getByText(resultLabels.columnsDropped(7))).toBeTruthy()
    expect(harness.view.getByText(resultLabels.valuesTruncated(3))).toBeTruthy()
  })

  it('reports rows written by a statement that returned no result set', async () => {
    const harness = open(notebookDraft([{ kind: 'sql', source: 'UPDATE t SET a = 1' }]), {
      blocks: [block({ columns: [], rows: [], changes: 3 })],
    })
    await harness.connect()
    fireEvent.click(harness.view.getAllByRole('button', { name: labels.runCell })[0] as HTMLElement)

    await harness.view.findByText(resultLabels.changes(3))
    expect(harness.view.queryByText(resultLabels.emptyRows)).toBeNull()
  })

  it('puts a failed statement’s line where the result would have been, and marks the row', async () => {
    const harness = open(notebookDraft([{ kind: 'sql', source: 'SELEKT 1' }]), {
      blocks: [block({ columns: [], rows: [], error: { code: 'SQL_STATEMENT_FAILED', message: 'near "SELEKT": syntax error' } })],
    })
    await harness.connect()
    fireEvent.click(harness.view.getAllByRole('button', { name: labels.runCell })[0] as HTMLElement)

    const alert = await harness.view.findByRole('alert')
    expect(alert.textContent).toContain('near "SELEKT"')
    expect(harness.view.getByText(labels.statusError)).toBeTruthy()
    expect(harness.view.getByText('In[1]')).toBeTruthy()
  })

  it('renders a Markdown cell instead of sending it to the database', async () => {
    const harness = open(notebookDraft([{ kind: 'markdown', source: '# Title' }]))
    await harness.connect()
    fireEvent.click(harness.view.getByRole('button', { name: labels.renderMarkdown }))

    expect(harness.view.getByTestId('markdown').textContent).toBe('# Title')
    expect(harness.api.sqlExecute).not.toHaveBeenCalled()
  })

  it('asks how many cells a Run All will take before it takes them', () => {
    const { view } = open(notebookDraft([
      { kind: 'sql', source: 'SELECT 1' },
      { kind: 'markdown', source: '# note' },
      { kind: 'sql', source: 'SELECT 2' },
    ]))
    fireEvent.click(view.getByRole('button', { name: labels.runAll }))

    // The count is of SQL cells only: a number that included the text cell would overstate
    // how long the workbench is about to be busy.
    expect(view.getByText(labels.runAllNotice(2))).toBeTruthy()
  })

  it('runs the cell whose editor has the caret on Ctrl+Enter', async () => {
    const harness = open(notebookDraft([
      { kind: 'sql', source: 'SELECT 1' },
      { kind: 'sql', source: 'SELECT 2' },
    ]))
    await harness.connect()
    const second = harness.view.getByRole('textbox', { name: 'sqlnb-1 sql' })
    fireEvent.keyDown(second, { key: 'Enter', ctrlKey: true })

    await waitFor(() => { expect(harness.api.sqlExecute).toHaveBeenCalledTimes(1) })
    expect(harness.api.sqlExecute).toHaveBeenLastCalledWith('workspace-1', 'query.sqlnb', 'SELECT 2')
  })

  it('clears what a run put on screen without touching the file', async () => {
    const harness = open(notebookDraft([{ kind: 'sql', source: 'SELECT 1' }]))
    await harness.connect()
    fireEvent.click(harness.view.getAllByRole('button', { name: labels.runCell })[0] as HTMLElement)
    await harness.view.findByText('In[1]')

    fireEvent.click(harness.view.getByRole('button', { name: labels.clearAllOutputs }))

    await waitFor(() => { expect(harness.view.queryByText('In[1]')).toBeNull() })
    expect(harness.onEdit).not.toHaveBeenCalled()
  })

  it('offers cancel while a run is outstanding and drops the answer that arrives after it', async () => {
    let release!: () => void
    const pending = new Promise<{ path: string; blocks: SqlResultBlock[]; elapsedMs: number; executionCount: number }>(resolve => {
      release = () => { resolve({ path: 'demo.db', blocks: [block()], elapsedMs: 42, executionCount: 1 }) }
    })
    const harness = open(notebookDraft([
      { kind: 'sql', source: 'SELECT 1' },
      { kind: 'sql', source: 'SELECT 2' },
    ]), { execute: () => pending })
    await harness.connect()

    const runButtons = harness.view.getAllByRole('button', { name: labels.runCell })
    fireEvent.click(runButtons[0] as HTMLElement)
    fireEvent.click(runButtons[1] as HTMLElement)

    // The affordance exists only while something is outstanding, and its tooltip states the
    // limit rather promising an interrupt this runtime does not have. The toolbar and each
    // outstanding row all offer it, so the assertion takes the first of them.
    const cancel = (await harness.view.findAllByRole('button', { name: labels.cancel }))[0] as HTMLElement
    expect(cancel.getAttribute('title')).toContain(labels.cancelLimit)
    fireEvent.click(cancel)

    await waitFor(() => { expect(harness.view.getAllByText(labels.statusCancelled)).toHaveLength(2) })
    act(() => { release() })
    await Promise.resolve()
    await waitFor(() => { expect(harness.view.queryByText('In[1]')).toBeNull() })
    expect(harness.view.queryByText('Tokyo')).toBeNull()
  })
})
