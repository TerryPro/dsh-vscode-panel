// @vitest-environment jsdom

/**
 * The kernel manager panel.
 *
 * What is under test is the panel's *judgement*, not its pixels: which row offers a
 * reclaim, and what the panel refuses to claim it can do. A button that stops a kernel
 * somebody is watching is the one mistake this surface must not be able to make.
 */
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The store package pulls zustand/immer, which are not installed for tests; the same
// minimal stand-in the other notebook specs use keeps these about behaviour.
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

import type { KernelListResult, KernelListing } from '../src/shared/notebook-protocol.ts'
import { KernelPanel } from '../src/client/notebook/KernelPanel.tsx'
import { KernelRegistry } from '../src/client/notebook/kernel-registry.ts'
import { zh } from '../src/client/core/locales.ts'

/**
 * Resolve real dictionary strings and interpolate them the way the shell does.
 *
 * Built from `zh` rather than restated, so a renamed key fails the build instead of
 * passing a test that asserts a string nobody sees.
 */
function t(key: string, values?: Record<string, string>): string {
  const template = (zh as Record<string, string>)[key] ?? key
  if (values === undefined) return template
  return template.replace(/\{(\w+)\}/gu, (_all, name: string) => values[name] ?? '')
}

function listing(overrides: Partial<KernelListing> = {}): KernelListing {
  return {
    kernelId: 'k1',
    path: 'analysis.ipynb',
    displayName: 'DSH Runtime Python 3',
    specName: 'dsh-runtime-python3',
    language: 'python',
    phase: 'ready',
    busy: false,
    executionCount: 3,
    attached: 1,
    lastEngagedAt: Date.now(),
    pid: 4242,
    orphan: false,
    reclaimable: false,
    ...overrides,
  }
}

function emptyResult(overrides: Partial<KernelListResult> = {}): KernelListResult {
  return { kernels: [], maxKernelsPerWorkspace: 3, maxKernelsTotal: 8, totalKernels: 0, ...overrides }
}

async function setup(result: KernelListResult) {
  const api = {
    kernelList: vi.fn(async () => result),
    kernelReclaim: vi.fn(async () => ({
      kernelId: 'k1', phase: 'terminated' as const, executionCount: 0, sequence: 1,
      attached: 0, displayName: 'Python 3', specName: 'python3',
    })),
  }
  const registry = new KernelRegistry(api as never, { warn: vi.fn() })
  const controller = { kernelRegistry: registry, openFile: vi.fn(async () => undefined) }
  const view = render(<KernelPanel controller={controller as never} workspaceId="ws-1" t={t as never} />)
  await act(async () => { await vi.waitFor(() => { expect(api.kernelList).toHaveBeenCalled() }) })
  return { ...view, api, registry, controller }
}

afterEach(() => {
  cleanup()
})

describe('kernel panel', () => {
  it('lists the kernels this workspace is running', async () => {
    const { findByText, api } = await setup(emptyResult({ totalKernels: 1, kernels: [listing()] }))
    expect(await findByText('analysis.ipynb')).toBeTruthy()
    expect(api.kernelList).toHaveBeenCalledWith('ws-1')
  })

  it('says so when nothing is running', async () => {
    const { findByText } = await setup(emptyResult())
    expect(await findByText(t('kernels.empty'))).toBeTruthy()
  })

  it('shows the capacity that explains a refused start', async () => {
    const { findByText } = await setup(emptyResult({
      totalKernels: 5,
      maxKernelsPerWorkspace: 3,
      maxKernelsTotal: 8,
      kernels: [
        listing(),
        listing({ kernelId: 'k2', path: 'b.ipynb' }),
        listing({ kernelId: 'k3', path: 'c.ipynb' }),
      ],
    }))
    expect(await findByText(/3\/3/u)).toBeTruthy()
    // At the ceiling the panel warns, because the next notebook will fail to start.
    expect(await findByText(t('kernels.capacityFull'))).toBeTruthy()
  })

  it('does not warn below the ceiling', async () => {
    const { findByText, queryByText } = await setup(emptyResult({
      maxKernelsPerWorkspace: 3,
      kernels: [listing()],
    }))
    await findByText('analysis.ipynb')
    expect(queryByText(t('kernels.capacityFull'))).toBeNull()
  })

  it('offers no reclaim for a kernel a page is watching', async () => {
    const { findByText, queryByText } = await setup(emptyResult({ kernels: [listing({ attached: 1 })] }))
    await findByText('analysis.ipynb')
    // The row must explain where to go rather than offer a button the Host refuses.
    expect(queryByText(t('kernels.reclaim'))).toBeNull()
  })

  it('reclaims an unattended kernel once the Host has cleared it', async () => {
    const { findByText, api, registry } = await setup(emptyResult({
      kernels: [listing({ attached: 0, orphan: true, reclaimable: true })],
    }))
    const button = await findByText(t('kernels.reclaim'))
    expect((button as HTMLButtonElement).disabled).toBe(false)
    await act(async () => {
      fireEvent.click(button)
      await vi.waitFor(() => { expect(api.kernelReclaim).toHaveBeenCalledWith('k1', 'ws-1') })
    })
    registry.dispose()
  })

  it('disables reclaim while the kernel is still settling', async () => {
    const { findByText } = await setup(emptyResult({
      kernels: [listing({ attached: 0, orphan: true, reclaimable: false })],
    }))
    const button = await findByText(t('kernels.reclaim'))
    expect((button as HTMLButtonElement).disabled).toBe(true)
  })

  it('explains an unattended kernel rather than just offering to kill it', async () => {
    // The variables are the reason the kernel was kept, so the row has to say what
    // reclaiming costs; otherwise the panel invites the reader to destroy state.
    const { findByText } = await setup(emptyResult({
      kernels: [listing({ attached: 0, orphan: true, reclaimable: true })],
    }))
    expect(await findByText(t('kernels.orphanHint'))).toBeTruthy()
  })

  it('names the process id, the one fact a user can act on outside the app', async () => {
    const { findByText } = await setup(emptyResult({ kernels: [listing({ pid: 98765 })] }))
    expect(await findByText(/98765/u)).toBeTruthy()
  })

  it('reports a kernel that never came up as having no process', async () => {
    const { findByText, queryByText } = await setup(emptyResult({
      kernels: [listing({ phase: 'failed', pid: null })],
    }))
    await findByText(t('kernels.failed'))
    expect(queryByText(/process/u)).toBeNull()
  })

  it('opens the notebook that owns a kernel', async () => {
    const { findByText, controller } = await setup(emptyResult({ kernels: [listing()] }))
    const name = await findByText('analysis.ipynb')
    await act(async () => {
      fireEvent.click(name)
      await vi.waitFor(() => { expect(controller.openFile).toHaveBeenCalledWith('ws-1', 'analysis.ipynb') })
    })
  })

  it('surfaces a failed read rather than an empty list', async () => {
    const registry = new KernelRegistry({
      kernelList: vi.fn(async () => { throw new Error('endpoint missing') }),
      kernelReclaim: vi.fn(),
    } as never, { warn: vi.fn() })
    const controller = { kernelRegistry: registry, openFile: vi.fn() }
    const { findByText } = render(
      <KernelPanel controller={controller as never} workspaceId="ws-1" t={t as never} />,
    )
    expect(await findByText(/endpoint missing/u)).toBeTruthy()
    registry.dispose()
  })

  it('stops polling when the panel unmounts', async () => {
    const { api, registry, unmount } = await setup(emptyResult({ kernels: [listing()] }))
    api.kernelList.mockClear()
    unmount()
    await act(async () => { await new Promise(resolve => { setTimeout(resolve, 60) }) })
    // A panel nobody is looking at must not keep hitting the Host every few seconds.
    expect(api.kernelList).not.toHaveBeenCalled()
    registry.dispose()
  })
})
