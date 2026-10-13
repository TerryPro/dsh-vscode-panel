// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { zh } from '../src/client/core/locales.ts'
import type { DirectoryListing, WorkspaceEntry } from '../src/shared/contracts.ts'
import type { SqlResultBlock } from '../src/shared/sql-protocol.ts'
import { SqlNotebookSurface, type SqlNotebookLabels } from '../src/client/sql/SqlNotebookSurface.tsx'
import type { SqlResultLabels } from '../src/client/sql/SqlResultBlockView.tsx'
import { SqlRuntime } from '../src/client/sql/sql-runtime.ts'
import { sqlBlock } from './sql-block-fixture.ts'
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
  collapseCell: zh['sqlnotebook.collapseCell'],
  expandCell: zh['sqlnotebook.expandCell'],
  outline: zh['sqlnotebook.outline'],
  outlineEmpty: zh['sqlnotebook.outlineEmpty'],
  changeKind: zh['sqlnotebook.changeKind'],
  sqlCell: zh['sqlnotebook.sqlCell'],
  markdownCell: zh['sqlnotebook.markdownCell'],
  rawCell: zh['sqlnotebook.rawCell'],
  degradedCell: zh['sqlnotebook.degradedCell'],
  degradedNotice: zh['sqlnotebook.degradedNotice'],
  foldedBlocks: count => zh['sqlnotebook.foldedBlocks'].replace('{count}', String(count)),
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
  runAllStopped: (index, remaining) => zh['sqlnotebook.runAllStopped']
    .replace('{index}', String(index)).replace('{remaining}', String(remaining)),
  disconnectedRolledBack: zh['sqlnotebook.disconnectedRolledBack'],
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
  pager: zh['sqlnotebook.pager'],
  previousPage: zh['sqlnotebook.previousPage'],
  nextPage: zh['sqlnotebook.nextPage'],
  pagerUnavailable: zh['sqlnotebook.pagerUnavailable'],
}

const markdownLabels = {} as never

function block(overrides: Partial<SqlResultBlock> = {}): SqlResultBlock {
  return sqlBlock([{ label: 'x', name: 'x', type: 'INTEGER' }], [[1]], overrides)
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
  /** Whether the Host says it rolled an open transaction back when the handle closed. */
  rolledBack?: boolean
  /** Whether the outline panel is open, which the editor's status bar owns. */
  outlineVisible?: boolean
} = {}): Harness {
  const onEdit = vi.fn()
  const onSave = vi.fn()
  // The draft the surface and the runtime both read: an edit writes it before it repaints, so a
  // queued cell sees the text that is in its cell when its turn comes.
  const box = { current: draft }
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
    sqlClose: vi.fn(() => Promise.resolve({ path: 'demo.db', closed: true, rolledBack: options.rolledBack ?? false })),
    sqlAbandon: vi.fn(() => Promise.resolve({ path: 'demo.db', scheduled: true })),
    sqlCancel: vi.fn(() => Promise.resolve({ cancelled: true })),
  }
  const runtime = new SqlRuntime(api as never, { info: vi.fn(), warn: vi.fn() }, { getDraft: () => box.current })
  const root: DirectoryListing = { path: '', entries: options.entries ?? [{ name: 'demo.db', path: 'demo.db', kind: 'file' }], truncated: false }
  const listDirectory = vi.fn((path: string) => Promise.resolve(path === '' ? root : { path, entries: [], truncated: false }))
  /**
   * The draft held in state, the way the file tab holds it.
   *
   * A fixed prop would let a reorder test assert on the text the surface wrote while the screen
   * it claims to show never moved — and would leave the runtime reading a draft the reader has
   * already rearranged, which is the one case the re-keying below exists for.
   */
  function SurfaceHost() {
    const [text, setText] = useState(draft)
    return (
      <SqlNotebookSurface
        tabId="file:query.sqlnb"
        workspaceId="workspace-1"
        path="query.sqlnb"
        draft={text}
        editable
        outlineVisible={options.outlineVisible === true}
        dirty={false}
        saving={false}
        runtime={runtime}
        listDirectory={listDirectory as never}
        onEdit={next => { box.current = next; onEdit(next); setText(next) }}
        onSave={onSave}
        labels={labels}
        resultLabels={resultLabels}
        markdownLabels={markdownLabels}
      />
    )
  }
  const view = render(<SurfaceHost />)
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
        outlineVisible={false}
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

  it('opens an in-memory database without a tier, because it has none', async () => {
    const harness = open(notebookDraft([{ kind: 'sql', source: 'SELECT 1' }]))
    const picker = harness.view.getByRole('combobox', { name: labels.database }) as HTMLSelectElement
    await waitFor(() => { expect(picker.options.length).toBeGreaterThan(2) })
    fireEvent.change(picker, { target: { value: ':memory:' } })

    // The requirement is that no read-only/writable choice is shown for it; a toggle that
    // merely defaulted to writable would still offer the answer the Host refuses.
    expect(harness.view.queryByRole('combobox', { name: labels.readOnlyTier })).toBeNull()
    fireEvent.click(harness.view.getByRole('button', { name: labels.connect }))
    await waitFor(() => { expect(harness.api.sqlOpen).toHaveBeenCalled() })
    expect(harness.api.sqlOpen).toHaveBeenCalledWith({
      workspaceId: 'workspace-1', notebook: 'query.sqlnb', path: ':memory:', access: 'writable',
    })
  })

  it('says which cell a Run All stopped at, and how many it left unrun', async () => {
    const harness = open(notebookDraft([
      { kind: 'sql', source: 'SELEKT 1' },
      { kind: 'sql', source: 'SELECT 2' },
    ]), {
      blocks: [block({ columns: [], rows: [], error: { code: 'SQL_STATEMENT_FAILED', message: 'near "SELEKT": syntax error' } })],
    })
    await harness.connect()
    fireEvent.click(harness.view.getByRole('button', { name: labels.runAll }))
    fireEvent.click(harness.view.getByRole('button', { name: labels.confirm }))

    await waitFor(() => { expect(harness.api.sqlExecute).toHaveBeenCalledTimes(1) })
    expect(await harness.view.findByText(labels.runAllStopped(1, 1))).toBeTruthy()
  })

  it('says when disconnecting rolled back an open transaction', async () => {
    const harness = open(notebookDraft([{ kind: 'sql', source: 'SELECT 1' }]), { rolledBack: true })
    await harness.connect()
    fireEvent.click(harness.view.getByRole('button', { name: labels.disconnect }))

    expect(await harness.view.findByText(labels.disconnectedRolledBack)).toBeTruthy()
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

  it('reserves the paging slot under a truncated block, with both arrows dark', async () => {
    const harness = open(notebookDraft([{ kind: 'sql', source: 'SELECT * FROM t' }]), {
      blocks: [block({ truncated: true, rowLimit: 1000 })],
    })
    await harness.connect()
    fireEvent.click(harness.view.getAllByRole('button', { name: labels.runCell })[0] as HTMLElement)

    // The slot is there so the second page lands in place rather than pushing the table around
    // later. Its caption says what it is and nothing about a page size: paging needs an offset the
    // Host does not take yet, so both arrows are dark and a claim like "1000 rows per page" is not
    // made anywhere.
    const group = await harness.view.findByRole('group', { name: resultLabels.pager })
    expect(group.textContent).toContain(resultLabels.pager)
    const previous = harness.view.getByRole('button', { name: resultLabels.previousPage }) as HTMLButtonElement
    const next = harness.view.getByRole('button', { name: resultLabels.nextPage }) as HTMLButtonElement
    expect(previous.disabled).toBe(true)
    expect(next.disabled).toBe(true)
    expect(next.getAttribute('title')).toBe(resultLabels.pagerUnavailable)
  })

  it('gives a block that reached its end no paging slot', async () => {
    const harness = open(notebookDraft([{ kind: 'sql', source: 'SELECT 1' }]), {
      blocks: [block({ truncated: false, rowLimit: 1000 })],
    })
    await harness.connect()
    fireEvent.click(harness.view.getAllByRole('button', { name: labels.runCell })[0] as HTMLElement)
    await harness.view.findByText('In[1]')

    expect(harness.view.queryByRole('group', { name: resultLabels.pager })).toBeNull()
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

    // The affordance exists only while something is outstanding, and its tooltip states what the
    // button really reaches: a scan stops at its next chunk, a statement that yields no rows until
    // it finishes does not. The toolbar and each outstanding row all offer it, so the assertion
    // takes the first of them.
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

/** A `DOMRect` good enough for the drag geometry this file needs (top and height only). */
function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left, top, width, height,
    right: left + width, bottom: top + height,
    x: left, y: top, toJSON: () => ({}),
  } as DOMRect
}

/**
 * Stack the rows one per 100px so a `clientY` says which half of which row it landed in:
 * row 0 occupies 0-100, row 1 100-200, row 2 200-300.
 *
 * jsdom gives every element a zero-sized box, so without this every row's midpoint is 0 and
 * every drop aims at the first row — a test that would pass the wrong order.
 */
function stubRowRects(container: HTMLElement): void {
  const rows = [...container.querySelectorAll('[data-cell-id]')]
  expect(rows.length).toBeGreaterThan(0)
  rows.forEach((row, index) => { row.getBoundingClientRect = () => rect(0, index * 100, 400, 100) })
}

function rowOf(container: HTMLElement, cellId: string): HTMLElement {
  const row = container.querySelector<HTMLElement>(`[data-cell-id="${cellId}"]`)
  if (row === null) throw new Error(`no row for ${cellId}`)
  return row
}

/** The header strip of one row, which is where a drag of that cell starts. */
function handleOf(container: HTMLElement, cellId: string): HTMLElement {
  const handle = container.querySelector<HTMLElement>(`[data-cell-id="${cellId}"] [data-cell-handle]`)
  if (handle === null) throw new Error(`no drag handle for ${cellId}`)
  return handle
}

/**
 * A `DataTransfer` stand-in that records what was stored rather than knowing the payload.
 *
 * One object belongs to one gesture: the cell id only exists after a `dragStart` put it there,
 * so a `drop` that never began on the handle has nothing to move. A pre-filled stub would pass
 * even if the handle did nothing, which is the regression this must catch. `types` is a live
 * view because that is all a `dragover` may read — the browser locks payload values mid-drag.
 */
function fakeTransfer(): {
  types: string[]
  getData: (requested: string) => string
  setData: (requested: string, value: string) => void
  dropEffect: string
  effectAllowed: string
} {
  const carried = new Map<string, string>()
  return {
    get types(): string[] { return [...carried.keys()] },
    getData: (requested: string) => carried.get(requested) ?? '',
    setData: (requested: string, value: string) => { carried.set(requested, value) },
    dropEffect: '',
    effectAllowed: '',
  }
}

/**
 * Fire a drag event that actually carries `clientY`.
 *
 * `fireEvent.dragOver(el, { clientY })` drops the coordinate here: jsdom has no constructible
 * `DragEvent`, so testing-library builds a plain event and the init key dies on the setter-less
 * prototype getter. The name passed to `dispatchEvent` is the native lowercase one — React
 * listens for `dragover`, and a camel-cased type silently fires nothing.
 */
function fireDrag(
  el: Element,
  type: 'dragStart' | 'dragOver' | 'drop' | 'dragEnd',
  transfer: ReturnType<typeof fakeTransfer>,
  clientY?: number,
): Event {
  const event = new Event(type.toLowerCase(), { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: transfer })
  if (clientY !== undefined) Object.defineProperty(event, 'clientY', { value: clientY })
  act(() => { el.dispatchEvent(event) })
  return event
}

/** Which rows currently carry a drop line, as `id:before|after`. */
function dropLines(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-drop-before], [data-drop-after]')]
    .map(node => `${node.getAttribute('data-cell-id')}:${node.getAttribute('data-drop-before') === 'true' ? 'before' : 'after'}`)
}

describe('SqlNotebookSurface 拖拽与折叠', () => {
  it('drags a row below another one and writes the drop position back as the file order', () => {
    const { view, onEdit } = open(notebookDraft([
      { kind: 'sql', source: 'SELECT 1' },
      { kind: 'sql', source: 'SELECT 2' },
      { kind: 'sql', source: 'SELECT 3' },
    ]))
    stubRowRects(view.container)
    const transfer = fakeTransfer()
    fireDrag(handleOf(view.container, 'sqlnb-0'), 'dragStart', transfer)
    const third = rowOf(view.container, 'sqlnb-2')
    // The reader has to see *where* the row will land, not only that a drag is happening: a
    // reorder that drops blind is how a notebook gets quietly mangled.
    expect(dropLines(view.container)).toHaveLength(0)
    fireDrag(third, 'dragOver', transfer, 260)
    expect(dropLines(view.container)).toEqual(['sqlnb-2:after'])
    fireDrag(third, 'drop', transfer)

    const written = onEdit.mock.calls[0]?.[0] as string
    expect(parseSqlNotebook(written).cells.map(cell => cell.source)).toEqual(['SELECT 2', 'SELECT 3', 'SELECT 1'])
    expect(dropLines(view.container)).toHaveLength(0)
  })

  it('lifts a row to the top when the pointer aims at the first row’s upper half', () => {
    const { view, onEdit } = open(notebookDraft([
      { kind: 'sql', source: 'SELECT 1' },
      { kind: 'sql', source: 'SELECT 2' },
      { kind: 'sql', source: 'SELECT 3' },
    ]))
    stubRowRects(view.container)
    const transfer = fakeTransfer()
    fireDrag(handleOf(view.container, 'sqlnb-2'), 'dragStart', transfer)
    const first = rowOf(view.container, 'sqlnb-0')
    fireDrag(first, 'dragOver', transfer, 10)
    fireDrag(first, 'drop', transfer)

    const written = onEdit.mock.calls[0]?.[0] as string
    expect(parseSqlNotebook(written).cells.map(cell => cell.source)).toEqual(['SELECT 3', 'SELECT 1', 'SELECT 2'])
  })

  it('writes nothing for a drag that lands beside the row it started on', () => {
    const { view, onEdit } = open(notebookDraft([
      { kind: 'sql', source: 'SELECT 1' },
      { kind: 'sql', source: 'SELECT 2' },
    ]))
    stubRowRects(view.container)
    const transfer = fakeTransfer()
    const handle = handleOf(view.container, 'sqlnb-0')
    fireDrag(handle, 'dragStart', transfer)
    const own = rowOf(view.container, 'sqlnb-0')
    fireDrag(own, 'dragOver', transfer, 10)
    fireDrag(own, 'drop', transfer)

    // A jitter on the spot that rewrote the file would mark a saved notebook dirty for a gesture
    // that changed nothing.
    expect(onEdit).not.toHaveBeenCalled()
  })

  it('leaves a drag it did not start alone, so a file drop stays the editor’s', () => {
    const { view, onEdit } = open(notebookDraft([
      { kind: 'sql', source: 'SELECT 1' },
      { kind: 'sql', source: 'SELECT 2' },
    ]))
    stubRowRects(view.container)
    // A payload from elsewhere: a file from the tree, a URL or a text selection all arrive as
    // `text/plain`, and taking one would reorder on a stray gesture.
    const transfer = fakeTransfer()
    transfer.setData('text/plain', 'sqlnb-0')
    const second = rowOf(view.container, 'sqlnb-1')
    const over = fireDrag(second, 'dragOver', transfer, 150)
    expect(over.defaultPrevented).toBe(false)
    expect(dropLines(view.container)).toHaveLength(0)
    const dropped = fireDrag(second, 'drop', transfer)
    expect(dropped.defaultPrevented).toBe(false)
    expect(onEdit).not.toHaveBeenCalled()
  })

  it('refuses to drag a row of a file it will not rewrite', () => {
    const { view } = open(notebookDraft([{ kind: 'sql', source: 'SELECT 1' }], SQLNB_VERSION + 1))
    const handle = handleOf(view.container, 'sqlnb-0')
    expect(handle.getAttribute('draggable')).toBe('false')
    const transfer = fakeTransfer()
    fireDrag(handle, 'dragStart', transfer)
    // The grab cursor is already off, and the payload stays empty: a drag that looks grabbable
    // and does nothing reads as a broken drag rather than a refusal.
    expect(transfer.types).toEqual([])
  })

  it('clears the drop line when the drag is cancelled instead of dropped', () => {
    const { view } = open(notebookDraft([
      { kind: 'sql', source: 'SELECT 1' },
      { kind: 'sql', source: 'SELECT 2' },
    ]))
    stubRowRects(view.container)
    const transfer = fakeTransfer()
    const handle = handleOf(view.container, 'sqlnb-0')
    fireDrag(handle, 'dragStart', transfer)
    fireDrag(rowOf(view.container, 'sqlnb-1'), 'dragOver', transfer, 150)
    expect(dropLines(view.container)).toHaveLength(1)
    // Escape, or releasing outside the window, fires `dragend` on the handle and nothing else.
    fireDrag(handle, 'dragEnd', transfer)
    expect(dropLines(view.container)).toHaveLength(0)
  })

  it('folds a row to its header and says what it is hiding', async () => {
    const harness = open(notebookDraft([{ kind: 'sql', source: 'SELECT 1' }]))
    await harness.connect()
    fireEvent.click(harness.view.getByRole('button', { name: labels.runCell }))
    await harness.view.findByText('In[1]')
    expect(harness.view.container.querySelector('table')).not.toBeNull()

    fireEvent.click(harness.view.getByRole('button', { name: labels.collapseCell }))
    expect(harness.view.queryByRole('textbox')).toBeNull()
    expect(harness.view.container.querySelector('table')).toBeNull()
    // A row whose table vanished because the reader clicked a chevron is a different fact from
    // one whose results disappeared, and the header is the only place left to say it.
    expect(harness.view.getByText(labels.foldedBlocks(1))).toBeTruthy()

    fireEvent.click(harness.view.getByRole('button', { name: labels.expandCell }))
    expect(harness.view.getByRole('textbox', { name: 'sqlnb-0 sql' })).toBeTruthy()
    expect(harness.view.container.querySelector('table')).not.toBeNull()
  })

  it('keeps a run’s result with its cell when the cell changes row', async () => {
    const harness = open(notebookDraft([
      { kind: 'sql', source: 'SELECT 1' },
      { kind: 'sql', source: 'SELECT 2' },
    ]))
    await harness.connect()
    fireEvent.click(harness.view.getAllByRole('button', { name: labels.runCell })[0] as HTMLElement)
    await harness.view.findByText('In[1]')

    // Cell ids name positions, so moving the executed row down has to move the run state with
    // it: leaving it behind would paint this query's table under the neighbour's row.
    fireEvent.click(harness.view.getAllByRole('button', { name: labels.moveDown })[0] as HTMLElement)
    await waitFor(() => {
      const moved = harness.view.getByRole('textbox', { name: 'sqlnb-1 sql' }) as HTMLTextAreaElement
      expect(moved.value).toBe('SELECT 1')
    })

    expect(rowOf(harness.view.container, 'sqlnb-1').querySelector('table')).not.toBeNull()
    expect(rowOf(harness.view.container, 'sqlnb-0').querySelector('table')).toBeNull()
  })

  it('moves a finished result with its row when a cell is inserted above it', async () => {
    const harness = open(notebookDraft([
      { kind: 'sql', source: 'SELECT 1' },
      { kind: 'sql', source: 'SELECT 2' },
    ]))
    await harness.connect()
    fireEvent.click(harness.view.getAllByRole('button', { name: labels.runCell })[1] as HTMLElement)
    await harness.view.findByText('In[1]')

    // An insert shifts rows exactly as a move does, so the executed cell becomes row 2. A new empty
    // row must not open on top of the table.
    fireEvent.click(harness.view.getAllByRole('button', { name: labels.insertSqlBelow })[0] as HTMLElement)
    await waitFor(() => { expect(rowOf(harness.view.container, 'sqlnb-2').querySelector('table')).not.toBeNull() })

    expect(rowOf(harness.view.container, 'sqlnb-0').querySelector('table')).toBeNull()
    expect(rowOf(harness.view.container, 'sqlnb-1').querySelector('table')).toBeNull()
  })

  it('drops a deleted row’s result instead of leaving it on the row that takes its number', async () => {
    const harness = open(notebookDraft([
      { kind: 'sql', source: 'SELECT 1' },
      { kind: 'sql', source: 'SELECT 2' },
    ]))
    await harness.connect()
    fireEvent.click(harness.view.getAllByRole('button', { name: labels.runCell })[0] as HTMLElement)
    await harness.view.findByText('In[1]')

    fireEvent.click(harness.view.getAllByRole('button', { name: labels.deleteCell })[0] as HTMLElement)

    await waitFor(() => {
      const surviving = harness.view.getByRole('textbox', { name: 'sqlnb-0 sql' }) as HTMLTextAreaElement
      expect(surviving.value).toBe('SELECT 2')
    })
    expect(rowOf(harness.view.container, 'sqlnb-0').querySelector('table')).toBeNull()
  })

  it('folds the cell rather than the row number when a folded cell moves', async () => {
    const { view } = open(notebookDraft([
      { kind: 'sql', source: 'SELECT 1' },
      { kind: 'sql', source: 'SELECT 2' },
    ]))
    fireEvent.click(view.getAllByRole('button', { name: labels.collapseCell })[0] as HTMLElement)
    expect(view.getAllByRole('button', { name: labels.expandCell })).toHaveLength(1)
    expect(rowOf(view.container, 'sqlnb-0').querySelector('textarea')).toBeNull()

    fireEvent.click(view.getAllByRole('button', { name: labels.moveDown })[0] as HTMLElement)

    // A fold is view state per cell, and the cell just changed rows: leaving it behind would fold
    // whichever neighbour slid into the number — the reader's own cell would spring open.
    await waitFor(() => { expect(rowOf(view.container, 'sqlnb-0').querySelector('textarea')).not.toBeNull() })
    expect(rowOf(view.container, 'sqlnb-1').querySelector('textarea')).toBeNull()
    expect(view.getAllByRole('button', { name: labels.expandCell })).toHaveLength(1)
  })

  it('lists the headings of the text cells, and nothing out of a SQL cell', () => {
    const { view } = open(notebookDraft([
      { kind: 'markdown', source: '# Setup' },
      { kind: 'sql', source: 'SELECT 1 AS first_line' },
      { kind: 'markdown', source: '## Detail' },
    ]), { outlineVisible: true })

    const nav = view.getByRole('navigation', { name: labels.outline })
    expect(nav.textContent).toContain('Setup')
    expect(nav.textContent).toContain('Detail')
    // A SQL cell's first line is a statement, not a heading: mixing the two would make the list
    // unscannable for either purpose.
    expect(nav.textContent).not.toContain('SELECT 1 AS first_line')
  })

  it('shows no outline until the status bar asks for one', () => {
    const { view } = open(notebookDraft([{ kind: 'markdown', source: '# Setup' }]))

    expect(view.queryByRole('navigation', { name: labels.outline })).toBeNull()
  })

  it('scrolls the cell an outline row names rather than the row at that position', () => {
    let scrolled: Element | null = null
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function (this: Element) { scrolled = this }
    try {
      // The first text cell carries two headings on purpose, so the outline's third row names the
      // cell at position 2. An implementation that took "the cell at that outline position" would
      // walk the heading count against the cell list and land on the SQL cell.
      const { view } = open(notebookDraft([
        { kind: 'markdown', source: '# First\n## Also first' },
        { kind: 'sql', source: 'SELECT 1' },
        { kind: 'markdown', source: '# Second' },
      ]), { outlineVisible: true })
      const nav = view.getByRole('navigation', { name: labels.outline })
      const row = Array.from(nav.querySelectorAll('button')).find(button => button.textContent === 'Second')
      if (row === null || row === undefined) throw new Error('no outline row named Second')
      fireEvent.click(row)
    } finally {
      Element.prototype.scrollIntoView = original
    }

    expect((scrolled as unknown as HTMLElement | null)?.getAttribute('data-cell-id')).toBe('sqlnb-2')
  })
})
