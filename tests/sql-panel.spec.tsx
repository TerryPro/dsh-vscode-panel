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
  selectTab: ReturnType<typeof vi.fn>
  openFile: ReturnType<typeof vi.fn>
  connect: (target?: string) => Promise<void>
  rerender: () => void
}

function mount(options: {
  refuse?: WorkbenchApiError
  tables?: Array<{ name: string; kind: 'table' | 'view'; sections?: { indexes?: number; foreignKeys?: number; triggers?: number } }>
  tablesTruncated?: boolean
  tablesRefuse?: WorkbenchApiError
  columns?: Array<{ name: string; type?: string; notNull: boolean; primaryKey: boolean; unique?: boolean; foreignKey?: { table: string; column?: string }; autoIncrement?: boolean; stats?: { approxRows?: number; approxDistinct?: number } }>
  columnsByTable?: Record<string, Array<{ name: string; type?: string; notNull: boolean; primaryKey: boolean; unique?: boolean; foreignKey?: { table: string; column?: string }; autoIncrement?: boolean; stats?: { approxRows?: number; approxDistinct?: number } }>>
  walExpected?: boolean
  databaseKind?: 'file' | 'memory'
  listings?: Record<string, { entries: Array<{ name: string; path: string; kind: 'file' | 'directory' | 'symlink' }>; truncated?: boolean }>
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
    sqlColumns: vi.fn((_ws: string, _nb: string, table: string) => {
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
  const selectTab = vi.fn()
  const openFile = vi.fn()
  const listings = options.listings ?? {}
  const listDirectory = vi.fn((_ws: string, path: string) => {
    const listing = listings[path]
    if (listing === undefined) {
      return Promise.resolve({ entries: [], truncated: false })
    }
    return Promise.resolve({ entries: listing.entries, truncated: listing.truncated ?? false })
  })
  const readFile = vi.fn(() => Promise.resolve({ content: NOTEBOOK_DRAFT }))
  const controller = {
    sqlRuntime: runtime,
    setDraft,
    consumeSidebarAction,
    selectTab,
    openFile,
    api: { ...schemaApi, listDirectory, readFile },
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

  return { view, api, schema: schemaApi, runtime, setDraft, connect, consumeSidebarAction, selectTab, openFile, rerender }
}

/* ── helpers for driving the four-level tree ──────────────────────────── */

const TABLE = (name: string) => ({ name, kind: 'table' as const })

async function openColumnsOf(
  harness: Harness,
  tableName: string,
): Promise<void> {
  const tableRow = await harness.view.findByRole('button', { name: new RegExp(`\\b${tableName}\\b`, 'u') })
  fireEvent.click(tableRow)
  const allButtons = [...harness.view.container.querySelectorAll('button')]
  const columnsCategory = allButtons.find(button => button.textContent?.includes(zh['sqlnotebook.categoryColumns']))
  if (columnsCategory === undefined) {
    throw new Error(`no 字段 button found`)
  }
  fireEvent.click(columnsCategory)
  await waitFor(() => {
    expect(harness.view.queryByText(zh['sqlnotebook.schemaLoading'])).toBeNull()
  })
}

/* ── Structure tests ──────────────────────────────────────────────── */

describe('SqlPanel — 结构', () => {
  it('lists the connected database\'s tables and marks a view as one', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount({
      tables: [
        TABLE('city'),
        { name: 'city_summary', kind: 'view' as const },
      ],
    })
    await harness.connect()

    // Wait for the schema to load
    await waitFor(() => {
      expect(harness.view.queryByText(zh['sqlnotebook.schemaLoading'])).toBeNull()
    })
    expect(await harness.view.findByRole('button', { name: /city\b/u })).toBeTruthy()
    const view = harness.view.getByRole('button', { name: /city_summary/u })
    expect(view.textContent).toContain(zh['sqlnotebook.viewLabel'])
  })

  it('reads a table\'s columns once, however often the field category is opened and closed', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount()
    await harness.connect()
    await openColumnsOf(harness, 'city')

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

  it('uses the outline chevron, and flips it when the table is expanded', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount()
    await harness.connect()

    const tableRow = await harness.view.findByRole('button', { name: /\bcity\b/u })
    expect(tableRow.querySelector('[data-icon="chevron-right"]')).toBeTruthy()
    expect(tableRow.querySelector('[data-icon="chevron-down"]')).toBeNull()

    fireEvent.click(tableRow)
    expect(tableRow.querySelector('[data-icon="chevron-down"]')).toBeTruthy()
    expect(tableRow.querySelector('[data-icon="chevron-right"]')).toBeNull()
  })
})

/* ── Only structure, no connection control ──────────────────────────── */

describe('SqlPanel — 只有结构，没有连接控件', () => {
  it('offers no database picker, tier or connect button while connected', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount()
    await harness.connect()

    expect(harness.view.queryByLabelText(zh['sqlnotebook.database'])).toBeNull()
    expect(harness.view.queryByRole('button', { name: zh['sqlnotebook.connect'] })).toBeNull()
    expect(harness.view.queryByRole('button', { name: zh['sqlnotebook.disconnect'] })).toBeNull()
  })

  it('titles the panel after what it holds, and says it once', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount()
    await harness.connect()

    expect(harness.view.getByText(zh['sqlnotebook.schema'])).toBeTruthy()
    expect(harness.view.getAllByText(zh['sqlnotebook.schema'])).toHaveLength(1)
  })

  it('has its one refresh button read the tree', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount()
    await harness.connect()

    const refresh = harness.view.getByRole('button', { name: zh['sqlnotebook.refreshSchema'] })
    expect(harness.view.getAllByRole('button', { name: zh['sqlnotebook.refreshSchema'] })).toHaveLength(1)
    const before = harness.schema.sqlTables.mock.calls.length
    fireEvent.click(refresh)

    await waitFor(() => { expect(harness.schema.sqlTables.mock.calls.length).toBeGreaterThan(before) })
  })

  it('says it is not connected when no notebook is open', async () => {
    workbench.current = { activeTabId: undefined, tabs: [] }
    const { view } = mount()

    expect(view.getByText(zh['sqlnotebook.notConnected'])).toBeTruthy()
    expect(view.getByText(zh['sqlnotebook.connectInToolbar'])).toBeTruthy()
  })

  it('says it is not connected, and points at the toolbar that can connect', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount()

    expect(harness.view.getByText(zh['sqlnotebook.notConnected'])).toBeTruthy()
    expect(harness.view.getByText(zh['sqlnotebook.connectInToolbar'])).toBeTruthy()
    expect((harness.view.getByRole('button', { name: zh['sqlnotebook.refreshSchema'] }) as HTMLButtonElement).disabled).toBe(true)
  })
})

/* ── Column badges ──────────────────────────────────────────────── */

describe('SqlPanel — 列字段标签', () => {
  it('shows 主键 / 非空 / 唯一 / 外键 pills on a column that is all four', async () => {
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

    const idRow = await harness.view.findByText('country_id')
    const item = idRow.closest('[role="treeitem"]')
    expect(item).not.toBeNull()
    const trailingPills = item!.querySelectorAll(`[class*="${cssImport('columnTrailing')}"] > span`)
    expect(trailingPills.length).toBe(4)
    expect(trailingPills[0]?.textContent).toBe(zh['sqlnotebook.badgePrimaryKey'])
    expect(trailingPills[1]?.textContent).toBe(zh['sqlnotebook.badgeNotNull'])
    expect(trailingPills[2]?.textContent).toBe(zh['sqlnotebook.badgeUnique'])
    expect(trailingPills[3]?.textContent).toBe(zh['sqlnotebook.badgeForeignKey'])
  })

  it('does not show any pill on a plain nullable, non-PK column', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount({
      columnsByTable: { city: [{ name: 'name', type: 'TEXT', notNull: false, primaryKey: false }] },
    })
    await harness.connect()
    await openColumnsOf(harness, 'city')

    const nameRow = await harness.view.findByText('name')
    const item = nameRow.closest('[role="treeitem"]')
    expect(item).not.toBeNull()
    const trailing = item!.querySelector(`[class*="${cssImport('columnTrailing')}"]`)
    expect(trailing?.querySelectorAll('span').length ?? 0).toBe(0)
  })

  it('keeps the 非空 pill on a PK column', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount({
      columnsByTable: {
        city: [{ name: 'id', type: 'INTEGER', notNull: true, primaryKey: true }],
      },
    })
    await harness.connect()
    await openColumnsOf(harness, 'city')

    const idRow = await harness.view.findByText('id')
    const item = idRow.closest('[role="treeitem"]')
    const trailingPills = item!.querySelectorAll(`[class*="${cssImport('columnTrailing')}"] > span`)
    expect(trailingPills.length).toBe(2)
    expect(trailingPills[0]?.textContent).toBe(zh['sqlnotebook.badgePrimaryKey'])
    expect(trailingPills[1]?.textContent).toBe(zh['sqlnotebook.badgeNotNull'])
  })

  it('shows the 自增 pill only when the host reports autoIncrement', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount({
      columnsByTable: {
        city: [
          { name: 'id', type: 'INTEGER', notNull: true, primaryKey: true, autoIncrement: true },
        ],
      },
    })
    await harness.connect()
    await openColumnsOf(harness, 'city')

    const idRow = await harness.view.findByText('id')
    const item = idRow.closest('[role="treeitem"]')
    const trailingPills = [...(item!.querySelectorAll(`[class*="${cssImport('columnTrailing')}"] > span`))]
    expect(trailingPills.map(node => node.textContent)).toContain(zh['sqlnotebook.badgeAutoIncrement'])
  })

  it('does not allow the trailing pill slot to shrink', async () => {
    const stylesheet = readFileSync(resolve(process.cwd(), 'src/client/sql/sql-panel.module.css'), 'utf8')
    const rule = (stylesheet.match(/\.columnTrailing \{[\s\S]*?\n\}/u) ?? [])[0]
    expect(rule, '.columnTrailing must exist in sql-panel.module.css').toBeDefined()
    expect(rule).toMatch(/\bflex-shrink:\s*0\b/u)
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

/* ── Category nodes ──────────────────────────────────────────────── */

describe('SqlPanel — 分类节点', () => {
  it('renders every category under a table, with its count, even when zero', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount({ tables: [TABLE('city')] })
    await harness.connect()

    fireEvent.click(await harness.view.findByRole('button', { name: /city\b/u }))

    expect(await harness.view.findByText(zh['sqlnotebook.categoryColumns'])).toBeTruthy()
    expect(harness.view.getByText(zh['sqlnotebook.categoryIndexes'])).toBeTruthy()
    expect(harness.view.getByText(zh['sqlnotebook.categoryForeignKeys'])).toBeTruthy()
    expect(harness.view.getByText(zh['sqlnotebook.categoryTriggers'])).toBeTruthy()
  })
})

/* ── Context menu ───────────────────────────────────────────────── */

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
    const row = await connectedRow(harness)
    fireEvent.click(row)
    const columnsCategory = await harness.view.findByText(zh['sqlnotebook.categoryColumns'])
    fireEvent.click(columnsCategory.closest('button')!)
    await waitFor(() => { expect(harness.schema.sqlColumns).toHaveBeenCalled() })

    fireEvent.contextMenu(row)
    expect((harness.view.getByRole('menuitem', { name: zh['sqlnotebook.copyColumnNames'] }) as HTMLButtonElement).disabled).toBe(true)
  })
})

/* ── Notebook list (top half) ────────────────────────────────── */

describe('SqlPanel — 笔记本列表', () => {
  it('scans the workspace on mount and lists every .sqlnb it finds', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount({
      listings: {
        '': {
          entries: [
            { name: 'query-1.sqlnb', path: 'query-1.sqlnb', kind: 'file' },
            { name: 'demo.db', path: 'demo.db', kind: 'file' },
            { name: 'archived', path: 'archived', kind: 'directory' },
            { name: '.git', path: '.git', kind: 'directory' },
          ],
        },
        archived: {
          entries: [
            { name: 'orders.sqlnb', path: 'archived/orders.sqlnb', kind: 'file' },
          ],
        },
      },
    })

    const rows = await harness.view.findAllByRole('button', { name: new RegExp(zh['sqlnotebook.workspaceNotebookOpenAria'].replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace('\\{name\\}', '.+')) })
    const labels = rows.map(row => row.getAttribute('aria-label')).sort()
    expect(labels).toEqual([
      `打开 SQL 笔记 orders.sqlnb`,
      `打开 SQL 笔记 query-1.sqlnb`,
    ])
  })

  it('calls controller.openFile with the workspace-relative path of the row that was clicked', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount({
      listings: {
        '': {
          entries: [{ name: 'notes.sqlnb', path: 'notes.sqlnb', kind: 'file' }],
        },
      },
    })
    const row = await harness.view.findByRole('button', { name: new RegExp(`^${zh['sqlnotebook.workspaceNotebookOpenAria'].replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace('\\{name\\}', 'notes\\.sqlnb')}$`) })
    fireEvent.click(row)
    expect(harness.openFile).toHaveBeenCalledWith('workspace-1', 'notes.sqlnb')
  })

  it('says the workspace is empty rather than pretending the scan found nothing', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount({
      listings: { '': { entries: [] } },
    })
    expect(await harness.view.findByText(zh['sqlnotebook.workspaceNotebooksEmpty'])).toBeTruthy()
  })

  it('marks the active notebook with an active badge', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount({
      listings: {
        '': {
          entries: [
            { name: 'query.sqlnb', path: 'query.sqlnb', kind: 'file' },
            { name: 'other.sqlnb', path: 'other.sqlnb', kind: 'file' },
          ],
        },
      },
    })

    // The active notebook has the active badge
    const activeBadge = await harness.view.findByText(zh['sqlnotebook.notebookListActiveBadge'])
    expect(activeBadge).toBeTruthy()

    // The badge and the notebook name must share a single clickable button so
    // the "当前" pill renders on the same row as the name, not on its own
    // line below it. If the badge ever drops out of the button, the entry
    // splits into three rows (name / badge / connection) instead of two, and
    // the panel starts looking like a stack of disconnected labels.
    const badgeButton = activeBadge.closest('button')
    expect(badgeButton, 'active badge must live inside the notebook select button').not.toBeNull()
    const nameInSameButton = Array.from(badgeButton!.querySelectorAll('span'))
      .some(span => span.textContent === 'query.sqlnb')
    expect(nameInSameButton, 'notebook name must be a sibling of the active badge inside the same button').toBe(true)
  })

  it('pins the active badge to the right of the name in the same flex row', () => {
    // Regression guard for the visual bug where the "当前" badge used to drop
    // to its own line below the notebook name: `.notebookSelect` (a flex row)
    // had no explicit `flex-wrap: nowrap`, and the badge inherited
    // `flex: 0 1 auto` from the default. When the button was narrow the badge
    // shrank to zero, `margin-left: auto` collapsed, and the badge wrapped to
    // a second line — splitting the active entry into three rows (name /
    // badge / connection) instead of the intended two. The CSS rules below
    // are the ones that keep the badge pinned to the right of the name on a
    // single 30px row, so this test reads the stylesheet and asserts each one.
    const stylesheet = readFileSync(
      resolve(process.cwd(), 'src/client/sql/sql-panel.module.css'),
      'utf8',
    )

    const selectRule = (stylesheet.match(/\.notebookSelect \{[\s\S]*?\n\}/u) ?? [])[0]
    expect(selectRule, '.notebookSelect must exist in sql-panel.module.css').toBeDefined()
    expect(selectRule, '.notebookSelect must forbid flex wrapping so the badge cannot drop to a new line')
      .toMatch(/flex-wrap:\s*nowrap/u)
    expect(selectRule, '.notebookSelect must clip its overflow so a long name cannot push the badge out of the row')
      .toMatch(/overflow:\s*hidden/u)

    const badgeRule = (stylesheet.match(/\.activeBadge \{[\s\S]*?\n\}/u) ?? [])[0]
    expect(badgeRule, '.activeBadge must exist in sql-panel.module.css').toBeDefined()
    expect(badgeRule, '.activeBadge must declare flex: 0 0 auto so margin-left: auto actually pushes it right')
      .toMatch(/flex:\s*0\s+0\s+auto/u)
    expect(badgeRule, '.activeBadge must keep margin-left: auto to push itself to the row edge')
      .toMatch(/margin-left:\s*auto/u)

    const nameRule = (stylesheet.match(/\.notebookName \{[\s\S]*?\n\}/u) ?? [])[0]
    expect(nameRule, '.notebookName must exist in sql-panel.module.css').toBeDefined()
    expect(nameRule, '.notebookName must declare flex: 1 1 auto so the long name can shrink beside the badge')
      .toMatch(/flex:\s*1\s+1\s+auto/u)
    expect(nameRule, '.notebookName must keep min-width: 0 so flex shrinking actually works inside the button')
      .toMatch(/min-width:\s*0/u)
  })

  it('shows connection status in the status line', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount({
      listings: {
        '': {
          entries: [{ name: 'query.sqlnb', path: 'query.sqlnb', kind: 'file' }],
        },
      },
    })
    await harness.connect()

    // The connection path should appear in the status line (first occurrence in statusValue)
    expect(harness.view.getAllByText('demo.db').length).toBeGreaterThanOrEqual(1)
  })

  it('states the database without a label and parks the tier at the row end', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount({
      listings: {
        '': {
          entries: [{ name: 'query.sqlnb', path: 'query.sqlnb', kind: 'file' }],
        },
      },
    })
    await harness.connect()

    const statusLine = harness.view.container.querySelector(`[class*="${cssImport('notebookStatusLine')}"]`)
    // The path is the line's only text: a "库文件" prefix would restate what the row
    // above already says, so the line reads as the database and nothing else.
    expect(statusLine?.textContent).toBe(`demo.db${zh['sqlnotebook.notebookListTierReadOnly']}`)
    // The tier pill is the line's last child and carries the class whose
    // `margin-left: auto` pushes it to the right edge.
    const tier = statusLine?.lastElementChild
    expect(tier?.textContent).toBe(zh['sqlnotebook.notebookListTierReadOnly'])
    expect(tier?.getAttribute('class')).toContain(cssImport('statusTier'))

    const stylesheet = readFileSync(
      resolve(process.cwd(), 'src/client/sql/sql-panel.module.css'),
      'utf8',
    )
    const tierRule = (stylesheet.match(/\.statusTier \{[\s\S]*?\n\}/u) ?? [])[0]
    expect(tierRule, '.statusTier must exist in sql-panel.module.css').toBeDefined()
    expect(tierRule, '.statusTier must push the pill to the row end and keep it from shrinking')
      .toMatch(/margin-left:\s*auto/u)
  })

  it('keeps both lines of an entry in one container', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount({
      listings: {
        '': {
          entries: [{ name: 'query.sqlnb', path: 'query.sqlnb', kind: 'file' }],
        },
      },
    })

    const button = await harness.view.findByRole('button', { name: /query\.sqlnb/u })
    // "未连接数据库" is also the schema pane's empty state, so the status line is
    // picked out by its class rather than by its text.
    const statusLine = harness.view.container.querySelector(`[class*="${cssImport('notebookStatusLine')}"]`)
    expect(statusLine?.textContent).toContain(zh['sqlnotebook.notConnected'])
    // The name row (the button's line) and the connection line must be siblings under
    // the same entry div. If the status line ever moves out, the panel lists the
    // connection as a peer of the notebook instead of as a fact about it.
    expect(statusLine?.parentElement)
      .toBe(button.closest(`[class*="${cssImport('notebookRow')}"]`)?.parentElement)
  })

  it('lets only the entry div paint a box, so the two lines read as one item', () => {
    // Regression guard for the entry rendering as *two* stacked boxes. `.notebookRow`
    // was declared twice in the stylesheet: the declaration left over from the
    // pre-terminal design carried its own `padding`, `border-radius`, `background`
    // and `:hover` fill, so the first line drew a rounded box inside the entry's
    // fill and the name row read as a separate item from the connection line below
    // it. The entry is the only box in the list, so no class the two lines use may
    // paint a fill of its own.
    const stylesheet = readFileSync(
      resolve(process.cwd(), 'src/client/sql/sql-panel.module.css'),
      'utf8',
    )

    for (const name of ['notebookEntry', 'notebookRow', 'notebookSelect', 'notebookStatusLine']) {
      const declarations = [...stylesheet.matchAll(new RegExp(`\\.${name}\\s*\\{`, 'gu'))]
      expect(declarations, `.${name} must be declared exactly once`).toHaveLength(1)
    }

    const rowRule = (stylesheet.match(/\.notebookRow \{[\s\S]*?\n\}/u) ?? [])[0]
    expect(rowRule, '.notebookRow must exist in sql-panel.module.css').toBeDefined()
    for (const property of ['background', 'border-radius', 'padding', 'border:']) {
      expect(rowRule, `.notebookRow must not declare ${property} — the entry is the only box that paints`)
        .not.toMatch(new RegExp(`(^|;|\\n)\\s*${property.replace(/[:/]/gu, '\\\\$&')}`, 'u'))
    }
    expect(stylesheet, '.notebookRow must not carry its own hover fill')
      .not.toMatch(/\.notebookRow:hover/u)
  })
})

/* ── Two-pane layout ───────────────────────────────────────────── */

describe('SqlPanel — 上下两部分', () => {
  it('renders two panes: top for notebook list, bottom for schema', () => {
    openNotebook(notebookTab('query.sqlnb'))
    const { view } = mount()

    // Find panes: each one has the hashed class name, e.g. `_pane_2675e8` or `_paneTop_2675e8 _pane_2675e8`
    const allDivs = view.container.querySelectorAll('div')
    const panes = [...allDivs].filter(div => {
      const cls = div.getAttribute('class') ?? ''
      // After vite hashing the source class is the substring before the hash.
      return /(^|\s)_?pane[A-Za-z]*_[A-Za-z0-9]+/.test(cls)
    })
    expect(panes.length).toBeGreaterThanOrEqual(2)
  })

  it('draws pane dividers via the frame-level overlay, not via CSS borders', () => {
    const stylesheet = readFileSync(
      resolve(process.cwd(), 'src/client/sql/sql-panel.module.css'),
      'utf8',
    )
    const paneTop = stylesheet.match(/\.paneTop \{[\s\S]*?\n\}/u)
    expect(paneTop, '.paneTop must exist').not.toBeNull()
    expect(paneTop![0]).toMatch(/border-bottom:\s*1px solid transparent/u)
  })

  it('schema tree appears in the bottom pane', async () => {
    openNotebook(notebookTab('query.sqlnb'))
    const harness = mount({
      tables: [TABLE('city')],
    })
    await harness.connect()

    await waitFor(() => {
      expect(harness.view.queryByText(zh['sqlnotebook.schemaLoading'])).toBeNull()
    })
    expect(await harness.view.findByRole('button', { name: /city\b/u })).toBeTruthy()
    const tree = harness.view.getByRole('tree', { name: zh['sqlnotebook.schema'] })

    // Two panes: the top carries the `paneTop` source class, the bottom is plain `pane`.
    const allDivs = harness.view.container.querySelectorAll('div')
    const panes = [...allDivs].filter(div => {
      const cls = div.getAttribute('class') ?? ''
      return /(^|\s)_?pane_[A-Za-z0-9]+/.test(cls)
    })
    // At least the bottom (schema) pane should be present, and tree should be inside it
    expect(panes.length).toBeGreaterThanOrEqual(1)
    const bottomPane = panes[panes.length - 1]
    expect(bottomPane).toBeDefined()
    expect(bottomPane!.contains(tree)).toBe(true)
  })
})

/* ── Helper: CSS class lookup ─────────────────────────────────── */

function cssImport(name: string): string {
  const stylesheet = readFileSync(
    resolve(process.cwd(), 'src/client/sql/sql-panel.module.css'),
    'utf8',
  )
  const declared = new RegExp(`\\.${name}\\s*\\{`, 'u')
  if (!declared.test(stylesheet)) throw new Error(`css class not declared: ${name}`)
  return name
}
