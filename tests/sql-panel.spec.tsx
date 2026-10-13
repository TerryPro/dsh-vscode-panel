// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { zh } from '../src/client/core/locales.ts'
import type { WorkbenchFileTab } from '../src/client/model/controller.ts'
import { WorkbenchApiError } from '../src/client/model/api.ts'
import { SqlPanel } from '../src/client/sql/SqlPanel.tsx'
import { parseSqlNotebook } from '../src/client/sql/sql-notebook-document.ts'
import { SqlRuntime } from '../src/client/sql/sql-runtime.ts'

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

// A box rather than a fixed object, so one case can put another tab on screen.
const workbench = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))
vi.mock('../src/client/model/use-workbench.ts', () => ({ useWorkbench: () => workbench.current }))

afterEach(() => {
  cleanup()
  workbench.current = {}
})

/** The panel's translator: the dictionary's own strings, with `{placeholder}` filled in. */
function translate(key: string, values?: Record<string, unknown>): string {
  let text = (zh as Record<string, string>)[key] ?? key
  for (const [name, value] of Object.entries(values ?? {})) text = text.replace(`{${name}}`, String(value))
  return text
}

const NOTEBOOK_DRAFT = JSON.stringify({ version: 1, cells: [{ kind: 'sql', source: 'SELECT 1' }] })

function notebookTab(path: string, draft = NOTEBOOK_DRAFT): WorkbenchFileTab {
  return {
    id: `file:${path}`,
    kind: 'file',
    path,
    file: { path, content: draft, version: '1', size: draft.length, markdown: false },
    image: null,
    draft,
    dirty: false,
    markdownMode: 'source',
    wrap: true,
    externalChange: null,
    gitBaseline: null,
    saving: false,
    outlineVisible: false,
    error: null,
  } as unknown as WorkbenchFileTab
}

/** One open notebook, active, with whatever else the case needs on top. */
function openNotebook(current: WorkbenchFileTab): void {
  workbench.current = { activeTabId: current.id, tabs: [current] }
}

interface Harness {
  view: ReturnType<typeof render>
  api: Record<string, ReturnType<typeof vi.fn>>
  /** The schema routes the panel calls: tables and columns. */
  schema: { sqlTables: ReturnType<typeof vi.fn>; sqlColumns: ReturnType<typeof vi.fn> }
  runtime: SqlRuntime
  setDraft: ReturnType<typeof vi.fn>
  consumeSidebarAction: ReturnType<typeof vi.fn>
  /** Pick a database and press connect, the way a reader does. */
  connect: (target?: string) => Promise<void>
}

function mount(options: {
  entries?: Array<{ name: string; path: string; kind: 'file' }>
  refuse?: WorkbenchApiError
  tables?: Array<{ name: string; kind: 'table' | 'view' }>
  tablesTruncated?: boolean
  tablesRefuse?: WorkbenchApiError
  columns?: Array<{ name: string; type?: string; notNull: boolean; primaryKey: boolean }>
  /** Whether the Host says a read-only WAL connection will leave -wal/-shm behind. */
  walExpected?: boolean
} = {}): Harness {
  const api = {
    // The handle answers with the target it was asked for: a fake that always says `demo.db` would
    // make every "is this the memory database" assertion pass for the wrong reason.
    sqlOpen: vi.fn((request: { path: string; access?: string }) => Promise.resolve({
      path: request.path,
      access: (request.access ?? 'read-only') as 'read-only' | 'writable',
      sqliteVersion: '3.46.0',
      walSidecarExpected: options.walExpected ?? false,
      rowLimit: 1000,
    })),
    sqlExecute: vi.fn(() => Promise.resolve({ path: 'demo.db', blocks: [], elapsedMs: 1, executionCount: 1 })),
    sqlClose: vi.fn(() => Promise.resolve({ path: 'demo.db', closed: true, rolledBack: false })),
    sqlAbandon: vi.fn(() => Promise.resolve({ path: 'demo.db', scheduled: true })),
    sqlCancel: vi.fn(() => Promise.resolve({ cancelled: false })),
  }
  if (options.refuse !== undefined) {
    const refusal = options.refuse
    api.sqlOpen = vi.fn(() => Promise.reject(refusal))
  }
  const schemaApi = {
    sqlTables: vi.fn(() => options.tablesRefuse === undefined
      ? Promise.resolve({ path: 'demo.db', tables: options.tables ?? [{ name: 'city', kind: 'table' as const }], truncated: options.tablesTruncated ?? false })
      : Promise.reject(options.tablesRefuse)),
    sqlColumns: vi.fn(() => Promise.resolve({
      path: 'demo.db',
      table: 'city',
      columns: options.columns ?? [{ name: 'id', type: 'INTEGER', notNull: false, primaryKey: true }],
    })),
  }
  const runtime = new SqlRuntime(api as never, { info: vi.fn(), warn: vi.fn() }, {
    /**
     * The open tab's draft, not a constant.
     *
     * The panel and the runtime both serve whatever notebook is on screen, so a fixture that hands
     * the runtime a different file from the one rendered would let them disagree — and would make the
     * auto-connect read a record the panel never showed. `workbench.current` is the same snapshot the
     * panel itself reads.
     */
    getDraft: () => {
      const tabs = (workbench.current['tabs'] ?? []) as Array<{ kind?: string; draft?: string }>
      return tabs.find(tab => tab.kind === 'file')?.draft ?? NOTEBOOK_DRAFT
    },
    setDraft: vi.fn(),
    save: vi.fn(),
  })
  const entries = options.entries ?? [
    { name: 'demo.db', path: 'demo.db', kind: 'file' as const },
    { name: 'demo.db-wal', path: 'demo.db-wal', kind: 'file' as const },
    { name: 'archive.sqlite', path: 'archive.sqlite', kind: 'file' as const },
  ]
  const setDraft = vi.fn()
  const consumeSidebarAction = vi.fn()
  const controller = {
    sqlRuntime: runtime,
    setDraft,
    consumeSidebarAction,
    api: {
      ...schemaApi,
      listDirectory: vi.fn((_workspaceId: string, path: string) => Promise.resolve(
        path === '' ? { path: '', entries, truncated: false } : { path, entries: [], truncated: false },
      )),
    },
  }
  const view = render(
    <SqlPanel
      controller={controller as never}
      workspaceId="workspace-1"
      t={translate}
    />,
  )
  /**
   * Connect the way a reader does: pick the database, press connect, wait for the handle.
   *
   * The wait for `断开` is what makes the schema assertions about a real connection rather than
   * about a click that has not come back yet.
   */
  async function connect(target = 'demo.db'): Promise<void> {
    const select = await view.findByLabelText(zh['sqlnotebook.database']) as HTMLSelectElement
    await waitFor(() => { expect(select.options.length).toBeGreaterThan(2) })
    fireEvent.change(select, { target: { value: target } })
    fireEvent.click(view.getByRole('button', { name: zh['sqlnotebook.connect'] }))
    await waitFor(() => { expect(api.sqlOpen).toHaveBeenCalled() })
    await waitFor(() => { expect(view.getByRole('button', { name: zh['sqlnotebook.disconnect'] })).toBeTruthy() })
  }

  return { view, api, schema: schemaApi, runtime, setDraft, connect, consumeSidebarAction }
}

describe('SqlPanel — 结构', () => {
  it('lists the connected database’s tables and marks a view as one', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount({
      tables: [
        { name: 'city', kind: 'table' },
        { name: 'city_summary', kind: 'view' },
      ],
    })
    await harness.connect()

    expect(await harness.view.findByRole('button', { name: /city\b/u })).toBeTruthy()
    const view = harness.view.getByRole('button', { name: /city_summary/u })
    // A view is listed beside tables but said to be one: the reader may read it and may not write
    // to it, which is exactly the difference that matters at this point.
    expect(view.textContent).toContain(zh['sqlnotebook.viewLabel'])
  })

  it('reads a table’s columns once, however often the row is opened and closed', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount()
    await harness.connect()

    const row = await harness.view.findByRole('button', { name: /city\b/u })
    fireEvent.click(row)
    expect(await harness.view.findByText('id')).toBeTruthy()
    expect(harness.view.getByText('INTEGER')).toBeTruthy()
    fireEvent.click(row)
    expect(harness.view.queryByText('id')).toBeNull()
    fireEvent.click(row)

    // Lazy means once per table, not once per click: re-asking the Host for a schema that has not
    // been told to change is a request per gesture.
    await waitFor(() => { expect(harness.view.getByText('id')).toBeTruthy() })
    expect(harness.view.container.querySelectorAll('li')).toHaveLength(1)
  })

  it('writes a SELECT * into a new cell when a table is double-clicked', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount({ tables: [{ name: 'ci"ty', kind: 'table' }] })
    await harness.connect()

    fireEvent.doubleClick(await harness.view.findByRole('button', { name: /ci"ty/u }))

    const written = harness.setDraft.mock.calls[0]?.[0] as string
    // Read through the document layer rather than matching the raw text: the file is JSON, so every
    // quote in the query is escaped in it, and a substring match would be about JSON escaping.
    expect(parseSqlNotebook(written).cells.map(cell => cell.source)).toEqual(['SELECT 1', 'SELECT * FROM "ci""ty" LIMIT 1000'])
    expect(harness.setDraft.mock.calls[0]?.[2]).toBe('file:query.sqlnb')
  })

  it('says a long table list was cut short instead of looking like the whole database', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount({ tablesTruncated: true })
    await harness.connect()

    expect(await harness.view.findByText(zh['sqlnotebook.schemaTruncated'])).toBeTruthy()
  })

  /**
   * The panel is often the only SQL surface on screen, so it is the one that reopens a notebook's
   * connection when the editor is showing something else (ADR 0007).
   */
  it('reconnects to the database the notebook file records, without the reader asking', async () => {
    const draft = JSON.stringify({
      version: 2,
      connection: { path: 'archive.sqlite', access: 'writable' },
      cells: [{ kind: 'sql', source: 'SELECT 1' }],
    })
    openNotebook(notebookTab('query.sqlnb', draft))
    const harness = mount()

    await waitFor(() => { expect(harness.api.sqlOpen).toHaveBeenCalled() })
    expect(harness.api.sqlOpen).toHaveBeenCalledWith({
      workspaceId: 'workspace-1', notebook: 'query.sqlnb', path: 'archive.sqlite', access: 'writable',
    })
    // The picker names it too, which is what the reader sees if that open is later refused.
    await waitFor(() => {
      const select = harness.view.getByLabelText(zh['sqlnotebook.database']) as HTMLSelectElement
      expect(select.value).toBe('archive.sqlite')
    })
  })

  it('reads the schema again after a run, without watching files', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount()
    await harness.connect()
    const afterConnect = harness.schema.sqlTables.mock.calls.length

    // A run may have created or dropped a table, so the tree is stale the moment a cell finishes.
    harness.runtime.runCell('file:query.sqlnb', 'sqlnb-0')
    await waitFor(() => {
      expect(harness.schema.sqlTables.mock.calls.length).toBeGreaterThan(afterConnect)
    })
  })

  it('re-reads the schema when the collapsed rail asks for it', async () => {
    // The rail can only request the re-read — the panel owns the tree and its requests — so the
    // request is a store write this component consumes, once, by id.
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount()
    await harness.connect()
    const afterConnect = harness.schema.sqlTables.mock.calls.length

    workbench.current = {
      ...workbench.current,
      sidebarAction: { id: 7, action: 'sql.refreshSchema', workspaceId: 'workspace-1' },
    }
    // Any runtime update re-renders the panel, which is when it reads the store again.
    act(() => { harness.runtime.clearConnectionNotice('file:query.sqlnb') })

    await waitFor(() => { expect(harness.consumeSidebarAction).toHaveBeenCalledWith(7) })
    expect(harness.schema.sqlTables.mock.calls.length).toBeGreaterThan(afterConnect)
  })

  it('says a WAL database leaves sidecar files, since nothing removes them', async () => {
    // Measured: the first statement on a read-only WAL connection creates -wal and -shm beside the
    // file and close() does not remove them. The panel is where the reader is told before finding
    // two unexpected files on disk.
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount({ walExpected: true })
    await harness.connect()

    expect(harness.view.getByText(zh['sqlnotebook.walSidecarNotice'])).toBeTruthy()
  })

  it('shows why the schema could not be read', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount({ tablesRefuse: new WorkbenchApiError('SQL_NOT_CONNECTED', '该笔记还没有连接数据库。') })
    await harness.connect()

    expect((await harness.view.findByRole('alert')).textContent).toContain('该笔记还没有连接数据库。')
  })
})

describe('SqlPanel — 连接', () => {
  it('says there is no notebook rather than describing a connection it cannot name', () => {
    workbench.current = { activeTabId: undefined, tabs: [] }
    const { view } = mount()

    expect(view.getByText(zh['sqlnotebook.panelNoNotebook'])).toBeTruthy()
    expect(view.queryByLabelText(zh['sqlnotebook.database'])).toBeNull()
  })

  it('lists the workspace databases, leaving the WAL sidecars out', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const { view } = mount()

    const select = await view.findByLabelText(zh['sqlnotebook.database']) as HTMLSelectElement
    await waitFor(() => { expect(select.options.length).toBeGreaterThan(2) })
    const offered = [...select.options].map(option => option.value)
    // The sidecar files are what a WAL database leaves behind; they are databases' neighbours, not
    // databases, and the Host would refuse one as SQL_DATABASE_REQUIRED. The walk sorts, so the
    // order here is the picker's own.
    expect(offered).toEqual(['', ':memory:', 'archive.sqlite', 'demo.db'])
  })

  it('connects the picked database, and hides the tier for an in-memory one', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const { view, api } = mount()

    const select = await view.findByLabelText(zh['sqlnotebook.database']) as HTMLSelectElement
    await waitFor(() => { expect(select.options.length).toBeGreaterThan(2) })
    fireEvent.change(select, { target: { value: ':memory:' } })
    // `:memory:` has no tier: there is no file to protect, so the Host always opens it writable and
    // refuses a request that names a tier. The choice is hidden rather than defaulted.
    expect(view.queryByLabelText(zh['sqlnotebook.tier'])).toBeNull()

    fireEvent.click(view.getByRole('button', { name: zh['sqlnotebook.connect'] }))
    await waitFor(() => { expect(api.sqlOpen).toHaveBeenCalled() })
    expect(api.sqlOpen).toHaveBeenCalledWith({
      workspaceId: 'workspace-1', notebook: 'query.sqlnb', path: ':memory:', access: 'writable',
    })
  })

  it('locks the picker while a handle is open and warns that the memory database goes away', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const { view } = mount()
    const select = await view.findByLabelText(zh['sqlnotebook.database']) as HTMLSelectElement
    await waitFor(() => { expect(select.options.length).toBeGreaterThan(2) })
    fireEvent.change(select, { target: { value: ':memory:' } })
    fireEvent.click(view.getByRole('button', { name: zh['sqlnotebook.connect'] }))

    // Changing database or tier on a live handle is a close plus reopen on the Host's side, so the
    // control is locked and 断开 is the way through — stated before it happens, not after.
    await waitFor(() => { expect((view.getByLabelText(zh['sqlnotebook.database']) as HTMLSelectElement).disabled).toBe(true) })
    expect(view.getByText(zh['sqlnotebook.memoryNotice'])).toBeTruthy()
    const disconnect = view.getByRole('button', { name: zh['sqlnotebook.disconnect'] })
    expect(disconnect.getAttribute('title')).toBe(zh['sqlnotebook.disconnectHint'])
  })

  it('shows why a connect was refused instead of looking unconnected', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const { view } = mount({ refuse: new WorkbenchApiError('SQL_WRITE_OCCUPIED', '该库文件已被其它笔记的连接占用。') })

    const select = await view.findByLabelText(zh['sqlnotebook.database']) as HTMLSelectElement
    await waitFor(() => { expect(select.options.length).toBeGreaterThan(2) })
    fireEvent.change(select, { target: { value: 'demo.db' } })
    fireEvent.click(view.getByRole('button', { name: zh['sqlnotebook.connect'] }))

    // `未连接` alone would send the reader to try again; the Host's own line says which gate it was.
    expect((await view.findByRole('alert')).textContent).toContain('该库文件已被其它笔记的连接占用。')
  })

  it('describes the last opened notebook when the editor is showing something else', async () => {
    const other = notebookTab('notes.md')
    const first = notebookTab('first.sqlnb')
    const second = notebookTab('second.sqlnb')
    workbench.current = { activeTabId: other.id, tabs: [first, other, second] }
    const { view } = mount()

    // Tabs keep their open order, so the last `.sqlnb` is the one the reader most recently opened —
    // not "the only connection in the workspace", which the Host itself refuses to guess at.
    expect(view.getByText(zh['sqlnotebook.panelNotebook'].replace('{path}', 'second.sqlnb'))).toBeTruthy()
  })
})
