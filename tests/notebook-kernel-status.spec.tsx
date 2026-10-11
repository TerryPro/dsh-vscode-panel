// @vitest-environment jsdom

/**
 * The status bar's kernel readout.
 *
 * Two things are worth locking down: the sentence and colour a given kernel state
 * produces (the strip's whole judgement), and the subscription path — a reader that
 * mounts before the tab has a runtime must end up attached to the real store, not
 * merely woken once. The second is asserted through a real `NotebookRuntime`, because
 * a fake that reimplements `peekSubscribe` would test the fake.
 */
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The store package pulls zustand/immer, which are not installed for tests; this
// stand-in also exposes how many listeners are attached, which is how the
// migration-under-test is observed without reaching into private fields.
const stores = vi.hoisted(() => ({ created: [] as Array<{ listenerCount: () => number }> }))
vi.mock('@deepseek-ai/dsh-client-store', () => ({
  createSnapshotStore: <T,>(initial: T) => {
    let state = initial
    const listeners = new Set<() => void>()
    const store = {
      getSnapshot: () => state,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      set: (next: T) => { state = next; listeners.forEach(listener => { listener() }) },
      update: (mutator: (draft: T) => void) => {
        const next = structuredClone(state)
        mutator(next)
        state = next
        listeners.forEach(listener => { listener() })
      },
      listenerCount: () => listeners.size,
    }
    stores.created.push(store as { listenerCount: () => number })
    return store
  },
}))

import type { NotebookState } from '../src/client/notebook/notebook-model.ts'
import { initialNotebookState } from '../src/client/notebook/notebook-model.ts'
import { describeKernelStatus } from '../src/client/notebook/notebook-kernel-status.ts'
import { NotebookKernelStatus } from '../src/client/notebook/NotebookKernelStatus.tsx'
import { NotebookRuntime } from '../src/client/notebook/notebook-runtime.ts'
import { zh } from '../src/client/core/locales.ts'

function t(key: keyof typeof zh, values?: Record<string, string>): string {
  const template: string = zh[key]
  if (values === undefined) return template
  return Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, value), template)
}

/** A kernel the reader is attached to, ready to run. */
function connected(overrides: Partial<NotebookState['kernel']> = {}): NotebookState {
  return {
    ...initialNotebookState(),
    kernel: {
      ...initialNotebookState().kernel,
      phase: 'idle',
      kernelId: 'k-1',
      token: 'secret-token',
      displayName: 'DSH Runtime Python 3',
      specName: 'dsh-runtime-python3',
      transport: 'stream',
      ...overrides,
    },
  }
}

describe('kernel status wording', () => {
  it('names the kernel and calls it ready when it is attached and idle', () => {
    const view = describeKernelStatus(connected(), 0, t)
    expect(view.label).toBe('DSH Runtime Python 3')
    expect(view.tone).toBe('idle')
    expect(view.title).toBe(t('notebook.kernelIdle'))
  })

  it('says a cell is executing rather than merely attached', () => {
    const view = describeKernelStatus(connected({ phase: 'busy' }), 0, t)
    expect(view.tone).toBe('busy')
    expect(view.title).toBe(t('notebook.kernelBusy'))
  })

  it('does not invent a problem for a notebook that has not run yet', () => {
    // A fresh notebook has no kernel, and running a cell starts one. Reporting
    // "no kernel available" here would surface a failure the reader did not have.
    const view = describeKernelStatus(initialNotebookState(), 0, t)
    expect(view.tone).toBe('absent')
    expect(view.label).toBe(t('notebook.kernelDisconnected'))
    expect(view.title).toBe(t('notebook.runWithoutKernelHint'))
  })

  it('carries the Host failure message when a start fails', () => {
    const view = describeKernelStatus(
      connected({ phase: 'failed', kernelId: null, message: 'the kernel process exited' }),
      0,
      t,
    )
    expect(view.tone).toBe('failed')
    expect(view.title).toBe('the kernel process exited')
  })

  it('counts the prompts the kernel has run', () => {
    // Jupyter's own prompt number, and the one fact that says whether the variables
    // a reader is about to use were computed in this session.
    expect(describeKernelStatus(connected({ executionCount: 12 }), 0, t).extras)
      .toEqual([{
        text: 'In[12]',
        title: t('notebook.statusPromptCount', { count: '12' }),
      }])
    expect(describeKernelStatus(connected({ executionCount: 0 }), 0, t).extras).toEqual([])
  })

  it('reports cells a Run All still owes', () => {
    expect(describeKernelStatus(connected(), 3, t).extras)
      .toContainEqual({ text: t('notebook.statusQueue', { count: '3' }) })
  })

  it('says out loud when the event stream fell back to polling', () => {
    // Silent would look identical to a live stream, so the strip names the transport —
    // and flags it as the one readout that reports a fault, which is what colours it.
    const view = describeKernelStatus(connected({ transport: 'poll' }), 0, t)
    expect(view.extras).toHaveLength(1)
    expect(view.extras[0]?.text).toBe(t('notebook.statusPolling'))
    expect(view.extras[0]?.title).toBe(t('notebook.statusPollingHint'))
    expect(view.extras[0]?.warn).toBe(true)
  })

  it('keeps a factual readout uncoloured even though it explains itself', () => {
    // `In[12]` carries a tooltip but is not a problem; colouring anything with a title
    // would paint the whole right-hand cluster orange during normal use.
    const prompt = describeKernelStatus(connected({ executionCount: 5 }), 0, t).extras[0]
    expect(prompt?.title).toBeDefined()
    expect(prompt?.warn).toBeUndefined()
  })

  it('does not claim a prompt count or a transport for a kernel that is not running', () => {
    const view = describeKernelStatus(
      { ...initialNotebookState(), kernel: { ...initialNotebookState().kernel, executionCount: 7, transport: 'poll' } },
      0,
      t,
    )
    expect(view.extras).toEqual([])
  })

  it('stops claiming a live kernel once it is shutting down', () => {
    // The id is held for a moment while the process exits; the strip must not say
    // "ready" across that window.
    for (const phase of ['terminating', 'terminated'] as const) {
      const view = describeKernelStatus(connected({ phase }), 0, t)
      expect(view.tone).toBe('absent')
      expect(view.label).toBe(t('notebook.kernelDisconnected'))
    }
  })
})

describe('kernel status against a live runtime', () => {
  let runtime: NotebookRuntime
  let storeBefore = 0

  beforeEach(() => {
    stores.created.length = 0
    runtime = new NotebookRuntime(
      { kernelStart: vi.fn(), kernelDiscover: vi.fn() } as never,
      { info: vi.fn(), warn: vi.fn() },
      { getDraft: () => '', setDraft: () => undefined },
    )
    storeBefore = stores.created.length
  })

  afterEach(() => { cleanup() })

  it('tracks the store after the runtime appears, not just once', () => {
    // The regression: waking the reader once on creation would refresh it and then
    // leave it frozen at "no kernel" while the kernel kept moving, because the parked
    // listener was never re-attached to the real store.
    const view = render(<NotebookKernelStatus runtime={runtime} tabId="tab-1" t={t as never} />)
    expect(view.container.textContent).toContain(zh['notebook.kernelDisconnected'])
    // No runtime yet, so nothing to attach to.
    expect(stores.created).toHaveLength(storeBefore)

    // Creating the runtime is what a first run or an auto-connect does.
    act(() => {
      runtime.dispatch('tab-1', {
        type: 'session', kernelId: 'k-1', token: 'secret', displayName: 'DSH Runtime Python 3',
        specName: 'dsh-runtime-python3', language: 'python', since: 1,
      })
    })
    const store = stores.created[storeBefore]
    expect(store).toBeDefined()
    expect(view.container.textContent).toContain('DSH Runtime Python 3')

    // And it keeps tracking: this is the part a one-shot wake would have missed.
    act(() => {
      runtime.dispatch('tab-1', { type: 'kernel', phase: 'idle' })
      runtime.dispatch('tab-1', { type: 'execution-count', executionCount: 4 })
    })
    expect(view.container.textContent).toContain('In[4]')
    // Exactly one store listener: the migrated one, not a duplicate of a parked one.
    expect(store?.listenerCount()).toBe(1)
  })

  it('detaches from the store when the strip unmounts', () => {
    const view = render(<NotebookKernelStatus runtime={runtime} tabId="tab-1" t={t as never} />)
    act(() => {
      runtime.dispatch('tab-1', {
        type: 'session', kernelId: 'k-1', token: 'secret', displayName: 'Python 3',
        specName: 'python3', language: 'python', since: 1,
      })
    })
    const store = stores.created[storeBefore]
    expect(store?.listenerCount()).toBe(1)
    view.unmount()
    expect(store?.listenerCount()).toBe(0)
    // A dispatch after unmount must not throw or re-render a dead component.
    expect(() => {
      act(() => { runtime.dispatch('tab-1', { type: 'kernel', phase: 'busy' }) })
    }).not.toThrow()
  })

  it('never creates a runtime just by reading one', () => {
    // The strip renders for every tab; if it used `state(tabId)` it would mint a
    // runtime — and a store — for files that are not notebooks at all.
    render(<NotebookKernelStatus runtime={runtime} tabId="unrelated" t={t as never} />)
    expect(stores.created).toHaveLength(storeBefore)
    expect(runtime.peekState('unrelated')).toBeNull()
  })
})

describe('kernel status alongside the notebook toolbar', () => {
  function stubRuntime(state: NotebookState) {
    return {
      peekState: () => state,
      peekSubscribe: (_tabId: string, _listener: () => void) => () => undefined,
      peekPendingQueueLength: () => 3,
    } as never
  }

  it('drops the name chip when the toolbar already carries it', () => {
    // The toolbar sits above the scroller and is always on screen in notebook view, so
    // both surfaces would spell the kernel's name at once. The strip keeps only what the
    // toolbar never shows.
    const view = render(
      <NotebookKernelStatus runtime={stubRuntime(connected({ executionCount: 6 }))} tabId="tab-1" t={t as never} hideChip />,
    )
    expect(view.container.textContent).not.toContain('DSH Runtime Python 3')
    expect(view.container.textContent).toContain('In[6]')
    expect(view.container.textContent).toContain(t('notebook.statusQueue', { count: '3' }))
  })

  it('carries the whole readout when the toolbar is not on screen', () => {
    // Source view has no toolbar at all: this is the case the strip exists for.
    const view = render(
      <NotebookKernelStatus runtime={stubRuntime(connected({ executionCount: 6 }))} tabId="tab-1" t={t as never} />,
    )
    expect(view.container.textContent).toContain('DSH Runtime Python 3')
    expect(view.container.textContent).toContain('In[6]')
  })
})
