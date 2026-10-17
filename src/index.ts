/** Host half: trusted-origin workspace API backed by DSH filesystem and Session services. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { WebStartupValues } from '@deepseek-ai/dsh-web-app/startup'
import type {} from '@deepseek-ai/dsh-workspace'
import {
  FILE_ROUTES,
  GIT_GRAPH_PAGE_SIZE,
  GIT_ROUTES,
  MERMAID_RUNTIME_PATH,
  WORKBENCH_API_PREFIX,
} from './shared/contracts.ts'
import {
  CONFIG_FIELDS,
  CONFIG_ROUTES,
  CONFIG_WRITE_PATH,
  type ConfigFieldMeta,
  type ConfigKey,
} from './shared/config-protocol.ts'
import type { RouteTable } from './shared/route.ts'
import { KERNEL_POST_PREFIX, KERNEL_ROUTES, KERNEL_STREAM_PATH } from './shared/notebook-protocol.ts'
import { SQL_DEFAULT_MAX_ROWS, SQL_ROUTES } from './shared/sql-protocol.ts'
import { ConfigBackend } from './host/config-backend.ts'
import { GitBackend } from './host/git-backend.ts'
import { errorResponse, readJsonObject, sendJson, WorkbenchHttpError } from './host/http.ts'
import { dispatchRoute, routeRegistry } from './host/route-dispatch.ts'
import { DEFAULT_KERNEL_LIMITS, KernelBackend } from './host/kernel-backend.ts'
import { serveMermaidRuntime } from './host/mermaid-runtime.ts'
import { isTrustedWorkbenchRequest } from './host/request-trust.ts'
import { SqlBackend } from './host/sql-backend.ts'
import { WorkspaceBackend } from './host/workspace-backend.ts'

export const name = 'workbench-layout'
export const inject = ['webServer', 'fs', 'workspaceRegistry', 'webStartup']

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * The Web invocation's trust list, provided by the `webStartup` row.
     *
     * DSH 0.2.1 replaced the `webRuntime` service with `webStartup`; the shape is
     * imported from the package that owns the service rather than restated here,
     * so a future rename fails this build instead of failing at request time.
     */
    webStartup: WebStartupValues
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
  /*
   * 每个路由键一个 handler。
   *
   * 参数与回值都由共享声明给出：漏写一格、或把 handler 的参数写成另一个名字，都是编译错误。
   * 这里只做转交——工作台那 62 条路由的行为各自住在它的后端里，路由表不改变任何一条的行为。
   */
  const routes = routeRegistry(WORKBENCH_ROUTES, {
    // 配置
    readPluginConfig: async () => settings.read(),
    // 文件与目录
    listDirectory: async params => workspace.list(params.workspaceId, params.path),
    readFile: async params => workspace.read(params.workspaceId, params.path),
    readImage: async params => workspace.readImage(params.workspaceId, params.path),
    refreshFiles: async params => workspace.refreshFiles(params.workspaceId, params.files),
    saveFile: async params => workspace.save(params.workspaceId, params.path, params.content, params.version),
    createFile: async params => workspace.createFile(params.workspaceId, params.path),
    createDirectory: async params => workspace.createDirectory(params.workspaceId, params.path),
    renameEntry: async params => workspace.renameEntry(params.workspaceId, params.path, params.name),
    deleteEntry: async params => workspace.deleteEntry(params.workspaceId, params.path),
    absolutePath: async params => workspace.absolutePath(params.workspaceId, params.path),
    revealPath: async params => workspace.revealPath(params.workspaceId, params.path),
    relativePath: async params => workspace.relativePath(params.workspaceId, params.path),
    // Git
    gitStatus: async params => git.status(params.workspaceId),
    gitDiff: async params => git.diff(params.workspaceId, params.path, params.staged),
    gitEditorBaseline: async params => git.editorBaseline(params.workspaceId, params.path),
    gitGraph: async params => git.graph(params.workspaceId, params.offset),
    gitBranches: async params => git.branches(params.workspaceId),
    gitSwitchBranch: async params => git.switchBranch(params.workspaceId, params.ref),
    gitCreateBranch: async params => git.createBranch(params.workspaceId, params.name, params.source),
    gitRenameBranch: async params => git.renameBranch(params.workspaceId, params.name),
    gitDeleteBranch: async params => git.deleteBranch(params.workspaceId, params.ref),
    gitRemoteOperation: async params => git.remoteOperation(params.workspaceId, params.operation),
    gitRemotes: async params => git.remotes(params.workspaceId),
    gitAddRemote: async params => git.addRemote(params.workspaceId, params.name, params.fetchUrl, params.pushUrl),
    gitUpdateRemote: async params =>
      git.updateRemote(params.workspaceId, params.currentName, params.name, params.fetchUrl, params.pushUrl),
    gitDeleteRemote: async params => git.deleteRemote(params.workspaceId, params.name),
    gitTargetRemoteOperation: async params =>
      git.targetRemoteOperation(params.workspaceId, params.operation, params.remote, params.branch),
    gitCommitFiles: async params => git.commitFiles(params.workspaceId, params.revision),
    gitCommitFileDiff: async params => git.commitFileDiff(params.workspaceId, params.revision, params.path),
    gitComparisonFiles: async params => git.comparisonFiles(params.workspaceId, params.revision),
    gitComparisonFileDiff: async params => git.comparisonFileDiff(params.workspaceId, params.revision, params.path),
    gitCommitAction: async params => git.commitAction(params.workspaceId, params.operation, params.revision),
    gitStage: async params => git.stage(params.workspaceId, params.path),
    gitStageAll: async params => git.stageAll(params.workspaceId),
    gitUnstage: async params => git.unstage(params.workspaceId, params.path),
    gitUnstageAll: async params => git.unstageAll(params.workspaceId),
    gitDiscard: async params => git.discard(params.workspaceId, params.path),
    gitDiscardAll: async params => git.discardAll(params.workspaceId),
    gitCommit: async params => git.commit(params.workspaceId, params.message),
    /*
     * SQL notebook. These verbs are POST-only, so they ride the same prefix, origin fence and
     * JSON bounds as files and Git rather than getting their own registration. Identity is the
     * *notebook*, not the database: `path` below is the database, `notebook` is the .sqlnb file,
     * and the connection belongs to the notebook (see src/host/sql-backend.ts).
     */
    sqlOpen: async params => sql.open(params.workspaceId, params.notebook, params.path, params.access, params.rowLimit),
    sqlExecute: async params => sql.execute(params.workspaceId, params.notebook, params.sql),
    sqlCancel: async params => sql.cancel(params.workspaceId, params.notebook),
    sqlClose: async params => sql.close(params.workspaceId, params.notebook),
    sqlTables: async params => sql.tables(params.workspaceId, params.notebook),
    sqlColumns: async params => sql.columns(params.workspaceId, params.notebook, params.table),
    sqlAbandon: async params => sql.abandon(params.workspaceId, params.notebook),
    sqlReleaseWorkspace: async params => ({ released: sql.releaseWorkspace(params.workspaceId) }),
    /*
     * Kernel API arms. Every verb that names a kernel needs its token too — the loopback
     * origin fence proves the request came from a browser on this machine, not from *this*
     * page, so the token is what keeps one tab from interrupting another notebook's kernel.
     */
    kernelDiscover: async params => kernel.discover(params.workspaceId),
    kernelList: async params => kernel.list(params.workspaceId),
    kernelReclaim: async params => kernel.reclaim(params),
    kernelStart: async params => kernel.start(params.workspaceId, params.path, params.specName),
    kernelStatus: async params => kernel.status(params),
    kernelExecute: async params => kernel.execute(params),
    kernelInterrupt: async params => kernel.interrupt(params),
    kernelInput: async params => kernel.input(params),
    kernelComplete: async params => kernel.complete(params),
    kernelInspect: async params => kernel.inspect(params),
    kernelIsComplete: async params => kernel.isComplete(params),
    kernelPoll: async params => kernel.poll(params),
    kernelRestart: async params => kernel.restart(params),
    kernelShutdown: async params => kernel.shutdown(params),
  })
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (req.method !== 'POST') throw new WorkbenchHttpError(405, 'METHOD_NOT_ALLOWED', '只允许 POST 请求。')
      if (!isTrustedWorkbenchRequest(req.headers, ctx.webStartup.trustedHosts, ctx.webServer.host)) {
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
      const routed = await dispatchRoute(routes, path, body)
      // 表里没有这条路径：`routeIndex` 只登记声明过的路径，所以这就是原来的 404。
      if (!routed.found) throw new WorkbenchHttpError(404, 'ENDPOINT_NOT_FOUND', '工作台接口不存在。')
      sendJson(res, 200, routed.value)
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
      // 轮询那条臂单独处理：它是一次 GET，参数来自查询串而不是请求体，理由见这条注释上方。
      const poll = path === KERNEL_ROUTES.kernelPoll.path && req.method === 'GET'
      if (!poll && req.method !== 'POST') {
        throw new WorkbenchHttpError(405, 'METHOD_NOT_ALLOWED', '内核接口只允许 POST 请求。')
      }
      if (!isTrustedWorkbenchRequest(req.headers, ctx.webStartup.trustedHosts, ctx.webServer.host)) {
        throw new WorkbenchHttpError(403, 'ORIGIN_REJECTED', '请求来源无效。')
      }
      const body = poll
        ? Object.fromEntries(new URL(req.url ?? '/', 'http://dsh.invalid').searchParams)
        : await readJsonObject(req, config.maxFileBytes + 64 * 1024)
      const routed = await dispatchRoute(routes, path, body)
      if (!routed.found) throw new WorkbenchHttpError(404, 'ENDPOINT_NOT_FOUND', '内核接口不存在。')
      sendJson(res, 200, routed.value)
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
      if (!isTrustedWorkbenchRequest(req.headers, ctx.webStartup.trustedHosts, ctx.webServer.host)) {
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

/**
 * 宿主服务端全部路由：各区域协议模块的声明拼成一张。
 *
 * 这是唯一一张表，客户端与宿主都照它走：客户端照形状写参数，宿主照路径查 handler。
 * 表里漏一条、或同一条路径被两个区域各声明一次，都由 `routeRegistry` 在启动时报出来。
 */
export const WORKBENCH_ROUTES = {
  ...CONFIG_ROUTES,
  ...FILE_ROUTES,
  ...GIT_ROUTES,
  ...SQL_ROUTES,
  ...KERNEL_ROUTES,
} satisfies RouteTable
