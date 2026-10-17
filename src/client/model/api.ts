/** Same-origin browser client for the workbench Host route. */

import type {
  CreatedWorkspaceEntry,
  DeletedWorkspaceEntry,
  DirectoryListing,
  GitBranches,
  GitCommitFiles,
  GitCommitAction,
  GitCommitActionResult,
  GitCommitResult,
  GitEditorBaseline,
  GitFileDiff,
  GitGraph,
  GitRemoteOperation,
  GitRemote,
  GitRemoteResult,
  GitRemotes,
  GitStatus,
  GitTargetRemoteOperation,
  GitTargetRemoteResult,
  SavedWorkspaceFile,
  RenamedWorkspaceEntry,
  WorkbenchErrorBody,
  WorkspaceFile,
  WorkspaceFileObservation,
  WorkspaceFilesRefresh,
  WorkspaceImageFile,
  WorkspaceAbsolutePath,
  WorkspaceRelativePath,
} from '../../shared/contracts.ts'
import { FILE_ROUTES, GIT_ROUTES } from '../../shared/contracts.ts'
import { CONFIG_PREAMBLE, CONFIG_ROUTES, type ConfigSnapshot } from '../../shared/config-protocol.ts'
import type { Route } from '../../shared/route.ts'
import type {
  KernelCompletionResult,
  KernelDiscoverResult,
  KernelExecuteResult,
  KernelInputResult,
  KernelInspectResult,
  KernelIsCompleteResult,
  KernelListResult,
  KernelStartResult,
  KernelStatusResult,
  NotebookKernelPollResult,
} from '../../shared/notebook-protocol.ts'
import { KERNEL_POST_PREFIX, KERNEL_ROUTES } from '../../shared/notebook-protocol.ts'
import {
  SQL_ROUTES,
  type SqlCancelResult,
  type SqlCloseResult,
  type SqlColumnsResult,
  type SqlAccess,
  type SqlExecuteResult,
  type SqlOpenResult,
  type SqlTablesResult,
} from '../../shared/sql-protocol.ts'

export class WorkbenchApiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'WorkbenchApiError'
  }
}

/** Typed fetch facade; all mutations stay explicit methods. */
export class WorkbenchApi {
  async listDirectory(workspaceId: string, path: string): Promise<DirectoryListing> {
    return this.post(FILE_ROUTES.listDirectory, { workspaceId, path })
  }

  async readFile(workspaceId: string, path: string): Promise<WorkspaceFile> {
    return this.post(FILE_ROUTES.readFile, { workspaceId, path })
  }

  async readImage(workspaceId: string, path: string): Promise<WorkspaceImageFile> {
    return this.post(FILE_ROUTES.readImage, { workspaceId, path })
  }

  async refreshFiles(workspaceId: string, files: WorkspaceFileObservation[]): Promise<WorkspaceFilesRefresh> {
    return this.post(FILE_ROUTES.refreshFiles, { workspaceId, files })
  }

  async saveFile(workspaceId: string, path: string, content: string, version: string): Promise<SavedWorkspaceFile> {
    return this.post(FILE_ROUTES.saveFile, { workspaceId, path, content, version })
  }

  async createFile(workspaceId: string, path: string): Promise<CreatedWorkspaceEntry> {
    return this.post(FILE_ROUTES.createFile, { workspaceId, path })
  }

  async createDirectory(workspaceId: string, path: string): Promise<CreatedWorkspaceEntry> {
    return this.post(FILE_ROUTES.createDirectory, { workspaceId, path })
  }

  async renameEntry(workspaceId: string, path: string, name: string): Promise<RenamedWorkspaceEntry> {
    return this.post(FILE_ROUTES.renameEntry, { workspaceId, path, name })
  }

  async deleteEntry(workspaceId: string, path: string): Promise<DeletedWorkspaceEntry> {
    return this.post(FILE_ROUTES.deleteEntry, { workspaceId, path })
  }

  async absolutePath(workspaceId: string, path: string): Promise<WorkspaceAbsolutePath> {
    return this.post(FILE_ROUTES.absolutePath, { workspaceId, path })
  }

  /**
   * Show one entry in the operating system's file manager.
   *
   * The answer carries only the workspace-relative path: the absolute path is what the
   * Host spends on the way out, not something this page needs back.
   */
  async revealPath(workspaceId: string, path: string): Promise<WorkspaceRelativePath> {
    return this.post(FILE_ROUTES.revealPath, { workspaceId, path })
  }

  async relativePath(workspaceId: string, path: string): Promise<WorkspaceRelativePath> {
    return this.post(FILE_ROUTES.relativePath, { workspaceId, path })
  }

  async gitStatus(workspaceId: string): Promise<GitStatus> {
    return this.post(GIT_ROUTES.gitStatus, { workspaceId })
  }

  async gitDiff(workspaceId: string, path: string, staged: boolean): Promise<GitFileDiff> {
    return this.post(GIT_ROUTES.gitDiff, { workspaceId, path, staged })
  }

  async gitEditorBaseline(workspaceId: string, path: string): Promise<GitEditorBaseline> {
    return this.post(GIT_ROUTES.gitEditorBaseline, { workspaceId, path })
  }

  async gitGraph(workspaceId: string, offset = 0): Promise<GitGraph> {
    return this.post(GIT_ROUTES.gitGraph, { workspaceId, offset })
  }

  async gitBranches(workspaceId: string): Promise<GitBranches> {
    return this.post(GIT_ROUTES.gitBranches, { workspaceId })
  }

  async gitSwitchBranch(workspaceId: string, ref: string): Promise<GitStatus> {
    return this.post(GIT_ROUTES.gitSwitchBranch, { workspaceId, ref })
  }

  async gitCreateBranch(workspaceId: string, name: string, source?: string): Promise<GitStatus> {
    return this.post(GIT_ROUTES.gitCreateBranch, { workspaceId, name, ...(source === undefined ? {} : { source }) })
  }

  async gitRenameBranch(workspaceId: string, name: string): Promise<GitStatus> {
    return this.post(GIT_ROUTES.gitRenameBranch, { workspaceId, name })
  }

  async gitDeleteBranch(workspaceId: string, ref: string): Promise<GitStatus> {
    return this.post(GIT_ROUTES.gitDeleteBranch, { workspaceId, ref })
  }

  async gitRemoteOperation(workspaceId: string, operation: GitRemoteOperation): Promise<GitRemoteResult> {
    return this.post(GIT_ROUTES.gitRemoteOperation, { workspaceId, operation })
  }

  async gitRemotes(workspaceId: string): Promise<GitRemotes> {
    return this.post(GIT_ROUTES.gitRemotes, { workspaceId })
  }

  async gitAddRemote(workspaceId: string, remote: Omit<GitRemote, 'separatePushUrl'>): Promise<GitRemotes> {
    return this.post(GIT_ROUTES.gitAddRemote, { workspaceId, ...remote })
  }

  async gitUpdateRemote(workspaceId: string, currentName: string, remote: Omit<GitRemote, 'separatePushUrl'>): Promise<GitRemotes> {
    return this.post(GIT_ROUTES.gitUpdateRemote, { workspaceId, currentName, ...remote })
  }

  async gitDeleteRemote(workspaceId: string, name: string): Promise<GitRemotes> {
    return this.post(GIT_ROUTES.gitDeleteRemote, { workspaceId, name })
  }

  async gitTargetRemoteOperation(
    workspaceId: string,
    operation: GitTargetRemoteOperation,
    remote: string,
    branch?: string,
  ): Promise<GitTargetRemoteResult> {
    return this.post(
      GIT_ROUTES.gitTargetRemoteOperation,
      { workspaceId, operation, remote, ...(branch === undefined ? {} : { branch }) },
    )
  }

  async gitCommitFiles(workspaceId: string, revision: string): Promise<GitCommitFiles> {
    return this.post(GIT_ROUTES.gitCommitFiles, { workspaceId, revision })
  }

  async gitCommitFileDiff(workspaceId: string, revision: string, path: string): Promise<GitFileDiff> {
    return this.post(GIT_ROUTES.gitCommitFileDiff, { workspaceId, revision, path })
  }

  async gitComparisonFiles(workspaceId: string, revision: string): Promise<GitCommitFiles> {
    return this.post(GIT_ROUTES.gitComparisonFiles, { workspaceId, revision })
  }

  async gitComparisonFileDiff(workspaceId: string, revision: string, path: string): Promise<GitFileDiff> {
    return this.post(GIT_ROUTES.gitComparisonFileDiff, { workspaceId, revision, path })
  }

  async gitCommitAction(workspaceId: string, operation: GitCommitAction, revision: string): Promise<GitCommitActionResult> {
    return this.post(GIT_ROUTES.gitCommitAction, { workspaceId, operation, revision })
  }

  async gitStage(workspaceId: string, path: string): Promise<GitStatus> {
    return this.post(GIT_ROUTES.gitStage, { workspaceId, path })
  }

  async gitStageAll(workspaceId: string): Promise<GitStatus> {
    return this.post(GIT_ROUTES.gitStageAll, { workspaceId })
  }

  async gitUnstage(workspaceId: string, path: string): Promise<GitStatus> {
    return this.post(GIT_ROUTES.gitUnstage, { workspaceId, path })
  }

  async gitUnstageAll(workspaceId: string): Promise<GitStatus> {
    return this.post(GIT_ROUTES.gitUnstageAll, { workspaceId })
  }

  async gitDiscard(workspaceId: string, path: string): Promise<GitStatus> {
    return this.post(GIT_ROUTES.gitDiscard, { workspaceId, path })
  }

  async gitDiscardAll(workspaceId: string): Promise<GitStatus> {
    return this.post(GIT_ROUTES.gitDiscardAll, { workspaceId })
  }

  async gitCommit(workspaceId: string, message: string): Promise<GitCommitResult> {
    return this.post(GIT_ROUTES.gitCommit, { workspaceId, message })
  }

  /**
   * Kernels and Python environments this Workspace can start.
   *
   * Asked when a notebook tab opens, so "what can I run here" is answered before the
   * user presses Run rather than failing on it.
   */
  async kernelDiscover(workspaceId: string): Promise<KernelDiscoverResult> {
    return this.post(KERNEL_ROUTES.kernelDiscover, { workspaceId })
  }

  /**
   * Every kernel this Workspace is running right now, for the manager panel.
   *
   * Read-only and token-free by design: the panel exists to show kernels no notebook
   * tab can reach, so it cannot be required to present a token it does not have. The
   * Host never returns a token here.
   */
  async kernelList(workspaceId: string): Promise<KernelListResult> {
    return this.post(KERNEL_ROUTES.kernelList, { workspaceId })
  }

  /** Reclaim a kernel the Host has judged unreachable by any notebook. */
  async kernelReclaim(kernelId: string, workspaceId: string): Promise<KernelStatusResult> {
    return this.post(KERNEL_ROUTES.kernelReclaim, { kernelId, workspaceId })
  }

  async kernelStart(workspaceId: string, path: string, specName?: string): Promise<KernelStartResult> {
    return this.post(KERNEL_ROUTES.kernelStart, { workspaceId, path, ...(specName === undefined ? {} : { specName }) })
  }

  async kernelStatus(kernelId: string, token: string, workspaceId: string): Promise<KernelStatusResult> {
    return this.post(KERNEL_ROUTES.kernelStatus, { kernelId, token, workspaceId })
  }

  async kernelExecute(input: {
    kernelId: string
    token: string
    workspaceId: string
    code: string
    cellId?: string
    silent?: boolean
  }): Promise<KernelExecuteResult> {
    return this.post(KERNEL_ROUTES.kernelExecute, input)
  }

  async kernelInterrupt(kernelId: string, token: string, workspaceId: string): Promise<KernelStatusResult> {
    return this.post(KERNEL_ROUTES.kernelInterrupt, { kernelId, token, workspaceId })
  }

  async kernelInput(kernelId: string, token: string, workspaceId: string, value: string): Promise<KernelInputResult> {
    return this.post(KERNEL_ROUTES.kernelInput, { kernelId, token, workspaceId, value })
  }

  async kernelComplete(input: {
    kernelId: string
    token: string
    workspaceId: string
    code: string
    cursorPos: number
  }): Promise<KernelCompletionResult> {
    return this.post(KERNEL_ROUTES.kernelComplete, input)
  }

  async kernelInspect(input: {
    kernelId: string
    token: string
    workspaceId: string
    code: string
    cursorPos: number
  }): Promise<KernelInspectResult> {
    return this.post(KERNEL_ROUTES.kernelInspect, input)
  }

  async kernelIsComplete(input: {
    kernelId: string
    token: string
    workspaceId: string
    code: string
  }): Promise<KernelIsCompleteResult> {
    return this.post(KERNEL_ROUTES.kernelIsComplete, input)
  }

  async kernelRestart(input: {
    kernelId: string
    token: string
    workspaceId: string
    path: string
  }): Promise<KernelStartResult> {
    return this.post(KERNEL_ROUTES.kernelRestart, input)
  }

  async kernelShutdown(kernelId: string, token: string, workspaceId: string): Promise<KernelStatusResult> {
    return this.post(KERNEL_ROUTES.kernelShutdown, { kernelId, token, workspaceId })
  }

  /** Poll fallback for the event stream, for environments that cannot hold one open. */
  async kernelPoll(input: {
    kernelId: string
    token: string
    workspaceId: string
    since: number
  }): Promise<NotebookKernelPollResult> {
    const query = new URLSearchParams({
      kernelId: input.kernelId,
      token: input.token,
      workspaceId: input.workspaceId,
      since: String(input.since),
    })
    const response = await fetch(`${KERNEL_POST_PREFIX}/poll?${query.toString()}`, {
      method: 'GET',
      credentials: 'same-origin',
    })
    return readResponse<NotebookKernelPollResult>(response)
  }

  /**
   * The plugin's own configuration, as the settings page needs it.
   *
   * The fields arrive with their bounds and defaults because the page must not
   * restate a number the host no longer uses; it renders whatever the schema declares.
   */
  async readPluginConfig(): Promise<ConfigSnapshot> {
    return this.post(CONFIG_ROUTES.readPluginConfig, {})
  }

  /**
   * Apply a new configuration.
   *
   * The host answers before it restarts itself, so a resolved promise means the values
   * were accepted — not that they are live yet. The restart drops the notebook kernels
   * this plugin owns, which is why the page says so before it offers the button.
   */
  async updatePluginConfig(config: Record<string, number>): Promise<ConfigSnapshot> {
    return this.post(CONFIG_PREAMBLE.updatePluginConfig, { config })
  }

  // --- SQL notebook -------------------------------------------------------------
  //
  // The identity these calls carry is the *notebook*, not the database: the Host owns one
  // connection per open `.sqlnb`, keyed by that file, and the database appears only when a
  // connection is created. Nothing here is a kernel id or token — SQL notebook connections
  // never enter the kernel registry or the kernel event stream (ADR 0002).

  /**
   * Open or re-arm this notebook's connection to one database file.
   *
   * Re-opening the same notebook with the same file and tier is how a page that went away
   * inside the Host's grace window gets its handle back — including the temporary tables
   * that handle holds.
   */
  async sqlOpen(input: {
    workspaceId: string
    notebook: string
    path: string
    access?: SqlAccess
    rowLimit?: number
  }): Promise<SqlOpenResult> {
    return this.post(SQL_ROUTES.sqlOpen, input)
  }

  /** Run one cell. The Host runs its statements in order and answers one block each. */
  async sqlExecute(workspaceId: string, notebook: string, sql: string): Promise<SqlExecuteResult> {
    return this.post(SQL_ROUTES.sqlExecute, { workspaceId, notebook, sql })
  }

  /** Close the connection now, rolling back an open transaction on the way out. */
  async sqlClose(workspaceId: string, notebook: string): Promise<SqlCloseResult> {
    return this.post(SQL_ROUTES.sqlClose, { workspaceId, notebook })
  }

  /**
   * Ask the Host to stop the cell this notebook's connection is stepping through.
   *
   * Honoured where the row loop yields, so it bounds a scan that returns rows and not an
   * aggregate whose whole cost sits in its first row. The answer says whether anything was
   * running at all.
   */
  async sqlCancel(workspaceId: string, notebook: string): Promise<SqlCancelResult> {
    return this.post(SQL_ROUTES.sqlCancel, { workspaceId, notebook })
  }

  /**
   * Let the Host keep this notebook's connection for its grace window instead of closing it.
   *
   * Used when the notebook leaves the screen but may come back within seconds, which is what
   * makes a page reload keep the user's temporary tables.
   */
  async sqlAbandon(workspaceId: string, notebook: string): Promise<{ path: string; scheduled: boolean }> {
    return this.post(SQL_ROUTES.sqlAbandon, { workspaceId, notebook })
  }

  /** First schema level: tables and views, with the tree's own truncation flag. */
  async sqlTables(workspaceId: string, notebook: string): Promise<SqlTablesResult> {
    return this.post(SQL_ROUTES.sqlTables, { workspaceId, notebook })
  }

  /** Declared columns of one table or view, as the schema tree shows them. */
  async sqlColumns(workspaceId: string, notebook: string, table: string): Promise<SqlColumnsResult> {
    return this.post(SQL_ROUTES.sqlColumns, { workspaceId, notebook, table })
  }

  /** Release every connection of a workspace the reader left. */
  async sqlReleaseWorkspace(workspaceId: string): Promise<{ released: number }> {
    return this.post(SQL_ROUTES.sqlReleaseWorkspace, { workspaceId })
  }

  /**
   * 一次工作台请求，唯一的那条出口。
   *
   * 路径与参数都来自同一个声明：声明里已经拼好完整路径，所以这里不再加任何前缀；
   * 参数由声明的形状约束，写错名字或漏一个字段过不了编译。
   */
  private async post<Params extends object, Result>(spec: Route<Params, Result>, params: Params): Promise<Result> {
    const response = await fetch(spec.path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    })
    return readResponse(response)
  }
}

/** Unwrap one workbench response into a value or a typed error. */
async function readResponse<T>(response: Response): Promise<T> {
  const value: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const error = value as WorkbenchErrorBody | undefined
    throw new WorkbenchApiError(
      error?.error.code ?? `HTTP_${response.status}`,
      error?.error.message ?? `Workbench request failed with HTTP ${response.status}`,
    )
  }
  return value as T
}
