/**
 * `KernelBackend` owns the rules that make a kernel safe to expose over HTTP: token
 * authorization, sequence-numbered replay, stream fan-out, and capacity. Those rules
 * are what this spec exercises — a fake session stands in for the Jupyter wire
 * protocol, which the protocol spec and the live probe cover separately.
 */
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { KernelBackend, DEFAULT_KERNEL_LIMITS } from '../src/host/kernel-backend.ts'
import type { KernelLaunchPlan, KernelSessionHandle, KernelSessionSink } from '../src/host/kernel/kernel-session.ts'
import type { KernelDescription, NotebookKernelEvent } from '../src/shared/notebook-protocol.ts'
import type { KernelMessage } from '../src/host/kernel/messaging.ts'
import { WorkbenchHttpError } from '../src/host/http.ts'

const DESCRIPTION: KernelDescription = {
  implementation: 'ipython',
  implementationVersion: '9.17.1',
  protocolVersion: '5.3',
  language: { name: 'python', version: '3.12.14', fileExtension: '.py', codemirrorMode: 'ipython' },
  debugger: true,
}

class FakeSession extends EventEmitter implements KernelSessionHandle {
  readonly kernelId = `kernel-${Math.random().toString(36).slice(2, 8)}`
  readonly token = `token-${Math.random().toString(36).slice(2, 8)}`
  executionCountValue = 0
  phaseValue: KernelSessionHandle['phase'] = 'absent'
  stopped: string | null = null
  busy = false
  lastActivityAt = Date.now()

  constructor(
    readonly displayName: string,
    readonly specName: string,
    readonly notebookPath: string,
    private readonly sink: KernelSessionSink,
  ) {
    super()
  }

  get phase(): KernelSessionHandle['phase'] {
    return this.phaseValue
  }

  get executionCount(): number {
    return this.executionCountValue
  }

  async start(): Promise<KernelDescription> {
    this.phaseValue = 'ready'
    this.sink.publish({ type: 'info', info: DESCRIPTION })
    return DESCRIPTION
  }

  execute(code: string, cellId: string | undefined): { msgId: string } {
    const msgId = `msg-${code}`
    this.busy = true
    this.phaseValue = 'busy'
    this.sink.publish(cellEvent({ type: 'cell_started', msgId, code, executionCount: 1 }, cellId))
    return { msgId }
  }

  /** Test hook: emit a frame the way IOPub would. */
  publishOutput(msgId: string, cellId: string | undefined, text: string): void {
    this.sink.publish(cellEvent({
      type: 'cell_output',
      msgId,
      truncated: false,
      item: { kind: 'stream', name: 'stdout', text },
    }, cellId))
  }

  finish(msgId: string, cellId: string | undefined, status: 'ok' | 'error' = 'ok'): void {
    this.busy = false
    this.executionCountValue += 1
    this.phaseValue = 'ready'
    this.sink.publish(cellEvent({ type: 'cell_completed', msgId, status, executionCount: this.executionCountValue }, cellId))
  }

  interrupt(): void {
    this.sink.publish({ type: 'phase', phase: 'ready' })
  }

  replyInput(value: string): boolean {
    this.lastInput = value
    return true
  }

  lastInput: string | null = null
  /** The last content object the manager sent on a helper request, for assertions. */
  replyContent: Record<string, unknown> = {}

  async requestReply<T>(
    _type: string,
    content: Record<string, unknown>,
    extract: (message: KernelMessage) => T,
  ): Promise<T> {
    this.replyContent = content
    return extract({
      header: { msg_id: 'reply-1', session: 's', username: 'u', date: new Date().toISOString(), msg_type: _type.replace(/_request$/u, '_reply'), version: '5.3' },
      parentHeader: {},
      metadata: {},
      content: {
        // `is_complete_request` is answered with its own status verb; the other two
        // replies carry the usual `status: 'ok'`.
        status: _type === 'is_complete_request' ? 'incomplete' : 'ok',
        matches: ['print'],
        cursor_start: 0,
        cursor_end: 2,
        found: true,
        data: { 'text/plain': 'doc' },
        indent: '  ',
      },
      buffers: [],
      topic: '',
    })
  }

  async stop(reason: string): Promise<void> {
    this.stopped = reason
    // The point the reclaim test needs: the session was still mid-run when it was
    // stopped, i.e. `busy` did not spare it.
    this.busyAtStop = this.busy
    this.phaseValue = 'terminated'
  }

  busyAtStop = false
}

/**
 * Build an event whose optional `cellId` is *absent* rather than `undefined`.
 *
 * The project compiles with `exactOptionalPropertyTypes`, so a cell id that may be
 * missing has to be omitted, not assigned `undefined` — the same rule the Host code
 * follows with its own `...(x === undefined ? {} : { x })` idiom.
 */
function cellEvent<E extends NotebookKernelEvent>(event: E, cellId: string | undefined): E {
  return cellId === undefined ? event : { ...event, cellId }
}

const workspace = {
  async rootProcessPath(): Promise<{ cwd: string; workspaceId: string }> {
    return { cwd: '/work/scope', workspaceId: 'ws-1' as never }
  },
  async assertRelativePath(_id: unknown, path: unknown): Promise<string> {
    if (typeof path !== 'string' || path === '') throw new WorkbenchHttpError(400, 'FILE_REQUIRED', 'missing path')
    return path
  },
  async absolutePath(_id: unknown, path: unknown): Promise<{ path: string; absolutePath: string }> {
    return { path: String(path), absolutePath: `/work/scope/${String(path)}` }
  },
}

function makeBackend(overrides: Partial<typeof DEFAULT_KERNEL_LIMITS> = {}) {
  const sessions: FakeSession[] = []
  const logger = { info: vi.fn(), warn: vi.fn() }
  const ctx = { logger } as unknown as Context
  const backend = new KernelBackend(ctx, workspace as never, {
    ...DEFAULT_KERNEL_LIMITS,
    maxKernelsPerWorkspace: 1,
    maxKernelsTotal: 1,
    reaperIntervalMs: 60_000,
    ...overrides,
  }, {
    // The real bridge file, so the "is the launcher present" guard is exercised rather
    // than skipped, without depending on the build output.
    bridgeScriptPath: fileURLToPath(new URL('../src/host/kernel/kernel-bridge.py', import.meta.url)),
    // Discovery reaches out to the machine, so it is injected: the manager's own rules
    // are what is under test here, not the interpreter scan.
    discoverKernels: async () => ({
      environments: [],
      kernels: [{
        name: 'python3', displayName: 'Python 3', language: 'python',
        interpreterPath: '/env/bin/python', available: true, source: 'venv',
      }],
    }),
    createSession: (workspaceId, launch: KernelLaunchPlan, sink) => {
      const session = new FakeSession(launch.displayName, launch.specName, launch.notebookPath, sink)
      sessions.push(session)
      void workspaceId
      return session
    },
  })
  return { backend, sessions, logger }
}

const body = (kernel: { kernelId: string; token: string }) => ({
  workspaceId: 'ws-1', kernelId: kernel.kernelId, token: kernel.token,
})

describe('kernel manager', () => {
  it('starts one kernel per notebook and reuses it for the same path', async () => {
    const { backend, sessions } = makeBackend()
    const first = await backend.start('ws-1', 'nb.ipynb', undefined)
    const second = await backend.start('ws-1', 'nb.ipynb', undefined)
    expect(second.kernelId).toBe(first.kernelId)
    expect(sessions).toHaveLength(1)
    expect(first.token).toBeTruthy()
    expect(sessions[0]!.notebookPath).toBe('nb.ipynb')
    await backend.dispose()
  })

  it('races two cold starts of the same notebook into one process', async () => {
    const { backend, sessions } = makeBackend()
    const [a, b] = await Promise.all([
      backend.start('ws-1', 'nb.ipynb', undefined),
      backend.start('ws-1', 'nb.ipynb', undefined),
    ])
    expect(a.kernelId).toBe(b.kernelId)
    expect(sessions).toHaveLength(1)
    await backend.dispose()
  })

  it('gives each notebook its own kernel', async () => {
    const { backend, sessions } = makeBackend({ maxKernelsPerWorkspace: 4, maxKernelsTotal: 4 })
    const a = await backend.start('ws-1', 'a.ipynb', undefined)
    const b = await backend.start('ws-1', 'b.ipynb', undefined)
    expect(a.kernelId).not.toBe(b.kernelId)
    expect(sessions).toHaveLength(2)
    await backend.dispose()
  })

  it('refuses a request whose token is not the one it issued', async () => {
    const { backend } = makeBackend()
    const started = await backend.start('ws-1', 'nb.ipynb', undefined)
    expect(() => backend.execute({ ...body(started), token: 'guessed', code: 'x' }))
      .toThrowError(/another notebook/u)
    expect(() => backend.execute({ workspaceId: 'ws-1', kernelId: started.kernelId, token: started.token, code: 'x' }))
      .not.toThrow()
    await backend.dispose()
  })

  it('refuses a request that claims a different workspace', async () => {
    const { backend } = makeBackend()
    const started = await backend.start('ws-1', 'nb.ipynb', undefined)
    expect(() => backend.execute({ ...body(started), workspaceId: 'ws-2', code: 'x' }))
      .toThrowError(/another workspace/u)
    await backend.dispose()
  })

  it('reports a kernel that is gone instead of throwing a raw lookup', async () => {
    const { backend } = makeBackend()
    expect(() => backend.execute({ workspaceId: 'ws-1', kernelId: 'nope', token: 't', code: 'x' }))
      .toThrowError(/no longer running/u)
    await backend.dispose()
  })

  it('numbers frames monotonically so a stream can resume without a gap', async () => {
    const { backend, sessions } = makeBackend()
    const started = await backend.start('ws-1', 'nb.ipynb', undefined)
    const session = sessions[0]!
    const { msgId } = backend.execute({ ...body(started), code: 'print(1)', cellId: 'c1' })
    session.publishOutput(msgId, 'c1', '1\n')
    session.finish(msgId, 'c1')

    const poll = backend.poll({ ...body(started), since: 1 })
    expect(poll.frames.map(frame => frame.sequence)).toEqual(poll.frames.map((_, index) => index + 1))
    expect(poll.nextSequence).toBe(poll.frames.at(-1)!.sequence + 1)
    expect(poll.frames.at(-1)).toMatchObject({ type: 'cell_completed', cellId: 'c1', status: 'ok' })
    // Resuming from a mid-point replays only the tail.
    expect(backend.poll({ ...body(started), since: 3 }).frames.every(f => f.sequence >= 3)).toBe(true)
    await backend.dispose()
  })

  it('says when the buffer could no longer replay from the asked position', async () => {
    const { backend } = makeBackend()
    const started = await backend.start('ws-1', 'nb.ipynb', undefined)
    // Nothing has been published yet, so a cursor of zero predates the buffer.
    const poll = backend.poll({ ...body(started), since: 0 })
    expect(poll.resynced).toBe(true)
    await backend.dispose()
  })

  it('stops the kernel on request and drops the notebook mapping', async () => {
    const { backend, sessions } = makeBackend()
    const started = await backend.start('ws-1', 'nb.ipynb', undefined)
    const status = await backend.shutdown(body(started))
    expect(status.phase).toBe('terminated')
    expect(sessions[0]!.stopped).toBe('user')
    const again = await backend.start('ws-1', 'nb.ipynb', undefined)
    expect(again.kernelId).not.toBe(started.kernelId)
    expect(sessions).toHaveLength(2)
    await backend.dispose()
  })

  it('restarts by replacing the session and hands the browser the new id', async () => {
    const { backend, sessions } = makeBackend()
    const started = await backend.start('ws-1', 'nb.ipynb', undefined)
    const restarted = await backend.restart({ ...body(started), path: 'nb.ipynb' })
    expect(restarted.kernelId).not.toBe(started.kernelId)
    expect(sessions[0]!.stopped).toBe('restart')
    // The old token must stop working: its kernel no longer exists.
    expect(() => backend.execute({ ...body(started), code: 'x' })).toThrowError(/no longer running/u)
    await backend.dispose()
  })

  it('answers an input request only for the kernel asking', async () => {
    const { backend, sessions } = makeBackend()
    const started = await backend.start('ws-1', 'nb.ipynb', undefined)
    expect(backend.input({ ...body(started), value: '42' })).toEqual({ accepted: true })
    expect(sessions[0]!.lastInput).toBe('42')
    await backend.dispose()
  })

  it('exposes the introspection replies the cell editor needs', async () => {
    const { backend } = makeBackend()
    const started = await backend.start('ws-1', 'nb.ipynb', undefined)
    await expect(backend.complete({ ...body(started), code: 'pr', cursorPos: 2 }))
      .resolves.toEqual({ matches: ['print'], cursorStart: 0, cursorEnd: 2 })
    await expect(backend.inspect({ ...body(started), code: 'print', cursorPos: 5 }))
      .resolves.toEqual({ found: true, text: 'doc' })
    await expect(backend.isComplete({ ...body(started), code: 'for i in x:' }))
      .resolves.toEqual({ status: 'incomplete', indent: '  ' })
    await backend.dispose()
  })

  it('clamps a cursor outside the code instead of trusting the browser', async () => {
    const { backend, sessions } = makeBackend()
    const started = await backend.start('ws-1', 'nb.ipynb', undefined)
    await backend.complete({ ...body(started), code: 'ab', cursorPos: 9_999 })
    // The fake records what the manager actually put on the wire, so the assertion is
    // about the clamp rather than about a spy's typing.
    const content = sessions[0]!.replyContent
    expect(content['cursor_pos']).toBe(2)
    await backend.dispose()
  })

  it('reclaims an unattended kernel even mid-run', async () => {
    // A runaway `while True: pass` attached to nobody must not hold its slot forever;
    // output is deliberately not treated as engagement, or it would self-renew.
    const { backend, sessions } = makeBackend({ unattendedTimeoutMs: 10, reaperIntervalMs: 20 })
    const started = await backend.start('ws-1', 'a.ipynb', undefined)
    backend.execute({ ...body(started), code: 'while True: pass', cellId: 'c' })
    sessions[0]!.busy = true
    await new Promise(resolve => { setTimeout(resolve, 200) })
    expect(backend.kernelCount).toBe(0)
    expect(sessions[0]!.stopped).toBe('idle')
    // Being mid-run did not spare it: that is the whole difference from the old policy.
    expect(sessions[0]!.busyAtStop).toBe(true)
    await backend.dispose()
  })

  it('refuses a kernel beyond the per-workspace ceiling rather than waiting for a sweep', async () => {
    // The ceiling is enforced at start, not by the 30s reaper: a burst of notebook
    // tabs must never spawn past it and be trimmed only afterwards.
    const { backend, sessions } = makeBackend({ maxKernelsPerWorkspace: 1, maxKernelsTotal: 8 })
    const first = await backend.start('ws-1', 'a.ipynb', undefined)
    sessions[0]!.busy = true
    await expect(backend.start('ws-1', 'b.ipynb', undefined)).rejects.toThrowError(/already running 1 kernels/u)
    // A different workspace is not blocked by this one being full.
    const other = await backend.start('ws-2', 'c.ipynb', undefined)
    expect(other.kernelId).not.toBe(first.kernelId)
    await backend.dispose()
  })

  it('refuses a kernel beyond the whole-process ceiling', async () => {
    const { backend } = makeBackend({ maxKernelsTotal: 1, maxKernelsPerWorkspace: 1 })
    const first = await backend.start('ws-1', 'a.ipynb', undefined)
    // A kernel with a live run cannot be reclaimed, so the only honest answer to a
    // second start is a refusal rather than spawning past the ceiling. `execute` leaves
    // the session busy until its run is finished, which is the state being asserted.
    backend.execute({ ...body(first), code: 'while True: pass', cellId: 'c' })
    await expect(backend.start('ws-1', 'b.ipynb', undefined)).rejects.toThrowError(/already running/u)
    await backend.dispose()
  })

  it('reclaims the longest-idle kernel to make room', async () => {
    const { backend, sessions } = makeBackend({ maxKernelsTotal: 1, maxKernelsPerWorkspace: 1 })
    const first = await backend.start('ws-1', 'a.ipynb', undefined)
    // Finish the run so the session is not busy, then push its activity into the past.
    const { msgId } = backend.execute({ ...body(first), code: 'x', cellId: 'c' })
    sessions[0]!.finish(msgId, 'c')
    const other = await backend.start('ws-1', 'b.ipynb', undefined)
    expect(other.kernelId).not.toBe(first.kernelId)
    expect(sessions).toHaveLength(2)
    await backend.dispose()
  })

  it('writes the workspace-relative path into the launch plan, never an absolute one', async () => {
    const { backend, sessions } = makeBackend()
    await backend.start('ws-1', 'notes/nb.ipynb', undefined)
    expect(sessions[0]!.notebookPath).toBe('notes/nb.ipynb')
    await backend.dispose()
  })

  it('rejects a path that is not a file inside the workspace', async () => {
    const { backend } = makeBackend()
    await expect(backend.start('ws-1', '', undefined)).rejects.toThrowError(/missing path/u)
    await backend.dispose()
  })
})

describe('kernel event stream', () => {
  /** A minimal `ServerResponse` stand-in: enough for the SSE handler's own calls. */
  function fakeResponse() {
    const written: string[] = []
    let status = 0
    const emitter = new EventEmitter() as EventEmitter & {
      writeHead(next: number, headers: Record<string, string>): void
      flushHeaders(): void
      write(chunk: string): boolean
      end(): void
      headersSent: boolean
      writableEnded: boolean
    }
    emitter.writeHead = (next) => {
      status = next
      emitter.headersSent = true
    }
    emitter.flushHeaders = () => undefined
    emitter.write = (chunk: string) => { written.push(chunk); return true }
    emitter.end = () => { emitter.writableEnded = true }
    emitter.headersSent = false
    emitter.writableEnded = false
    return { res: emitter, written, status: () => status }
  }

  function fakeRequest(url: string) {
    const emitter = new EventEmitter() as EventEmitter & { socket: { setNoDelay(): void }; url: string }
    emitter.url = url
    emitter.socket = { setNoDelay: () => undefined }
    return emitter
  }

  it('sends a snapshot, replays what the cursor missed, then streams live frames', async () => {
    const { backend, sessions } = makeBackend()
    const started = await backend.start('ws-1', 'nb.ipynb', undefined)
    const first = backend.execute({ ...body(started), code: 'x', cellId: 'c' })
    sessions[0]!.finish(first.msgId, 'c')

    const { res, written } = fakeResponse()
    const req = fakeRequest(`/kernel/stream?kernelId=${started.kernelId}&token=${started.token}&since=1`)
    await backend.stream(req as never, res as never)
    const text = written.join('')
    expect(text).toContain('event: snapshot')
    expect(text).toContain('event: frame')
    // One SSE event per frame, each on its own `data:` line pair.
    expect((text.match(/event: frame\n/gu) ?? [])).toHaveLength(3)

    // A live frame reaches the attached listener without another poll.
    const second = backend.execute({ ...body(started), code: 'y', cellId: 'c2' })
    sessions[0]!.publishOutput(second.msgId, 'c2', 'out')
    expect(written.at(-1)).toContain('"text":"out"')

    // Detaching on client close must not stop the kernel: a reload is not a shutdown.
    req.emit('close')
    expect(sessions[0]!.stopped).toBeNull()
    await backend.dispose()
  })

  it('refuses a stream whose token does not match', async () => {
    const { backend } = makeBackend()
    const started = await backend.start('ws-1', 'nb.ipynb', undefined)
    const { res, written, status } = fakeResponse()
    const req = fakeRequest(`/kernel/stream?kernelId=${started.kernelId}&token=wrong&since=1`)
    await backend.stream(req as never, res as never)
    // A 404 with no body: a caller that cannot prove it owns the kernel learns nothing
    // about it, and no event stream is opened for it to read.
    expect(status()).toBe(404)
    expect(written).toHaveLength(0)
    expect(res.writableEnded).toBe(true)
    await backend.dispose()
  })

  it('closes a stream for a kernel that already ended rather than hanging it', async () => {
    const { backend } = makeBackend()
    const started = await backend.start('ws-1', 'nb.ipynb', undefined)
    await backend.shutdown(body(started))
    const { res, written, status } = fakeResponse()
    const req = fakeRequest(`/kernel/stream?kernelId=${started.kernelId}&token=${started.token}&since=1`)
    await backend.stream(req as never, res as never)
    // The kernel is gone, so the route answers and closes instead of holding a socket
    // that could never deliver another frame.
    expect(status()).toBe(404)
    expect(written.join('')).toBe('')
    expect(res.writableEnded).toBe(true)
    await backend.dispose()
  })

  it('resumes from a cursor past the buffer without inventing frames', async () => {
    const { backend, sessions } = makeBackend()
    const started = await backend.start('ws-1', 'nb.ipynb', undefined)
    const { msgId } = backend.execute({ ...body(started), code: 'x', cellId: 'c' })
    sessions[0]!.finish(msgId, 'c')
    const { res, written } = fakeResponse()
    // A cursor ahead of everything: the snapshot still tells the client where it is.
    const req = fakeRequest(`/kernel/stream?kernelId=${started.kernelId}&token=${started.token}&since=99`)
    await backend.stream(req as never, res as never)
    const text = written.join('')
    expect(text).toContain('event: snapshot')
    expect(text).not.toContain('event: frame')
    await backend.dispose()
  })
})
