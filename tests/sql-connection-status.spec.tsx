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

/** One notebook and a runtime that answers open with whatever tier it was asked for. */
function mount(props: { hideReadout?: boolean } = {}): { runtime: SqlRuntime; view: ReturnType<typeof render>; api: Record<string, ReturnType<typeof vi.fn>> } {
  const api = {
    sqlOpen: vi.fn((request: { path: string; access?: string }) => Promise.resolve({
      path: request.path,
      access: (request.access ?? 'read-only') as 'read-only' | 'writable',
      sqliteVersion: '3.46.0',
      walSidecarExpected: false,
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
  runtime.bind('tab-1', 'workspace-1', 'query.sqlnb')
  // `SqlConnectionStatus` renders nothing until a tab is bound, which the call above does.
  const view = render(<SqlConnectionStatus runtime={runtime} tabId="tab-1" t={t as never} {...(props.hideReadout === undefined ? {} : { hideReadout: props.hideReadout })} />)
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

  /**
   * The strip gives up the readout when the notebook toolbar is on screen and already states it
   * (ADR 0008, following the `hideChip` rule `NotebookKernelStatus` already keeps). Rendering an
   * empty span would still take a slot in the strip's flex row and read as a missing value rather
   * than as a fact stated once.
   */
  it('goes quiet while the notebook toolbar is the one reporting', async () => {
    const { runtime, view } = mount({ hideReadout: true })
    await runtime.connect('tab-1', 'demo.db', 'read-only')

    await waitFor(() => { expect(runtime.state('tab-1').connection).not.toBeNull() })
    expect(view.container.textContent).toBe('')
  })

  it('still reports a lost database file while the toolbar reports the handle', async () => {
    // The one fact the toolbar cannot show: it keeps naming the database it opened, so "that file is
    // gone" has no other surface on screen, hideReadout or not.
    const { runtime, view, api } = mount({ hideReadout: true })
    await runtime.connect('tab-1', 'demo.db', 'read-only')
    api['sqlExecute'] = vi.fn(() => Promise.reject(new WorkbenchApiError(SQL_PATH_UNAVAILABLE_CODE, '数据库文件当前不可访问。')))
    runtime.runCell('tab-1', 'sqlnb-0')

    await waitFor(() => { expect(view.container.textContent).toBe(zh['sqlnotebook.reconnectHint']) })
  })
})
