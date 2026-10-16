// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { zh } from '../src/client/core/locales.ts'
import type { DirectoryListing, WorkspaceEntry } from '../src/shared/contracts.ts'
import type { SqlResultBlock } from '../src/shared/sql-protocol.ts'
import { SqlNotebookSurface, type SqlNotebookLabels } from '../src/client/sql/SqlNotebookSurface.tsx'
import type { SqlResultLabels } from '../src/client/sql/SqlResultBlockView.tsx'
import { SqlRuntime } from '../src/client/sql/sql-runtime.ts'
import { WorkbenchApiError } from '../src/client/model/api.ts'
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
  resultsUnrecorded: zh['sqlnotebook.resultsUnrecorded'],
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
  disconnectHint: zh['sqlnotebook.disconnectHint'],
  memoryNotice: zh['sqlnotebook.memoryNotice'],
  walSidecarNotice: zh['sqlnotebook.walSidecarNotice'],
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
  resultRows: count => zh['sqlnotebook.resultRows'].replace('{count}', String(count)),
  rowsTruncated: limit => zh['sqlnotebook.rowsTruncated'].replace('{limit}', String(limit)),
  columnsDropped: count => zh['sqlnotebook.columnsDropped'].replace('{count}', String(count)),
  valuesTruncated: count => zh['sqlnotebook.valuesTruncated'].replace('{count}', String(count)),
  deadline: ms => zh['sqlnotebook.deadline'].replace('{ms}', String(ms)),
  changes: count => zh['sqlnotebook.changes'].replace('{count}', String(count)),
  emptyRows: zh['sqlnotebook.emptyRows'],
  pager: zh['sqlnotebook.pager'],
  previousPage: zh['sqlnotebook.previousPage'],
  nextPage: zh['sqlnotebook.nextPage'],
  pagerPosition: (page, pageCount, from, to) => zh['sqlnotebook.pagerPosition']
    .replace('{page}', String(page))
    .replace('{pageCount}', String(pageCount))
    .replace('{from}', String(from))
    .replace('{to}', String(to)),
}

const markdownLabels = {} as never

function block(overrides: Partial<SqlResultBlock> = {}): SqlResultBlock {
  return sqlBlock([{ label: 'x', name: 'x', type: 'INTEGER' }], [[1]], overrides)
}

/**
 * The body rows currently rendered.
 *
 * Read from the DOM rather than from the block handed to the component: the page a reader is on is
 * a fact about what is on screen, and an assertion that recomputed the slice in the test would pass
 * while the view showed something else.
 */
function rowsShown(container: HTMLElement): HTMLTableRowElement[] {
  return [...container.querySelectorAll<HTMLTableRowElement>('tbody tr')]
}

/** One visible cell's text, addressed by row and column rather than by content. */
function cellText(container: HTMLElement, rowIndex: number, columnIndex: number): string | undefined {
  return rowsShown(container)[rowIndex]?.cells[columnIndex]?.textContent ?? undefined
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
  /** The workspace walk the picker drives, so a case can assert it was not needed. */
  listDirectory: ReturnType<typeof vi.fn>
  /** The draft the tab holds — what a save would write, and what a reopen would read. */
  box: { current: string }
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
  /** Whether the Host says a read-only WAL connection will leave -wal/-shm behind. */
  walExpected?: boolean
  /** Replaces the open answer entirely, so a case can make the connect refuse. */
  open?: () => Promise<unknown>
  /** Whether the workspace walk stopped at its cap, so the picker's list is not everything. */
  scanTruncated?: boolean
  /** Overrides the walked entries *and* marks the listing itself truncated. */
  scanEntries?: WorkspaceEntry[]
  /** Never answers the walk, so a case can assert what the toolbar shows before it returns. */
  holdScan?: boolean
} = {}): Harness {
  const onEdit = vi.fn()
  const onSave = vi.fn()
  // The draft the surface and the runtime both read: an edit writes it before it repaints, so a
  // queued cell sees the text that is in its cell when its turn comes.
  const box = { current: draft }
  /**
   * How the runtime's own write reaches the rendered surface.
   *
   * The real tab owns the draft, so a write from the runtime repaints exactly as typing does. The
   * fixture has to model that, or a test could assert "the result is in the file" while the screen
   * still shows the pre-run document.
   */
  let setDraftIntoHost: (text: string) => void = () => undefined
  const api = {
    // The handle answers with the target it was asked for. A fake that always said `demo.db` would
    // make every "is this the in-memory database" assertion below pass for the wrong reason — and
    // one of them would fail, which is how this was caught.
    sqlOpen: vi.fn(options.open ?? ((request: { path: string; access?: string }) => Promise.resolve({
      path: request.path, access: (request.access ?? 'read-only') as 'read-only' | 'writable',
      sqliteVersion: '3.46.0', walSidecarExpected: options.walExpected ?? false, rowLimit: 1000,
    }))),
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
  const runtime = new SqlRuntime(api as never, { info: vi.fn(), warn: vi.fn() }, {
    getDraft: () => box.current,
    /**
     * A run records its results in the file (ADR 0007), so this write goes through the same
     * `onEdit` the reader's own typing uses — not straight into `box`. Routing it around the
     * callback would make every "what did the run write" assertion here pass without the surface
     * ever being told, which is exactly the shape of test this fixture must not become.
     */
    setDraft: (_tabId, text) => { box.current = text; onEdit(text); setDraftIntoHost(text) },
    save: onSave,
  })
  const root: DirectoryListing = {
    path: '',
    entries: options.scanEntries ?? options.entries ?? [{ name: 'demo.db', path: 'demo.db', kind: 'file' }],
    // Two ways the scan says "this is not everything": its own directory budget, or a listing the
    // Host already truncated. Either has to reach the picker's title, so the fixture can set it.
    truncated: options.scanTruncated ?? false,
  }
  const listDirectory = vi.fn((path: string) => options.holdScan === true
    // Never settles: the reader's first paint is then strictly before any walk result, which is
    // the only way to assert that the toolbar does not need the walk to name the notebook's own
    // database.
    ? new Promise<never>(() => undefined)
    : Promise.resolve(path === '' ? root : { path, entries: [], truncated: false }))
  /**
   * The draft held in state, the way the file tab holds it.
   *
   * A fixed prop would let a reorder test assert on the text the surface wrote while the screen
   * it claims to show never moved — and would leave the runtime reading a draft the reader has
   * already rearranged, which is the one case the re-keying below exists for.
   */
  function SurfaceHost() {
    const [text, setText] = useState(draft)
    // A runtime write repaints the surface the way a typed edit does, so the two writers of the
    // draft are one path here as they are in the real tab.
    setDraftIntoHost = setText
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
  return { view, onEdit, onSave, api, connect, listDirectory, box }
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
    // By text rather than by `getByRole('status')`: an unreadable file shows two notices (why it
    // cannot be read, and that its results will not be kept), and asserting on the exact sentence is
    // what this case is actually about.
    expect(view.getByText(labels.unsupportedVersion)).toBeTruthy()
    expect(view.queryByRole('textbox')).toBeNull()
    expect(view.getByText('SELECT 1')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: labels.deleteCell }))
    expect(onEdit).not.toHaveBeenCalled()
  })

  it('says up front that a notebook it cannot rewrite will not keep its results', () => {
    // The consequence a reader has to know before they run anything: with this file, the answer stays
    // on screen and nothing goes to disk. Silence here is discovered as lost work.
    const { view } = open(notebookDraft([{ kind: 'sql', source: 'SELECT 1' }], SQLNB_VERSION + 1))
    expect(view.getByText(labels.resultsUnrecorded)).toBeTruthy()
  })

  it('does not claim results are unrecorded for a file it can rewrite', () => {
    const { view } = open(notebookDraft([{ kind: 'sql', source: 'SELECT 1' }]))
    expect(view.queryByText(labels.resultsUnrecorded)).toBeNull()
  })

  it('points at the source view when the file is not valid JSON', () => {
    const { view } = open('{"version": 1, "cells": [')
    // Two places, deliberately: the banner above the cells and the empty state that stands in for the
    // cells this file has none of. Both send the reader to the same fix, so both are asserted.
    expect(view.getAllByText(labels.invalidJson).length).toBeGreaterThan(0)
    expect(view.queryByRole('textbox')).toBeNull()
    expect((view.getByRole('button', { name: labels.addSqlCell }) as HTMLButtonElement).disabled).toBe(true)
  })

  /**
   * Reopening a notebook (ADR 0007): the file remembers the database and the results, so the reader
   * lands on a notebook that is already connected and already shows what it ran.
   */
  it('connects on open to the database the file records, without the reader picking one', async () => {
    const draft = JSON.stringify({
      version: 2,
      connection: { path: 'demo.db', access: 'read-only' },
      cells: [{ kind: 'sql', source: 'SELECT 1' }],
    })
    const harness = open(draft)

    await waitFor(() => { expect(harness.api.sqlOpen).toHaveBeenCalled() })
    expect(harness.api.sqlOpen).toHaveBeenCalledWith({
      workspaceId: 'workspace-1', notebook: 'query.sqlnb', path: 'demo.db', access: 'read-only',
    })
    // The run button is live, which is the reader-visible half: a notebook that reconnects must be
    // immediately runnable rather than merely labelled.
    await waitFor(() => {
      expect((harness.view.getAllByRole('button', { name: labels.runCell })[0] as HTMLButtonElement).disabled).toBe(false)
    })
  })

  /**
   * The reported bug, on the surface the reader actually uses: a notebook whose file records both a
   * database and results must show the tables *after* the automatic connect lands, not only before
   * it. The original version of this case asserted synchronously, which sampled the render between
   * hydration and the connect — the one instant where the bug was invisible.
   *
   * The fixture is the shape a real session writes (three cells, `connection` last, ascending
   * `execution_count` per cell), because that is the file the reader reported opening.
   */
  it('still shows the recorded results after the automatic connect lands', async () => {
    const result = (columns: string[], rows: Array<Array<string | number>>) => ({
      columns: columns.map(label => ({ label, name: label, type: label === 'id' ? 'INTEGER' : 'TEXT' })),
      rows,
      rowLimit: 1000,
      truncated: false,
      columnsDropped: 0,
      valuesTruncated: 0,
    })
    const draft = JSON.stringify({
      version: 2,
      cells: [
        { kind: 'sql', source: 'SELECT * from city', execution_count: 1, elapsed_ms: 0, results: [result(['id', 'name'], [[1, 'Tokyo'], [2, 'Osaka']])] },
        { kind: 'sql', source: 'select * from country', execution_count: 2, elapsed_ms: 0, results: [result(['name'], [['Japan']])] },
        { kind: 'sql', source: 'SELECT name FROM sqlite_master', execution_count: 3, elapsed_ms: 1, results: [result(['name'], [['city']])] },
      ],
      connection: { path: 'demo.db', access: 'read-only' },
    })
    const harness = open(draft)

    await waitFor(() => { expect(harness.api.sqlOpen).toHaveBeenCalled() })
    // The connection is live and the reader can run again, and every recorded cell still shows its
    // own rows and its own prompt number.
    await waitFor(() => {
      expect((harness.view.getAllByRole('button', { name: labels.runCell })[0] as HTMLButtonElement).disabled).toBe(false)
    })
    expect(harness.view.getByText('Tokyo')).toBeTruthy()
    expect(harness.view.getByText('Osaka')).toBeTruthy()
    expect(harness.view.getByText('Japan')).toBeTruthy()
    expect(harness.view.getByText('city')).toBeTruthy()
    expect(harness.view.getByText('In[1]')).toBeTruthy()
    expect(harness.view.getByText('In[3]')).toBeTruthy()
    expect(harness.view.getByText(labels.elapsed(1))).toBeTruthy()
  })

  /**
   * The notebook whose file already records a database must not flash a "connecting…"
   * placeholder on the first paint (ADR 0007): the file is the only thing that can answer
   * before the auto-connect lands, and the status bar must answer from it. The earlier
   * version of this surface routed `runState === null` to the placeholder, which read as
   * a "not connected" line sitting under tables the file had just loaded — the user
   * reported it as "disconnected while loading". The auto-connect still races, but the bar
   * says the path and tier the file recorded for the whole stretch, and the Host's answer
   * (which carries the row cap) only refines it.
   *
   * The case holds `sqlOpen` so the auto-connect is paused on the wire: without the
   * fallback the bar would have nowhere to look but `runState`, which is `null` until
   * `bind` runs in the effect.
   */
  it('does not flash a connecting placeholder on first paint when the file already records a database', () => {
    const draft = JSON.stringify({
      version: 2,
      cells: [{ kind: 'sql', source: 'SELECT 1' }],
      connection: { path: 'demo.db', access: 'read-only' },
    })
    const held = new Promise<{ path: string; access: 'read-only'; sqliteVersion: string; walSidecarExpected: boolean; rowLimit: number }>(() => undefined)
    const harness = open(draft, { open: () => held })
    // The file recorded `demo.db` as read-only, so the very first synchronous render should
    // already say so — no "connecting…" placeholder, no "not connected" line.
    expect(harness.view.queryByText(labels.connecting)).toBeNull()
    expect(harness.view.queryByText(labels.notConnected)).toBeNull()
    // Asserted as the bar's whole sentence rather than a `/demo\.db/` search: the path also
    // appears as the picker's selected option, and a loose match would pass on either one while
    // the bar itself said nothing. This is the line that must carry the path *and* the tier, and
    // must not yet carry a cap — `connectionReadout` drops that until the Host answers with one.
    expect(harness.view.getByText(`demo.db · ${labels.readOnlyTier}`)).toBeTruthy()
  })

  it('opens a file that records no database without connecting anything', async () => {
    // A notebook created from nothing has no database to return to, and `:memory:` must not be
    // guessed for it: its first query would then run against an empty database.
    const harness = open(notebookDraft([{ kind: 'sql', source: 'SELECT 1' }]))

    await new Promise(resolve => { setTimeout(resolve, 0) })

    expect(harness.api.sqlOpen).not.toHaveBeenCalled()
    expect(harness.view.getByText(labels.notConnected)).toBeTruthy()
    expect((harness.view.getAllByRole('button', { name: labels.runCell })[0] as HTMLButtonElement).disabled).toBe(true)
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
    } as never, { info: vi.fn(), warn: vi.fn() }, { getDraft: () => draft, setDraft: vi.fn(), save: vi.fn() })
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

  /**
   * The reported bug: the toolbar's database picker took "ages" to name the notebook's database.
   *
   * Nothing was slow. A `<select>` whose `value` matches no `<option>` renders **blank** — the
   * browser falls back to the first option — so the recorded path sat in `pickPath` from the first
   * render while the box kept showing the placeholder, and it only appeared once a full workspace
   * walk happened to return an option for it. The value was always right; the control had nothing
   * to draw it with.
   *
   * The walk is held open here so the assertion lands strictly before it returns: if the picker
   * needs the walk to display its own record, this fails.
   */
  it('names the recorded database before the workspace walk returns', () => {
    const draft = JSON.stringify({
      version: 2,
      connection: { path: 'examples/demo.db', access: 'read-only' },
      cells: [{ kind: 'sql', source: 'SELECT 1' }],
    })
    const harness = open(draft, { holdScan: true })
    const picker = harness.view.getByRole('combobox', { name: labels.database }) as HTMLSelectElement

    // The walk has been *asked* — that is correct and happens on mount — but it has not answered.
    expect(harness.listDirectory).toHaveBeenCalled()
    // Nothing the walk could have contributed is on screen yet: only the placeholder, `:memory:`,
    // and the record the file itself carries.
    expect([...picker.options].map(option => option.value))
      .toEqual(['', ':memory:', 'examples/demo.db'])
    // And the record is already the selected, visible answer.
    expect(picker.value).toBe('examples/demo.db')
    expect(picker.selectedOptions[0]?.textContent).toBe('examples/demo.db')
  })

  it('does not list the recorded database twice once the walk names it too', async () => {
    const draft = JSON.stringify({
      version: 2,
      connection: { path: 'examples/demo.db', access: 'read-only' },
      cells: [{ kind: 'sql', source: 'SELECT 1' }],
    })
    const harness = open(draft, { scanEntries: [{ name: 'demo.db', path: 'examples/demo.db', kind: 'file' }] })
    const picker = harness.view.getByRole('combobox', { name: labels.database }) as HTMLSelectElement

    await waitFor(() => { expect(picker.options.length).toBeGreaterThan(2) })
    expect([...picker.options].filter(option => option.value === 'examples/demo.db')).toHaveLength(1)
    expect(picker.value).toBe('examples/demo.db')
  })

  it('still lists the walk’s databases for a notebook that records none', async () => {
    // The negative control: the recorded path is prepended only when there is one, so a notebook
    // with no record keeps showing exactly what the walk found.
    const harness = open(notebookDraft([{ kind: 'sql', source: 'SELECT 1' }]))
    const picker = harness.view.getByRole('combobox', { name: labels.database }) as HTMLSelectElement

    await waitFor(() => { expect([...picker.options].some(option => option.value === 'demo.db')).toBe(true) })
    expect(picker.value).toBe('')
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

  it('does not expose the tier as a picker in the toolbar; the status bar carries it instead', async () => {
    // The toolbar used to hold a `<select>` for the tier, and a separate test used to assert
    // that the select was disabled while a handle was open. The tier is now a fact about the
    // handle, not a control: it lives in the status bar alongside the path, and a notebook that
    // wants a different tier reconnects to a different target. A `<select>` would be one more
    // thing to scan in a row of icons.
    const harness = open(notebookDraft([{ kind: 'sql', source: 'SELECT 1' }]))
    expect(harness.view.queryByRole('combobox', { name: labels.readOnlyTier })).toBeNull()
    expect(harness.view.queryByRole('combobox', { name: labels.writableTier })).toBeNull()

    await harness.connect()
    // After the connect, the status bar reads the path · tier · rowLimit; that one line is the
    // reader's only way to see the tier, and it changes only when the handle itself does.
    await harness.view.findByText('demo.db · 只读 · 1000')
  })

  /**
   * The cost of disconnecting, stated before the click rather than after the loss.
   *
   * `ca2296c` found this hint sitting on the sidebar's button while the toolbar's said nothing, and
   * left it alone as out of scope for a deletion. The sidebar's button is gone now (ADR 0008), so
   * the sentence would have vanished with it if it had not moved here.
   */
  it('says what disconnecting costs on the button that does it', async () => {
    const harness = open(notebookDraft([{ kind: 'sql', source: 'SELECT 1' }]))
    await harness.connect()

    const disconnect = harness.view.getByRole('button', { name: labels.disconnect })
    expect(disconnect.getAttribute('title')).toBe(labels.disconnectHint)
  })

  // The two standing facts about a live handle moved with the control they describe, and stayed
  // lines rather than becoming tooltips: an in-memory database is still evaporating while the reader
  // is four queries in, and a WAL sidecar is still there after the handle closes.
  // The two standing facts about the live handle used to render as a line above the cells. They
  // moved into the editor's status strip (the `attachment` slot `EditorStatusBar` already owns),
  // so the cell surface no longer carries them — the strip outlives the cell view and is the
  // right home for a fact the reader needs to know about the handle, not about the cell. The
  // behaviour each test pinned now lives in `sql-connection-status.spec.tsx`, with a fixture that
  // renders the same component the workbench wires into the strip.

  it('does not put the in-memory notice above the cells, because the strip is the home for it', async () => {
    const harness = open(notebookDraft([{ kind: 'sql', source: 'SELECT 1' }]))
    const picker = harness.view.getByRole('combobox', { name: labels.database }) as HTMLSelectElement
    await waitFor(() => { expect(picker.options.length).toBeGreaterThan(2) })
    fireEvent.change(picker, { target: { value: ':memory:' } })
    fireEvent.click(harness.view.getByRole('button', { name: labels.connect }))

    // The picker change is what triggers the connect; wait for the handle to land before sampling
    // the surface, otherwise the read races the connect.
    await harness.view.findByText(labels.memoryDatabase)
    expect(harness.view.container.textContent).not.toContain(labels.memoryNotice)
  })

  it('does not put the WAL sidecar notice above the cells, because the strip is the home for it', async () => {
    const harness = open(notebookDraft([{ kind: 'sql', source: 'SELECT 1' }]), { walExpected: true })
    await harness.connect()

    // Same reasoning as the memory test: the connect must land before the read.
    expect(harness.view.container.textContent).not.toContain(labels.walSidecarNotice)
  })

  /**
   * A short database list that claims to be complete is the failure `scanTruncated` exists to
   * prevent — and the reader is only wondering it while pointing at the picker, which is why the
   * caveat rides on that control rather than on a line above the cells.
   */
  it('marks the picker as holding only part of the workspace when the walk was cut short', async () => {
    const harness = open(notebookDraft([{ kind: 'sql', source: 'SELECT 1' }]), { scanTruncated: true })
    const picker = harness.view.getByRole('combobox', { name: labels.database }) as HTMLSelectElement
    await waitFor(() => { expect(picker.options.length).toBeGreaterThan(1) })

    expect(picker.title).toBe(labels.scanTruncated)
  })

  it('leaves the picker without that caveat when the walk saw everything', async () => {
    const harness = open(notebookDraft([{ kind: 'sql', source: 'SELECT 1' }]))
    const picker = harness.view.getByRole('combobox', { name: labels.database }) as HTMLSelectElement
    await waitFor(() => { expect(picker.options.length).toBeGreaterThan(1) })

    expect(picker.getAttribute('title')).toBeNull()
  })

  /**
   * A refused connect has to say which gate it was, on the surface that did the refusing.
   *
   * This case used to live in the panel spec, because the panel was the other place a reader could
   * connect. ADR 0008 left the toolbar the only one, and 未连接 alone would send the reader to press
   * the same button again: the Host's own line names the notebook that holds the file writable.
   */
  it('shows why a connect was refused instead of looking unconnected', async () => {
    const harness = open(notebookDraft([{ kind: 'sql', source: 'SELECT 1' }]), {
      open: () => Promise.reject(new WorkbenchApiError('SQL_WRITE_OCCUPIED', '该库文件已被其它笔记的连接占用。')),
    })
    await harness.connect()

    expect((await harness.view.findByRole('alert')).textContent).toContain('该库文件已被其它笔记的连接占用。')
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
    // The declared type is still shown; it now sits beside the name in the same header cell.
    expect(harness.view.getByText('INTEGER')).toBeTruthy()
    expect(harness.view.getByText('In[1]')).toBeTruthy()
    expect(harness.view.getByText(labels.elapsed(42))).toBeTruthy()
    /**
     * A settled run is recorded in the file (ADR 0007): the draft the tab holds now carries the
     * result and the prompt number, and the notebook is saved. This is the assertion that would
     * have been `not.toHaveBeenCalled()` under ADR 0003 — the behaviour flipped, so the test did.
     */
    const written = parseSqlNotebook(harness.box.current)
    expect(written.cells[0]?.blocks[0]?.rows).toEqual([[7, 'Tokyo']])
    expect(written.cells[0]?.executionCount).toBe(1)
    expect(harness.onSave).toHaveBeenCalled()
  })

  /**
   * A cell with a single very long value used to push the whole row's height to a hundred lines,
   * collapsing every neighbouring column into a sliver and the page along with it. The cell now
   * carries the value in a clamp container, and the full text rides on the `title` attribute so a
   * hover surfaces it without forcing the table open again — that is the contract the CSS line-clamp
   * depends on, and a regression that lost `title` would lose the value as far as the reader is
   * concerned.
   */
  it('clamps a runaway text value to a fixed number of lines and keeps the full text on hover', async () => {
    const long = '段落文字'.repeat(2000)
    const harness = open(notebookDraft([{ kind: 'sql', source: 'SELECT 1' }]), {
      blocks: [block({ columns: [{ label: 'name', name: 'name' }], rows: [[long]] })],
    })
    await harness.connect()
    fireEvent.click(harness.view.getAllByRole('button', { name: labels.runCell })[0] as HTMLElement)

    const cell = await harness.view.findByText(long)
    expect(cell, 'the cell must render the full value, not a summary').toBeTruthy()
    // The clamp container is a class we can name — a CSS-module hash is no use to a test that has
    // to assert the value still rides on a hover, and `tagName` would not survive a future change
    // from `<span>` to anything else. Class is the only name the test can keep while the renderer
    // does not.
    expect(cell.className).toMatch(/resultText/u)
    // The full string must still be reachable: the ellipsis on screen is a presentation, not a
    // loss. A clamp that forgot to put the value on `title` would be the same as a delete, so
    // this is the assertion that catches it.
    expect(cell.getAttribute('title')).toBe(long)
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

  /**
   * The admissions moved above the table.
   *
   * They used to sit in a strip under it, so a block that hit the row cap pushed the sentence
   * "this table is not complete" below the very rows it described — the reader had to scroll past a
   * thousand rows to learn they were not all there. Asserting they share one bar with the row count
   * is what pins the order, since jsdom lays nothing out.
   */
  it('states the row count and the block’s admissions in one bar above the table', async () => {
    const harness = open(notebookDraft([{ kind: 'sql', source: 'SELECT 1' }]), {
      blocks: [block({ truncated: true, rowLimit: 1000, columnsDropped: 7 })],
    })
    await harness.connect()
    fireEvent.click(harness.view.getAllByRole('button', { name: labels.runCell })[0] as HTMLElement)

    const count = await harness.view.findByText(resultLabels.resultRows(1))
    const bar = count.parentElement
    expect(bar?.textContent).toContain(resultLabels.rowsTruncated(1000))
    expect(bar?.textContent).toContain(resultLabels.columnsDropped(7))
    // The table is a sibling after the bar, not something the bar sits inside.
    expect(bar?.parentElement?.querySelector('table')).toBeTruthy()
  })

  it('right-aligns the columns whose values are numbers, and only those', async () => {
    const harness = open(notebookDraft([{ kind: 'sql', source: 'SELECT 1' }]), {
      blocks: [sqlBlock(
        [
          { label: 'id', name: 'id', type: 'INTEGER' },
          { label: 'who', name: 'who', type: 'TEXT' },
          { label: 'big', name: 'big', type: 'INTEGER' },
        ],
        // `big` is what the Host sends for an out-of-range INTEGER: a decimal string. Left-aligned
        // because of its JavaScript type, it would sit apart from the numbers it belongs with.
        [[1, 'Tokyo', '9007199254740993'], [2, 'Osaka', '2700000']],
      )],
    })
    await harness.connect()
    fireEvent.click(harness.view.getAllByRole('button', { name: labels.runCell })[0] as HTMLElement)
    await harness.view.findByText('Tokyo')

    const heads = harness.view.getAllByRole('columnheader')
    expect(heads.map(head => head.getAttribute('data-numeric'))).toEqual(['true', null, 'true'])
    // Two rows × three columns: the numeric ones carry the marker, the text column carries none.
    expect(harness.view.container.querySelectorAll('td[data-numeric]')).toHaveLength(4)
  })

  it('keeps the header to one row, with the declared type inside the cell it describes', async () => {
    const harness = open(notebookDraft([{ kind: 'sql', source: 'SELECT 1' }]), {
      blocks: [block({
        columns: [{ label: 'id', name: 'id', type: 'INTEGER' }, { label: 'who', name: 'who' }],
        rows: [[7, 'Tokyo']],
      })],
    })
    await harness.connect()
    fireEvent.click(harness.view.getAllByRole('button', { name: labels.runCell })[0] as HTMLElement)
    await harness.view.findByText('Tokyo')

    // One header row rather than two: the type used to occupy its own row under every label, which
    // made the header twice as tall and put the type out of sight of the name it describes.
    const heads = harness.view.getAllByRole('columnheader')
    expect(heads).toHaveLength(2)
    expect(heads[0]?.textContent).toBe('idINTEGER')
    // A column with no declared type says nothing rather than inventing one.
    expect(heads[1]?.textContent).toBe('who')
  })

  it('pages a long answer at fifty rows a page and moves through it', async () => {
    // The pager exists to keep a thousand-row answer readable, so the assertions are about the rows
    // on screen: the first page shows rows 1–50, the second shows 51–100, and neither shows the
    // other's data. A slice bug (dropping or repeating a row at the seam) shows here and nowhere
    // else, because the underlying answer is the same array either way.
    const harness = open(notebookDraft([{ kind: 'sql', source: 'SELECT * FROM t' }]), {
      blocks: [block({
        columns: [{ label: 'i', name: 'i', type: 'INTEGER' }],
        rows: Array.from({ length: 120 }, (_unused, index) => [index + 1]),
      })],
    })
    await harness.connect()
    fireEvent.click(harness.view.getAllByRole('button', { name: labels.runCell })[0] as HTMLElement)

    const group = await harness.view.findByRole('group', { name: resultLabels.pager })
    // `toContain`, not `toBe`: the group's text carries the two arrow glyphs as well, and the fact
    // under test is that the readout states the page and the row span, not what else is in the row.
    expect(group.textContent).toContain(resultLabels.pagerPosition(1, 3, 1, 50))
    expect(rowsShown(harness.view.container)).toHaveLength(50)
    expect(cellText(harness.view.container, 0, 0)).toBe('1')
    expect(cellText(harness.view.container, 49, 0)).toBe('50')

    const next = harness.view.getByRole('button', { name: resultLabels.nextPage })
    fireEvent.click(next)
    await waitFor(() => { expect(cellText(harness.view.container, 0, 0)).toBe('51') })
    expect(group.textContent).toContain(resultLabels.pagerPosition(2, 3, 51, 100))
    expect(rowsShown(harness.view.container)).toHaveLength(50)
    // Row 1 is no longer on screen: the page replaced it rather than appending to it.
    expect(harness.view.queryByText('1')).toBeNull()

    fireEvent.click(harness.view.getByRole('button', { name: resultLabels.previousPage }))
    await waitFor(() => { expect(cellText(harness.view.container, 0, 0)).toBe('1') })
    expect(group.textContent).toContain(resultLabels.pagerPosition(1, 3, 1, 50))
  })

  it('stops the arrows at the ends rather than wrapping past the answer', async () => {
    const harness = open(notebookDraft([{ kind: 'sql', source: 'SELECT * FROM t' }]), {
      blocks: [block({
        columns: [{ label: 'i', name: 'i', type: 'INTEGER' }],
        rows: Array.from({ length: 120 }, (_unused, index) => [index + 1]),
      })],
    })
    await harness.connect()
    fireEvent.click(harness.view.getAllByRole('button', { name: labels.runCell })[0] as HTMLElement)
    await harness.view.findByRole('group', { name: resultLabels.pager })

    const previous = harness.view.getByRole('button', { name: resultLabels.previousPage }) as HTMLButtonElement
    const next = harness.view.getByRole('button', { name: resultLabels.nextPage }) as HTMLButtonElement
    // The first page cannot go back, and the last cannot go forward: wrapping would send a reader
    // hunting for a row they had already passed, believing the table had more of the answer in it.
    expect(previous.disabled).toBe(true)
    expect(next.disabled).toBe(false)

    fireEvent.click(next)
    fireEvent.click(next)
    await waitFor(() => { expect(next.disabled).toBe(true) })
    expect(previous.disabled).toBe(false)
    // Page 3 holds the twenty rows the answer has left, and says so.
    expect(harness.view.getByRole('group', { name: resultLabels.pager }).textContent)
      .toContain(resultLabels.pagerPosition(3, 3, 101, 120))
    expect(rowsShown(harness.view.container)).toHaveLength(20)
  })

  it('aligns a column by the whole answer, not by the page showing', async () => {
    // The trap the pager could have set: alignment decided from the visible fifty rows would call
    // page 1 a number column and the last page a text one, so the same column would shift under the
    // reader as they turned the page — data changing, rather than a page being turned.
    //
    // One text value anywhere in the answer makes the column not numeric (`isNumericColumn` says
    // so), so the whole answer decides *no* page of it is numeric. Asserting page 1 is the
    // discriminating half: per-page arithmetic would have right-aligned it.
    const harness = open(notebookDraft([{ kind: 'sql', source: 'SELECT * FROM t' }]), {
      blocks: [block({
        columns: [{ label: 'v', name: 'v', type: 'INTEGER' }],
        rows: [...Array.from({ length: 119 }, (_unused, index) => [index + 1]), ['n/a']],
      })],
    })
    await harness.connect()
    fireEvent.click(harness.view.getAllByRole('button', { name: labels.runCell })[0] as HTMLElement)

    const head = async (): Promise<HTMLElement> => await harness.view.findByRole('columnheader')
    expect((await head()).getAttribute('data-numeric')).toBeNull()

    fireEvent.click(harness.view.getByRole('button', { name: resultLabels.nextPage }))
    await waitFor(() => { expect(cellText(harness.view.container, 0, 0)).toBe('51') })
    expect((await head()).getAttribute('data-numeric')).toBeNull()
    // The row carrying the text is on the last page, and it stays with the text columns.
    fireEvent.click(harness.view.getByRole('button', { name: resultLabels.nextPage }))
    await waitFor(() => { expect(harness.view.getByText('n/a')).toBeTruthy() })
    expect((await head()).getAttribute('data-numeric')).toBeNull()
  })

  it('gives an answer that fits on one page no pager at all', async () => {
    // The old placeholder appeared on a truncated block, which is a different fact: rows beyond the
    // cap were never delivered, and the notice above the table says so. Offering a second page for
    // those would promise a page that cannot exist.
    const harness = open(notebookDraft([{ kind: 'sql', source: 'SELECT 1' }]), {
      blocks: [block({ truncated: true, rowLimit: 1000 })],
    })
    await harness.connect()
    fireEvent.click(harness.view.getAllByRole('button', { name: labels.runCell })[0] as HTMLElement)
    await harness.view.findByText('In[1]')

    expect(harness.view.queryByRole('group', { name: resultLabels.pager })).toBeNull()
    // The cap's own sentence is still there, which is what carries the truth about undelivered rows.
    expect(harness.view.getByText(resultLabels.rowsTruncated(1000))).toBeTruthy()
  })

  it('holds the row count over the whole answer, not the page', async () => {
    // The headline says how many rows the block holds. Paging changes what is on screen, not what was
    // delivered, so a count that dropped to 50 would report the answer as shorter than it is.
    const harness = open(notebookDraft([{ kind: 'sql', source: 'SELECT * FROM t' }]), {
      blocks: [block({
        columns: [{ label: 'i', name: 'i', type: 'INTEGER' }],
        rows: Array.from({ length: 120 }, (_unused, index) => [index + 1]),
      })],
    })
    await harness.connect()
    fireEvent.click(harness.view.getAllByRole('button', { name: labels.runCell })[0] as HTMLElement)

    await harness.view.findByRole('group', { name: resultLabels.pager })
    const count = () => harness.view.getByText(resultLabels.resultRows(120)).textContent
    expect(count()).toBe(resultLabels.resultRows(120))
    fireEvent.click(harness.view.getByRole('button', { name: resultLabels.nextPage }))
    await waitFor(() => { expect(rowsShown(harness.view.container)).toHaveLength(50) })
    // Read as text rather than by node identity: React is free to reuse or replace the span, and the
    // claim is that the headline still reports the whole answer, not that it is the same element.
    expect(count()).toBe(resultLabels.resultRows(120))
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

  it('clears what a run put on screen and in the file', async () => {
    const harness = open(notebookDraft([{ kind: 'sql', source: 'SELECT 1' }]))
    await harness.connect()
    fireEvent.click(harness.view.getAllByRole('button', { name: labels.runCell })[0] as HTMLElement)
    await harness.view.findByText('In[1]')
    expect(parseSqlNotebook(harness.box.current).cells[0]?.blocks).toHaveLength(1)

    fireEvent.click(harness.view.getByRole('button', { name: labels.clearAllOutputs }))

    await waitFor(() => { expect(harness.view.queryByText('In[1]')).toBeNull() })
    // The file is cleared with the screen: blocks left behind would come back on the next open,
    // which is the opposite of what this button means (ADR 0007).
    expect(parseSqlNotebook(harness.box.current).cells[0]?.blocks).toEqual([])
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

/**
 * The result grid carries column rules, and its outer ring belongs to the cell that holds it.
 *
 * Asserted against the stylesheet because jsdom applies none: a DOM test cannot see a cell's
 * border, so nothing above would have caught this. It is written down because the column rules
 * have already been removed once — the design sheet draws horizontal rules only, which looks right
 * in a mockup whose columns are narrow and wrong against a real result, where column widths follow
 * the values and a value then sits far from the header naming it. Whoever trims the grid again has
 * to argue with a failing test rather than with a screenshot.
 */
describe('SqlResultBlockView 结果表', () => {
  it('draws a column rule on every cell, not only a row rule', () => {
    const stylesheet = readFileSync(resolve(process.cwd(), 'src/client/sql/sql-notebook.module.css'), 'utf8')
    const block = (stylesheet.match(/\.resultTable th,\s*\.resultTable td \{[\s\S]*?\n\}/u) ?? [])[0]
    expect(block, 'the shared cell rule must exist').toBeDefined()
    // `border: 1px solid` sets all four sides. The horizontal-only form this replaced wrote
    // `border-block-end`, which leaves the columns open — so this is the shape that must hold.
    expect(block).toMatch(/border: 1px solid/u)
  })

  it('leaves the outer ring to the cell, so the grid is not a panel inside the panel', () => {
    const stylesheet = readFileSync(resolve(process.cwd(), 'src/client/sql/sql-notebook.module.css'), 'utf8')
    // Every cell draws four sides, then the four outermost ones are switched off: the container's
    // own border frames the grid. Without these the table floats inside its cell, framed twice.
    expect(stylesheet).toMatch(/\.resultTable tr > :first-child \{\s*border-inline-start: none;/u)
    expect(stylesheet).toMatch(/\.resultTable tr > :last-child \{\s*border-inline-end: none;/u)
    expect(stylesheet).toMatch(/\.resultTable thead th \{[^}]*border-block-start: none;/u)
    expect(stylesheet).toMatch(/\.resultTable tbody tr:last-child > td \{\s*border-block-end: none;/u)
    // And nothing insets the table from those borders, or the merge is undone by whitespace. The
    // assertion is on the shorthand, since that is the form an inset would be written in.
    const scroll = (stylesheet.match(/\.resultScroll \{[\s\S]*?\n\}/u) ?? [])[0]
    expect(scroll, '.resultScroll must exist').toBeDefined()
    expect(scroll).not.toMatch(/^\s*padding:/mu)
  })

  /*
   * A thousand-row answer used to push the pager past the fold: every row sat in the document, so
   * the block grew until the controls lived below the visible window. The table is now capped at a
   * height the pager stays under, and the header is glued to the top of that scrollport so the
   * column names are still there on the row a reader is looking at.
   *
   * Asserted against the stylesheet because jsdom does not lay anything out: nothing above can
   * catch a `max-height: 720px` that was dropped, or a sticky header that lost its `top: 0`.
   * Whoever widens the answer or the column count has to argue with a failing test.
   */
  it('caps the table scrollport, so a long result does not push the pager below the fold', () => {
    const stylesheet = readFileSync(resolve(process.cwd(), 'src/client/sql/sql-notebook.module.css'), 'utf8')
    const scroll = (stylesheet.match(/\.resultScroll \{[\s\S]*?\n\}/u) ?? [])[0]
    expect(scroll, '.resultScroll must exist').toBeDefined()
    // `max-height` is what gives a 1000-row answer a height the pager can stay under. An `overflow: auto`
    // without a height cap would still grow with the content, which is the failure this rule exists
    // to prevent.
    expect(scroll).toMatch(/max-height:\s*\d+px/u)
    // And it must actually scroll, not just clip: a long result on a one-screen window is the
    // problem, and `overflow: auto` is what makes the rule do that.
    expect(scroll).toMatch(/overflow:\s*auto/u)
    /*
     * And it must not be the half-screen value that was tried first: a 720px scrollport still
     * pushes a notebook with three results past one screen, and a 1000px one is no scrollport at
     * all on a small window. The number the rule says is the one the reader sees, so the
     * contract is on the literal — whoever widens this has to argue that a 16-row table is the
     * wrong target.
     */
    const match = scroll!.match(/max-height:\s*(\d+)px/u)
    expect(match, '.resultScroll must declare max-height in pixels').toBeTruthy()
    const captured = match![1]
    const value = Number(captured)
    expect(value).toBeGreaterThanOrEqual(360)
    expect(value).toBeLessThanOrEqual(560)
  })

  it('sticks the column header to the top of the table scrollport', () => {
    const stylesheet = readFileSync(resolve(process.cwd(), 'src/client/sql/sql-notebook.module.css'), 'utf8')
    // The `thead th` rule carries the sticky position. It is the one place that has the background
    // colour hiding the rows sliding under it, so the rule belongs there rather than on `tr` or `td`.
    const theadTh = (stylesheet.match(/\.resultTable thead th \{[\s\S]*?\n\}/u) ?? [])[0]
    expect(theadTh, '.resultTable thead th must exist').toBeDefined()
    // The three together — sticky / top / z-index — are what makes a header stay on top and not
    // render on top of the next row's text. A header that is sticky but transparent reads as a
    // typo, not as a header.
    expect(theadTh).toMatch(/position:\s*sticky/u)
    expect(theadTh).toMatch(/top:\s*0/u)
    expect(theadTh).toMatch(/z-index:\s*1/u)
  })

  /*
   * A single value with no newlines repeated until the row is a hundred lines tall used to push
   * every neighbouring column into a sliver and the page off the screen. The cell value now sits
   * in a clamp container that draws the ellipsis itself, not on the `td`, because `td` already
   * owns `pre-wrap` and `overflow-wrap: anywhere` for content that needs to break. Putting the
   * clamp there would also cut the header chip, the NULL symbol and the BLOB size, which are
   * already short and intentionally readable.
   *
   * Asserted against the stylesheet because jsdom does not lay anything out: the only fact a
   * regression can drop is the line-count itself, and an `-webkit-line-clamp` that was widened
   * to 100 would be a quiet change in the opposite direction — a test that sampled the rendered
   * height could not catch it. Whoever widens the clamp has to argue with a failing test.
   */
  it('clamps a long value to three lines, on the value container rather than the cell', () => {
    const stylesheet = readFileSync(resolve(process.cwd(), 'src/client/sql/sql-notebook.module.css'), 'utf8')
    const text = (stylesheet.match(/\.resultText \{[\s\S]*?\n\}/u) ?? [])[0]
    expect(text, '.resultText must exist').toBeDefined()
    // `display: -webkit-box` is the box model `-webkit-line-clamp` reads from. Without it the
    // line-clamp is ignored, which is the failure this rule exists to prevent: a clamped value
    // that still grew to the bottom of the viewport because the box was inline.
    expect(text).toMatch(/display:\s*-webkit-box/u)
    expect(text).toMatch(/-webkit-line-clamp:\s*3/u)
    // And the value has to actually be hidden, not just clipped: an `overflow: hidden` missing
    // here would leak the long value past the line the clamp set.
    expect(text).toMatch(/overflow:\s*hidden/u)
  })
})
