// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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

const workbench = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))
vi.mock('../src/client/model/use-workbench.ts', () => ({ useWorkbench: () => workbench.current }))

/**
 * The official Menu, stubbed the way the file tree's and the CSV grid's specs stub it.
 *
 * The real package pulls `clsx`, which is not installed for the test runtime, so a spec that
 * renders a menu has to replace it. The stub keeps the contract the case below reads: one
 * `role="menu"` and one `role="menuitem"` button per data row, with `disabled` carried
 * through.
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
  /*
   * The schema tree chevron: the panel imports the real `IconChevronDownOutlineRegular` /
   * `IconChevronRightOutlineRegular` so the disclosure row looks like the rest of the workbench
   * (git / file tree). The mock here just keeps the contract the tests read — a marker element
   * the test can look for when it cares about open/closed, otherwise an empty span.
   */
  IconChevronDownOutlineRegular: () => <span data-icon="chevron-down" />,
  IconChevronRightOutlineRegular: () => <span data-icon="chevron-right" />,
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

function openNotebook(current: WorkbenchFileTab): void {
  workbench.current = { activeTabId: current.id, tabs: [current] }
}

interface Harness {
  view: ReturnType<typeof render>
  api: Record<string, ReturnType<typeof vi.fn>>
  schema: { sqlTables: ReturnType<typeof vi.fn>; sqlColumns: ReturnType<typeof vi.fn> }
  runtime: SqlRuntime
  setDraft: ReturnType<typeof vi.fn>
  consumeSidebarAction: ReturnType<typeof vi.fn>
  connect: (target?: string) => Promise<void>
  rerender: () => void
}

function mount(options: {
  refuse?: WorkbenchApiError
  tables?: Array<{ name: string; kind: 'table' | 'view'; sections?: { indexes?: number; foreignKeys?: number; triggers?: number } }>
  tablesTruncated?: boolean
  tablesRefuse?: WorkbenchApiError
  columns?: Array<{ name: string; type?: string; notNull: boolean; primaryKey: boolean; unique?: boolean; foreignKey?: { table: string; column?: string }; stats?: { approxRows?: number; approxDistinct?: number } }>
  columnsByTable?: Record<string, Array<{ name: string; type?: string; notNull: boolean; primaryKey: boolean; unique?: boolean; foreignKey?: { table: string; column?: string }; stats?: { approxRows?: number; approxDistinct?: number } }>>
  walExpected?: boolean
  databaseKind?: 'file' | 'memory'
} = {}): Harness {
  const api = {
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
      ? Promise.resolve({
          path: 'demo.db',
          databaseKind: options.databaseKind ?? 'file',
          tables: options.tables ?? [{ name: 'city', kind: 'table' as const }],
          truncated: options.tablesTruncated ?? false,
        })
      : Promise.reject(options.tablesRefuse)),
    sqlColumns: vi.fn((_ws, _nb, table: string) => {
      // The mock has a per-table column list when the test opts in via `tableColumns`.
      // Falling back to a single `id` column is what every other test in the file
      // expects, so the default stays small.
      const perTable = (options.columnsByTable ?? {})[table]
      if (perTable !== undefined) {
        return Promise.resolve({ path: 'demo.db', table, columns: perTable })
      }
      return Promise.resolve({
        path: 'demo.db',
        table,
        columns: options.columns ?? [{ name: 'id', type: 'INTEGER', notNull: false, primaryKey: true }],
      })
    }),
  }
  const runtime = new SqlRuntime(api as never, { info: vi.fn(), warn: vi.fn() }, {
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
    api: { ...schemaApi },
  }
  const panel = () => (
    <SqlPanel
      controller={controller as never}
      workspaceId="workspace-1"
      t={translate}
    />
  )
  const view = render(panel())
  const rerender = (): void => { view.rerender(panel()) }
  async function connect(target = 'demo.db'): Promise<void> {
    await runtime.connect('file:query.sqlnb', target, 'read-only')
    await waitFor(() => { expect(runtime.state('file:query.sqlnb').connection).not.toBeNull() })
  }

  return { view, api, schema: schemaApi, runtime, setDraft, connect, consumeSidebarAction, rerender }
}

/* ── helpers for driving the new four-level tree ────────────────────── */

const TABLE = (name: string) => ({ name, kind: 'table' as const })

/**
 * Open the chain database → table → 字段 → see the column names. The test suite talks to the
 * panel through clicks alone; if the panel ever stops making the column read on first expand
 * of the 字段 category, the read assertion in the cases below will start failing.
 */
async function openColumnsOf(
  harness: Harness,
  tableName: string,
): Promise<void> {
  // The root is open by default. Open the table by clicking its disclosure button — there
  // is one `treeRowButton` per row, with the row label as its accessible name.
  const tableRow = await harness.view.findByRole('button', { name: new RegExp(`\\b${tableName}\\b`, 'u') })
  fireEvent.click(tableRow)
  // Open 字段. The category labels share the same button slots; pick the one whose
  // accessible name is the category's translated text. The first such button is the
  // topmost 字段 row — there is one per table, but a single click only ever opens one.
  const allButtons = [...harness.view.container.querySelectorAll('button')]
  const columnsCategory = allButtons.find(button => button.textContent?.includes(zh['sqlnotebook.categoryColumns']))
  if (columnsCategory === undefined) {
    throw new Error(`no 字段 button found; buttons were: ${allButtons.map(button => button.textContent).join('|')}`)
  }
  fireEvent.click(columnsCategory)
  // Wait until the column read *and* the resulting state write have both reached the
  // DOM. A read that has not yet resolved is rendered as `loading`; the helper waits on
  // that text disappearing so every caller lands on a tree that has columns in it.
  await waitFor(() => {
    expect(harness.view.queryByText(zh['sqlnotebook.schemaLoading'])).toBeNull()
  })
}

describe('SqlPanel — 结构', () => {
  it('lists the connected database’s tables and marks a view as one', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount({
      tables: [
        TABLE('city'),
        { name: 'city_summary', kind: 'view' as const },
      ],
    })
    await harness.connect()

    expect(await harness.view.findByRole('button', { name: /city\b/u })).toBeTruthy()
    const view = harness.view.getByRole('button', { name: /city_summary/u })
    expect(view.textContent).toContain(zh['sqlnotebook.viewLabel'])
  })

  it('reads a table’s columns once, however often the field category is opened and closed', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount()
    await harness.connect()
    await openColumnsOf(harness, 'city')

    // Open the same field category again: the second open is a no-op for the host.
    const before = harness.schema.sqlColumns.mock.calls.length
    const columnsCategory = await harness.view.findByText(zh['sqlnotebook.categoryColumns'])
    fireEvent.click(columnsCategory.closest('button')!)
    fireEvent.click(columnsCategory.closest('button')!)
    expect(harness.view.getByText('id')).toBeTruthy()
    expect(harness.view.getByText('INTEGER')).toBeTruthy()
    expect(harness.schema.sqlColumns.mock.calls.length).toBe(before)
  })

  it('writes a SELECT * into a new cell when a table is double-clicked', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount({ tables: [TABLE('ci"ty')] })
    await harness.connect()

    fireEvent.doubleClick(await harness.view.findByRole('button', { name: /ci"ty/u }))

    const written = harness.setDraft.mock.calls[0]?.[0] as string
    expect(parseSqlNotebook(written).cells.map(cell => cell.source)).toEqual(['SELECT 1', 'SELECT * FROM "ci""ty" LIMIT 1000'])
    expect(harness.setDraft.mock.calls[0]?.[2]).toBe('file:query.sqlnb')
  })

  it('says a long table list was cut short instead of looking like the whole database', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount({ tablesTruncated: true })
    await harness.connect()

    expect(await harness.view.findByText(zh['sqlnotebook.schemaTruncated'])).toBeTruthy()
  })

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

    harness.runtime.runCell('file:query.sqlnb', 'sqlnb-0')
    await waitFor(() => {
      expect(harness.schema.sqlTables.mock.calls.length).toBeGreaterThan(afterConnect)
    })
  })

  it('re-reads the schema when the collapsed rail asks for it', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount()
    await harness.connect()
    const afterConnect = harness.schema.sqlTables.mock.calls.length

    workbench.current = {
      ...workbench.current,
      sidebarAction: { id: 7, action: 'sql.refreshSchema', workspaceId: 'workspace-1' },
    }
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

  /*
   * The chevron is the only thing on the disclosure row whose *shape* tells the reader
   * whether the row is folded. A regression that swaps it for a unicode glyph, or that
   * forgets to swap it on toggle, would not be caught by anything else in this file —
   * the row is still a button, the label is still there, the count badge is still there.
   * The marker elements on the mocked chevron let the test read the rendered DOM instead
   * of re-implementing the panel's render function just to assert against it.
   */
  it('uses the outline chevron, and flips it when the table is expanded', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount()
    await harness.connect()

    // The root row is open by default; the table row starts folded.
    const tableRow = await harness.view.findByRole('button', { name: /\bcity\b/u })
    expect(tableRow.querySelector('[data-icon="chevron-right"]')).toBeTruthy()
    expect(tableRow.querySelector('[data-icon="chevron-down"]')).toBeNull()

    fireEvent.click(tableRow)
    expect(tableRow.querySelector('[data-icon="chevron-down"]')).toBeTruthy()
    expect(tableRow.querySelector('[data-icon="chevron-right"]')).toBeNull()
  })
})

/**
 * The ownership fence (ADR 0008).
 */
describe('SqlPanel — 只有结构，没有连接控件', () => {
  it('offers no database picker, tier or connect button while connected', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount()
    await harness.connect()

    expect(harness.view.queryByLabelText(zh['sqlnotebook.database'])).toBeNull()
    expect(harness.view.queryByRole('button', { name: zh['sqlnotebook.connect'] })).toBeNull()
    expect(harness.view.queryByRole('button', { name: zh['sqlnotebook.disconnect'] })).toBeNull()
    expect(harness.view.queryByText(zh['sqlnotebook.scanTruncated'])).toBeNull()
  })

  it('titles the panel after what it holds, and says it once', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount()
    await harness.connect()

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
    expect(harness.view.queryByRole('button', { name: zh['sqlnotebook.rescan'] })).toBeNull()
  })

  it('keeps describing its own .sqlnb when the editor is on a different file', async () => {
    const other = notebookTab('notes.md')
    const first = notebookTab('first.sqlnb')
    const second = notebookTab('second.sqlnb')
    workbench.current = { activeTabId: other.id, tabs: [first, other, second] }
    const { view } = mount()

    // `activeSqlNotebook` falls back to the most recently opened `.sqlnb`, so the panel is
    // about `second.sqlnb` and the notebook's own draft is `SELECT 1` with no `connection`
    // record — meaning the panel is in its not-connected state, not pretending to describe
    // `first.sqlnb`. The notebook path itself is no longer rendered as a separate line:
    // the editor tab and toolbar already carry it, and the panel is bound to a single
    // notebook either way.
    expect(await view.findByText(zh['sqlnotebook.notConnected'])).toBeTruthy()
    expect(view.getByText(zh['sqlnotebook.connectInToolbar'])).toBeTruthy()
    expect(view.queryByText('city')).toBeNull()
    expect(view.queryByText('笔记 second.sqlnb')).toBeNull()
  })

  it('says it is not connected, and points at the toolbar that can connect', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount()

    expect(harness.view.getByText(zh['sqlnotebook.notConnected'])).toBeTruthy()
    expect(harness.view.getByText(zh['sqlnotebook.connectInToolbar'])).toBeTruthy()
    expect(harness.view.queryByText('city')).toBeNull()
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
  async function connectedRow(harness: Harness): Promise<HTMLElement> {
    return await harness.view.findByRole('button', { name: /city\b/u })
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
    const harness = mount({ tables: [TABLE('ci"ty')] })
    await harness.connect()

    fireEvent.contextMenu(await harness.view.findByRole('button', { name: /ci"ty/u }))
    fireEvent.click(harness.view.getByRole('menuitem', { name: zh['sqlnotebook.insertTableName'] }))

    const written = harness.setDraft.mock.calls[0]?.[0] as string
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

    // The reader right-clicked without expanding the field category, so the panel has not
    // asked for columns at all.
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

    const alert = await harness.view.findByRole('alert')
    expect(alert.textContent).toContain(zh['sqlnotebook.copyFailed'])
  })

  it('does not offer to copy columns a table provably has none of', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount({ columns: [] })
    await harness.connect()
    // Expand the table and the 字段 category, so the empty answer is a real read fact.
    const row = await connectedRow(harness)
    fireEvent.click(row)
    const columnsCategory = await harness.view.findByText(zh['sqlnotebook.categoryColumns'])
    fireEvent.click(columnsCategory.closest('button')!)
    await waitFor(() => { expect(harness.schema.sqlColumns).toHaveBeenCalled() })

    fireEvent.contextMenu(row)
    expect((harness.view.getByRole('menuitem', { name: zh['sqlnotebook.copyColumnNames'] }) as HTMLButtonElement).disabled).toBe(true)
  })
})

/**
 * The connection header still names the file the runtime is on and the tier; the
 * difference is that the file path is now the *root* node's label, not a separate
 * line. The tier pill stays in the header strip beside it.
 */
describe('SqlPanel — 连接头', () => {
  it('names the file the runtime is on, as the root tree node', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount()
    await harness.connect()

    // The root tree node's label is the file path. The root row is the *only* tree
    // button whose accessible name starts with the file path — table buttons match a
    // separate pattern. We grab the row by walking from the root's `treeLabel`.
    const headerSpan = harness.view.getAllByText('demo.db', { selector: 'span' })
      .find(node => node.className.includes('treeLabel'))
    expect(headerSpan).not.toBeUndefined()
    const rootRow = headerSpan!.closest('[role="treeitem"]')?.querySelector('button')
    expect(rootRow).not.toBeNull()
  })

  it('counts tables and views in the database, on the root node', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount({
      tables: [
        TABLE('city'),
        TABLE('country'),
        TABLE('order_items'),
        TABLE('orders'),
        { name: 'city_summary', kind: 'view' as const },
      ],
    })
    await harness.connect()

    // The root node carries the total count as a `(N)` badge — 4 tables + 1 view.
    const headerSpan = harness.view.getAllByText('demo.db', { selector: 'span' })
      .find(node => node.className.includes('treeLabel'))
    expect(headerSpan).not.toBeUndefined()
    const rootRow = headerSpan!.closest('[role="treeitem"]')?.querySelector('button')
    expect(rootRow).not.toBeNull()
    expect(rootRow!.textContent).toContain('(5)')
  })
})

/**
 * The four-level tree, the leading icons on columns, and the in-line NOT NULL label.
 *
 * Every column row has the same three slots (icon, name+type, NOT NULL text) so a
 * reader's eye lands in the same place on every row.
 */
describe('SqlPanel — 列图标与 NOT NULL 文本', () => {
  it('shows PK / UNIQUE / FK icons on a column that is all three', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount({
      columnsByTable: {
        city: [{
          name: 'country_id', type: 'INTEGER', notNull: true, primaryKey: true,
          unique: true,
          foreignKey: { table: 'country', column: 'id' },
        }],
      },
    })
    await harness.connect()
    await openColumnsOf(harness, 'city')

    // The id column row's leading slot has all three icons. The matcher is
    // `[class*="columnLeading"]` because vitest's css-module loader hashes the
    // class names; see `git-diff-editor.spec.tsx` for the same pattern.
    const idRow = await harness.view.findByText('country_id')
    const item = idRow.closest('[role="treeitem"]')
    expect(item).not.toBeNull()
    const leadingIcons = item!.querySelectorAll(`[class*="${cssImport('columnLeading')}"] svg`)
    expect(leadingIcons.length).toBe(3)
  })

  it('does not show any leading icon on a plain nullable, non-PK column', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount({
      columnsByTable: { city: [{ name: 'name', type: 'TEXT', notNull: false, primaryKey: false }] },
    })
    await harness.connect()
    await openColumnsOf(harness, 'city')

    const nameRow = await harness.view.findByText('name')
    const item = nameRow.closest('[role="treeitem"]')
    expect(item).not.toBeNull()
    const leading = item!.querySelector(`[class*="${cssImport('columnLeading')}"]`)
    expect(leading?.querySelector('svg')).toBeNull()
  })

  /*
   * The leading slot used to be 28px wide, which left a 12px icon floating with ~16px of empty
   * space on each side and another 5px to the column name. The reader saw the key as a small
   * mark somewhere in front of the text, not as something that marked the column. A 16px slot
   * fits one icon with breathing room; this pair of tests pins that:
   *
   *   - PK and no-flag columns still start their column name at the same x, so `id` and `name`
   *     do not staircase; the test below compares the bounding rects.
   *   - The slot itself never grows back to 28px or wider, which is what made the gap read.
   *     A future redesign that wants a wider slot has to argue for it in this test.
   */
  it('keeps the column name on the same x whether the column has a leading icon or not', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount({
      columnsByTable: {
        city: [
          { name: 'id', type: 'INTEGER', notNull: true, primaryKey: true },
          { name: 'name', type: 'TEXT', notNull: false, primaryKey: false },
        ],
      },
    })
    await harness.connect()
    await openColumnsOf(harness, 'city')

    const idRow = (await harness.view.findByText('id')).closest('[role="treeitem"]') as HTMLElement
    const nameRow = (await harness.view.findByText('name')).closest('[role="treeitem"]') as HTMLElement
    const idName = idRow.querySelector(`[class*="${cssImport('columnName')}"]`) as HTMLElement
    const nameName = nameRow.querySelector(`[class*="${cssImport('columnName')}"]`) as HTMLElement
    // The slot has to hold its width whether or not it carries an icon, or PK rows and plain
    // rows staircase. Both column-name rects must start at the same x, within a pixel.
    expect(Math.abs(idName.getBoundingClientRect().left - nameName.getBoundingClientRect().left)).toBeLessThanOrEqual(1)
  })

  it('does not reserve more than 18px for the leading slot, so the icon sits close to the column name', async () => {
    // Read the rule out of the stylesheet, not out of a DOM measurement: the panel is a
    // tree of css-module classnames, and the literal that ships is the contract.
    const stylesheet = readFileSync(resolve(process.cwd(), 'src/client/sql/sql-panel.module.css'), 'utf8')
    const rule = (stylesheet.match(/\.columnLeading \{[\s\S]*?\n\}/u) ?? [])[0]
    expect(rule, '.columnLeading must exist in sql-panel.module.css').toBeDefined()
    const widthMatch = rule!.match(/width:\s*(\d+)px/u)
    expect(widthMatch, '.columnLeading must declare width in pixels').toBeTruthy()
    // 12px icon + 4px breathing room = 16px. Anything ≥ 20px brings back the gap the rule was
    // tightened to remove; anything < 14px crowds the icon against the name.
    const width = Number(widthMatch![1])
    expect(width).toBeGreaterThanOrEqual(14)
    expect(width).toBeLessThanOrEqual(18)
  })

  it('shows "可为空" on a nullable column and "非空" on a NOT NULL one', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount({
      columnsByTable: {
        city: [
          { name: 'name', type: 'TEXT', notNull: true, primaryKey: false },
          { name: 'note', type: 'TEXT', notNull: false, primaryKey: false },
        ],
      },
    })
    await harness.connect()
    await openColumnsOf(harness, 'city')

    // The text is plain — not a pill, not a badge — because the file management
    // panel puts every property in plain text and this column row is the same
    // kind of attribute read.
    const nameRow = await harness.view.findByText('name')
    expect(nameRow.closest('[role="treeitem"]')?.textContent).toContain(zh['sqlnotebook.columnNotNull'])
    const noteRow = await harness.view.findByText('note')
    expect(noteRow.closest('[role="treeitem"]')?.textContent).toContain(zh['sqlnotebook.columnNullable'])
  })

  it('formats a sqlite_stat1 row count as ~1.2K instead of the raw integer', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount({
      columnsByTable: {
        city: [
          { name: 'id', type: 'INTEGER', notNull: true, primaryKey: true, stats: { approxRows: 1234 } },
        ],
      },
    })
    await harness.connect()
    await openColumnsOf(harness, 'city')

    const idRow = await harness.view.findByText('id')
    expect(idRow.closest('[role="treeitem"]')?.textContent).toContain('~1.2K')
  })
})

/**
 * The four-level tree, the categories.
 *
 * The category nodes always show their count, even when the count is zero, so a
 * reader can tell at a glance that the section exists and is empty (rather than
 * missing).
 */
describe('SqlPanel — 分类节点', () => {
  it('renders every category under a table, with its count, even when zero', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount({ tables: [TABLE('city')] })
    await harness.connect()

    // Open the city table to expose its category nodes.
    fireEvent.click(await harness.view.findByRole('button', { name: /city\b/u }))

    // The four categories from the spec doc: 字段 / 索引 / 外键 / 触发器. All four
    // are rendered, with `(N)` badges, even when the host did not report a count.
    expect(await harness.view.findByText(zh['sqlnotebook.categoryColumns'])).toBeTruthy()
    expect(harness.view.getByText(zh['sqlnotebook.categoryIndexes'])).toBeTruthy()
    expect(harness.view.getByText(zh['sqlnotebook.categoryForeignKeys'])).toBeTruthy()
    expect(harness.view.getByText(zh['sqlnotebook.categoryTriggers'])).toBeTruthy()
  })
})

/**
 * Read the SQL panel's stylesheet and hand back a class selector by source name.
 *
 * The test runner does not have a CSS-module loader, so `import css from './…module.css'`
 * would not resolve here. The class names are hashed at build time, so the spec reaches
 * for the very selector the source declares — same trick as `git-diff-editor.spec.tsx`.
 */
function cssImport(name: string): string {
  const stylesheet = readFileSync(
    resolve(process.cwd(), 'src/client/sql/sql-panel.module.css'),
    'utf8',
  )
  const declared = new RegExp(`\\.${name}\\s*\\{`, 'u')
  if (!declared.test(stylesheet)) throw new Error(`css class not declared: ${name}`)
  return name
}
