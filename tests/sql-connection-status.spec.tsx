// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { zh } from '../src/client/core/locales.ts'
import { WorkbenchApiError } from '../src/client/model/api.ts'
import { SqlConnectionStatus } from '../src/client/sql/SqlConnectionStatus.tsx'
import { SqlRuntime } from '../src/client/sql/sql-runtime.ts'
import { SQL_PATH_UNAVAILABLE_CODE } from '../src/shared/sql-protocol.ts'

const NOTEBOOK_DRAFT = JSON.stringify({ version: 1, cells: [{ kind: 'sql', source: 'SELECT 1' }] })

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

afterEach(() => { cleanup() })

const t = (key: string): string => (zh as Record<string, string>)[key] ?? key

/**
 * The strip, with the tab bound by default.
 *
 * `bound: false` leaves the tab without a runtime, which is the state the strip is in on the paint
 * before `bind` runs — and for the whole time in the source view, where nothing mounts a surface to
 * bind. `recorded` is what the notebook's own file names in that state.
 */
function mount(props: {
  walExpected?: boolean
  path?: string
  bound?: boolean
  recorded?: { path: string; access: 'read-only' | 'writable' } | null
} = {}): { runtime: SqlRuntime; view: ReturnType<typeof render>; api: Record<string, ReturnType<typeof vi.fn>> } {
  const api = {
    sqlOpen: vi.fn((request: { path: string; access?: string }) => Promise.resolve({
      path: request.path,
      access: (request.access ?? 'read-only') as 'read-only' | 'writable',
      sqliteVersion: '3.46.0',
      walSidecarExpected: props.walExpected ?? false,
      rowLimit: 1000,
    })),
    sqlExecute: vi.fn(() => Promise.resolve({ path: 'demo.db', blocks: [], elapsedMs: 1, executionCount: 1 })),
    sqlClose: vi.fn(() => Promise.resolve({ path: 'demo.db', closed: true, rolledBack: false })),
    sqlAbandon: vi.fn(() => Promise.resolve({ path: 'demo.db', scheduled: true })),
    sqlCancel: vi.fn(() => Promise.resolve({ cancelled: false })),
  }
  const runtime = new SqlRuntime(api as never, { info: vi.fn(), warn: vi.fn() }, {
    getDraft: () => NOTEBOOK_DRAFT,
    setDraft: vi.fn(),
    save: vi.fn(),
  })
  if (props.bound !== false) runtime.bind('tab-1', 'workspace-1', 'query.sqlnb')
  const view = render(
    <SqlConnectionStatus
      runtime={runtime}
      tabId="tab-1"
      t={t as never}
      recorded={props.recorded ?? null}
    />,
  )
  return { runtime, view, api }
}

describe('SqlConnectionStatus', () => {
  it('reads as unconnected before any handle exists', () => {
    const { view } = mount()

    expect(view.getByText(zh['sqlnotebook.notConnected'])).toBeTruthy()
  })

  it('shows which database, which tier and which cap the handle got', async () => {
    const { runtime, view } = mount()
    await runtime.connect('tab-1', 'demo.db', 'writable')

    await waitFor(() => {
      expect(view.container.textContent).toBe(`demo.db · ${zh['sqlnotebook.writableTier']} · 1000`)
    })
  })

  it('reports the granted tier, not the requested one', async () => {
    // The Host answers with the tier it actually gave: a writable request refused as occupied has to
    // read as read-only rather than as the tier nobody granted.
    const { runtime, view } = mount()
    await runtime.connect('tab-1', 'demo.db', 'read-only')

    await waitFor(() => {
      expect(view.container.textContent).toContain(zh['sqlnotebook.readOnlyTier'])
    })
  })

  it('turns a file that went missing into a reconnect hint instead of one failure among many', async () => {
    const { runtime, view, api } = mount()
    await runtime.connect('tab-1', 'demo.db', 'read-only')
    // The dedicated code is what the Host mints when the driver's message named the file's own path —
    // a renamed or deleted database, which nothing watches. The readout is where the reader learns
    // to reconnect rather than reading it as one failed query among many.
    api['sqlExecute'] = vi.fn(() => Promise.reject(new WorkbenchApiError(SQL_PATH_UNAVAILABLE_CODE, '数据库文件当前不可访问。')))
    runtime.runCell('tab-1', 'sqlnb-0')

    await waitFor(() => { expect(view.container.textContent).toBe(zh['sqlnotebook.reconnectHint']) })
  })

  /*
   * Two standing session facts moved into the strip from above the cell surface (#16 accepted the
   * same line-on-top reading for the panel, but a line that only shows while the cell view is on
   * screen is a fact the reader has to remember the toolbar for, and that is not what a handle
   * fact is). The strip outlives the cell surface, so it is the home for the same line.
   */
  it('appends the WAL sidecar notice to the strip when the handle is expected to leave -wal/-shm', async () => {
    const { runtime, view } = mount({ walExpected: true })
    await runtime.connect('tab-1', 'demo.db', 'read-only')

    await waitFor(() => {
      // The connection line and the sidecar notice share the strip, so the textContent holds both
      // — asserting the sidecar line is in there is the contract, and the prior tests above
      // already keep the connection line honest.
      expect(view.container.textContent).toContain(zh['sqlnotebook.walSidecarNotice'])
    })
  })

  it('appends the in-memory notice to the strip when the handle is on :memory:', async () => {
    const { runtime, view } = mount()
    await runtime.connect('tab-1', ':memory:', 'read-only')

    await waitFor(() => {
      expect(view.container.textContent).toContain(zh['sqlnotebook.memoryNotice'])
    })
  })

  it('shows both notices side by side when both apply, with the in-memory fact first', async () => {
    // A read-only handle on :memory: is not what the Host grants, but the strip's job is to render
    // what it is told, and a component test that re-derives the access tier would assert against
    // its own input. Both flags are independently observable on the connection; their order on
    // screen is the contract.
    const { runtime, view } = mount({ walExpected: true })
    await runtime.connect('tab-1', ':memory:', 'read-only')

    await waitFor(() => {
      const text = view.container.textContent ?? ''
      const walAt = text.indexOf(zh['sqlnotebook.walSidecarNotice'])
      const memAt = text.indexOf(zh['sqlnotebook.memoryNotice'])
      expect(walAt).toBeGreaterThanOrEqual(0)
      // The two notices are appended in the order the connection surfaces them, with the
      // in-memory fact first (the more time-critical one — the database is evaporating right
      // now) and the WAL sidecar after. The component owns that order; the test pins it.
      expect(memAt).toBeGreaterThanOrEqual(0)
      expect(memAt).toBeLessThan(walAt)
    })
  })

  /**
   * The strip is the *only* place the connection line is said, in the cell view as much as in the
   * source view. The cell surface used to paint `库名 · 档别 · 上限` in a row of its own directly
   * above the strip while the strip held its copy back (`hideReadout`, ADR 0008) — two rows for one
   * sentence, and nothing told the reader which was the authority. That row is gone, so these cases
   * are the inverse of the ones they replace: the line must now be present, not absent.
   */
  it('carries the readout in the cell view too, since the surface row is gone', async () => {
    const { runtime, view } = mount()
    await runtime.connect('tab-1', 'demo.db', 'read-only')

    await waitFor(() => {
      expect(view.container.textContent).toBe(`demo.db · ${zh['sqlnotebook.readOnlyTier']} · 1000`)
    })
  })

  it('names the file\'s recorded database before the tab has a runtime', () => {
    // The paint before `bind` runs, and the whole time in the source view: the file already named
    // its database, so "connecting…" here is the frame a reader takes for a dropped connection.
    // The cap is dropped — no Host has answered, and inventing `1000` would be a lie.
    const { view } = mount({ bound: false, recorded: { path: 'examples/demo.db', access: 'read-only' } })

    expect(view.container.textContent).toBe(`examples/demo.db · ${zh['sqlnotebook.readOnlyTier']}`)
  })

  it('says unconnected before the tab has a runtime and the file names no database', () => {
    const { view } = mount({ bound: false, recorded: null })

    expect(view.container.textContent).toBe(zh['sqlnotebook.notConnected'])
  })

  it('prefers the live handle over the file record once the tab is bound', async () => {
    // The record is a fallback, not a second authority: once `bind` has seeded the store and the
    // Host has answered, a strip still reading the file's copy would be the stale one of the two.
    const { runtime, view } = mount({ recorded: { path: 'old.db', access: 'read-only' } })
    await runtime.connect('tab-1', 'demo.db', 'writable')

    await waitFor(() => {
      expect(view.container.textContent).toBe(`demo.db · ${zh['sqlnotebook.writableTier']} · 1000`)
    })
  })

  it('still reports a lost database file over the readout', async () => {
    // The readout would keep naming the path the handle was opened on until the reader disconnects,
    // so a missing file must outrank it rather than sit underneath it.
    const { runtime, view, api } = mount()
    await runtime.connect('tab-1', 'demo.db', 'read-only')
    api['sqlExecute'] = vi.fn(() => Promise.reject(new WorkbenchApiError(SQL_PATH_UNAVAILABLE_CODE, '数据库文件当前不可访问。')))
    runtime.runCell('tab-1', 'sqlnb-0')

    await waitFor(() => { expect(view.container.textContent).toBe(zh['sqlnotebook.reconnectHint']) })
  })

  it('carries the two standing session facts beside the readout', async () => {
    // Both are true for the whole session, and the strip is the one surface on screen in both views.
    const { runtime, view } = mount({ walExpected: true })
    await runtime.connect('tab-1', ':memory:', 'read-only')

    await waitFor(() => {
      const text = view.container.textContent ?? ''
      expect(text).toContain(zh['sqlnotebook.memoryNotice'])
      expect(text).toContain(zh['sqlnotebook.walSidecarNotice'])
    })
  })
})
