/** Host half: trusted-origin workspace API backed by DSH filesystem and Session services. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-workspace'
import { GIT_GRAPH_PAGE_SIZE, MERMAID_RUNTIME_PATH, WORKBENCH_API_PREFIX } from './shared/contracts.ts'
import {
  CONFIG_FIELDS,
  CONFIG_READ_PATH,
  CONFIG_WRITE_PATH,
  type ConfigFieldMeta,
  type ConfigKey,
} from './shared/config-protocol.ts'
import { KERNEL_POST_PREFIX, KERNEL_STREAM_PATH } from './shared/notebook-protocol.ts'
import { SQL_DEFAULT_MAX_ROWS, SQL_POST_PREFIX } from './shared/sql-protocol.ts'
import { ConfigBackend } from './host/config-backend.ts'
import { GitBackend } from './host/git-backend.ts'
import { errorResponse, readJsonObject, sendJson, WorkbenchHttpError } from './host/http.ts'
import { DEFAULT_KERNEL_LIMITS, KernelBackend } from './host/kernel-backend.ts'
import { serveMermaidRuntime } from './host/mermaid-runtime.ts'
import { isTrustedWorkbenchRequest } from './host/request-trust.ts'
import { SqlBackend } from './host/sql-backend.ts'
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

/**
 * The plugin's configuration as the host hands it to `apply`.
 *
 * Every field is present because this is the *validated output*: the host fills
 * whatever the user did not change from the declared defaults below. The schema's
 * input type is `Partial<Config>` instead, because a user who adjusted one setting
 * must not have to spell out the other eighteen — and because cordis saves exactly
 * the fields that differ from their defaults.
 */
export interface Config {
  maxFileBytes: number
  maxDirectoryEntries: number
  gitTimeoutMs: number
  gitMaxOutputBytes: number
  gitGraphPageSize: number
  sqlMaxRows: number
  kernelStartTimeoutMs: number
  kernelRequestTimeoutMs: number
  kernelMaxPerWorkspace: number
  kernelMaxTotal: number
  kernelUnattendedTimeoutMs: number
  kernelReclaimGraceMs: number
  kernelReaperIntervalMs: number
  kernelHeartbeatMs: number
  kernelFrameBuffer: number
  kernelMaxOutputChunkChars: number
  kernelMaxOutputRunChars: number
  kernelMaxOutputRunFrames: number
  kernelDiscoveryCacheMs: number
  kernelProbeTimeoutMs: number
}

/**
 * Every tunable the plugin exposes, with the reason it is worth a setting.
 *
 * Defaults are read from the constants the host modules already declare rather than
 * restated here. That is the point: the shipped numbers were duplicated once (the
 * kernel ceilings read 3/8 here and 4/16 there), and a settings UI that shows one
 * while the code honours the other is worse than no settings UI. A test locks this
 * coupling down.
 *
 * A field earns its place by being a number someone has a reason to change: a big
 * notebook that prints a lot, a slow interpreter that needs a longer start, a Git
 * history worth paging deeper. Anything else stays a constant in the module that
 * owns it, because a setting nobody understands is worse than a sensible default.
 */
const defaults = DEFAULT_KERNEL_LIMITS

/**
 * One bounded setting, described from the shared table.
 *
 * The description comes from `CONFIG_DESCRIPTIONS` rather than being written here, so
 * the schema and the settings page cannot tell two different stories about the same
 * field — and so a field cannot be added without one, because the key is required.
 */
function setting(key: ConfigKey, min: number, max: number, def: number) {
  return z.natural().min(min).max(max).default(def).description(CONFIG_FIELDS[key].description.zh)
}

export const Config: z<Partial<Config>, Config> = z.object({
  maxFileBytes: setting('maxFileBytes', 1024, 16 * 1024 * 1024, 2 * 1024 * 1024),
  maxDirectoryEntries: setting('maxDirectoryEntries', 10, 5000, 1000),
  gitTimeoutMs: setting('gitTimeoutMs', 1000, 120_000, 30_000),
  gitMaxOutputBytes: setting('gitMaxOutputBytes', 64 * 1024, 32 * 1024 * 1024, 4 * 1024 * 1024),
  gitGraphPageSize: setting('gitGraphPageSize', 10, 500, GIT_GRAPH_PAGE_SIZE),
  // The one SQL cap that is a setting: rows per result block. The rest (columns, value length,
  // BLOB bytes, deadline) are protection values nobody has a reason to tune, so they stay
  // constants in `SQL_LIMITS` rather than becoming five more fields on this page.
  sqlMaxRows: setting('sqlMaxRows', 10, 100_000, SQL_DEFAULT_MAX_ROWS),

  // A cold Python kernel with a fat import graph takes seconds, not milliseconds.
  kernelStartTimeoutMs: setting('kernelStartTimeoutMs', 5_000, 180_000, defaults.startTimeoutMs),
  kernelRequestTimeoutMs: setting('kernelRequestTimeoutMs', 1_000, 60_000, defaults.requestTimeoutMs),
  // Kernel count is the one resource this feature cannot grow without limit, so
  // both a per-Workspace and a whole-process ceiling are enforced.
  kernelMaxPerWorkspace: setting('kernelMaxPerWorkspace', 1, 8, defaults.maxKernelsPerWorkspace),
  kernelMaxTotal: setting('kernelMaxTotal', 1, 16, defaults.maxKernelsTotal),
  // A kernel nobody is watching for this long is stopped, the same policy the
  // host's own terminals use for an unattended process.
  kernelUnattendedTimeoutMs: setting('kernelUnattendedTimeoutMs', 60_000, 24 * 3_600_000, defaults.unattendedTimeoutMs),
  kernelReclaimGraceMs: setting('kernelReclaimGraceMs', 0, 60_000, defaults.reclaimGraceMs),
  kernelReaperIntervalMs: setting('kernelReaperIntervalMs', 1_000, 600_000, defaults.reaperIntervalMs),
  kernelHeartbeatMs: setting('kernelHeartbeatMs', 1_000, 300_000, defaults.heartbeatMs),
  kernelFrameBuffer: setting('kernelFrameBuffer', 64, 65_536, defaults.frameBuffer),
  // Output is bounded twice over: a runaway `print` loop should cost one truncated
  // cell, not the browser tab that asked for it.
  kernelMaxOutputChunkChars: setting('kernelMaxOutputChunkChars', 1_024, 4 * 1024 * 1024, defaults.maxOutputChunkChars),
  kernelMaxOutputRunChars: setting('kernelMaxOutputRunChars', 64 * 1024, 256 * 1024 * 1024, defaults.maxOutputRunChars),
  kernelMaxOutputRunFrames: setting('kernelMaxOutputRunFrames', 100, 1_000_000, defaults.maxOutputRunFrames),
  kernelDiscoveryCacheMs: setting('kernelDiscoveryCacheMs', 0, 3_600_000, defaults.discoveryCacheMs),
  kernelProbeTimeoutMs: setting('kernelProbeTimeoutMs', 1_000, 60_000, defaults.probeTimeoutMs),
})

/** Register the workbench's isolated JSON endpoint. */
export function apply(ctx: Context, config: Config): void {
  const workspace = new WorkspaceBackend(ctx, config)
  /*
   * The settings page reads its fields off the live schema rather than a second table
   * of numbers, and reports the values in force — which are `config`, the object the
   * host already validated, not the schema's defaults.
   *
   * Handed over as three reads instead of the schema object itself: the backend needs
   * a field's declared bounds and a validator, and nothing more. That keeps it free of
   * schemastery's generic shape and testable without the real schema.
   */
  const settings = new ConfigBackend({
    metaOf: key => (Config.dict?.[key] as { meta?: ConfigFieldMeta } | undefined)?.meta,
    valueOf: key => {
      // Every configuration field is a number, so indexing the validated object by a
      // key the page asked for is total — no cast through `unknown` needed.
      const value: unknown = config[key as keyof Config]
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined
    },
    validate: proposed => Config(proposed) as unknown as Record<string, unknown>,
  })
  const git = new GitBackend(ctx, workspace, {
    timeoutMs: config.gitTimeoutMs,
    maxOutputBytes: config.gitMaxOutputBytes,
    graphPageSize: config.gitGraphPageSize,
  })
  const kernel = new KernelBackend(ctx, workspace, {
    startTimeoutMs: config.kernelStartTimeoutMs,
    requestTimeoutMs: config.kernelRequestTimeoutMs,
    maxKernelsPerWorkspace: config.kernelMaxPerWorkspace,
    maxKernelsTotal: config.kernelMaxTotal,
    unattendedTimeoutMs: config.kernelUnattendedTimeoutMs,
    // The manager panel's reclaim button is refused until a kernel has been
    // unattended this long, so a page that is merely reloading cannot lose its run.
    reclaimGraceMs: config.kernelReclaimGraceMs,
    reaperIntervalMs: config.kernelReaperIntervalMs,
    heartbeatMs: config.kernelHeartbeatMs,
    frameBuffer: config.kernelFrameBuffer,
    maxOutputChunkChars: config.kernelMaxOutputChunkChars,
    maxOutputRunChars: config.kernelMaxOutputRunChars,
    maxOutputRunFrames: config.kernelMaxOutputRunFrames,
    discoveryCacheMs: config.kernelDiscoveryCacheMs,
    probeTimeoutMs: config.kernelProbeTimeoutMs,
  })
  // SQL notebook connections. Independent of the kernel backend by design (ADR 0002): it shares
  // the cell view, not the Jupyter session or transport, so it never enters the kernel registry.
  const sql = new SqlBackend(ctx, { maxRowLimit: config.sqlMaxRows })
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (req.method !== 'POST') throw new WorkbenchHttpError(405, 'METHOD_NOT_ALLOWED', '只允许 POST 请求。')
      if (!isTrustedWorkbenchRequest(req.headers, ctx.webRuntime.trustedHosts)) {
        throw new WorkbenchHttpError(403, 'ORIGIN_REJECTED', '请求来源无效。')
      }
      const body = await readJsonObject(req, config.maxFileBytes + 64 * 1024)
      const path = new URL(req.url ?? '/', 'http://dsh.invalid').pathname
      if (path === CONFIG_WRITE_PATH) {
        // Applying the new configuration restarts this plugin, which disposes the very
        // effect serving this request. Answering first is not politeness: restarting
        // mid-handler leaves the browser a connection that closes without a status,
        // and the user cannot tell a saved setting from a failed one.
        const snapshot = settings.stage(body)
        sendJson(res, 200, snapshot)
        const applied = settings.takePending()
        if (applied !== undefined) {
          ctx.logger.info('workbench-layout: configuration accepted, restarting the plugin with it')
          setImmediate(() => {
            // `update` can fail two ways: it throws when validation rejects the values,
            // and it returns a promise for the restart that rejects when the restarted
            // plugin fails. Either left unhandled becomes an uncaught exception, which in
            // Node takes down the process — so a bad setting could kill DSH rather than
            // just fail to apply. The reply has already gone out claiming acceptance, so
            // the log says plainly that the values are not in force.
            try {
              // `Promise.resolve` rather than a `.catch` on the result: `update` is typed
              // `void | Promise<void>`, and resolving an already-settled value is free
              // while also adopting a thenable the waterfall might return.
              const restarting: void | Promise<void> = ctx.fiber.update(applied)
              if (restarting !== undefined) Promise.resolve(restarting).catch(reportRestartFailure)
            } catch (error: unknown) {
              reportRestartFailure(error)
            }
            function reportRestartFailure(error: unknown): void {
              ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
              ctx.logger.warn('workbench-layout: the plugin did not restart, so the new configuration is not in force')
            }
          })
        }
        return
      }
      const value = await dispatch(path, body, workspace, git, settings, sql)
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
  // No SQLite handle may outlive the effect that opened it: a leaked handle holds a file open and,
  // under the default journal mode, its read transaction can block another writer.
  ctx.effect(() => () => { sql.dispose() }, 'workbench-layout: sql connections closed on dispose')
  ctx.logger.info('workbench-layout: public-package workspace, Git, and kernel APIs registered')
}

async function dispatch(
  path: string,
  body: Record<string, unknown>,
  workspace: WorkspaceBackend,
  git: GitBackend,
  settings: ConfigBackend,
  sql: SqlBackend,
): Promise<unknown> {
  switch (path) {
    case CONFIG_READ_PATH:
      return settings.read()
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
    case `${WORKBENCH_API_PREFIX}/path/reveal`:
      return workspace.revealPath(body.workspaceId, body.path)
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
    // SQL notebook. These verbs are POST-only, so they ride the same prefix, origin fence and
    // JSON bounds as files and Git rather than getting their own registration. Identity is the
    // *notebook*, not the database: `path` below is the database, `notebook` is the .sqlnb file,
    // and the connection belongs to the notebook (see src/host/sql-backend.ts).
    case `${SQL_POST_PREFIX}/open`:
      return sql.open(body.workspaceId, body.notebook, body.path, body.access, body.rowLimit)
    case `${SQL_POST_PREFIX}/execute`:
      return sql.execute(body.workspaceId, body.notebook, body.sql)
    // Cancel is a separate verb from close because it answers a different question: the reader
    // wants this cell to stop taking rows while keeping the connection, its scratch tables and
    // its place in the session. Closing would drop all three.
    case `${SQL_POST_PREFIX}/cancel`:
      return sql.cancel(body.workspaceId, body.notebook)
    case `${SQL_POST_PREFIX}/close`:
      return sql.close(body.workspaceId, body.notebook)
    case `${SQL_POST_PREFIX}/tables`:
      return sql.tables(body.workspaceId, body.notebook)
    case `${SQL_POST_PREFIX}/columns`:
      return sql.columns(body.workspaceId, body.notebook, body.table)
    case `${SQL_POST_PREFIX}/abandon`:
      return sql.abandon(body.workspaceId, body.notebook)
    // Requirement: switching away from a workspace releases all of its connections rather than
    // letting them hold files open until the grace timers happen to fire.
    case `${SQL_POST_PREFIX}/release-workspace`:
      return { released: sql.releaseWorkspace(body.workspaceId) }
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
    case `${KERNEL_POST_PREFIX}/list`:
      return kernel.list(body.workspaceId)
    case `${KERNEL_POST_PREFIX}/reclaim`:
      return kernel.reclaim(body)
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
