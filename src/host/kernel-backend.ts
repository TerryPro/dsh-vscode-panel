/**
 * Kernel manager: one Jupyter kernel per open notebook, its replay buffer, and the
 * two transports the browser can read it through.
 *
 * This is the only place in the Host that knows about notebook *sessions*: it owns
 * kernel lifecycles, assigns each event a monotonic sequence number so a dropped
 * stream can resume without losing output, fans frames out to attached SSE
 * listeners, and falls back to explicit polling for environments that cannot hold
 * a stream open. It also enforces the two limits a feature that spawns processes
 * must have — how many kernels may run at once, and how long one may live with no
 * browser attached — because an orphaned kernel would hold a port, a process, and
 * the user's variables indefinitely.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {
  KernelCompletionResult,
  KernelDescription,
  KernelDiscoverResult,
  KernelExecuteResult,
  KernelInputResult,
  KernelInspectResult,
  KernelIsCompleteResult,
  KernelPhase,
  KernelStartResult,
  KernelStatusResult,
  KernelStreamSnapshot,
  NotebookKernelEvent,
  NotebookKernelFrame,
  NotebookKernelPollResult,
} from '../shared/notebook-protocol.ts'
import { KERNEL_FRAME_BUFFER } from '../shared/notebook-protocol.ts'
import { WorkbenchHttpError } from './http.ts'
import type { WorkspaceBackend } from './workspace-backend.ts'
import {
  DEFAULT_KERNEL_SESSION_LIMITS,
  KernelSession,
  type KernelLaunchPlan,
  type KernelSessionHandle,
  type KernelSessionLimits,
  type KernelSessionSink,
  type KernelStopReason,
} from './kernel/kernel-session.ts'
import {
  defaultKernelChoice,
  discoverKernels,
  forgetKernelDiscovery,
} from './kernel/discovery.ts'
import type { KernelChoice, KernelEnvironment } from '../shared/notebook-protocol.ts'

/** Tunables the plugin's `Config` supplies, mirroring the Git backend's shape. */
export interface KernelLimits extends KernelSessionLimits {
  /** Kernels allowed per Workspace at once. */
  maxKernelsPerWorkspace: number
  /** Kernels allowed in this DSH process at once. */
  maxKernelsTotal: number
  /** A kernel with no attached browser and no run for this long is stopped. */
  unattendedTimeoutMs: number
  /** How often the reaper scans sessions. */
  reaperIntervalMs: number
  /** SSE comment keepalive interval, so a proxy does not close an idle stream. */
  heartbeatMs: number
}

export const DEFAULT_KERNEL_LIMITS: KernelLimits = {
  ...DEFAULT_KERNEL_SESSION_LIMITS,
  maxKernelsPerWorkspace: 4,
  maxKernelsTotal: 16,
  unattendedTimeoutMs: 15 * 60_000,
  reaperIntervalMs: 30_000,
  heartbeatMs: 15_000,
}

/** One managed kernel plus the state its listeners need. */
interface ManagedKernel {
  session: KernelSessionHandle
  workspaceId: string
  /** Workspace-relative notebook path this kernel belongs to. */
  path: string
  frames: NotebookKernelFrame[]
  nextSequence: number
  /** Oldest sequence still replayable; `nextSequence` when the buffer wrapped. */
  oldestSequence: number
  info: KernelDescription | null
  listeners: Set<ServerResponse>
  heartbeats: Map<ServerResponse, NodeJS.Timeout>
  /** Wall clock of the last attached listener or published event. */
  lastEngagedAt: number
  stopping: boolean
}

/** Construction overrides; the only one needed outside tests is the bridge path. */
export interface KernelBackendOptions {
  /** Absolute path of the shipped `kernel-bridge.py`. */
  bridgeScriptPath?: string
  /**
   * Session factory, overridable so the manager's own rules (authorization, replay,
   * capacity, fan-out) can be tested without starting a Python process.
   */
  createSession?: (
    workspaceId: string,
    launch: KernelLaunchPlan,
    sink: KernelSessionSink,
    limits: KernelSessionLimits,
  ) => KernelSessionHandle
  /**
   * Machine scan for interpreters and kernelspecs, overridable so the manager's rules
   * can be tested without a Python install.
   */
  discoverKernels?: (
    workspaceRoot: string,
  ) => Promise<{ environments: KernelEnvironment[]; kernels: KernelChoice[] }>
}

export class KernelBackend {
  private readonly kernels = new Map<string, ManagedKernel>()
  /** `workspaceId\0path` → kernelId, so one notebook has one kernel. */
  private readonly byNotebook = new Map<string, string>()
  private reaper: NodeJS.Timeout | undefined
  private readonly bridgeScriptPath: string
  private readonly createSession: (
    workspaceId: string,
    launch: KernelLaunchPlan,
    sink: KernelSessionSink,
    limits: KernelSessionLimits,
  ) => KernelSessionHandle
  private readonly scanKernels: (
    workspaceRoot: string,
  ) => Promise<{ environments: KernelEnvironment[]; kernels: KernelChoice[] }>
  /** Start requests in flight per notebook, so a racing second tab joins rather than doubles. */
  private readonly startRaces = new Map<string, Promise<KernelStartResult>>()

  constructor(
    private readonly ctx: Context,
    private readonly workspace: WorkspaceBackend,
    private readonly limits: KernelLimits = DEFAULT_KERNEL_LIMITS,
    options: KernelBackendOptions = {},
  ) {
    // Resolved beside the bundled `lib/index.js`, which is where the build copies
    // `kernel-bridge.py`; an absent file is reported when a start is attempted, not
    // at load time, so a broken install cannot take the file API down.
    this.bridgeScriptPath = options.bridgeScriptPath
      ?? fileURLToPath(new URL('./kernel-bridge.py', import.meta.url))
    this.createSession = options.createSession
      ?? ((workspaceId, launch, sink, sessionLimits) => new KernelSession(workspaceId, launch, sink, sessionLimits))
    this.scanKernels = options.discoverKernels ?? ((root: string) => discoverKernels(root))
    this.startReaper()
  }

  /** Stop every kernel: called when the plugin's effect is disposed. */
  async dispose(): Promise<void> {
    if (this.reaper !== undefined) clearInterval(this.reaper)
    this.reaper = undefined
    await Promise.all([...this.kernels.values()].map(kernel => this.stopKernel(kernel, 'workspace')))
    this.kernels.clear()
    this.byNotebook.clear()
  }

  /** Kernels currently managed, for the reaper and the status surface. */
  get kernelCount(): number {
    return this.kernels.size
  }

  /**
   * Report every kernel and Python environment this Workspace can start.
   *
   * @param workspaceIdValue browser-supplied Workspace id, validated here.
   */
  async discover(workspaceIdValue: unknown): Promise<KernelDiscoverResult> {
    const root = await this.workspace.rootProcessPath(requireWorkspaceId(workspaceIdValue))
    const { environments, kernels } = await this.scanKernels(root.cwd)
    const usable = kernels.some(kernel => kernel.available)
    return {
      usable,
      kernels,
      environments,
      ...(usable
        ? {}
        : {
          message: kernels.length === 0
            ? 'no Python interpreter was found for this workspace; install Python, or add a .venv to the workspace.'
            : 'no Python environment here has ipykernel installed; run: python -m pip install ipykernel',
        }),
    }
  }

  /**
   * Start, or reuse, the kernel for one notebook.
   *
   * Reuse is the behaviour a user expects: running a cell must not silently reset
   * the variables of the notebook already open in another tab, and two calls that
   * race on a cold start must produce one process.
   */
  async start(
    workspaceIdValue: unknown,
    pathValue: unknown,
    specNameValue: unknown,
  ): Promise<KernelStartResult> {
    const workspaceId = requireWorkspaceId(workspaceIdValue)
    const path = await this.workspace.assertRelativePath(workspaceId, pathValue)
    const existingKey = notebookKey(workspaceId, path)
    const existingId = this.byNotebook.get(existingKey)
    if (existingId !== undefined) {
      const existing = this.kernels.get(existingId)
      if (existing !== undefined && !existing.stopping && existing.session.phase !== 'failed') {
        existing.lastEngagedAt = Date.now()
        return startResult(existing, existing.session.phase)
      }
      if (existing !== undefined) this.forget(existing)
    }
    const racing = this.startRaces.get(existingKey)
    if (racing !== undefined) return await racing

    const specName = typeof specNameValue === 'string' && specNameValue !== '' ? specNameValue : undefined
    const start = this.startKernel(workspaceId, path, specName).finally(() => {
      this.startRaces.delete(existingKey)
    })
    this.startRaces.set(existingKey, start)
    return await start
  }

  /** Live facts for one kernel, plus the stream position to resume from. */
  async status(body: Record<string, unknown>): Promise<KernelStatusResult> {
    const kernel = this.requireKernel(body)
    return {
      kernelId: kernel.session.kernelId,
      phase: kernel.session.phase,
      executionCount: kernel.session.executionCount,
      sequence: kernel.nextSequence,
      attached: kernel.listeners.size,
      displayName: kernel.session.displayName,
      specName: kernel.session.specName,
    }
  }

  /** Run one cell and return the id its output events are keyed by. */
  execute(body: Record<string, unknown>): KernelExecuteResult {
    const kernel = this.requireKernel(body)
    const code = requireString(body['code'], 'CODE_REQUIRED', 'cell code is required.')
    const cellId = typeof body['cellId'] === 'string' && body['cellId'] !== '' ? body['cellId'] : undefined
    const silent = body['silent'] === true
    kernel.lastEngagedAt = Date.now()
    try {
      const { msgId } = kernel.session.execute(code, cellId, silent)
      return { msgId, executionCount: kernel.session.executionCount, phase: kernel.session.phase }
    } catch (error: unknown) {
      throw kernelActionFailure(error)
    }
  }

  /** Interrupt the running cell on this kernel. */
  interrupt(body: Record<string, unknown>): KernelStatusResult {
    const kernel = this.requireKernel(body)
    kernel.lastEngagedAt = Date.now()
    kernel.session.interrupt()
    return this.statusOf(kernel)
  }

  /** Answer a parked `input()` prompt. */
  input(body: Record<string, unknown>): KernelInputResult {
    const kernel = this.requireKernel(body)
    const value = typeof body['value'] === 'string' ? body['value'] : ''
    kernel.lastEngagedAt = Date.now()
    return { accepted: kernel.session.replyInput(value) }
  }

  /** Tab completion for the cell editor, asked of the kernel itself. */
  async complete(body: Record<string, unknown>): Promise<KernelCompletionResult> {
    const kernel = this.requireKernel(body)
    const code = requireString(body['code'], 'CODE_REQUIRED', 'cell code is required.')
    const cursorPos = clampInteger(body['cursorPos'], 0, code.length)
    try {
      return await kernel.session.requestReply<KernelCompletionResult>(
        'complete_request',
        { code, cursor_pos: cursorPos },
        message => ({
          matches: Array.isArray(message.content['matches'])
            ? message.content['matches'].filter(entry => typeof entry === 'string') as string[]
            : [],
          cursorStart: typeof message.content['cursor_start'] === 'number' ? message.content['cursor_start'] : cursorPos,
          cursorEnd: typeof message.content['cursor_end'] === 'number' ? message.content['cursor_end'] : cursorPos,
        }),
      )
    } catch (error: unknown) {
      throw kernelActionFailure(error)
    }
  }

  /** Docstring/introspection text for a hover, in plain text. */
  async inspect(body: Record<string, unknown>): Promise<KernelInspectResult> {
    const kernel = this.requireKernel(body)
    const code = requireString(body['code'], 'CODE_REQUIRED', 'cell code is required.')
    const cursorPos = clampInteger(body['cursorPos'], 0, code.length)
    try {
      return await kernel.session.requestReply<KernelInspectResult>(
        'inspect_request',
        { code, cursor_pos: cursorPos, detail_level: 0 },
        message => {
          const data = message.content['data']
          const plain = typeof data === 'object' && data !== null
            ? (data as Record<string, unknown>)['text/plain']
            : undefined
          return {
            found: message.content['found'] === true,
            text: typeof plain === 'string' ? plain : '',
          }
        },
      )
    } catch (error: unknown) {
      throw kernelActionFailure(error)
    }
  }

  /** Whether a cell's code is complete, so a run can wait for a continuation. */
  async isComplete(body: Record<string, unknown>): Promise<KernelIsCompleteResult> {
    const kernel = this.requireKernel(body)
    const code = requireString(body['code'], 'CODE_REQUIRED', 'cell code is required.')
    try {
      return await kernel.session.requestReply<KernelIsCompleteResult>(
        'is_complete_request',
        { code },
        message => {
          const status = message.content['status']
          const known = status === 'complete' || status === 'incomplete' || status === 'invalid'
          return {
            status: known ? status : 'unknown',
            ...(typeof message.content['indent'] === 'string' ? { indent: message.content['indent'] } : {}),
          }
        },
      )
    } catch (error: unknown) {
      throw kernelActionFailure(error)
    }
  }

  /** Stop this notebook's kernel, keeping its tab usable for a later restart. */
  async shutdown(body: Record<string, unknown>): Promise<KernelStatusResult> {
    const kernel = this.requireKernel(body)
    await this.stopKernel(kernel, 'user')
    // Read the status after the stop so the client sees `terminated` rather than the
    // phase the kernel had while it was still alive.
    const result = this.statusOf(kernel)
    this.forget(kernel)
    return result
  }

  /**
   * Restart one notebook's kernel.
   *
   * A restart is a new session with a new id: the browser gets it from the reply and
   * re-attaches, so no stream can ever be asked to replay events from a kernel that
   * no longer exists.
   */
  async restart(body: Record<string, unknown>): Promise<KernelStartResult> {
    const kernel = this.requireKernel(body)
    const { workspaceId, path } = kernel
    await this.stopKernel(kernel, 'restart')
    this.forget(kernel)
    forgetKernelDiscovery(await (await this.workspace.rootProcessPath(workspaceId)).cwd)
    return await this.start(workspaceId, path, undefined)
  }

  /** Poll fallback: every frame after `since`, bounded by the replay buffer. */
  poll(body: Record<string, unknown>): NotebookKernelPollResult {
    const kernel = this.requireKernel(body)
    const since = clampInteger(body['since'], 0, Number.MAX_SAFE_INTEGER)
    kernel.lastEngagedAt = Date.now()
    const oldest = kernel.oldestSequence
    // A cursor older than the buffer means frames were dropped; say so instead of
    // silently returning a gap the browser would render as missing output.
    const resynced = since < oldest
    const from = resynced ? oldest : since
    const frames = kernel.frames.filter(frame => frame.sequence >= from && frame.sequence < kernel.nextSequence)
    return {
      frames,
      nextSequence: kernel.nextSequence,
      phase: kernel.session.phase,
      executionCount: kernel.session.executionCount,
      resynced,
    }
  }

  /**
   * Answer one SSE stream request for one kernel.
   *
   * The handler owns the response end to end: it validates, sends a snapshot so the
   * browser learns its resume position, replays what it missed, then stays attached
   * until either side goes away. Detaching never stops the kernel — a page reload
   * must not lose a running cell.
   */
  async stream(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const query = new URL(req.url ?? '/', 'http://dsh.invalid').searchParams
    const kernelId = query.get('kernelId') ?? ''
    const token = query.get('token') ?? ''
    const since = Number.parseInt(query.get('since') ?? '0', 10)
    const kernel = this.kernels.get(kernelId)
    if (kernel === undefined || kernel.session.token !== token || kernel.stopping) {
      res.writeHead(404, { 'Cache-Control': 'no-store' })
      res.end()
      return
    }
    const snapshot: KernelStreamSnapshot = {
      kernelId,
      phase: kernel.session.phase,
      executionCount: kernel.session.executionCount,
      sequence: kernel.nextSequence,
      displayName: kernel.session.displayName,
      specName: kernel.session.specName,
      oldestSequence: kernel.oldestSequence,
      ...(kernel.info === null ? {} : { language: kernel.info.language }),
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      // `no-store` keeps a proxy from buffering a live run; `no-transform` stops a
      // gateway from gzipping a stream that gzip already skips.
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.flushHeaders()
    req.socket?.setNoDelay(true)
    writeEvent(res, 'snapshot', snapshot)
    const from = Number.isFinite(since) && since >= kernel.oldestSequence ? since : kernel.oldestSequence
    for (const frame of kernel.frames) {
      if (frame.sequence >= from && frame.sequence < kernel.nextSequence) writeEvent(res, 'frame', frame)
    }
    // A kernel that ended before the browser attached has no future frames; say so
    // and close, rather than holding a stream that can never deliver anything.
    if (kernel.stopping || kernel.session.phase === 'terminated' || kernel.session.phase === 'failed') {
      writeEvent(res, 'end', { phase: kernel.session.phase })
      res.end()
      return
    }
    kernel.listeners.add(res)
    kernel.lastEngagedAt = Date.now()
    const heartbeat = setInterval(() => {
      // A comment frame is the standard keepalive: it resets an idle proxy timer
      // without producing an event the browser has to ignore.
      if (!res.writableEnded) res.write(': ping\n\n')
    }, this.limits.heartbeatMs)
    heartbeat.unref?.()
    kernel.heartbeats.set(res, heartbeat)
    const detach = (): void => {
      if (!kernel.listeners.delete(res)) return
      const timer = kernel.heartbeats.get(res)
      if (timer !== undefined) clearInterval(timer)
      kernel.heartbeats.delete(res)
      // The grace period is measured from the last moment anyone was watching, so it
      // starts now rather than at the last request the page happened to make.
      if (kernel.listeners.size === 0) kernel.lastEngagedAt = Date.now()
    }
    req.once('close', detach)
    res.once('error', detach)
    res.once('finish', detach)
  }

  /**
   * Start one kernel process and register its session.
   *
   * Concurrency is bounded before the process is spawned, not after, so a burst of
   * notebook tabs cannot fork an unbounded number of interpreters.
   */
  private async startKernel(
    workspaceId: string,
    path: string,
    specName: string | undefined,
  ): Promise<KernelStartResult> {
    if (!await this.bridgeExists()) {
      throw new WorkbenchHttpError(500, 'KERNEL_BRIDGE_MISSING', 'the kernel launcher script is missing from this installation.')
    }
    this.enforceCapacity(workspaceId)
    const root = await this.workspace.rootProcessPath(workspaceId)
    const { kernels } = await this.scanKernels(root.cwd)
    const choice = specName === undefined
      ? defaultKernelChoice(kernels)
      : kernels.find(kernel => kernel.name === specName && kernel.available)
    if (choice === undefined || !choice.available) {
      throw new WorkbenchHttpError(409, 'KERNEL_UNAVAILABLE', choice === undefined && specName !== undefined
        ? `the kernel ${specName} cannot be started here.`
        : 'no available Jupyter kernel: install ipykernel into the environment you want to use.')
    }
    // The kernel's cwd is the notebook's directory, matching Jupyter's own
    // frontends so `open("data.csv")` inside a cell means what the user expects.
    const launch = {
      ...(await this.launchPlanFor(choice, root.cwd, path)),
      workingDirectory: await this.notebookDirectory(workspaceId, path),
    }
    const managed: ManagedKernel = {
      session: undefined as unknown as KernelSession,
      workspaceId,
      path,
      frames: [],
      nextSequence: 1,
      oldestSequence: 1,
      info: null,
      listeners: new Set(),
      heartbeats: new Map(),
      lastEngagedAt: Date.now(),
      stopping: false,
    }
    const session = this.createSession(workspaceId, launch, {
      publish: event => { this.publish(managed, event) },
      ended: reason => {
        this.ctx.logger.info(`workbench-layout: kernel ended for ${JSON.stringify(path)} (${shortReason(reason)})`)
        this.forget(managed)
      },
    }, this.limits)
    managed.session = session
    // Registered before `start()` awaits, so a second tab opening the same notebook
    // while this one is still starting finds it and waits on the same promise.
    this.kernels.set(session.kernelId, managed)
    this.byNotebook.set(notebookKey(workspaceId, path), session.kernelId)
    try {
      managed.info = await session.start(AbortSignal.timeout(this.limits.startTimeoutMs))
    } catch (error: unknown) {
      this.forget(managed)
      await session.stop('user').catch(() => undefined)
      throw new WorkbenchHttpError(
        502,
        'KERNEL_START_FAILED',
        `the kernel could not start: ${safeMessage(error)}`,
      )
    }
    this.ctx.logger.info(
      `workbench-layout: started kernel ${session.specName} for ${JSON.stringify(path)} in ${JSON.stringify(workspaceId)}`,
    )
    return startResult(managed, session.phase)
  }

  /**
   * Build the launch plan for one chosen kernel.
   *
   * A kernel discovered without a spec is started the canonical way
   * (`python -m ipykernel_launcher -f <file>`). A kernelspec's own argv is honoured
   * and re-pointed at the interpreter the Host verified, so a spec written for
   * another machine's Python still starts here. `workingDirectory` is filled in by
   * the caller, which is the only place that has resolved the notebook's directory.
   */
  private async launchPlanFor(
    choice: KernelChoice,
    workspaceRoot: string,
    path: string,
  ): Promise<KernelLaunchPlan> {
    const interpreter = choice.interpreterPath
    if (interpreter === undefined) {
      throw new WorkbenchHttpError(409, 'KERNEL_UNAVAILABLE', 'this kernel has no interpreter this workspace can reach.')
    }
    // A kernelspec choice already carries its own argv; `kernelCommandForPlan`
    // substitutes the interpreter this Host verified, so a spec written for another
    // machine's Python still starts here. A bare discovered environment gets the
    // canonical `python -m ipykernel_launcher -f <file>` command.
    return {
      bridgeInterpreter: interpreter,
      bridgeScript: this.bridgeScriptPath,
      kernelArgv: choice.argv ?? [interpreter, '-m', 'ipykernel_launcher', '-f', '{connection_file}'],
      interpreterPath: interpreter,
      displayName: choice.displayName,
      specName: choice.name,
      workingDirectory: workspaceRoot,
      notebookPath: path,
    }
  }

  /** Absolute directory containing one workspace-relative notebook path. */
  private async notebookDirectory(workspaceId: string, path: string): Promise<string> {
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    const resolved = await this.workspace.absolutePath(workspaceId, parent)
    return resolved.absolutePath
  }

  /** Publish one session event: assign its sequence, buffer it, broadcast it. */
  private publish(kernel: ManagedKernel, event: NotebookKernelEvent): void {
    const frame: NotebookKernelFrame = { ...event, sequence: kernel.nextSequence }
    kernel.nextSequence += 1
    kernel.frames.push(frame)
    if (kernel.frames.length > KERNEL_FRAME_BUFFER) {
      const dropped = kernel.frames.length - KERNEL_FRAME_BUFFER
      kernel.frames.splice(0, dropped)
      kernel.oldestSequence += dropped
    }
    // Deliberately *not* the engagement clock: kernel output is not a reader watching
    // it, or a runaway cell that prints forever would keep itself alive past its
    // grace period and hold a slot the user wants back.
    if (event.type === 'info') kernel.info = event.info
    for (const res of kernel.listeners) {
      if (res.writableEnded) {
        kernel.listeners.delete(res)
        continue
      }
      try {
        writeEvent(res, 'frame', frame)
      } catch {
        // A stream that can no longer be written is gone; the kernel keeps running
        // and a later attachment replays from the buffer.
        this.detach(kernel, res)
      }
    }
    if (event.type === 'phase' && (event.phase === 'terminated' || event.phase === 'failed')) {
      for (const res of [...kernel.listeners]) {
        writeEvent(res, 'end', { phase: event.phase })
        this.detach(kernel, res)
        res.end()
      }
    }
  }

  private detach(kernel: ManagedKernel, res: ServerResponse): void {
    kernel.listeners.delete(res)
    const timer = kernel.heartbeats.get(res)
    if (timer !== undefined) clearInterval(timer)
    kernel.heartbeats.delete(res)
  }

  /** End a kernel's process and drop its listeners. */
  private async stopKernel(kernel: ManagedKernel, reason: KernelStopReason): Promise<void> {
    if (kernel.stopping) return
    kernel.stopping = true
    for (const res of [...kernel.listeners]) {
      this.detach(kernel, res)
      if (!res.writableEnded) res.end()
    }
    await kernel.session.stop(reason).catch((error: unknown) => {
      this.ctx.logger.warn(`workbench-layout: failed to stop a kernel cleanly: ${safeMessage(error)}`)
    })
  }

  private forget(kernel: ManagedKernel): void {
    this.kernels.delete(kernel.session.kernelId)
    if (this.byNotebook.get(notebookKey(kernel.workspaceId, kernel.path)) === kernel.session.kernelId) {
      this.byNotebook.delete(notebookKey(kernel.workspaceId, kernel.path))
    }
  }

  private statusOf(kernel: ManagedKernel): KernelStatusResult {
    return {
      kernelId: kernel.session.kernelId,
      phase: kernel.session.phase,
      executionCount: kernel.session.executionCount,
      sequence: kernel.nextSequence,
      attached: kernel.listeners.size,
      displayName: kernel.session.displayName,
      specName: kernel.session.specName,
    }
  }

  /**
   * Resolve a request's kernel and check the caller's token.
   *
   * The loopback origin fence proves the request came from a browser on this
   * machine, not from *this* page, so the per-kernel token is what stops another
   * local tab from reading or interrupting a notebook it never opened.
   */
  private requireKernel(body: Record<string, unknown>): ManagedKernel {
    const workspaceId = requireWorkspaceId(body['workspaceId'])
    const kernelId = requireString(body['kernelId'], 'KERNEL_ID_REQUIRED', 'a kernel id is required.')
    const token = requireString(body['token'], 'KERNEL_TOKEN_REQUIRED', 'a kernel token is required.')
    const kernel = this.kernels.get(kernelId)
    if (kernel === undefined) throw new WorkbenchHttpError(404, 'KERNEL_NOT_FOUND', 'this kernel is no longer running.')
    if (kernel.session.token !== token) throw new WorkbenchHttpError(403, 'KERNEL_UNAUTHORIZED', 'this kernel belongs to another notebook.')
    if (kernel.workspaceId !== workspaceId) throw new WorkbenchHttpError(403, 'KERNEL_WORKSPACE_MISMATCH', 'this kernel belongs to another workspace.')
    return kernel
  }

  /**
   * Make room for one more kernel, refusing only when nothing can be reclaimed.
   *
   * Both ceilings are enforced here rather than waiting for the reaper: a burst of
   * notebook tabs opening would otherwise spawn up to `maxKernelsTotal` interpreters
   * and only be trimmed thirty seconds later. A busy kernel is never a candidate, so
   * an active run is never stolen to satisfy a new tab — the request fails visibly
   * instead.
   */
  private enforceCapacity(workspaceId: string): void {
    const sameWorkspace = [...this.kernels.values()].filter(kernel => kernel.workspaceId === workspaceId)
    if (sameWorkspace.length >= this.limits.maxKernelsPerWorkspace) {
      const candidate = this.reclaimCandidate(kernel => kernel.workspaceId === workspaceId)
      if (candidate === undefined) {
        throw new WorkbenchHttpError(429, 'KERNEL_LIMIT_WORKSPACE',
          `this workspace is already running ${sameWorkspace.length} kernels.`)
      }
      void this.stopKernel(candidate, 'limit')
      this.forget(candidate)
    }
    if (this.kernels.size >= this.limits.maxKernelsTotal) {
      const candidate = this.reclaimCandidate(() => true)
      if (candidate === undefined) {
        throw new WorkbenchHttpError(429, 'KERNEL_LIMIT_TOTAL', `this DSH host is already running ${this.kernels.size} kernels.`)
      }
      void this.stopKernel(candidate, 'limit')
      this.forget(candidate)
    }
  }

  /** Stop kernels no browser is watching, on the same policy the Host's terminals use. */
  private startReaper(): void {
    this.reaper = setInterval(() => {
      const now = Date.now()
      for (const kernel of [...this.kernels.values()]) {
        if (kernel.stopping) continue
        if (kernel.listeners.size > 0) continue
        if (now - kernel.lastEngagedAt <= this.limits.unattendedTimeoutMs) continue
        // A still-running cell is reclaimed too, not spared: nobody has been
        // attached for the whole grace period, and a runaway loop that held its slot
        // forever would eventually refuse the user a new kernel they do want. Its
        // cells are reported `lost` by the stop, which is the truth for a reader who
        // comes back to a notebook whose run was abandoned.
        void this.stopKernel(kernel, 'idle')
        this.forget(kernel)
        this.ctx.logger.info(
          `workbench-layout: stopped unattended kernel ${kernel.session.specName} for ${JSON.stringify(kernel.path)}`
          + `${kernel.session.busy ? ' during a run' : ''}`,
        )
      }
      // The per-workspace and whole-process ceilings are enforced at start, not here:
      // a reaper pass that trimmed by age would be free to stop a kernel the user is
      // about to come back to, while a start that needed room *right now* would have
      // been allowed through.
    }, this.limits.reaperIntervalMs)
    this.reaper.unref?.()
  }

  /** The longest-idle kernel the given rule may reclaim, or none if all are busy. */
  private reclaimCandidate(accept: (kernel: ManagedKernel) => boolean): ManagedKernel | undefined {
    let oldest: ManagedKernel | undefined
    for (const kernel of this.kernels.values()) {
      if (!accept(kernel) || kernel.stopping || kernel.session.busy) continue
      if (oldest === undefined || kernel.lastEngagedAt < oldest.lastEngagedAt) oldest = kernel
    }
    return oldest
  }

  private async bridgeExists(): Promise<boolean> {
    const { stat } = await import('node:fs/promises')
    try {
      return (await stat(this.bridgeScriptPath)).isFile()
    } catch {
      return false
    }
  }
}

/** One kernel per Workspace and notebook path. */
function notebookKey(workspaceId: string, path: string): string {
  return `${workspaceId}\0${path}`
}

function startResult(kernel: ManagedKernel, phase: KernelPhase): KernelStartResult {
  return {
    kernelId: kernel.session.kernelId,
    token: kernel.session.token,
    displayName: kernel.session.displayName,
    specName: kernel.session.specName,
    language: kernel.info?.language.name ?? 'python',
    phase,
    sequence: kernel.nextSequence,
  }
}

function writeEvent(res: ServerResponse, name: string, data: unknown): void {
  // A `data:` line cannot carry a newline, so the JSON is emitted compactly and
  // `JSON.stringify` guarantees the single-line requirement.
  res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
}

function requireWorkspaceId(value: unknown): string {
  if (typeof value !== 'string' || value === '') {
    throw new WorkbenchHttpError(400, 'WORKSPACE_REQUIRED', 'no workspace is selected.')
  }
  return value
}

function requireString(value: unknown, code: string, message: string): string {
  if (typeof value !== 'string') throw new WorkbenchHttpError(400, code, message)
  return value
}

function clampInteger(value: unknown, minimum: number, maximum: number): number {
  const number = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(number)) return minimum
  return Math.max(minimum, Math.min(maximum, Math.trunc(number)))
}

/** Keep a subprocess/kernel message presentable: one line, bounded, no host paths. */
function safeMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/\s+/gu, ' ').replace(/[A-Za-z]:\\[^\s]*|(?:^|\s)\/[^\s]*/gu, '[path]').trim().slice(0, 200)
}

function shortReason(reason: string): string {
  return reason.length > 120 ? `${reason.slice(0, 120)}…` : reason
}

/** Translate a session throw into the JSON API's error shape. */
function kernelActionFailure(error: unknown): WorkbenchHttpError {
  if (error instanceof WorkbenchHttpError) return error
  const message = safeMessage(error)
  if (message.includes('not connected')) {
    return new WorkbenchHttpError(409, 'KERNEL_NOT_READY', 'the kernel is not connected; restart it and try again.')
  }
  return new WorkbenchHttpError(502, 'KERNEL_REQUEST_FAILED', `the kernel did not answer: ${message}`)
}

/** Used by tests and the reaper's tuning surface. */
export const KERNEL_INTERNALS = { notebookKey, safeMessage, clampInteger }
