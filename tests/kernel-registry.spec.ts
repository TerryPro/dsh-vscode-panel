/**
 * The kernel manager's client-side store.
 *
 * The panel is thin; what carries risk here is the polling lifecycle. A stale refresh
 * landing after the reader switches Workspace would show one workspace's kernels under
 * another's header, which looks authoritative and is wrong.
 */
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

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KernelListResult } from '../src/shared/notebook-protocol.ts'
import {
  KernelRegistry,
  kernelIdleLabel,
  kernelStatusKey,
} from '../src/client/notebook/kernel-registry.ts'

function listOf(overrides: Partial<KernelListResult> = {}): KernelListResult {
  return {
    kernels: [],
    maxKernelsPerWorkspace: 3,
    maxKernelsTotal: 8,
    totalKernels: 0,
    ...overrides,
  }
}

function makeRegistry(result: KernelListResult = listOf()) {
  const api = {
    kernelList: vi.fn(async () => result),
    kernelReclaim: vi.fn(async () => ({
      kernelId: 'k1', phase: 'terminated' as const, executionCount: 0, sequence: 1,
      attached: 0, displayName: 'Python 3', specName: 'python3',
    })),
  }
  const logger = { warn: vi.fn() }
  return { api, registry: new KernelRegistry(api as never, logger) }
}

afterEach(() => { vi.useRealTimers() })

describe('kernel registry polling', () => {
  it('reads once immediately and then on a timer', async () => {
    vi.useFakeTimers()
    const { api, registry } = makeRegistry(listOf({ totalKernels: 1 }))
    registry.watch('ws-1')
    // Advance zero ms: this settles the immediate read's microtasks without firing
    // the interval, which `runOnlyPendingTimersAsync` would do.
    await vi.advanceTimersByTimeAsync(0)
    expect(api.kernelList).toHaveBeenCalledTimes(1)
    expect(registry.state.result?.totalKernels).toBe(1)
    expect(registry.state.loading).toBe(false)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(api.kernelList).toHaveBeenCalledTimes(2)
    registry.dispose()
    vi.useRealTimers()
  })

  it('does not stack a second timer when told to watch the same workspace twice', async () => {
    const { api, registry } = makeRegistry()
    registry.watch('ws-1')
    registry.watch('ws-1')
    await vi.waitFor(() => { expect(api.kernelList).toHaveBeenCalledTimes(1) })
    registry.dispose()
  })

  it('drops a refresh that finishes after the workspace changed', async () => {
    // React StrictMode and rapid workspace switching both produce this ordering; the
    // panel must never show the previous workspace's rows under a new header.
    // A holder object rather than a bare variable: control-flow analysis cannot see
    // the assignment made inside the executor callback, and narrows it to `null`.
    const held: { release: ((value: KernelListResult) => void) | null } = { release: null }
    const api: {
      kernelList: ReturnType<typeof vi.fn>
      kernelReclaim: ReturnType<typeof vi.fn>
    } = {
      kernelList: vi.fn<() => Promise<KernelListResult>>()
        .mockImplementationOnce(() => new Promise<KernelListResult>(resolve => { held.release = resolve }))
        .mockResolvedValue(listOf({ totalKernels: 99 })),
      kernelReclaim: vi.fn(),
    }
    const registry = new KernelRegistry(api as never, { warn: vi.fn() })
    registry.watch('ws-1')
    await vi.waitFor(() => { expect(api.kernelList).toHaveBeenCalledTimes(1) })
    // Switching workspaces invalidates the in-flight read, then the second read lands.
    registry.watch('ws-2')
    held.release?.(listOf({ totalKernels: 7 }))
    await vi.waitFor(() => { expect(api.kernelList).toHaveBeenCalledTimes(2) })
    expect(registry.state.result?.totalKernels).toBe(99)
    expect(registry.state.workspaceId).toBe('ws-2')
    registry.dispose()
  })

  it('reports a failed read instead of showing a stale list as current', async () => {
    const api = { kernelList: vi.fn().mockRejectedValue(new Error('kernel list endpoint missing')), kernelReclaim: vi.fn() }
    const registry = new KernelRegistry(api as never, { warn: vi.fn() })
    registry.watch('ws-1')
    await vi.waitFor(() => { expect(registry.state.error).toContain('endpoint missing') })
    expect(registry.state.loading).toBe(false)
    registry.dispose()
  })

  it('stops polling on unwatch', async () => {
    vi.useFakeTimers()
    const { api, registry } = makeRegistry()
    registry.watch('ws-1')
    await vi.advanceTimersByTimeAsync(0)
    expect(api.kernelList).toHaveBeenCalledTimes(1)
    registry.unwatch()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(api.kernelList).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })
})

describe('kernel reclaim', () => {
  it('reclaims through the api and refreshes afterwards', async () => {
    const { api, registry } = makeRegistry()
    registry.watch('ws-1')
    await vi.waitFor(() => { expect(api.kernelList).toHaveBeenCalled() })
    api.kernelList.mockClear()
    const ok = await registry.reclaim('ws-1', 'k1')
    expect(ok).toBe(true)
    expect(api.kernelReclaim).toHaveBeenCalledWith('k1', 'ws-1')
    // The row must disappear promptly rather than sit there until the next tick.
    expect(api.kernelList).toHaveBeenCalled()
    registry.dispose()
  })

  it('does not send two reclaims for the same kernel at once', async () => {
    const held: { release: (() => void) | null } = { release: null }
    const api = {
      kernelList: vi.fn(async () => listOf()),
      kernelReclaim: vi.fn(() => new Promise(resolve => { held.release = () => resolve({}) })),
    }
    const registry = new KernelRegistry(api as never, { warn: vi.fn() })
    const first = registry.reclaim('ws-1', 'k1')
    const second = registry.reclaim('ws-1', 'k1')
    expect(api.kernelReclaim).toHaveBeenCalledTimes(1)
    held.release?.()
    await Promise.all([first, second])
    expect(registry.state.reclaiming).toEqual([])
    registry.dispose()
  })

  it('surfaces a refusal and still clears the in-flight marker', async () => {
    const api = {
      kernelList: vi.fn(async () => listOf()),
      kernelReclaim: vi.fn().mockRejectedValue(new Error('this kernel is open in a notebook')),
    }
    const registry = new KernelRegistry(api as never, { warn: vi.fn() })
    const ok = await registry.reclaim('ws-1', 'k1')
    expect(ok).toBe(false)
    expect(registry.state.reclaiming).toEqual([])
    registry.dispose()
  })
})

describe('kernel list scoping', () => {
  it('returns nothing while the cached list belongs to another workspace', async () => {
    const { api, registry } = makeRegistry(listOf({
      totalKernels: 1,
      kernels: [{
        kernelId: 'k1', path: 'a.ipynb', displayName: 'Python 3', specName: 'python3',
        language: 'python', phase: 'ready', busy: false, executionCount: 1, attached: 0,
        lastEngagedAt: Date.now(), pid: 1, orphan: true, reclaimable: true,
      }],
    }))
    registry.watch('ws-1')
    await vi.waitFor(() => { expect(api.kernelList).toHaveBeenCalled() })
    expect(registry.kernelsFor('ws-1')).toHaveLength(1)
    expect(registry.kernelsFor('ws-2')).toEqual([])
    expect(registry.kernelsFor(undefined)).toEqual([])
    registry.dispose()
  })
})

describe('kernel presentation helpers', () => {
  it('ages an idle kernel in the smallest sensible unit', () => {
    const now = 1_000_000_000_000
    expect(kernelIdleLabel(now, now)).toBe('now')
    expect(kernelIdleLabel(now, now - 4_000)).toBe('now')
    expect(kernelIdleLabel(now, now - 12_000)).toBe('12s')
    expect(kernelIdleLabel(now, now - 90_000)).toBe('1m')
    expect(kernelIdleLabel(now, now - 3_700_000)).toBe('1h')
    // A clock skew must not read as a negative age.
    expect(kernelIdleLabel(now, now + 50_000)).toBe('now')
  })

  it('reports a running kernel as running whatever its phase says', () => {
    // A kernel mid-run is the one state a reader must not misread, and its reported
    // phase can lag the run by a frame.
    expect(kernelStatusKey('ready', true)).toBe('kernels.running')
    expect(kernelStatusKey('idle', true)).toBe('kernels.running')
    expect(kernelStatusKey('ready', false)).toBe('kernels.idle')
    expect(kernelStatusKey('starting', false)).toBe('kernels.starting')
    expect(kernelStatusKey('absent', false)).toBe('kernels.starting')
    expect(kernelStatusKey('failed', false)).toBe('kernels.failed')
    expect(kernelStatusKey('terminating', false)).toBe('kernels.terminating')
    expect(kernelStatusKey('terminated', false)).toBe('kernels.terminated')
  })
})
