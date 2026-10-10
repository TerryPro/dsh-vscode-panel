/**
 * The browser's kernel connection: start, run, and read one notebook's events.
 *
 * Two transports are implemented because the workbench runs inside whatever web
 * shell DSH provides. Server-sent events are the primary path — one held-open GET,
 * frames replayed from a sequence number, no per-frame cost. Where a stream cannot
 * be held (a proxy that buffers, a webview that closes idle connections), the same
 * frames are read by polling the Host's `poll` arm. Both paths deliver identical
 * frames, so the reducer below never has to know which one is live.
 *
 * Deliberately, this runtime owns no React state and reads no notebook document: it
 * publishes frames, and the surface decides what they mean. That is what makes it
 * testable without a DOM or a kernel.
 */

import { kernelStreamUrl } from '../../shared/notebook-protocol.ts'
import type {
  KernelPhase,
  NotebookKernelEvent,
  NotebookKernelFrame,
  NotebookKernelPollResult,
  KernelExecuteResult,
} from '../../shared/notebook-protocol.ts'

/**
 * The kernel calls this client needs.
 *
 * Declared as a narrow surface rather than importing `WorkbenchApi` so a test can
 * hand in a fake with two methods, and so this module stays free of `fetch`.
 */
export interface NotebookApiSurface {
  kernelPoll(input: {
    kernelId: string
    token: string
    workspaceId: string
    since: number
  }): Promise<NotebookKernelPollResult>
  kernelExecute(input: {
    kernelId: string
    token: string
    workspaceId: string
    code: string
    cellId?: string
    silent?: boolean
  }): Promise<KernelExecuteResult>
}

export interface KernelConnectionHandlers {
  /** One event frame, in order, after de-duplication. */
  frame(frame: NotebookKernelFrame): void
  /** The stream or poll reported a resume, so the caller can re-sync its cursor. */
  resynced(since: number): void
  /** Transport changed, surfaced so a reader can see polling is what they get. */
  transport(transport: KernelTransport): void
  /** The kernel's phase changed as seen through the transport. */
  phase(phase: KernelPhase, message?: string): void
  /** A transport error worth telling the reader about. */
  error(message: string): void
}

export type KernelTransport = 'stream' | 'poll' | 'none'

export interface KernelConnectionOptions {
  /** Poll interval when streaming is unavailable. */
  pollIntervalMs?: number
  /** Give up on a stream that produced nothing this long; then verify by poll. */
  streamStallMs?: number
  /** Injectable for tests; `EventSource` in a browser. */
  eventSourceFactory?: (url: string) => EventSourceLike
  /** Injectable for tests; the API facade otherwise. */
  now?: () => number
}

/** The face of `EventSource` this client needs, so a test can fake it. */
export interface EventSourceLike {
  close(): void
  addEventListener(type: string, listener: (event: { data: string }) => void): void
}

const DEFAULT_POLL_INTERVAL_MS = 700
const DEFAULT_STREAM_STALL_MS = 45_000

/**
 * One live connection to one kernel.
 *
 * A reconnect resumes from the last sequence it delivered, so output cannot be lost
 * by a dropped stream; a sequence gap (the Host's buffer wrapped) is reported through
 * `resynced` so the caller can rebuild from the notebook file rather than pretend a
 * contiguous run was seen.
 */
export class KernelConnection {
  private transport: KernelTransport = 'none'
  private source: EventSourceLike | null = null
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private stallTimer: ReturnType<typeof setTimeout> | null = null
  private lastSequence = 0
  private stopping = false
  private polling = false
  private pollFailures = 0

  constructor(
    private readonly api: NotebookApiSurface,
    private readonly kernelId: string,
    private readonly token: string,
    private readonly workspaceId: string,
    private readonly since: number,
    private readonly handlers: KernelConnectionHandlers,
    private readonly options: KernelConnectionOptions = {},
  ) {
    this.lastSequence = since
  }

  /** Which transport is currently carrying frames. */
  get currentTransport(): KernelTransport {
    return this.transport
  }

  /** Sequence of the last frame delivered, for a caller that persists its cursor. */
  get cursor(): number {
    return this.lastSequence
  }

  /**
   * Attach, preferring a stream.
   *
   * @returns the transport actually used, so the caller can label the tab honestly.
   */
  start(): KernelTransport {
    this.stopping = false
    const factory = this.options.eventSourceFactory
    if (typeof EventSource !== 'undefined' || factory !== undefined) {
      const opened = this.openStream(factory)
      if (opened) return 'stream'
    }
    this.startPolling()
    return this.transport
  }

  /** Close everything. Idempotent, and safe from a component unmount. */
  stop(): void {
    this.stopping = true
    if (this.source !== null) {
      this.source.close()
      this.source = null
    }
    if (this.pollTimer !== null) clearTimeout(this.pollTimer)
    this.pollTimer = null
    if (this.stallTimer !== null) clearTimeout(this.stallTimer)
    this.stallTimer = null
    this.setTransport('none')
  }

  private openStream(factory: ((url: string) => EventSourceLike) | undefined): boolean {
    const url = kernelStreamUrl(this.kernelId, this.token, this.lastSequence)
    try {
      const source = factory !== undefined ? factory(url) : nativeEventSource(url)
      this.source = source
      this.setTransport('stream')
      source.addEventListener('snapshot', event => {
        const snapshot = parseFrame<{ sequence: number; oldestSequence: number }>(event.data)
        if (snapshot === null) return
        // A snapshot whose oldest sequence is ahead of our cursor means frames were
        // dropped before this stream could replay them.
        if (snapshot.oldestSequence > this.lastSequence + 1) this.handlers.resynced(snapshot.oldestSequence)
        this.lastSequence = Math.max(this.lastSequence, snapshot.sequence - 1)
        this.armStallWatchdog(source)
      })
      source.addEventListener('frame', event => {
        const frame = parseFrame<NotebookKernelFrame>(event.data)
        if (frame === null) return
        this.armStallWatchdog(source)
        this.deliver(frame)
      })
      source.addEventListener('end', event => {
        const value = parseFrame<{ phase?: KernelPhase }>(event.data)
        this.handlers.phase(value?.phase ?? 'terminated')
        this.stop()
      })
      // `onerror` is deliberately not handled: the browser retries an EventSource on
      // its own, and a stream that stops delivering is detected by the stall watchdog
      // below rather than guessed at from an error event whose cause is unknowable.
      this.armStallWatchdog(source)
      return true
    } catch {
      this.handlers.error('the browser refused to open a kernel event stream; falling back to polling')
      return false
    }
  }

  /**
   * Verify a quiet stream by polling once.
   *
   * A stream that receives nothing is ambiguous: either the kernel has no output (the
   * normal case) or the connection is dead. A poll answers which, and costs one
   * request per stall window rather than per frame.
   */
  private armStallWatchdog(source: EventSourceLike): void {
    if (this.stopping) return
    if (this.stallTimer !== null) clearTimeout(this.stallTimer)
    const stallMs = this.options.streamStallMs ?? DEFAULT_STREAM_STALL_MS
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null
      if (this.stopping || this.source !== source) return
      void this.verifyByPolling(source)
    }, stallMs)
    this.stallTimer.unref?.()
  }

  private async verifyByPolling(source: EventSourceLike): Promise<void> {
    try {
      const result = await this.api.kernelPoll({
        kernelId: this.kernelId,
        token: this.token,
        workspaceId: this.workspaceId,
        since: this.lastSequence,
      })
      // Any successful poll proves the kernel and the route are alive, so the stream
      // was simply idle and stays open.
      this.handlers.phase(result.phase)
      for (const frame of result.frames) this.deliver(frame)
      if (result.resynced) this.handlers.resynced(result.nextSequence)
    } catch {
      if (this.stopping || this.source !== source) return
      source.close()
      this.source = null
      this.startPolling()
    }
  }

  private startPolling(): void {
    if (this.stopping || this.pollTimer !== null) return
    this.setTransport('poll')
    void this.pollNow()
  }

  private async pollNow(): Promise<void> {
    if (this.stopping || this.polling) return
    this.polling = true
    try {
      const result = await this.api.kernelPoll({
        kernelId: this.kernelId,
        token: this.token,
        workspaceId: this.workspaceId,
        since: this.lastSequence,
      })
      this.pollFailures = 0
      this.handlers.phase(result.phase)
      if (result.resynced) this.handlers.resynced(result.nextSequence)
      for (const frame of result.frames) this.deliver(frame)
    } catch (error: unknown) {
      this.pollFailures += 1
      const message = error instanceof Error ? error.message : String(error)
      if (this.pollFailures === 1 || this.pollFailures % 10 === 0) {
        this.handlers.error(`kernel output poll failed: ${message}`)
      }
      if (message.includes('KERNEL_NOT_FOUND')) {
        this.handlers.phase('terminated')
        this.stop()
        return
      }
    } finally {
      this.polling = false
    }
    if (!this.stopping) {
      // Back off when the host is failing, so a broken DSH does not get hammered.
      const interval = (this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS) * (this.pollFailures > 2 ? 4 : 1)
      this.pollTimer = setTimeout(() => {
        this.pollTimer = null
        void this.pollNow()
      }, interval)
      this.pollTimer.unref?.()
    }
  }

  private deliver(frame: NotebookKernelFrame): void {
    // Out-of-order or repeated frames are ignored rather than applied twice: an
    // output rendered twice is worse than one the reader never saw.
    if (frame.sequence <= this.lastSequence) return
    this.lastSequence = frame.sequence
    this.handlers.frame(frame)
  }

  private setTransport(transport: KernelTransport): void {
    if (this.transport === transport) return
    this.transport = transport
    this.handlers.transport(transport)
  }
}

/**
 * Wrap the browser's `EventSource` in this client's narrow face.
 *
 * `EventSource.addEventListener` is typed against the whole `Event` hierarchy, so
 * adapting it here keeps the single cast in this file and lets a test hand in a plain
 * object instead of a fake DOM class.
 */
function nativeEventSource(url: string): EventSourceLike {
  const source = new EventSource(url, { withCredentials: true })
  return {
    close: () => { source.close() },
    addEventListener: (type, listener) => {
      source.addEventListener(type, event => { listener({ data: (event as MessageEvent<string>).data }) })
    },
  }
}

function parseFrame<T>(data: string): T | null {
  try {
    return JSON.parse(data) as T
  } catch {
    return null
  }
}

/**
 * Run one cell through a started kernel, returning its msg_id.
 *
 * Separated from `KernelConnection` because the run and the transport are different
 * lifetimes: a cell can be running while the browser has no stream attached at all
 * (the user reloaded the page), and the Host keeps buffering its output.
 */
export async function executeCell(
  api: NotebookApiSurface,
  input: {
    kernelId: string
    token: string
    workspaceId: string
    code: string
    cellId?: string
    silent?: boolean
  },
): Promise<{ msgId: string; executionCount: number; phase: KernelPhase }> {
  return await api.kernelExecute(input)
}

/** One frame's cell id, when it targets a cell. */
export function frameCellId(frame: NotebookKernelEvent): string | undefined {
  return 'cellId' in frame ? frame.cellId : undefined
}
