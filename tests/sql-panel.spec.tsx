// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { zh } from '../src/client/core/locales.ts'
import type { WorkbenchFileTab } from '../src/client/model/controller.ts'
import { SqlPanel } from '../src/client/sql/SqlPanel.tsx'
import { parseSqlNotebook } from '../src/client/sql/sql-notebook-document.ts'
import { SqlRuntime } from '../src/client/sql/sql-runtime.ts'
import { WorkbenchApiError } from '../src/client/model/api.ts'

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

/**
 * The official Menu, stubbed the way the file tree's and the CSV grid's specs stub it.
 *
 * The real package pulls `clsx`, which is not installed for the test runtime, so a spec that renders
 * a menu has to replace it. The stub keeps the contract the case below reads: `role="menu"`, one
 * `role="menuitem"` button per data row, and `disabled` carried through — and it drops the anchoring
 * and portal, which are the package's business, not the panel's.
 */
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Menu: ({ open, items, onSelect }: {
    open: boolean
    items: Array<{ id: string; label?: React.ReactNode; type?: string; disabled?: boolean }>
    onSelect: (id: string) => void
  }) => (open ? (
    <div role="menu">{items.filter(item => item.type === undefined).map(item => (
      <button key={item.id} role="menuitem" disabled={item.disabled} onClick={() => { onSelect(item.id) }}>{item.label}</button>
    ))}</div>
  ) : null),
}))

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
  /**
   * Open a handle, now that the panel has no button to press.
   *
   * Connecting is the notebook toolbar's job (ADR 0008), so the panel's own cases drive the same
   * runtime method the toolbar calls. Asserting against `sqlOpen` here would say nothing about the
   * toolbar — it would only say the fixture managed to connect, which is what the panel needs in
   * order to have a tree at all.
   */
  connect: (target?: string) => Promise<void>
  /** Re-render the panel, which is what a workbench store write does in the real app. */
  rerender: () => void
}

function mount(options: {
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
     * the runtime a different file from the one rendered would let them disagree — and would make
     * the auto-connect read a record the panel never showed. `workbench.current` is the same
     * snapshot the panel itself reads.
     */
    getDraft: () => {
      const tabs = (workbench.current['tabs'] ?? []) as Array<{ kind?: string; draft?: string }>
      return tabs.find(tab => tab.kind === 'file')?.draft ?? NOTEBOOK_DRAFT
    },
    setDraft: vi.fn(),
    save: vi.fn(),
  })
  const setDraft = vi.fn()
  const consumeSidebarAction = vi.fn()
  const controller = {
    sqlRuntime: runtime,
    setDraft,
    consumeSidebarAction,
    // No `listDirectory`: the workspace walk fed the panel's database picker, and that picker is
    // gone. A fixture still offering it would let a regression sneak the scan back in unnoticed.
    api: { ...schemaApi },
  }
  /**
   * A fresh element each call.
   *
   * React bails out when it is handed the element it already rendered, so a re-render that is
   * supposed to make the component read the store again has to build the element every time.
   */
  const panel = () => (
    <SqlPanel
      controller={controller as never}
      workspaceId="workspace-1"
      t={translate}
    />
  )
  const view = render(panel())
  /**
   * Force the re-render a real store write would cause.
   *
   * `useWorkbench` is mocked to a plain object here, so writing `workbench.current` notifies no
   * one; the real panel re-renders because it subscribes to the workbench store. A test that needs
   * "and then the panel reads the store again" says so with this, rather than borrowing an
   * unrelated runtime call to trigger a render.
   */
  const rerender = (): void => { view.rerender(panel()) }
  async function connect(target = 'demo.db'): Promise<void> {
    await runtime.connect('file:query.sqlnb', target, 'read-only')
    // Waited on the handle rather than on a row of the tree: a case whose schema read fails has no
    // tree to find, and it still needs the connection to be live before it asserts the failure.
    await waitFor(() => { expect(runtime.state('file:query.sqlnb').connection).not.toBeNull() })
  }

  return { view, api, schema: schemaApi, runtime, setDraft, connect, consumeSidebarAction, rerender }
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
    // been changed is a request per gesture.
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
   *
   * It does that as a *reader* of the file's record, not as a connection control: ADR 0008 left the
   * toolbar the only place a reader connects, and the tree still needs a handle to describe.
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
    // The store write above is what the rail performs; the panel reads it on its next render.
    // `rerender` is already act-wrapped inside the library, so no extra act() here.
    harness.rerender()

    await waitFor(() => { expect(harness.consumeSidebarAction).toHaveBeenCalledWith(7) })
    expect(harness.schema.sqlTables.mock.calls.length).toBeGreaterThan(afterConnect)
  })

  it('shows why the schema could not be read', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount({ tablesRefuse: new WorkbenchApiError('SQL_NOT_CONNECTED', '该笔记还没有连接数据库。') })
    await harness.connect()

    expect((await harness.view.findByRole('alert')).textContent).toContain('该笔记还没有连接数据库。')
  })
})

/**
 * The ownership fence (ADR 0008).
 *
 * These are negative assertions, which is the whole point: the panel used to carry a second copy of
 * every connection control, and nothing in the suite would notice one creeping back — a duplicated
 * picker behaves correctly right up to the moment the two copies disagree. What each case pins is
 * that the *only* thing left in this column is the tree and its own refresh.
 */
describe('SqlPanel — 只有结构，没有连接控件', () => {
  it('offers no database picker, tier or connect button while connected', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount()
    await harness.connect()

    expect(harness.view.queryByLabelText(zh['sqlnotebook.database'])).toBeNull()
    expect(harness.view.queryByRole('button', { name: zh['sqlnotebook.connect'] })).toBeNull()
    expect(harness.view.queryByRole('button', { name: zh['sqlnotebook.disconnect'] })).toBeNull()
    // And it does not keep walking the workspace to fill a list it no longer shows.
    expect(harness.view.queryByText(zh['sqlnotebook.scanTruncated'])).toBeNull()
  })

  it('titles the panel after what it holds, and says it once', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount()
    await harness.connect()

    // 「SQL 连接」 described a form that is no longer here. The heading is now the tree's own name,
    // which is why the section cannot keep a second one of the same word inside the panel.
    expect(harness.view.getByText(zh['sqlnotebook.schema'])).toBeTruthy()
    expect(harness.view.getAllByText(zh['sqlnotebook.schema'])).toHaveLength(1)
  })

  it('has its one refresh button read the tree, not the workspace', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount()
    await harness.connect()

    const refresh = harness.view.getByRole('button', { name: zh['sqlnotebook.refreshSchema'] })
    expect(harness.view.getAllByRole('button', { name: zh['sqlnotebook.refreshSchema'] })).toHaveLength(1)
    const before = harness.schema.sqlTables.mock.calls.length
    fireEvent.click(refresh)

    await waitFor(() => { expect(harness.schema.sqlTables.mock.calls.length).toBeGreaterThan(before) })
    // The old header action was 重新扫描工作区: a ⟳ that refreshed something the panel cannot show.
    expect(harness.view.queryByRole('button', { name: zh['sqlnotebook.rescan'] })).toBeNull()
  })

  it('names the notebook the tree belongs to when the editor is showing something else', async () => {
    const other = notebookTab('notes.md')
    const first = notebookTab('first.sqlnb')
    const second = notebookTab('second.sqlnb')
    workbench.current = { activeTabId: other.id, tabs: [first, other, second] }
    const { view } = mount()

    // Tabs keep their open order, so the last `.sqlnb` is the one the reader most recently opened —
    // not "the only connection in the workspace", which is something the Host itself refuses to
    // guess at. The tree has no connection controls of its own now, so naming its notebook is the
    // only way this column can say whose structure it is showing.
    expect(await view.findByText(zh['sqlnotebook.panelNotebook'].replace('{path}', 'second.sqlnb'))).toBeTruthy()
  })

  it('says it is not connected, and points at the toolbar that can connect', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount()

    // With the connect button gone from this column, an unconnected panel that only said 未连接 would
    // be a dead end: the reader would have to already know the control moved.
    expect(harness.view.getByText(zh['sqlnotebook.notConnected'])).toBeTruthy()
    expect(harness.view.getByText(zh['sqlnotebook.connectInToolbar'])).toBeTruthy()
    expect(harness.view.queryByText('city')).toBeNull()
    // And the header's refresh has nothing to re-read yet.
    expect((harness.view.getByRole('button', { name: zh['sqlnotebook.refreshSchema'] }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('says there is no notebook rather than describing a structure it cannot name', () => {
    workbench.current = { activeTabId: undefined, tabs: [] }
    const { view } = mount()

    expect(view.getByText(zh['sqlnotebook.panelNoNotebook'])).toBeTruthy()
    expect(view.queryByLabelText(zh['sqlnotebook.database'])).toBeNull()
  })
})

describe('SqlPanel — 表行右键菜单', () => {
  /** The menu is the discoverable half of a write gesture nobody would otherwise find. */
  async function connectedRow(harness: Harness): Promise<HTMLElement> {
    const row = await harness.view.findByRole('button', { name: /city\b/u })
    return row
  }

  it('offers the four rows it promises, and no preview', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount()
    await harness.connect()

    fireEvent.contextMenu(await connectedRow(harness))
    const labels = [...(await harness.view.findByRole('menu')).querySelectorAll('button')].map(button => button.textContent)
    expect(labels).toEqual([
      zh['sqlnotebook.insertSelect'],
      zh['sqlnotebook.insertTableName'],
      zh['sqlnotebook.copyTableName'],
      zh['sqlnotebook.copyColumnNames'],
    ])
  })

  it('inserts the quoted table name when that row is chosen', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount({ tables: [{ name: 'ci"ty', kind: 'table' }] })
    await harness.connect()

    fireEvent.contextMenu(await harness.view.findByRole('button', { name: /ci"ty/u }))
    fireEvent.click(harness.view.getByRole('menuitem', { name: zh['sqlnotebook.insertTableName'] }))

    const written = harness.setDraft.mock.calls[0]?.[0] as string
    // A name that contains a quote is exactly what a database is allowed to have, and the only safe
    // way in is to double it — asserted as the document layer reads it, not as a substring of JSON.
    expect(parseSqlNotebook(written).cells.map(cell => cell.source)).toEqual(['SELECT 1', '"ci""ty"'])
  })

  it('copies the column names, reading them first when the table was never expanded', async () => {
    const clipboard = { writeText: vi.fn(() => Promise.resolve()) }
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard })
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount({
      columns: [
        { name: 'id', type: 'INTEGER', notNull: false, primaryKey: true },
        { name: 'name', type: 'TEXT', notNull: false, primaryKey: false },
      ],
    })
    await harness.connect()

    // The reader right-clicked without expanding, so the panel has not asked for columns at all.
    expect(harness.schema.sqlColumns).not.toHaveBeenCalled()
    fireEvent.contextMenu(await connectedRow(harness))
    fireEvent.click(harness.view.getByRole('menuitem', { name: zh['sqlnotebook.copyColumnNames'] }))

    await waitFor(() => { expect(clipboard.writeText).toHaveBeenCalledWith('id\nname') })
  })

  it('says when the clipboard refused instead of dropping the copy', async () => {
    const clipboard = { writeText: vi.fn(() => Promise.reject(new Error('Clipboard unavailable'))) }
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard })
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount()
    await harness.connect()

    fireEvent.contextMenu(await connectedRow(harness))
    fireEvent.click(harness.view.getByRole('menuitem', { name: zh['sqlnotebook.copyTableName'] }))

    // A copy that vanished silently is a reader pasting nothing and blaming the tree.
    const alert = await harness.view.findByRole('alert')
    expect(alert.textContent).toContain(zh['sqlnotebook.copyFailed'])
  })

  it('does not offer to copy columns a table provably has none of', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount({ columns: [] })
    await harness.connect()

    const row = await connectedRow(harness)
    // Expand first, so the empty answer is a read fact and not merely "unread yet".
    fireEvent.click(row)
    await waitFor(() => { expect(harness.schema.sqlColumns).toHaveBeenCalled() })

    fireEvent.contextMenu(row)
    expect((harness.view.getByRole('menuitem', { name: zh['sqlnotebook.copyColumnNames'] }) as HTMLButtonElement).disabled).toBe(true)
  })
})
