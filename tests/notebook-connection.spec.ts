// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KernelConnection, type EventSourceLike } from '../src/client/notebook/kernel-connection.ts'
import type { NotebookKernelFrame, NotebookKernelPollResult } from '../src/shared/notebook-protocol.ts'

/** A fake stream the test can push frames into, recording what the client asked for. */
class FakeSource implements EventSourceLike {
  readonly listeners = new Map<string, ((event: { data: string }) => void)[]>()
  closed = false
  close = vi.fn(() => { this.closed = true })
  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  emit(type: string, payload: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify(payload) })
  }
}

function frame(sequence: number, event: Record<string, unknown>): NotebookKernelFrame {
  return { ...event, sequence } as NotebookKernelFrame
}

function pollResult(overrides: Partial<NotebookKernelPollResult> = {}): NotebookKernelPollResult {
  return { frames: [], nextSequence: 1, phase: 'ready', executionCount: 0, resynced: false, ...overrides }
}

const handlers = () => ({
  frame: vi.fn(),
  resynced: vi.fn(),
  transport: vi.fn(),
  phase: vi.fn(),
  error: vi.fn(),
})

/**
 * A typed poll double.
 *
 * `vi.fn()` with no implementation types as `Mock<Procedure | Constructable>`, which
 * is not assignable to the API face; passing a real implementation makes the mock
 * carry that signature, so a wrong argument shape fails the typecheck.
 */
type PollFn = (input: { kernelId: string; token: string; workspaceId: string; since: number }) => Promise<NotebookKernelPollResult>

const okPoll: PollFn = async () => pollResult()

/**
 * A typed poll double.
 *
 * `vi.fn()` with no implementation types as `Mock<Procedure | Constructable>`, which is
 * not assignable to the API face; wrapping a real implementation makes the mock carry
 * that signature, so a wrong argument shape fails the typecheck instead of the tests.
 */
const apiOf = (poll: PollFn = okPoll) => ({
  kernelPoll: vi.fn(poll),
  kernelExecute: vi.fn(async () => {
    throw new Error('execution is not exercised by this spec')
  }),
})

let source: FakeSource

beforeEach(() => {
  source = new FakeSource()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('kernel connection over a stream', () => {
  it('opens an EventSource and delivers frames in order', () => {
    const on = handlers()
    const connection = new KernelConnection(
      apiOf(), 'k1', 't1', 'ws-1', 4, on,
      { eventSourceFactory: () => source },
    )
    expect(connection.start()).toBe('stream')
    expect(on.transport).toHaveBeenCalledWith('stream')

    source.emit('snapshot', { sequence: 5, oldestSequence: 5, phase: 'ready', executionCount: 0, kernelId: 'k1', displayName: 'Python 3', specName: 'python3' })
    source.emit('frame', frame(5, { type: 'phase', phase: 'busy' }))
    source.emit('frame', frame(6, { type: 'cell_output', msgId: 'm', cellId: 'a', item: { kind: 'stream', name: 'stdout', text: 'x' }, truncated: false }))

    expect(on.frame.mock.calls.map(call => (call[0] as NotebookKernelFrame).sequence)).toEqual([5, 6])
    expect(connection.cursor).toBe(6)
    connection.stop()
    expect(source.closed).toBe(true)
  })

  it('drops a repeated or out-of-order frame instead of applying it twice', () => {
    // Output rendered twice is worse than output never seen: a reconnect can replay a
    // frame the client already applied before the drop.
    const on = handlers()
    const connection = new KernelConnection(apiOf(), 'k1', 't1', 'ws-1', 6, on, { eventSourceFactory: () => source })
    connection.start()
    source.emit('frame', frame(6, { type: 'phase', phase: 'busy' }))
    source.emit('frame', frame(5, { type: 'phase', phase: 'idle' }))
    expect(on.frame).not.toHaveBeenCalled()
  })

  it('reports a gap the buffer can no longer replay', () => {
    const on = handlers()
    const connection = new KernelConnection(apiOf(), 'k1', 't1', 'ws-1', 3, on, { eventSourceFactory: () => source })
    connection.start()
    // Frames 4..9 were evicted from the Host ring, so 3 is unresumable.
    source.emit('snapshot', { sequence: 10, oldestSequence: 10, phase: 'ready', executionCount: 0, kernelId: 'k1', displayName: '', specName: '' })
    expect(on.resynced).toHaveBeenCalledWith(10)
  })

  it('closes on an end event and reports the final phase', () => {
    const on = handlers()
    const connection = new KernelConnection(apiOf(), 'k1', 't1', 'ws-1', 1, on, { eventSourceFactory: () => source })
    connection.start()
    source.emit('end', { phase: 'terminated' })
    expect(on.phase).toHaveBeenCalledWith('terminated')
    expect(source.closed).toBe(true)
  })

  it('ignores a malformed frame rather than throwing at the transport', () => {
    const on = handlers()
    const connection = new KernelConnection(apiOf(), 'k1', 't1', 'ws-1', 1, on, { eventSourceFactory: () => source })
    connection.start()
    for (const listener of source.listeners.get('frame') ?? []) {
      listener({ data: 'not json {' })
      listener({ data: '' })
    }
    expect(on.frame).not.toHaveBeenCalled()
  })
})

describe('kernel connection polling fallback', () => {
  it('polls from the cursor and advances it', async () => {
    const poll = vi.fn().mockResolvedValue(pollResult({
      frames: [frame(2, { type: 'phase', phase: 'busy' }), frame(3, { type: 'phase', phase: 'ready' })],
      nextSequence: 4,
      phase: 'ready',
    }))
    const on = handlers()
    // A factory that throws models a browser or webview that will not hold a stream
    // open: the client must fall back to polling rather than fail the notebook.
    const connection = new KernelConnection(apiOf(poll), 'k1', 't1', 'ws-1', 1, on, {
      pollIntervalMs: 100,
      streamStallMs: 100,
      eventSourceFactory: () => {
        throw new Error('streams are refused here')
      },
    })
    expect(connection.start()).toBe('poll')
    await vi.waitFor(() => { expect(poll).toHaveBeenCalled() }, { timeout: 2_000 })
    expect(poll.mock.calls[0]![0]).toMatchObject({ kernelId: 'k1', token: 't1', workspaceId: 'ws-1', since: 1 })
    expect(on.frame).toHaveBeenCalledTimes(2)
    expect(connection.cursor).toBe(3)
    connection.stop()
  })

  it('keeps polling after a transient failure and reports it only once', async () => {
    const poll = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue(pollResult({ nextSequence: 2 }))
    const on = handlers()
    const connection = new KernelConnection(apiOf(poll), 'k1', 't1', 'ws-1', 1, on, {
      pollIntervalMs: 20,
      eventSourceFactory: () => {
        throw new Error('no stream here')
      },
    })
    connection.start()
    await vi.waitFor(() => { expect(poll.mock.calls.length).toBeGreaterThan(2) }, { timeout: 3_000 })
    // The refused stream is reported once, and so is the failed poll; the retries that
    // followed are not, or a broken host would spam the reader one message per tick.
    const messages = on.error.mock.calls.map(call => String(call[0]))
    expect(messages.filter(message => message.includes('network down'))).toHaveLength(1)
    expect(messages.filter(message => message.includes('event stream'))).toHaveLength(1)
    connection.stop()
    const callsAfterStop = poll.mock.calls.length
    await new Promise(resolve => { setTimeout(resolve, 120) })
    // Stopping the connection must stop the requests too.
    expect(poll.mock.calls.length).toBe(callsAfterStop)
  })

  it('stops polling when the Host says the kernel is gone', async () => {
    const poll = vi.fn().mockRejectedValue(Object.assign(new Error('gone'), { message: 'KERNEL_NOT_FOUND' }))
    const on = handlers()
    const connection = new KernelConnection(apiOf(poll), 'k1', 't1', 'ws-1', 1, on, {
      pollIntervalMs: 100,
      eventSourceFactory: () => {
        throw new Error('no stream here')
      },
    })
    expect(connection.start()).toBe('poll')
    await vi.waitFor(() => { expect(poll).toHaveBeenCalled() })
    expect(on.phase).toHaveBeenCalledWith('terminated')
    expect(on.error).toHaveBeenCalled()
    connection.stop()
  })

  it('verifies a silent stream with one poll, and keeps the stream when it answers', async () => {
    vi.useRealTimers()
    const poll = vi.fn().mockResolvedValue(pollResult({ phase: 'ready' }))
    const on = handlers()
    const connection = new KernelConnection(apiOf(poll), 'k1', 't1', 'ws-1', 1, on, {
      eventSourceFactory: () => source,
      streamStallMs: 50,
    })
    connection.start()
    await vi.waitFor(() => { expect(poll).toHaveBeenCalled() }, { timeout: 2_000 })
    // A successful poll proves the kernel is merely idle, so the stream stays attached.
    expect(source.closed).toBe(false)
    expect(connection.currentTransport).toBe('stream')
    connection.stop()
  })

  it('switches to polling when a stream verification fails', async () => {
    const poll = vi.fn().mockRejectedValue(new Error('unavailable'))
    const on = handlers()
    const connection = new KernelConnection(apiOf(poll), 'k1', 't1', 'ws-1', 1, on, {
      eventSourceFactory: () => source,
      streamStallMs: 40,
      pollIntervalMs: 40,
    })
    connection.start()
    await vi.waitFor(() => { expect(source.closed).toBe(true) }, { timeout: 2_000 })
    expect(connection.currentTransport).toBe('poll')
    expect(on.transport).toHaveBeenCalledWith('poll')
    connection.stop()
  })
})

describe('kernel stream URL', () => {
  it('carries the resume cursor and the per-kernel token', async () => {
    const { kernelStreamUrl } = await import('../src/shared/notebook-protocol.ts')
    const url = new URL(kernelStreamUrl('k1', 'tok', 42), 'http://127.0.0.1:19387')
    expect(url.pathname).toBe('/dsh-workbench-layout/kernel/stream')
    expect(url.searchParams.get('kernelId')).toBe('k1')
    expect(url.searchParams.get('token')).toBe('tok')
    expect(url.searchParams.get('since')).toBe('42')
  })
})
