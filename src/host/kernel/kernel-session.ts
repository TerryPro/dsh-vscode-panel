/**
 * One live Jupyter kernel: its process, its channels, and the translation from
 * wire messages to the notebook events the workbench renders.
 *
 * The session is deliberately dumb about notebooks. It knows how to start a
 * kernel, run code, interrupt it, and turn the IOPub firehose into an ordered,
 * sequence-numbered event list; it does not touch the `.ipynb` file. That split is
 * what keeps the browser's draft/save pipeline as the only writer of a notebook,
 * and what makes the events replayable after a dropped stream.
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import net from 'node:net'
import type {
  KernelDescription,
  KernelPhase,
  NotebookKernelEvent,
  NotebookMimeBundle,
  NotebookOutputItem,
  NotebookRunStatus,
} from '../../shared/notebook-protocol.ts'
import { KERNEL_MAX_CHUNK_CHARS, KERNEL_MAX_RUN_CHARS } from '../../shared/notebook-protocol.ts'
import {
  decodeKernelMessage,
  encodeKernelMessage,
  kernelLanguageFromInfo,
  type KernelMessage,
} from './messaging.ts'
import { ZmtpSocket, waitForPort } from './zmtp.ts'

/** How the Host starts a kernel: the bridge script plus the resolved argv. */
export interface KernelLaunchPlan {
  /** Interpreter the bridge itself runs on; normally the kernel interpreter. */
  bridgeInterpreter: string
  /** Absolute path of `kernel-bridge.py`. */
  bridgeScript: string
  /** Kernel argv from the kernelspec, `{connection_file}` unsubstituted. */
  kernelArgv: readonly string[]
  /** Interpreter the kernel process runs as. */
  interpreterPath: string
  displayName: string
  specName: string
  /** Directory the kernel starts in — the notebook's own directory. */
  workingDirectory: string
  /** Workspace-relative notebook path, echoed back for stream scoping. */
  notebookPath: string
}

export interface KernelSessionLimits {
  /** Maximum ms to wait for a kernel to open its ports. */
  startTimeoutMs: number
  /** Maximum ms to wait for a non-execution reply (`complete`, `inspect`). */
  requestTimeoutMs: number
}

export const DEFAULT_KERNEL_SESSION_LIMITS: KernelSessionLimits = {
  startTimeoutMs: 60_000,
  requestTimeoutMs: 15_000,
}

/**
 * The face of a live kernel the manager uses.
 *
 * Declared as an interface so `KernelBackend` can be tested with a fake and stays free
 * of any assumption about how a kernel is actually started.
 */
export interface KernelSessionHandle {
  readonly kernelId: string
  /** Secret the browser must present to attach to this kernel's stream. */
  readonly token: string
  readonly displayName: string
  readonly specName: string
  readonly notebookPath: string
  readonly phase: KernelPhase
  /** Monotonic counter of completed runs, for the tab's `[n]` labels. */
  readonly executionCount: number
  /** Whether a run is still going, which is what idle reclamation waits on. */
  readonly busy: boolean
  /** Wall clock of the last activity, for the unattended timer. */
  readonly lastActivityAt: number
  start(signal: AbortSignal): Promise<KernelDescription>
  execute(code: string, cellId: string | undefined, silent: boolean): { msgId: string }
  interrupt(): void
  replyInput(value: string): boolean
  requestReply<T>(
    type: string,
    content: Record<string, unknown>,
    extract: (message: KernelMessage) => T,
  ): Promise<T>
  stop(reason: KernelStopReason): Promise<void>
}

/** Sink the owning Host implements to receive events and lifecycle changes. */
export interface KernelSessionSink {
  /** One translated event, before the Host assigns its sequence number. */
  publish(event: NotebookKernelEvent): void
  /** The session ended; the Host then stops advertising it. */
  ended(reason: string): void
}

interface PendingRequest {
  resolve(message: KernelMessage): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

/** Bookkeeping for one in-flight cell run. */
interface RunningCell {
  cellId?: string
  chars: number
  outputs: number
  interrupted: boolean
  capped: boolean
}

/** Why a session is being stopped, reflected in the phase message. */
export type KernelStopReason = 'user' | 'restart' | 'idle' | 'limit' | 'workspace'

/** Frames per run beyond which the cell is cut off, so a loop cannot fill memory. */
const MAX_RUN_FRAMES = 20_000

/** Lines of kernel launch noise retained to explain a failed start. */
const MAX_NOISE_LINES = 8

/**
 * A started kernel.
 *
 * `start()` is the only entry that reports failure by rejecting; afterwards a
 * channel or process failure converts to a `failed` phase and an honest run status,
 * so a crash mid-cell never leaves the browser waiting on a spinner.
 */
export class KernelSession implements KernelSessionHandle {
  readonly kernelId = randomUUID()
  /** Secret the browser must present to attach to this kernel's stream. */
  readonly token = randomUUID()

  /** Monotonic counter of completed runs, for the tab's `[n]` labels. */
  executionCount = 0

  private phaseValue: KernelPhase = 'absent'
  private bridge: ReturnType<typeof spawn> | null = null
  private shell: ZmtpSocket | null = null
  private control: ZmtpSocket | null = null
  private iopub: ZmtpSocket | null = null
  private directory = ''
  private connectionFile = ''
  private connectionKey = ''
  private readonly pending = new Map<string, PendingRequest>()
  private readonly running = new Map<string, RunningCell>()
  /** Header of the last `input_request`, needed to answer it correctly. */
  private inputRequest: KernelMessage | null = null
  private stopping = false
  private lastActivity = Date.now()
  /**
   * Kernel/bridge stderr collected while starting.
   *
   * Kept because "the kernel exited with code 1" is not an actionable message, and
   * the one line that explains it (a missing module, a bad interpreter) only exists
   * on the process's stderr. Bounded so a chatty kernel cannot grow this unbounded.
   */
  private readonly noise: string[] = []

  constructor(
    readonly workspaceId: string,
    readonly launch: KernelLaunchPlan,
    private readonly sink: KernelSessionSink,
    private readonly limits: KernelSessionLimits = DEFAULT_KERNEL_SESSION_LIMITS,
  ) {}

  get phase(): KernelPhase {
    return this.phaseValue
  }

  get displayName(): string {
    return this.launch.displayName
  }

  get specName(): string {
    return this.launch.specName
  }

  get notebookPath(): string {
    return this.launch.notebookPath
  }

  get lastActivityAt(): number {
    return this.lastActivity
  }

  /** Whether anything is still being executed, for idle reclamation. */
  get busy(): boolean {
    return this.running.size > 0 || this.inputRequest !== null
  }

  /**
   * Launch the kernel and connect its channels.
   *
   * @param signal aborted when the browser gives up waiting for a start.
   * @returns the `kernel_info_reply` facts, so the caller can label the session
   * before the browser has run anything.
   */
  async start(signal: AbortSignal): Promise<KernelDescription> {
    this.setPhase('starting', { specName: this.specName, displayName: this.displayName })
    const endpoints = await this.prepareConnectionFile()
    const command = this.bridgeCommand()
    const child = spawn(command.file, command.args, {
      cwd: this.launch.workingDirectory,
      env: kernelEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.bridge = child
    child.once('error', error => {
      this.fail(`the kernel process could not be started: ${error.message}`)
    })
    child.once('exit', code => {
      if (this.stopping) return
      const reason = code === null
        ? 'the kernel process was closed'
        : `the kernel process exited with code ${code}`
      this.fail(reason)
    })
    void forwardBridgeLines(child, (kind, text) => {
      if (kind === 'warning') {
        // A bridge warning is about the bridge's own capability (no interrupt
        // handle, no control pipe), which is worth knowing while it starts.
        if (this.phaseValue === 'starting') this.publishPhaseMessage(text)
        this.rememberNoise(`warning: ${text}`)
        return
      }
      // Kernel stderr after startup is usually an IPython notice, not an error: the
      // cell's real output and failures arrive on IOPub. Keep it as the reason a
      // start would have failed rather than showing it as a scary live message.
      this.rememberNoise(text)
      if (this.phaseValue === 'starting') this.publishPhaseMessage(text)
    })

    if (signal.aborted) {
      await this.stop('user')
      throw new Error('kernel start was cancelled')
    }
    try {
      await this.connectChannels(endpoints)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      // The kernel's own last words turn "it exited" into "it exited because
      // ModuleNotFoundError: No module named 'ipykernel'".
      const reason = this.startFailureReason
      await this.stop('user')
      throw new Error(reason === '' ? message : `${message} (${reason})`)
    }

    this.setPhase('ready', { specName: this.specName, displayName: this.displayName })
    const info = await this.request<KernelDescription>('control', 'kernel_info_request', {}, message =>
      kernelDescriptionFrom(message.content))
    this.sink.publish({ type: 'info', info })
    this.lastActivity = Date.now()
    return info
  }

  /**
   * Run one cell.
   *
   * @param code cell source, sent verbatim.
   * @param cellId the tab's cell id, echoed on every event of this run so output
   * lands on the right cell even when several runs overlap.
   * @returns the msg_id the browser correlates its events with.
   */
  execute(code: string, cellId: string | undefined, silent: boolean): { msgId: string } {
    const socket = this.requireSocket(this.shell, 'shell')
    const { frames, msgId } = encodeKernelMessage(this.connectionKey, this.kernelId, {
      type: 'execute_request',
      content: {
        code,
        silent,
        store_history: !silent,
        user_expressions: {},
        // `input()` in a cell is supported: the run parks on an input_request and
        // resumes when the browser answers it.
        allow_stdin: true,
        stop_on_error: true,
      },
    })
    this.running.set(msgId, {
      ...(cellId === undefined ? {} : { cellId }),
      chars: 0,
      outputs: 0,
      interrupted: false,
      capped: false,
    })
    socket.send(frames)
    this.lastActivity = Date.now()
    return { msgId }
  }

  /**
   * Interrupt the running cell.
   *
   * On Windows ipykernel's `interrupt_request` is a no-op, so the bridge signals the
   * Win32 event the kernel was launched with; the message is still sent because it
   * is the correct mechanism on POSIX and harmless on Windows.
   */
  interrupt(): void {
    for (const cell of this.running.values()) cell.interrupted = true
    this.writeBridge({ command: 'interrupt' })
    if (this.control?.usable === true) {
      const { frames } = encodeKernelMessage(this.connectionKey, this.kernelId, {
        type: 'interrupt_request',
        content: {},
      })
      this.control.send(frames)
    }
    this.lastActivity = Date.now()
  }

  /** Answer a parked `input()` prompt. False when nothing is waiting. */
  replyInput(value: string): boolean {
    const request = this.inputRequest
    if (request === null) return false
    const socket = this.requireSocket(this.shell, 'shell')
    const { frames } = encodeKernelMessage(this.connectionKey, this.kernelId, {
      type: 'input_reply',
      content: { value },
      parentHeader: request.header as unknown as Record<string, unknown>,
    })
    socket.send(frames)
    this.inputRequest = null
    this.lastActivity = Date.now()
    return true
  }

  /** A reply-bearing helper request (`complete`, `inspect`, `is_complete`). */
  async requestReply<T>(
    type: string,
    content: Record<string, unknown>,
    extract: (message: KernelMessage) => T,
  ): Promise<T> {
    return await this.request<T>('shell', type, content, extract)
  }

  /**
   * Stop the kernel and release its directory.
   *
   * The bridge is asked to shut down first so it can end the kernel politely, then
   * the process is killed; `stopping` keeps the exit handler from reporting a
   * deliberate stop as a crash.
   */
  async stop(reason: KernelStopReason): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    this.setPhase('terminating', reason === 'user' ? {} : { message: `kernel stopped (${reason})` })
    for (const [msgId, cell] of this.running) {
      this.sink.publish({
        type: 'cell_completed',
        msgId,
        ...(cell.cellId === undefined ? {} : { cellId: cell.cellId }),
        status: 'lost',
      })
    }
    this.running.clear()
    this.rejectAllPending(new Error('the kernel was stopped'))

    const child = this.bridge
    if (child !== null && child.exitCode === null && child.signalCode === null) {
      this.writeBridge({ command: 'shutdown' })
      if (this.control?.usable === true) {
        const { frames } = encodeKernelMessage(this.connectionKey, this.kernelId, {
          type: 'shutdown_request',
          content: { restart: false },
        })
        try {
          this.control.send(frames)
        } catch {
          // A channel already down is exactly what this method is cleaning up.
        }
      }
      await waitForExit(child, 1_500)
      if (child.exitCode === null && child.signalCode === null) child.kill()
    }
    for (const socket of [this.shell, this.control, this.iopub]) socket?.destroy()
    this.shell = null
    this.control = null
    this.iopub = null
    await this.removeDirectory()
    this.setPhase('terminated')
    this.sink.ended(reason)
  }

  private setPhase(phase: KernelPhase, extra: { message?: string; specName?: string; displayName?: string } = {}): void {
    this.phaseValue = phase
    this.sink.publish({ type: 'phase', phase, ...dropUndefined(extra) })
  }

  /** Report one transient fact under the current phase, without changing it. */
  private publishPhaseMessage(text: string): void {
    this.sink.publish({ type: 'phase', phase: this.phaseValue, message: text.slice(0, 400) })
  }

  /**
   * Collect one line of kernel launch noise, bounded and deduplicated.
   *
   * ipykernel's "running over TCP without encryption" notice is true, expected on a
   * loopback-only transport, and long enough to drown a real reason — so it is
   * dropped rather than shown.
   */
  private rememberNoise(text: string): void {
    const line = text.trim()
    if (line === '') return
    if (/without encryption|transport encryption|IPKernelApp\] WARNING/iu.test(line)) return
    if (this.noise.includes(line)) return
    this.noise.push(line)
    if (this.noise.length > MAX_NOISE_LINES) this.noise.shift()
  }

  /** The kernel's own last words, used to make a failed start actionable. */
  get startFailureReason(): string {
    return this.noise.slice(-3).join(' | ')
  }

  private fail(message: string): void {
    if (this.stopping) return
    this.stopping = true
    this.phaseValue = 'failed'
    this.sink.publish({ type: 'phase', phase: 'failed', message: message.slice(0, 400) })
    for (const [msgId, cell] of this.running) {
      this.sink.publish({
        type: 'cell_completed',
        msgId,
        ...(cell.cellId === undefined ? {} : { cellId: cell.cellId }),
        status: cell.interrupted ? 'interrupted' : 'lost',
      })
    }
    this.running.clear()
    this.rejectAllPending(new Error(message))
    for (const socket of [this.shell, this.control, this.iopub]) socket?.destroy()
    this.shell = null
    this.control = null
    this.iopub = null
    const child = this.bridge
    if (child !== null && child.exitCode === null && child.signalCode === null) {
      this.writeBridge({ command: 'shutdown' })
      child.kill()
    }
    void this.removeDirectory().then(() => { this.sink.ended(message) })
  }

  private rejectAllPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private requireSocket(socket: ZmtpSocket | null, name: string): ZmtpSocket {
    if (socket === null || !socket.usable) throw new Error(`the kernel ${name} channel is not connected`)
    return socket
  }

  private writeBridge(command: Record<string, unknown>): void {
    const stdin = this.bridge?.stdin
    if (stdin === undefined || stdin === null || stdin.destroyed) return
    stdin.write(`${JSON.stringify(command)}\n`)
  }

  /**
   * Create the kernel's private connection file.
   *
   * Ephemeral ports are allocated by binding and closing listeners first, so the
   * kernel binds exactly these and the Host already knows where to connect — no log
   * parsing, no race on a randomly chosen port.
   */
  private async prepareConnectionFile(): Promise<KernelEndpoints> {
    this.directory = await mkdtemp(join(tmpdir(), 'dsh-kernel-'))
    this.connectionFile = join(this.directory, 'kernel.json')
    await mkdir(this.launch.workingDirectory, { recursive: true }).catch(() => undefined)
    this.connectionKey = randomUUID()
    const ports = await allocatePorts(5)
    await writeFile(this.connectionFile, JSON.stringify({
      shell_port: ports[0] ?? 0,
      iopub_port: ports[1] ?? 0,
      stdin_port: ports[2] ?? 0,
      control_port: ports[3] ?? 0,
      hb_port: ports[4] ?? 0,
      ip: '127.0.0.1',
      key: this.connectionKey,
      transport: 'tcp',
      signature_scheme: 'hmac-sha256',
      kernel_name: this.launch.specName,
    }), { encoding: 'utf8', mode: 0o600 })
    return {
      ip: '127.0.0.1',
      shellPort: ports[0] ?? 0,
      iopubPort: ports[1] ?? 0,
      controlPort: ports[3] ?? 0,
    }
  }

  /** `<interpreter> -I -B <bridge> <connection-file> <working-dir> <kernel command...>` */
  private bridgeCommand(): { file: string; args: string[] } {
    return bridgeInvocation(this.launch, this.connectionFile)
  }

  private async connectChannels(endpoints: KernelEndpoints): Promise<void> {
    const deadline = Date.now() + this.limits.startTimeoutMs
    const abort = AbortSignal.timeout(this.limits.startTimeoutMs)
    // A kernel that finds a port busy may reallocate and rewrite the file, so the
    // Host follows the file rather than trusting its own allocation.
    for (;;) {
      const current = await readEndpoints(this.connectionFile, endpoints)
      try {
        const remaining = Math.max(500, deadline - Date.now())
        await Promise.all([
          waitForPort(current.ip, current.shellPort, abort, remaining),
          waitForPort(current.ip, current.iopubPort, abort, remaining),
        ])
        endpoints = current
        break
      } catch {
        if (Date.now() > deadline) throw new Error('the kernel did not open its communication ports in time')
      }
    }

    const shell = new ZmtpSocket({ host: endpoints.ip, port: endpoints.shellPort, socketType: 'DEALER' })
    shell.on('message', frames => { this.receiveShell(frames) })
    shell.on('close', error => {
      if (!this.stopping) this.fail(error?.message ?? 'the kernel shell channel closed')
    })
    this.shell = shell

    const iopub = new ZmtpSocket({
      host: endpoints.ip,
      port: endpoints.iopubPort,
      socketType: 'SUB',
      subscriptions: [''],
    })
    iopub.on('message', frames => { this.receiveIopub(frames) })
    iopub.on('close', error => {
      if (!this.stopping) this.fail(error?.message ?? 'the kernel output channel closed')
    })
    this.iopub = iopub

    const control = new ZmtpSocket({ host: endpoints.ip, port: endpoints.controlPort, socketType: 'DEALER' })
    control.on('message', frames => { this.receiveControl(frames) })
    control.on('close', error => {
      if (!this.stopping) this.fail(error?.message ?? 'the kernel control channel closed')
    })
    this.control = control

    await Promise.all([settled(shell), settled(iopub), settled(control)])
  }

  private async removeDirectory(): Promise<void> {
    if (this.directory === '') return
    const directory = this.directory
    this.directory = ''
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => undefined)
  }

  /** Shell replies resolve pending requests; an `input_request` parks the run. */
  private receiveShell(frames: Buffer[]): void {
    const message = decode(this.connectionKey, frames)
    if (message === null) return
    if (message.header.msg_type === 'input_request') {
      this.inputRequest = message
      const msgId = parentMessageId(message) ?? ''
      const cell = this.running.get(msgId)
      this.sink.publish({
        type: 'input_request',
        msgId,
        ...(cell?.cellId === undefined ? {} : { cellId: cell.cellId }),
        prompt: typeof message.content['prompt'] === 'string' ? message.content['prompt'] : '',
        password: message.content['password'] === true,
      })
      return
    }
    if (message.header.msg_type === 'execute_reply') {
      this.completeRun(message)
      return
    }
    this.resolvePending(message)
  }

  private receiveControl(frames: Buffer[]): void {
    const message = decode(this.connectionKey, frames)
    if (message === null) return
    this.resolvePending(message)
  }

  private resolvePending(message: KernelMessage): void {
    if (!message.header.msg_type.endsWith('_reply')) return
    const msgId = parentMessageId(message)
    if (msgId === undefined) return
    const pending = this.pending.get(msgId)
    if (pending === undefined) return
    this.pending.delete(msgId)
    clearTimeout(pending.timer)
    pending.resolve(message)
  }

  private request<T>(
    channel: 'shell' | 'control',
    type: string,
    content: Record<string, unknown>,
    extract: (message: KernelMessage) => T,
  ): Promise<T> {
    const socket = this.requireSocket(channel === 'shell' ? this.shell : this.control, channel)
    const { frames, msgId } = encodeKernelMessage(this.connectionKey, this.kernelId, { type, content })
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(msgId)
        reject(new Error(`the kernel did not answer ${type}`))
      }, this.limits.requestTimeoutMs)
      timer.unref?.()
      this.pending.set(msgId, {
        resolve: (message: KernelMessage) => {
          try {
            resolve(extract(message))
          } catch (error: unknown) {
            reject(error instanceof Error ? error : new Error(String(error)))
          }
        },
        reject,
        timer,
      })
      socket.send(frames)
    })
  }

  /**
   * IOPub is where every visible side effect arrives.
   *
   * Frames are translated, never stored raw: a `stream` becomes a bounded text
   * item, an `error` becomes a traceback, `status` becomes a phase. Anything that
   * belongs to a run this session did not start is dropped rather than invented
   * into an event, because an unrelated message must not land on a user's cell.
   */
  private receiveIopub(frames: Buffer[]): void {
    const message = decode(this.connectionKey, frames)
    if (message === null) return
    const type = message.header.msg_type
    const content = message.content
    const msgId = parentMessageId(message) ?? ''
    const cell = msgId === '' ? undefined : this.running.get(msgId)
    const cellId = cell?.cellId
    this.lastActivity = Date.now()

    switch (type) {
      case 'status': {
        const state = content['execution_state']
        if (state === 'busy') {
          if (this.phaseValue !== 'busy') {
            this.phaseValue = 'busy'
            this.sink.publish({ type: 'phase', phase: 'busy' })
          }
        } else if (state === 'idle' && this.running.size === 0 && this.phaseValue !== 'ready') {
          this.phaseValue = 'ready'
          this.sink.publish({ type: 'phase', phase: 'ready' })
        }
        return
      }
      case 'execute_input': {
        if (cell === undefined || typeof content['execution_count'] !== 'number') return
        this.executionCount = content['execution_count']
        this.sink.publish({
          type: 'cell_started',
          msgId,
          ...(cellId === undefined ? {} : { cellId }),
          code: typeof content['code'] === 'string' ? content['code'] : '',
          executionCount: content['execution_count'],
        })
        return
      }
      case 'stream': {
        this.publishOutput(msgId, cell, {
          kind: 'stream',
          name: content['name'] === 'stderr' ? 'stderr' : 'stdout',
          text: joinTextValue(content['text']),
        })
        return
      }
      case 'execute_result': {
        this.publishOutput(msgId, cell, {
          kind: 'execute_result',
          executionCount: typeof content['execution_count'] === 'number'
            ? content['execution_count']
            : this.executionCount,
          data: bundle(content['data']),
          metadata: bundle(content['metadata']),
        })
        return
      }
      case 'display_data': {
        this.publishOutput(msgId, cell, {
          kind: 'display_data',
          data: bundle(content['data']),
          metadata: bundle(content['metadata']),
        })
        return
      }
      case 'update_display_data': {
        this.publishOutput(msgId, cell, {
          kind: 'update_display_data',
          data: bundle(content['data']),
          metadata: bundle(content['metadata']),
        })
        return
      }
      case 'error': {
        this.publishOutput(msgId, cell, {
          kind: 'error',
          ename: typeof content['ename'] === 'string' ? content['ename'] : 'Error',
          evalue: typeof content['evalue'] === 'string' ? content['evalue'] : '',
          traceback: Array.isArray(content['traceback'])
            ? content['traceback'].map(entry => (typeof entry === 'string' ? entry : String(entry)))
            : [],
        })
        return
      }
      case 'clear_output': {
        this.sink.publish({
          type: 'cell_cleared',
          msgId,
          ...(cellId === undefined ? {} : { cellId }),
          stdout: content['stdout'] === true,
          stderr: content['stderr'] === true,
          outputs: content['outputs'] !== false,
        })
        return
      }
      case 'comm_info_reply':
      case 'comm_open':
      case 'comm_msg':
      case 'comm_close':
      case 'iopub_welcome':
      case 'debug_event':
      case 'kernel_info_reply':
      default:
        // ipywidgets comms, debugger events, and the XPUB subscription echo carry
        // nothing a notebook cell displays; forwarding them would only crowd the
        // replay buffer a stream resumes from.
        return
    }
  }

  private publishOutput(msgId: string, cell: RunningCell | undefined, item: NotebookOutputItem): void {
    const length = outputLength(item)
    const truncated = length > KERNEL_MAX_CHUNK_CHARS
    const bounded = truncated ? truncateOutput(item, KERNEL_MAX_CHUNK_CHARS) : item
    let emit = bounded
    if (cell !== undefined) {
      cell.outputs += 1
      if (!cell.capped) {
        cell.chars += Math.min(length, KERNEL_MAX_CHUNK_CHARS)
        if (cell.chars > KERNEL_MAX_RUN_CHARS || cell.outputs > MAX_RUN_FRAMES) {
          cell.capped = true
          emit = {
            kind: 'stream',
            name: 'stderr',
            text: 'output exceeded the workbench limit; further output from this run was dropped\n',
          }
        }
      } else {
        // Once capped, drop quietly: one notice per run is the useful signal.
        return
      }
    }
    this.sink.publish({
      type: 'cell_output',
      msgId,
      ...(cell?.cellId === undefined ? {} : { cellId: cell.cellId }),
      item: emit,
      truncated,
    })
  }

  /** Close one run when its `execute_reply` lands. */
  private completeRun(message: KernelMessage): void {
    const msgId = parentMessageId(message)
    if (msgId === undefined) return
    const cell = this.running.get(msgId)
    if (cell === undefined) return
    this.running.delete(msgId)
    const status = message.content['status']
    const result: NotebookRunStatus = cell.interrupted && status !== 'ok'
      ? 'interrupted'
      : status === 'ok'
        ? 'ok'
        : status === 'aborted'
          ? 'aborted'
          : 'error'
    const executionCount = typeof message.content['execution_count'] === 'number'
      ? message.content['execution_count']
      : undefined
    if (executionCount !== undefined) this.executionCount = executionCount
    this.sink.publish({
      type: 'cell_completed',
      msgId,
      ...(cell.cellId === undefined ? {} : { cellId: cell.cellId }),
      status: result,
      ...(executionCount === undefined ? {} : { executionCount }),
    })
    if (this.running.size === 0 && this.phaseValue === 'busy') {
      this.phaseValue = 'ready'
      this.sink.publish({ type: 'phase', phase: 'ready' })
    }
    this.lastActivity = Date.now()
  }
}

/** Where a kernel's channels answered; ports the Host reads back from the file. */
interface KernelEndpoints {
  ip: string
  shellPort: number
  iopubPort: number
  controlPort: number
}

/** Parent request id a message is answering, when it answers one. */
function parentMessageId(message: KernelMessage): string | undefined {
  const value = message.parentHeader['msg_id']
  return typeof value === 'string' && value !== '' ? value : undefined
}

function decode(key: string, frames: Buffer[]): KernelMessage | null {
  try {
    return decodeKernelMessage(key, frames)
  } catch {
    // A frame that fails its signature is not from this kernel: dropping it is the
    // safe reading of "unauthenticated", and the count is not worth a log line.
    return null
  }
}

function bundle(value: unknown): NotebookMimeBundle {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as NotebookMimeBundle
    : {}
}

function joinTextValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(entry => (typeof entry === 'string' ? entry : String(entry))).join('')
  return ''
}

function outputLength(item: NotebookOutputItem): number {
  switch (item.kind) {
    case 'stream':
      return item.text.length
    case 'error':
      return item.evalue.length + item.traceback.reduce((total, line) => total + line.length, 0)
    default:
      return JSON.stringify(item.data).length
  }
}

/** Cut an oversized output at the limit, saying so inside the item. */
export function truncateOutput(item: NotebookOutputItem, limit: number): NotebookOutputItem {
  switch (item.kind) {
    case 'stream':
      return {
        ...item,
        text: `${item.text.slice(0, limit)}\n… ${item.text.length - limit} characters dropped …\n`,
      }
    case 'error':
      return { ...item, traceback: item.traceback.map(line => (line.length > limit ? `${line.slice(0, limit)} …` : line)) }
    default: {
      // A MIME bundle is cut by keeping the cheapest parts that still render; the
      // `text/plain` fallback is always kept so a truncated output is never blank.
      const data: NotebookMimeBundle = {}
      let budget = limit
      const plain = item.data['text/plain']
      if (plain !== undefined) {
        data['text/plain'] = plain
        budget -= String(plain).length
      }
      for (const [key, value] of Object.entries(item.data)) {
        if (key === 'text/plain') continue
        const size = JSON.stringify(value).length
        if (size > budget) continue
        data[key] = value
        budget -= size
      }
      return item.kind === 'execute_result'
        ? { ...item, data }
        : { kind: item.kind, data, metadata: item.metadata }
    }
  }
}

function kernelDescriptionFrom(content: Record<string, unknown>): KernelDescription {
  const features = Array.isArray(content['supported_features']) ? content['supported_features'] : []
  return {
    implementation: typeof content['implementation'] === 'string' ? content['implementation'] : 'unknown',
    implementationVersion: typeof content['implementation_version'] === 'string'
      ? content['implementation_version']
      : '',
    protocolVersion: typeof content['protocol_version'] === 'string' ? content['protocol_version'] : '',
    language: kernelLanguageFromInfo(content),
    ...(typeof content['banner'] === 'string' ? { banner: content['banner'] } : {}),
    debugger: content['debugger'] === true || features.includes('debugger'),
  }
}

/** Environment for the bridge: the same hardening the Git runner applies. */
function kernelEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // A kernel that needs a credential must not open a prompt and hang the run.
    GIT_TERMINAL_PROMPT: '0',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUNBUFFERED: '1',
  }
}

/**
 * The kernel command the bridge runs.
 *
 * A kernelspec argv normally begins with an interpreter and continues with
 * `-m ipykernel_launcher -f {connection_file}`. The Host drops the spec's own leading
 * interpreter, prepends the one it verified, and re-points the connection file at its
 * own path — so a spec copied from another machine still starts here.
 *
 * A spec whose remaining arguments never name the launcher module (a wrapper script, a
 * bare program) carries nothing this Host can honour, so it falls back to the canonical
 * command. Appending `-m ipykernel_launcher` to an unrelated argv would hand the kernel
 * a stray positional argument and fail in a way no reader could diagnose.
 */
export function kernelCommandForPlan(launch: KernelLaunchPlan, connectionFile: string): string[] {
  const canonical = [launch.interpreterPath, '-m', 'ipykernel_launcher', '-f', connectionFile]
  const spec = launch.kernelArgv.map(entry => entry.replace(/\{connection_file\}/gu, connectionFile))
  const body = dropLeadingInterpreter(spec)
  if (body.length === 0) return canonical
  if (!body.some(entry => entry.includes('ipykernel'))) return canonical
  // The connection file is the one argument this function must guarantee: without it
  // the kernel binds a random port and the Host can never find it.
  const mentionsFile = body.includes(connectionFile)
    || body.includes('-f')
    || body.some(entry => entry.startsWith('-f='))
  return mentionsFile
    ? [launch.interpreterPath, ...body]
    : [launch.interpreterPath, ...body, '-f', connectionFile]
}

/**
 * The bridge invocation that owns a kernel.
 *
 * The notebook's directory is passed as its own argument rather than left to be
 * inferred: the connection file this Host writes lives in a private temporary
 * directory, so a bridge that took its working directory from the file would start
 * the kernel somewhere the notebook's relative paths do not resolve — a cell failing
 * over `open("data.csv")` with no visible reason.
 */
export function bridgeInvocation(
  launch: KernelLaunchPlan,
  connectionFile: string,
): { file: string; args: string[] } {
  return {
    file: launch.bridgeInterpreter,
    args: [
      // `-I` isolates the bridge from the user's environment, which must not be able
      // to break the stdlib-only launcher it runs; the kernel itself is launched by
      // the bridge with the full environment.
      '-I',
      '-B',
      launch.bridgeScript,
      connectionFile,
      launch.workingDirectory,
      ...kernelCommandForPlan(launch, connectionFile),
    ],
  }
}

/** Remove argv[0] only when it really is an interpreter path. */
function dropLeadingInterpreter(argv: readonly string[]): string[] {
  const head = argv[0]
  if (head === undefined || argv.length === 1) return [...argv]
  return /(?:^|[/\\])(?:python(?:3(?:\.\d+)?)?|pythonw(?:3(?:\.\d+)?)?)(?:\.exe)?$/iu.test(head)
    ? argv.slice(1)
    : [...argv]
}

/** One bridge protocol line, if it is one. */
export function parseBridgeLine(line: string): { kind: string; text?: string } | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const value = JSON.parse(trimmed) as Record<string, unknown>
    if (typeof value['event'] !== 'string') return null
    return { kind: value['event'], ...(typeof value['text'] === 'string' ? { text: value['text'] } : {}) }
  } catch {
    return null
  }
}

/** Forward the bridge's kernel-noise lines; the exit protocol is handled by Node. */
async function forwardBridgeLines(
  child: ReturnType<typeof spawn>,
  onNoise: (kind: string, text: string) => void,
): Promise<void> {
  for (const stream of [child.stdout, child.stderr]) {
    if (stream === null) continue
    stream.setEncoding('utf8')
    let pending = ''
    stream.on('data', (chunk: string) => {
      pending += chunk
      for (;;) {
        const index = pending.indexOf('\n')
        if (index < 0) break
        const line = pending.slice(0, index)
        pending = pending.slice(index + 1)
        const event = parseBridgeLine(line)
        if (event === null) {
          if (line !== '') onNoise('kernel-stderr', line.slice(0, 400))
          continue
        }
        if (event.kind === 'kernel-stderr' || event.kind === 'kernel-stdout' || event.kind === 'warning') {
          onNoise(event.kind, event.text ?? '')
        }
      }
    })
  }
}

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => { resolve() }, timeoutMs)
    timer.unref?.()
    child.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/** Resolve once a socket is past its handshake, or has failed. */
function settled(socket: ZmtpSocket): Promise<void> {
  return new Promise<void>(resolve => {
    if (socket.usable) {
      resolve()
      return
    }
    socket.once('ready', resolve)
    socket.once('close', resolve)
  })
}

/** Bind and close ephemeral listeners to obtain ports no one else holds. */
async function allocatePorts(count: number): Promise<number[]> {
  const listeners = Array.from({ length: count }, () => net.createServer())
  const ports = await Promise.all(listeners.map(listener => new Promise<number>((resolve, reject) => {
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address()
      resolve(typeof address === 'object' && address !== null ? address.port : 0)
    })
  })))
  await Promise.all(listeners.map(listener => new Promise<void>(resolve => {
    listener.close(() => { resolve() })
  })))
  return ports
}

/**
 * Ports to connect to, following a kernel that rewrote its connection file.
 *
 * ipykernel keeps the ports it was given, but a kernel that finds one busy
 * reallocates and writes the file again, so the file — not the allocation — is the
 * authority once the kernel is up.
 */
async function readEndpoints(
  connectionFile: string,
  fallback: KernelEndpoints,
): Promise<KernelEndpoints> {
  try {
    const value = JSON.parse(await readFile(connectionFile, 'utf8')) as Record<string, unknown>
    const port = (key: string, current: number): number => typeof value[key] === 'number' && value[key] as number > 0
      ? value[key] as number
      : current
    const ip = typeof value['ip'] === 'string' && value['ip'] !== '*' && value['ip'] !== '0.0.0.0'
      ? value['ip']
      : fallback.ip
    return {
      ip,
      shellPort: port('shell_port', fallback.shellPort),
      iopubPort: port('iopub_port', fallback.iopubPort),
      controlPort: port('control_port', fallback.controlPort),
    }
  } catch {
    return fallback
  }
}

function dropUndefined(value: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) result[key] = entry
  }
  return result
}
