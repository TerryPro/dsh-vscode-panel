/**
 * Notebook kernel vocabulary shared by the workbench Host and browser halves.
 *
 * The Host owns the Jupyter wire protocol — ZeroMQ framing, HMAC signatures, the
 * five channels, and `execute_request` bookkeeping — and translates it into the
 * small, notebook-shaped event union below. The browser half never learns ports,
 * keys, or channel names: it asks for a kernel, runs code, and renders the events
 * that come back, which keeps the whole feature inside the same-origin JSON API
 * the workbench already uses for files and Git.
 */

import { WORKBENCH_API_PREFIX } from './contracts.ts'
import { route, type RouteTable } from './route.ts'

/** Prefix every kernel POST is dispatched under, beside the file and Git arms. */
export const KERNEL_POST_PREFIX = `${WORKBENCH_API_PREFIX}/kernel`

/**
 * Exact GET path the browser opens as an `EventSource` for one kernel's events.
 *
 * Registered as its own route because the JSON prefix only answers POSTs. A stream
 * is scoped by the `kernelId` and `token` query parameters and resumes from
 * `since`, so a reconnect cannot lose output frames.
 */
export const KERNEL_STREAM_PATH = `${KERNEL_POST_PREFIX}/stream`

/** Lifecycle a kernel reports to the browser. */
export type KernelPhase =
  | 'absent'
  | 'starting'
  | 'ready'
  | 'busy'
  | 'idle'
  | 'terminating'
  | 'terminated'
  | 'failed'

/** Language facts from `kernel_info_reply`, enough to label and highlight a cell. */
export interface KernelLanguage {
  name: string
  version: string
  /** File extension including the dot, when the kernel reports one. */
  fileExtension?: string
  /** CodeMirror mode name the kernel suggests, when it differs from `name`. */
  codemirrorMode?: string
}

/** Everything `kernel_info_reply` offers that the workbench shows or keys on. */
export interface KernelDescription {
  implementation: string
  implementationVersion: string
  protocolVersion: string
  language: KernelLanguage
  banner?: string
  /** Whether the kernel advertises the `debugger` supported feature. */
  debugger: boolean
}

/** Where a discovered kernel came from, for the picker's secondary line. */
export type KernelChoiceSource = 'venv' | 'system' | 'kernelspec' | 'conda' | 'uv'

/** One selectable kernel in the picker. */
export interface KernelChoice {
  /** Jupyter kernel name (`python3`, or a kernelspec directory name). */
  name: string
  displayName: string
  language: string
  /** Interpreter the Host launches, when one was resolved. */
  interpreterPath?: string
  /** Kernel-specific argv from a `kernel.json`, when one was read. */
  argv?: string[]
  /** True when the Host verified the kernel can actually be started here. */
  available: boolean
  /** Short reason a kernel is listed but not startable. */
  reason?: string
  source: KernelChoiceSource
  /** Workspace-relative path of the environment, `''` for a machine-wide one. */
  environmentPath?: string
}

/** A Python environment the Host found for one Workspace. */
export interface KernelEnvironment {
  /** Workspace-relative environment directory, or `''` for the system install. */
  path: string
  interpreterPath: string
  pythonVersion: string
  /** Whether `ipykernel` imports in this environment. */
  ipykernel: boolean
  ipykernelVersion?: string
  kind: 'venv' | 'conda' | 'system' | 'uv'
}

export interface KernelDiscoverResult {
  /** True when at least one startable kernel exists. */
  usable: boolean
  kernels: KernelChoice[]
  environments: KernelEnvironment[]
  /** Why nothing is usable, phrased as an instruction rather than a stack. */
  message?: string
}

/** A MIME bundle as Jupyter sends it: mostly strings, some structured payloads. */
export type NotebookMimeBundle = Record<string, string | number | boolean | unknown[] | Record<string, unknown>>

/** One cell output, in the shape an `.ipynb` cell stores it. */
export type NotebookOutputItem =
  | { kind: 'stream'; name: 'stdout' | 'stderr'; text: string }
  | { kind: 'execute_result'; executionCount: number; data: NotebookMimeBundle; metadata: NotebookMimeBundle }
  | { kind: 'display_data'; data: NotebookMimeBundle; metadata: NotebookMimeBundle }
  | { kind: 'update_display_data'; data: NotebookMimeBundle; metadata: NotebookMimeBundle }
  | { kind: 'error'; ename: string; evalue: string; traceback: string[] }

/** Terminal state of one finished cell run. */
export type NotebookRunStatus = 'ok' | 'error' | 'aborted' | 'interrupted' | 'lost'

/**
 * One ordered kernel event.
 *
 * `sequence` is assigned by the Host and is monotonic per kernel, so the browser
 * can resume a dropped stream and tell whether an event belongs to the run it is
 * still showing.
 */
export type NotebookKernelEvent =
  | { type: 'phase'; phase: KernelPhase; message?: string; specName?: string; displayName?: string }
  | { type: 'info'; info: KernelDescription }
  | { type: 'cell_started'; msgId: string; cellId?: string; code: string; executionCount: number }
  | { type: 'cell_output'; msgId: string; cellId?: string; item: NotebookOutputItem; truncated: boolean }
  | { type: 'cell_cleared'; msgId: string; cellId?: string; stdout: boolean; stderr: boolean; outputs: boolean }
  | { type: 'cell_completed'; msgId: string; cellId?: string; status: NotebookRunStatus; executionCount?: number }
  | { type: 'input_request'; msgId: string; cellId?: string; prompt: string; password: boolean }
  | { type: 'progress'; msgId: string; cellId?: string; value: number; description: string }

/**
 * One published event carrying its per-kernel sequence number.
 *
 * A type alias rather than an interface, because the event vocabulary is a union
 * and an interface cannot extend one.
 */
export type NotebookKernelFrame = NotebookKernelEvent & { sequence: number }

/** Response to the poll fallback, for environments where SSE cannot be opened. */
export interface NotebookKernelPollResult {
  frames: NotebookKernelFrame[]
  nextSequence: number
  phase: KernelPhase
  executionCount: number
  /** True when `since` was older than the Host's buffer and output was resynced. */
  resynced: boolean
}

/** What one `execute` POST returns: the id the browser correlates events with. */
export interface KernelExecuteResult {
  msgId: string
  executionCount: number
  phase: KernelPhase
}

export interface KernelStartResult {
  kernelId: string
  token: string
  displayName: string
  specName: string
  language: string
  phase: KernelPhase
  sequence: number
}

/** Live per-kernel facts, so a tab's header can report the truth. */
export interface KernelStatusResult {
  kernelId: string
  phase: KernelPhase
  executionCount: number
  sequence: number
  /** Open SSE streams currently attached to this kernel. */
  attached: number
  displayName: string
  specName: string
  message?: string
}

/** Handshake the browser receives before the frames start. */
export interface KernelStreamSnapshot {
  kernelId: string
  phase: KernelPhase
  executionCount: number
  sequence: number
  displayName: string
  specName: string
  /** Oldest sequence still replayable from the Host buffer. */
  oldestSequence: number
  language?: KernelLanguage
}

/** Reply to a kernel's `input_request` (an `input()` call in a cell). */
export interface KernelInputResult {
  accepted: boolean
}

/**
 * One kernel the Host is currently running, as the manager panel sees it.
 *
 * Note what is *absent*: the per-kernel token. The panel is a workspace-wide view,
 * and handing out every token would turn a read-only list into a skeleton key that
 * can execute in, or interrupt, any notebook on this machine — precisely what the
 * token exists to prevent. So the panel can see everything and touch only what no
 * notebook can reach any more.
 */
export interface KernelListing {
  kernelId: string
  /** Workspace-relative notebook path this kernel belongs to. */
  path: string
  displayName: string
  specName: string
  /** Language from `kernel_info_reply`, `''` before the kernel has answered. */
  language: string
  phase: KernelPhase
  /** Whether a cell is still running or parked on `input()`. */
  busy: boolean
  executionCount: number
  /** Open event streams attached right now; zero means no page is watching. */
  attached: number
  /** Wall clock of the last moment a page watched it or it produced output. */
  lastEngagedAt: number
  /** Operating-system process id, or `null` if the process never came up. */
  pid: number | null
  /**
   * True when no notebook can reach this kernel any more, so the panel may reclaim
   * it. The Host owns this judgement; the panel only renders it.
   */
  orphan: boolean
  /** Whether the Host would currently accept a reclaim for this kernel. */
  reclaimable: boolean
}

/** The whole kernel picture: every live kernel plus the ceilings that bound them. */
export interface KernelListResult {
  kernels: KernelListing[]
  /** Kernels this Workspace may run at once. */
  maxKernelsPerWorkspace: number
  /** Kernels this DSH process may run at once, across every Workspace. */
  maxKernelsTotal: number
  /** Live kernels in the whole process, which is what the total ceiling counts. */
  totalKernels: number
}

/** Completion, introspection, and code-completeness helpers for cell editing. */
export interface KernelCompletionResult {
  matches: string[]
  cursorStart: number
  cursorEnd: number
}

export interface KernelInspectResult {
  found: boolean
  text: string
}

export interface KernelIsCompleteResult {
  status: 'complete' | 'incomplete' | 'invalid' | 'unknown'
  indent?: string
}

/** Largest single text chunk the Host forwards per output frame. */
export const KERNEL_MAX_CHUNK_CHARS = 128 * 1024

/** Total output characters the Host keeps buffering for one cell run. */
export const KERNEL_MAX_RUN_CHARS = 4 * 1024 * 1024

/** Number of frames the Host retains per kernel for a stream resume. */
export const KERNEL_FRAME_BUFFER = 2048

/** Build the SSE URL for one kernel, with its resume position. */
export function kernelStreamUrl(kernelId: string, token: string, since: number): string {
  const parameters = new URLSearchParams({ kernelId, token, since: String(since) })
  return `${KERNEL_STREAM_PATH}?${parameters.toString()}`
}

/** Kernel metadata a notebook file should carry for the session in use. */
export interface NotebookKernelMetadata {
  name: string
  displayName: string
  language: string
}

/**
 * 内核对 token 的那几条路由共用的请求前导。
 *
 * 回环来源栅栏只能证明请求来自本机浏览器，不能证明来自*这个*页面，所以 id 与 token 一起
 * 才是「允许动这个内核」的凭据。`discover` 与 `list` 没有它，它们问的是工作区有什么。
 */
export type KernelSessionRequest = { kernelId: string; token: string; workspaceId: string }

/**
 * 内核那一组路由的声明。
 *
 * 事件流（`KERNEL_STREAM_PATH`）不在这里：它是一条 GET 长连接，不是一次请求-响应，
 * 所以没有可查的回值形状。`poll` 声明在这，但它的 GET 臂由宿主的注册路由单独处理。
 */
export const KERNEL_ROUTES = {
  kernelDiscover: route<{ workspaceId: string }, KernelDiscoverResult>(`${KERNEL_POST_PREFIX}/discover`),
  kernelList: route<{ workspaceId: string }, KernelListResult>(`${KERNEL_POST_PREFIX}/list`),
  kernelReclaim: route<{ kernelId: string; workspaceId: string }, KernelStatusResult>(`${KERNEL_POST_PREFIX}/reclaim`),
  kernelStart: route<{ workspaceId: string; path: string; specName?: string }, KernelStartResult>(
    `${KERNEL_POST_PREFIX}/start`,
  ),
  kernelStatus: route<KernelSessionRequest, KernelStatusResult>(`${KERNEL_POST_PREFIX}/status`),
  kernelExecute: route<
    { kernelId: string; token: string; workspaceId: string; code: string; cellId?: string; silent?: boolean },
    KernelExecuteResult
  >(`${KERNEL_POST_PREFIX}/execute`),
  kernelInterrupt: route<KernelSessionRequest, KernelStatusResult>(`${KERNEL_POST_PREFIX}/interrupt`),
  kernelInput: route<{ kernelId: string; token: string; workspaceId: string; value: string }, KernelInputResult>(
    `${KERNEL_POST_PREFIX}/input`,
  ),
  kernelComplete: route<{ kernelId: string; token: string; workspaceId: string; code: string; cursorPos: number }, KernelCompletionResult>(
    `${KERNEL_POST_PREFIX}/complete`,
  ),
  kernelInspect: route<{ kernelId: string; token: string; workspaceId: string; code: string; cursorPos: number }, KernelInspectResult>(
    `${KERNEL_POST_PREFIX}/inspect`,
  ),
  kernelIsComplete: route<{ kernelId: string; token: string; workspaceId: string; code: string }, KernelIsCompleteResult>(
    `${KERNEL_POST_PREFIX}/is-complete`,
  ),
  kernelPoll: route<{ kernelId: string; token: string; workspaceId: string; since: number }, NotebookKernelPollResult>(
    `${KERNEL_POST_PREFIX}/poll`,
  ),
  kernelRestart: route<{ kernelId: string; token: string; workspaceId: string; path: string }, KernelStartResult>(
    `${KERNEL_POST_PREFIX}/restart`,
  ),
  kernelShutdown: route<KernelSessionRequest, KernelStatusResult>(`${KERNEL_POST_PREFIX}/shutdown`),
} satisfies RouteTable
