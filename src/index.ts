/** Host half: trusted-origin workspace API backed by DSH filesystem and Session services. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-workspace'
import { MERMAID_RUNTIME_PATH, WORKBENCH_API_PREFIX } from './shared/contracts.ts'
import { KERNEL_POST_PREFIX, KERNEL_STREAM_PATH } from './shared/notebook-protocol.ts'
import { GitBackend } from './host/git-backend.ts'
import { errorResponse, readJsonObject, sendJson, WorkbenchHttpError } from './host/http.ts'
import { KernelBackend } from './host/kernel-backend.ts'
import { serveMermaidRuntime } from './host/mermaid-runtime.ts'
import { isTrustedWorkbenchRequest } from './host/request-trust.ts'
import { WorkspaceBackend } from './host/workspace-backend.ts'

export const name = 'workbench-layout'
export const inject = ['webServer', 'fs', 'workspaceRegistry', 'webRuntime']

interface WebRuntimeValues {
  trustedHosts: string[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    webRuntime: WebRuntimeValues
  }
}

export interface Config {
  maxFileBytes: number
  maxDirectoryEntries: number
  gitTimeoutMs: number
  gitMaxOutputBytes: number
  kernelStartTimeoutMs: number
  kernelRequestTimeoutMs: number
  kernelMaxPerWorkspace: number
  kernelMaxTotal: number
  kernelUnattendedTimeoutMs: number
}

export const Config: z<Config> = z.object({
  maxFileBytes: z.natural().min(1024).max(16 * 1024 * 1024).default(2 * 1024 * 1024),
  maxDirectoryEntries: z.natural().min(10).max(5000).default(1000),
  gitTimeoutMs: z.natural().min(1000).max(120_000).default(30_000),
  gitMaxOutputBytes: z.natural().min(64 * 1024).max(32 * 1024 * 1024).default(4 * 1024 * 1024),
  // A cold Python kernel with a fat import graph takes seconds, not milliseconds.
  kernelStartTimeoutMs: z.natural().min(5_000).max(180_000).default(60_000),
  kernelRequestTimeoutMs: z.natural().min(1_000).max(60_000).default(15_000),
  // Kernel count is the one resource this feature cannot grow without limit, so
  // both a per-Workspace and a whole-process ceiling are enforced.
  kernelMaxPerWorkspace: z.natural().min(1).max(8).default(3),
  kernelMaxTotal: z.natural().min(1).max(16).default(8),
  // A kernel nobody is watching for this long is stopped, the same policy the
  // host's own terminals use for an unattended process.
  kernelUnattendedTimeoutMs: z.natural().min(60_000).max(24 * 3_600_000).default(15 * 60_000),
})

/** Register the workbench's isolated JSON endpoint. */
export function apply(ctx: Context, config: Config): void {
  const workspace = new WorkspaceBackend(ctx, config)
  const git = new GitBackend(ctx, workspace, {
    timeoutMs: config.gitTimeoutMs,
    maxOutputBytes: config.gitMaxOutputBytes,
  })
  const kernel = new KernelBackend(ctx, workspace, {
    startTimeoutMs: config.kernelStartTimeoutMs,
    requestTimeoutMs: config.kernelRequestTimeoutMs,
    maxKernelsPerWorkspace: config.kernelMaxPerWorkspace,
    maxKernelsTotal: config.kernelMaxTotal,
    unattendedTimeoutMs: config.kernelUnattendedTimeoutMs,
    reaperIntervalMs: 30_000,
    heartbeatMs: 15_000,
  })
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (req.method !== 'POST') throw new WorkbenchHttpError(405, 'METHOD_NOT_ALLOWED', '只允许 POST 请求。')
      if (!isTrustedWorkbenchRequest(req.headers, ctx.webRuntime.trustedHosts)) {
        throw new WorkbenchHttpError(403, 'ORIGIN_REJECTED', '请求来源无效。')
      }
      const body = await readJsonObject(req, config.maxFileBytes + 64 * 1024)
      const path = new URL(req.url ?? '/', 'http://dsh.invalid').pathname
      const value = await dispatch(path, body, workspace, git)
      sendJson(res, 200, value)
    } catch (error: unknown) {
      const response = errorResponse(error)
      if (response.status >= 500 || response.body.error.code === 'WORKBENCH_OPERATION_FAILED') {
        ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
      }
      sendJson(res, response.status, response.body)
    }
  }
  /**
   * The kernel API's own prefix.
   *
   * Registered separately from the file/Git prefix because it has one GET arm
   * (`poll`): a notebook view that cannot hold a stream open must still be able to
   * read output with the same plain request the rest of the workbench uses. Keeping
   * it on a longer prefix means the existing POST-only contract for files and Git is
   * untouched.
   */
  const kernelHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const path = new URL(req.url ?? '/', 'http://dsh.invalid').pathname
      const poll = path === `${KERNEL_POST_PREFIX}/poll` && req.method === 'GET'
      if (!poll && req.method !== 'POST') {
        throw new WorkbenchHttpError(405, 'METHOD_NOT_ALLOWED', '内核接口只允许 POST 请求。')
      }
      if (!isTrustedWorkbenchRequest(req.headers, ctx.webRuntime.trustedHosts)) {
        throw new WorkbenchHttpError(403, 'ORIGIN_REJECTED', '请求来源无效。')
      }
      const body = poll
        ? Object.fromEntries(new URL(req.url ?? '/', 'http://dsh.invalid').searchParams)
        : await readJsonObject(req, config.maxFileBytes + 64 * 1024)
      const value = await dispatchKernel(path, body, kernel)
      sendJson(res, 200, value)
    } catch (error: unknown) {
      const response = errorResponse(error)
      if (response.status >= 500) {
        ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
      }
      sendJson(res, response.status, response.body)
    }
  }
  /** One kernel's live event stream, held open until either side goes away. */
  const streamHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (req.method !== 'GET') throw new WorkbenchHttpError(405, 'METHOD_NOT_ALLOWED', '内核事件流只允许 GET 请求。')
      if (!isTrustedWorkbenchRequest(req.headers, ctx.webRuntime.trustedHosts)) {
        throw new WorkbenchHttpError(403, 'ORIGIN_REJECTED', '请求来源无效。')
      }
      await kernel.stream(req, res)
    } catch (error: unknown) {
      // The stream either has not written headers yet, or is already broken; in both
      // cases a JSON error is the honest answer and never corrupts an open stream.
      if (res.headersSent) {
        res.end()
        return
      }
      const response = errorResponse(error)
      sendJson(res, response.status, response.body)
    }
  }
  ctx.effect(
    () => {
      const routes = [
        ctx.webServer.register({ kind: 'prefix', path: WORKBENCH_API_PREFIX, handler }),
        ctx.webServer.register({ kind: 'prefix', path: KERNEL_POST_PREFIX, handler: kernelHandler }),
        ctx.webServer.register({ kind: 'exact', path: KERNEL_STREAM_PATH, handler: streamHandler }),
      ]
      return () => { for (const dispose of routes) dispose() }
    },
    'workbench-layout: workspace, Git, and kernel routes',
  )
  // The bundled Mermaid runtime, served on an exact GET route the router matches
  // before the POST-only prefix above. The path is resolved relative to this
  // bundled file (lib/index.js), beside which the build emits lib/mermaid-runtime.js.
  const mermaidRuntimePath = fileURLToPath(new URL('./mermaid-runtime.js', import.meta.url))
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: MERMAID_RUNTIME_PATH,
      handler: (req: IncomingMessage, res: ServerResponse) => serveMermaidRuntime(req, res, mermaidRuntimePath),
    }),
    'workbench-layout: mermaid runtime route',
  )
  ctx.effect(() => () => { void kernel.dispose() }, 'workbench-layout: kernel shutdown on dispose')
  ctx.logger.info('workbench-layout: public-package workspace, Git, and kernel APIs registered')
}

async function dispatch(
  path: string,
  body: Record<string, unknown>,
  workspace: WorkspaceBackend,
  git: GitBackend,
): Promise<unknown> {
  switch (path) {
    case `${WORKBENCH_API_PREFIX}/tree`:
      return workspace.list(body.workspaceId, body.path)
    case `${WORKBENCH_API_PREFIX}/file/read`:
      return workspace.read(body.workspaceId, body.path)
    case `${WORKBENCH_API_PREFIX}/file/image`:
      return workspace.readImage(body.workspaceId, body.path)
    case `${WORKBENCH_API_PREFIX}/files/refresh`:
      return workspace.refreshFiles(body.workspaceId, body.files)
    case `${WORKBENCH_API_PREFIX}/file/save`:
      return workspace.save(body.workspaceId, body.path, body.content, body.version)
    case `${WORKBENCH_API_PREFIX}/file/create`:
      return workspace.createFile(body.workspaceId, body.path)
    case `${WORKBENCH_API_PREFIX}/directory/create`:
      return workspace.createDirectory(body.workspaceId, body.path)
    case `${WORKBENCH_API_PREFIX}/entry/rename`:
      return workspace.renameEntry(body.workspaceId, body.path, body.name)
    case `${WORKBENCH_API_PREFIX}/entry/delete`:
      return workspace.deleteEntry(body.workspaceId, body.path)
    case `${WORKBENCH_API_PREFIX}/path/absolute`:
      return workspace.absolutePath(body.workspaceId, body.path)
    case `${WORKBENCH_API_PREFIX}/path/relative`:
      return workspace.relativePath(body.workspaceId, body.path)
    case `${WORKBENCH_API_PREFIX}/git/status`:
      return git.status(body.workspaceId)
    case `${WORKBENCH_API_PREFIX}/git/diff`:
      return git.diff(body.workspaceId, body.path, body.staged)
    case `${WORKBENCH_API_PREFIX}/git/editor-baseline`:
      return git.editorBaseline(body.workspaceId, body.path)
    case `${WORKBENCH_API_PREFIX}/git/graph`:
      return git.graph(body.workspaceId, body.offset)
    case `${WORKBENCH_API_PREFIX}/git/branches`:
      return git.branches(body.workspaceId)
    case `${WORKBENCH_API_PREFIX}/git/branch/switch`:
      return git.switchBranch(body.workspaceId, body.ref)
    case `${WORKBENCH_API_PREFIX}/git/branch/create`:
      return git.createBranch(body.workspaceId, body.name, body.source)
    case `${WORKBENCH_API_PREFIX}/git/branch/rename`:
      return git.renameBranch(body.workspaceId, body.name)
    case `${WORKBENCH_API_PREFIX}/git/branch/delete`:
      return git.deleteBranch(body.workspaceId, body.ref)
    case `${WORKBENCH_API_PREFIX}/git/remote`:
      return git.remoteOperation(body.workspaceId, body.operation)
    case `${WORKBENCH_API_PREFIX}/git/remotes`:
      return git.remotes(body.workspaceId)
    case `${WORKBENCH_API_PREFIX}/git/remote/add`:
      return git.addRemote(body.workspaceId, body.name, body.fetchUrl, body.pushUrl)
    case `${WORKBENCH_API_PREFIX}/git/remote/update`:
      return git.updateRemote(body.workspaceId, body.currentName, body.name, body.fetchUrl, body.pushUrl)
    case `${WORKBENCH_API_PREFIX}/git/remote/delete`:
      return git.deleteRemote(body.workspaceId, body.name)
    case `${WORKBENCH_API_PREFIX}/git/remote/target`:
      return git.targetRemoteOperation(body.workspaceId, body.operation, body.remote, body.branch)
    case `${WORKBENCH_API_PREFIX}/git/commit/files`:
      return git.commitFiles(body.workspaceId, body.revision)
    case `${WORKBENCH_API_PREFIX}/git/commit/file`:
      return git.commitFileDiff(body.workspaceId, body.revision, body.path)
    case `${WORKBENCH_API_PREFIX}/git/comparison/files`:
      return git.comparisonFiles(body.workspaceId, body.revision)
    case `${WORKBENCH_API_PREFIX}/git/comparison/file`:
      return git.comparisonFileDiff(body.workspaceId, body.revision, body.path)
    case `${WORKBENCH_API_PREFIX}/git/commit/action`:
      return git.commitAction(body.workspaceId, body.operation, body.revision)
    case `${WORKBENCH_API_PREFIX}/git/stage`:
      return git.stage(body.workspaceId, body.path)
    case `${WORKBENCH_API_PREFIX}/git/stage-all`:
      return git.stageAll(body.workspaceId)
    case `${WORKBENCH_API_PREFIX}/git/unstage`:
      return git.unstage(body.workspaceId, body.path)
    case `${WORKBENCH_API_PREFIX}/git/unstage-all`:
      return git.unstageAll(body.workspaceId)
    case `${WORKBENCH_API_PREFIX}/git/discard`:
      return git.discard(body.workspaceId, body.path)
    case `${WORKBENCH_API_PREFIX}/git/discard-all`:
      return git.discardAll(body.workspaceId)
    case `${WORKBENCH_API_PREFIX}/git/commit`:
      return git.commit(body.workspaceId, body.message)
    default:
      throw new WorkbenchHttpError(404, 'ENDPOINT_NOT_FOUND', '工作台接口不存在。')
  }
}

/**
 * Kernel API arms.
 *
 * Every verb needs the kernel id plus its token — the loopback origin fence proves
 * the request came from a browser on this machine, not from *this* page, so the
 * token is what keeps one tab from interrupting another notebook's kernel.
 */
async function dispatchKernel(
  path: string,
  body: Record<string, unknown>,
  kernel: KernelBackend,
): Promise<unknown> {
  switch (path) {
    case `${KERNEL_POST_PREFIX}/discover`:
      return kernel.discover(body.workspaceId)
    case `${KERNEL_POST_PREFIX}/start`:
      return kernel.start(body.workspaceId, body.path, body.specName)
    case `${KERNEL_POST_PREFIX}/status`:
      return kernel.status(body)
    case `${KERNEL_POST_PREFIX}/execute`:
      return kernel.execute(body)
    case `${KERNEL_POST_PREFIX}/interrupt`:
      return kernel.interrupt(body)
    case `${KERNEL_POST_PREFIX}/input`:
      return kernel.input(body)
    case `${KERNEL_POST_PREFIX}/complete`:
      return kernel.complete(body)
    case `${KERNEL_POST_PREFIX}/inspect`:
      return kernel.inspect(body)
    case `${KERNEL_POST_PREFIX}/is-complete`:
      return kernel.isComplete(body)
    case `${KERNEL_POST_PREFIX}/poll`:
      return kernel.poll(body)
    case `${KERNEL_POST_PREFIX}/restart`:
      return kernel.restart(body)
    case `${KERNEL_POST_PREFIX}/shutdown`:
      return kernel.shutdown(body)
    default:
      throw new WorkbenchHttpError(404, 'ENDPOINT_NOT_FOUND', '内核接口不存在。')
  }
}
