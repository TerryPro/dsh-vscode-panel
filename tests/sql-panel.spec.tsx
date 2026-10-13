// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { zh } from '../src/client/core/locales.ts'
import type { WorkbenchFileTab } from '../src/client/model/controller.ts'
import { WorkbenchApiError } from '../src/client/model/api.ts'
import { SqlPanel } from '../src/client/sql/SqlPanel.tsx'
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

function notebookTab(path: string): WorkbenchFileTab {
  return {
    id: `file:${path}`,
    kind: 'file',
    path,
    file: { path, content: '{}', version: '1', size: 2, markdown: false },
    image: null,
    draft: '{}',
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
  runtime: SqlRuntime
}

function mount(options: { entries?: Array<{ name: string; path: string; kind: 'file' }>; refuse?: WorkbenchApiError } = {}): Harness {
  const api = {
    // The handle answers with the target it was asked for: a fake that always says `demo.db` would
    // make every "is this the memory database" assertion pass for the wrong reason.
    sqlOpen: vi.fn((request: { path: string; access?: string }) => Promise.resolve({
      path: request.path,
      access: (request.access ?? 'read-only') as 'read-only' | 'writable',
      sqliteVersion: '3.46.0',
      walSidecarExpected: false,
      rowLimit: 1000,
    })),
    sqlExecute: vi.fn(),
    sqlClose: vi.fn(() => Promise.resolve({ path: 'demo.db', closed: true, rolledBack: false })),
    sqlAbandon: vi.fn(() => Promise.resolve({ path: 'demo.db', scheduled: true })),
    sqlCancel: vi.fn(() => Promise.resolve({ cancelled: false })),
  }
  if (options.refuse !== undefined) {
    const refusal = options.refuse
    api.sqlOpen = vi.fn(() => Promise.reject(refusal))
  }
  const runtime = new SqlRuntime(api as never, { info: vi.fn(), warn: vi.fn() }, { getDraft: () => '{}' })
  const entries = options.entries ?? [
    { name: 'demo.db', path: 'demo.db', kind: 'file' as const },
    { name: 'demo.db-wal', path: 'demo.db-wal', kind: 'file' as const },
    { name: 'archive.sqlite', path: 'archive.sqlite', kind: 'file' as const },
  ]
  const controller = {
    sqlRuntime: runtime,
    api: {
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
  return { view, api, runtime }
}

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
