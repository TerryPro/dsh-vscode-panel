/** 面向单文件审阅的 Git 操作；所有命令均使用固定 argv，不经过 shell。 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  GitBranch,
  GitBranches,
  GitCommit,
  GitCommitAction,
  GitCommitActionResult,
  GitCommitFile,
  GitCommitFiles,
  GitCommitResult,
  GitCommitStats,
  GitEditorBaseline,
  GitFileDiff,
  GitFileStatus,
  GitGraph,
  GitReference,
  GitRemote,
  GitRemoteOperation,
  GitRemoteResult,
  GitRemotes,
  GitStatus,
  GitTargetRemoteOperation,
  GitTargetRemoteResult,
} from '../shared/contracts.ts'
import { GIT_GRAPH_PAGE_SIZE } from '../shared/contracts.ts'
import { WorkbenchHttpError } from './http.ts'
import type { WorkspaceBackend, WorkspaceGitText } from './workspace-backend.ts'
import { emptyGitText, GitRunner, type GitText } from './git/git-runner.ts'
import {
  parseAheadBehind,
  parseGitBranches,
  parseGitGraph,
  parseGitGraphWithStats,
  parseGitNameStatus,
  parseGitNumstat,
  parsePorcelainStatus,
  REVISION_PATTERN,
  type GitNumstat,
} from './git/git-parsers.ts'

export * from './git/git-parsers.ts'

const REMOTE_OPERATIONS = new Set<GitRemoteOperation>(['fetch', 'pull', 'push', 'sync'])
const TARGET_REMOTE_OPERATIONS = new Set<GitTargetRemoteOperation>(['fetch', 'pull', 'push'])
const COMMIT_ACTIONS = new Set<GitCommitAction>(['cherry-pick', 'revert'])

export interface GitLimits {
  timeoutMs: number
  maxOutputBytes: number
}

/** Git 状态、单文件版本、索引和提交操作。 */
export class GitBackend {
  private readonly ctx: Context
  private readonly workspace: WorkspaceBackend
  private readonly limits: GitLimits
  private readonly runner: GitRunner

  constructor(
    ctx: Context,
    workspace: WorkspaceBackend,
    limits: GitLimits,
  ) {
    this.ctx = ctx
    this.workspace = workspace
    this.limits = limits
    this.runner = new GitRunner(ctx, workspace, limits)
  }

  async status(workspaceId: unknown): Promise<GitStatus> {
    let cwd: string
    try {
      cwd = await this.runner.repositoryRoot(workspaceId)
    } catch (error) {
      if (error instanceof WorkbenchHttpError && error.code === 'GIT_UNAVAILABLE') {
        return { available: false, files: [], message: error.message }
      }
      throw error
    }
    const [status, branch, remotes] = await Promise.all([
      this.runner.run(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
      this.runner.run(cwd, ['branch', '--show-current']),
      this.runner.run(cwd, ['remote']),
    ])
    const branchName = branch.stdout.trim()
    const remoteNames = remotes.stdout.split(/\r?\n/u).map(name => name.trim()).filter(name => name !== '')
    const head = await this.runner.headRevision(cwd)
    const hasHead = head !== undefined
    const upstreamResult = hasHead && branchName !== ''
      ? await this.runner.run(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], [0, 128])
      : undefined
    const upstream = upstreamResult?.exitCode === 0 ? upstreamResult.stdout.trim() : ''
    const sync = upstream === ''
      ? undefined
      : parseAheadBehind((await this.runner.run(cwd, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])).stdout)
    return {
      available: true,
      files: parsePorcelainStatus(status.stdout),
      ...(head === undefined ? {} : { head }),
      ...(branchName === '' ? {} : { branch: branchName }),
      detached: hasHead && branchName === '',
      hasRemote: remoteNames.length > 0,
      remotes: remoteNames,
      ...(upstream === '' ? {} : { upstream }),
      ...(sync === undefined ? {} : sync),
    }
  }

  async diff(workspaceId: unknown, pathValue: unknown, stagedValue: unknown): Promise<GitFileDiff> {
    const path = await this.workspace.assertGitPath(workspaceId, pathValue)
    const cwd = await this.runner.repositoryRoot(workspaceId)
    const status = parsePorcelainStatus((await this.runner.run(cwd, [
      'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', path,
    ])).stdout).find(file => file.path === path)
    if (status === undefined) throw new WorkbenchHttpError(404, 'GIT_CHANGE_NOT_FOUND', '找不到该文件的 Git 变更。')

    const staged = stagedValue === true
    if (staged && !isStaged(status)) throw new WorkbenchHttpError(409, 'GIT_CHANGE_NOT_STAGED', '该文件没有已暂存变更。')
    if (!staged && !hasWorktreeChange(status)) throw new WorkbenchHttpError(409, 'GIT_CHANGE_NOT_WORKTREE', '该文件没有工作区变更。')

    const [original, modified] = staged
      ? await this.stagedSides(cwd, status)
      : await this.worktreeSides(workspaceId, cwd, status)
    const stat = await this.changeStat(cwd, path, staged, status, modified)
    this.ctx.logger.info(`workbench-layout: opened ${staged ? 'staged' : 'worktree'} Git diff for ${JSON.stringify(path)}`)
    return this.buildFileDiff({
      kind: staged ? 'staged' : 'worktree',
      path,
      originalPath: status.originalPath,
      status: normalizeStatus(staged ? status.index : status.worktree),
      original,
      modified,
      stat,
    })
  }

  /** Return the HEAD-side text used by editable source-line Git decorations. */
  async editorBaseline(workspaceId: unknown, pathValue: unknown): Promise<GitEditorBaseline> {
    const path = await this.workspace.assertGitPath(workspaceId, pathValue)
    let cwd: string
    try {
      cwd = await this.runner.repositoryRoot(workspaceId)
    } catch (error) {
      if (error instanceof WorkbenchHttpError && error.code === 'GIT_UNAVAILABLE') {
        return { path, available: false, original: '', binary: false }
      }
      throw error
    }
    const head = await this.runner.headRevision(cwd)
    const status = parsePorcelainStatus((await this.runner.run(cwd, [
      'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', path,
    ])).stdout).find(file => file.path === path)
    if (status?.index === '?' || status?.index === 'A' || head === undefined) {
      this.ctx.logger.info(`workbench-layout: loaded empty Git editor baseline for ${JSON.stringify(path)}`)
      return {
        path,
        available: status !== undefined,
        original: '',
        binary: false,
        ...(head === undefined ? {} : { revision: head }),
      }
    }
    if (status === undefined) {
      const tracked = await this.runner.run(cwd, ['ls-files', '--error-unmatch', '--', path], [0, 1])
      if (tracked.exitCode !== 0) {
        this.ctx.logger.info(`workbench-layout: skipped Git editor baseline for untracked ignored path ${JSON.stringify(path)}`)
        return { path, available: false, original: '', binary: false, revision: head }
      }
    }
    const original = await this.runner.readGitBlobMaybe(cwd, `HEAD:${status?.originalPath ?? path}`)
    this.ctx.logger.info(`workbench-layout: loaded Git editor baseline for ${JSON.stringify(path)} from HEAD`)
    return {
      path,
      available: true,
      original: original.binary ? '' : original.text,
      binary: original.binary,
      revision: head,
    }
  }

  async graph(workspaceId: unknown, offsetValue: unknown = 0): Promise<GitGraph> {
    const offset = graphOffset(offsetValue)
    const cwd = await this.runner.repositoryRoot(workspaceId)
    if (!await this.runner.hasHead(cwd)) return { commits: [], truncated: false, nextOffset: offset }
    const result = await this.runner.run(cwd, [
      'log', '--all', '--topo-order', `--skip=${offset}`, '-n', String(GIT_GRAPH_PAGE_SIZE + 1), '--date=iso-strict', '--decorate=full',
      '--shortstat', '--diff-merges=first-parent',
      '--format=%x1e%H%x00%h%x00%P%x00%an%x00%aI%x00%s%x00%D%x00',
    ], [0], { LC_ALL: 'C', LANG: 'C' })
    const commits = parseGitGraphWithStats(result.stdout)
    const visible = commits.slice(0, GIT_GRAPH_PAGE_SIZE)
    const graph = { commits: visible, truncated: commits.length > GIT_GRAPH_PAGE_SIZE, nextOffset: offset + visible.length }
    this.ctx.logger.info(`workbench-layout: loaded Git graph page at offset ${offset} with ${visible.length} commits; older commits ${graph.truncated ? 'remain' : 'exhausted'}`)
    return graph
  }

  async branches(workspaceId: unknown): Promise<GitBranches> {
    const cwd = await this.runner.repositoryRoot(workspaceId)
    const result = await this.runner.run(cwd, [
      'for-each-ref',
      '--format=%(refname)%00%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(symref)',
      'refs/heads', 'refs/remotes',
    ])
    const branches = parseGitBranches(result.stdout)
    const current = branches.find(branch => branch.current)?.name
    return {
      ...(current === undefined ? {} : { current }),
      detached: current === undefined && await this.runner.hasHead(cwd),
      branches,
    }
  }

  async switchBranch(workspaceId: unknown, refValue: unknown): Promise<GitStatus> {
    if (typeof refValue !== 'string' || refValue === '') {
      throw new WorkbenchHttpError(400, 'GIT_BRANCH_REQUIRED', '请选择要切换的分支。')
    }
    const cwd = await this.runner.repositoryRoot(workspaceId)
    const available = await this.branches(workspaceId)
    const target = available.branches.find(branch => branch.ref === refValue)
    if (target === undefined) throw new WorkbenchHttpError(404, 'GIT_BRANCH_NOT_FOUND', '找不到所选分支。')
    if (target.current) return this.status(workspaceId)

    if (target.kind === 'local') {
      await this.runner.run(cwd, ['switch', '--', target.name])
    } else {
      const remoteNames = (await this.runner.run(cwd, ['remote'])).stdout.split(/\r?\n/u)
        .map(name => name.trim()).filter(name => name !== '').sort((left, right) => right.length - left.length)
      const remote = remoteNames.find(name => target.ref.startsWith(`refs/remotes/${name}/`))
      if (remote === undefined) throw new WorkbenchHttpError(409, 'GIT_REMOTE_UNAVAILABLE', '所选远程分支的远程地址已不存在。')
      const localName = target.ref.slice(`refs/remotes/${remote}/`.length)
      const local = available.branches.find(branch => branch.kind === 'local' && branch.name === localName)
      if (local === undefined) await this.runner.run(cwd, ['switch', '--track', '--', target.name])
      else await this.runner.run(cwd, ['switch', '--', local.name])
    }
    this.ctx.logger.info(`workbench-layout: switched Git branch to ${JSON.stringify(target.name)}`)
    return this.status(workspaceId)
  }

  async createBranch(workspaceId: unknown, nameValue: unknown, sourceValue?: unknown): Promise<GitStatus> {
    const cwd = await this.runner.repositoryRoot(workspaceId)
    const name = await this.runner.requireBranchName(cwd, nameValue)
    let source: string | undefined
    if (sourceValue !== undefined) {
      if (typeof sourceValue !== 'string' || sourceValue === '') {
        throw new WorkbenchHttpError(400, 'GIT_BRANCH_SOURCE_REQUIRED', '请选择新分支的来源。')
      }
      const available = await this.branches(workspaceId)
      const branch = available.branches.find(candidate => candidate.ref === sourceValue)
      if (branch !== undefined) source = branch.ref
      else if (REVISION_PATTERN.test(sourceValue)) {
        const revision = await this.runner.run(cwd, ['rev-parse', '--verify', `${sourceValue}^{commit}`], [0, 1, 128])
        if (revision.exitCode === 0) source = sourceValue
      }
      if (source === undefined) throw new WorkbenchHttpError(404, 'GIT_BRANCH_SOURCE_NOT_FOUND', '找不到新分支的来源。')
    }
    await this.runner.run(cwd, source === undefined ? ['switch', '-c', name] : ['switch', '-c', name, source])
    this.ctx.logger.info(`workbench-layout: created and switched to Git branch ${JSON.stringify(name)}`)
    return this.status(workspaceId)
  }

  async renameBranch(workspaceId: unknown, nameValue: unknown): Promise<GitStatus> {
    const cwd = await this.runner.repositoryRoot(workspaceId)
    const status = await this.status(workspaceId)
    if (status.branch === undefined) {
      throw new WorkbenchHttpError(409, 'GIT_BRANCH_CURRENT_UNAVAILABLE', '游离 HEAD 状态下不能重命名当前分支。')
    }
    if (typeof nameValue === 'string' && nameValue.trim() === status.branch) return status
    const name = await this.runner.requireBranchName(cwd, nameValue)
    await this.runner.run(cwd, ['branch', '-m', '--', name])
    this.ctx.logger.info(`workbench-layout: renamed current Git branch to ${JSON.stringify(name)}`)
    return this.status(workspaceId)
  }

  async deleteBranch(workspaceId: unknown, refValue: unknown): Promise<GitStatus> {
    if (typeof refValue !== 'string' || refValue === '') {
      throw new WorkbenchHttpError(400, 'GIT_BRANCH_REQUIRED', '请选择要删除的本地分支。')
    }
    const cwd = await this.runner.repositoryRoot(workspaceId)
    const available = await this.branches(workspaceId)
    const target = available.branches.find(branch => branch.ref === refValue && branch.kind === 'local')
    if (target === undefined) throw new WorkbenchHttpError(404, 'GIT_BRANCH_NOT_FOUND', '找不到要删除的本地分支。')
    if (target.current) throw new WorkbenchHttpError(409, 'GIT_BRANCH_CURRENT_DELETE', '不能删除当前分支。')
    await this.runner.run(cwd, ['branch', '-d', '--', target.name])
    this.ctx.logger.info(`workbench-layout: safely deleted Git branch ${JSON.stringify(target.name)}`)
    return this.status(workspaceId)
  }

  async remoteOperation(workspaceId: unknown, operationValue: unknown): Promise<GitRemoteResult> {
    if (typeof operationValue !== 'string' || !REMOTE_OPERATIONS.has(operationValue as GitRemoteOperation)) {
      throw new WorkbenchHttpError(400, 'GIT_REMOTE_OPERATION_INVALID', '不支持该远程 Git 操作。')
    }
    const operation = operationValue as GitRemoteOperation
    const cwd = await this.runner.repositoryRoot(workspaceId)
    const status = await this.status(workspaceId)
    if (status.hasRemote !== true) throw new WorkbenchHttpError(409, 'GIT_REMOTE_UNAVAILABLE', '当前仓库没有配置远程地址。')
    if ((operation === 'pull' || operation === 'sync') && status.upstream === undefined) {
      throw new WorkbenchHttpError(409, 'GIT_UPSTREAM_UNAVAILABLE', '当前分支没有配置上游分支。')
    }

    if (operation === 'fetch') await this.runner.run(cwd, ['fetch', '--all', '--prune'])
    if (operation === 'pull' || operation === 'sync') await this.runner.run(cwd, ['pull', '--ff-only'])
    if (operation === 'push' && status.upstream === undefined) {
      if (status.branch === undefined || status.remotes?.length !== 1) {
        throw new WorkbenchHttpError(409, 'GIT_UPSTREAM_UNAVAILABLE', '当前分支没有上游；存在多个远程时不会自动选择推送目标。')
      }
      await this.runner.run(cwd, ['push', '--set-upstream', '--', status.remotes[0]!, status.branch])
    } else if (operation === 'push' || operation === 'sync') {
      await this.runner.run(cwd, ['push'])
    }
    this.ctx.logger.info(`workbench-layout: completed explicit Git remote operation ${operation}`)
    return { operation }
  }

  async remotes(workspaceId: unknown): Promise<GitRemotes> {
    const cwd = await this.runner.repositoryRoot(workspaceId)
    const names = await this.runner.remoteNames(cwd)
    const remotes: GitRemote[] = []
    for (const name of names) {
      const fetchUrl = (await this.runner.run(cwd, ['config', '--get', `remote.${name}.url`], [0, 1])).stdout.trim()
      const pushConfig = (await this.runner.run(cwd, ['config', '--get', `remote.${name}.pushurl`], [0, 1])).stdout.trim()
      remotes.push({
        name,
        fetchUrl,
        pushUrl: pushConfig === '' ? fetchUrl : pushConfig,
        separatePushUrl: pushConfig !== '',
      })
    }
    return { remotes }
  }

  async addRemote(workspaceId: unknown, nameValue: unknown, fetchUrlValue: unknown, pushUrlValue?: unknown): Promise<GitRemotes> {
    const cwd = await this.runner.repositoryRoot(workspaceId)
    const name = await this.runner.requireRemoteName(cwd, nameValue)
    const fetchUrl = requireRemoteUrl(fetchUrlValue)
    const pushUrl = requireOptionalRemoteUrl(pushUrlValue)
    await this.runner.run(cwd, ['remote', 'add', '--', name, fetchUrl])
    try {
      if (pushUrl !== undefined && pushUrl !== fetchUrl) await this.runner.run(cwd, ['remote', 'set-url', '--push', name, pushUrl])
    } catch (error: unknown) {
      await this.runner.run(cwd, ['remote', 'remove', name], [0, 2, 128])
      throw error
    }
    this.ctx.logger.info(`workbench-layout: added Git remote ${JSON.stringify(name)}`)
    return this.remotes(workspaceId)
  }

  async updateRemote(
    workspaceId: unknown,
    currentNameValue: unknown,
    nameValue: unknown,
    fetchUrlValue: unknown,
    pushUrlValue?: unknown,
  ): Promise<GitRemotes> {
    const cwd = await this.runner.repositoryRoot(workspaceId)
    const currentName = await this.runner.requireRemote(cwd, currentNameValue)
    const name = typeof nameValue === 'string' && nameValue.trim() === currentName
      ? currentName
      : await this.runner.requireRemoteName(cwd, nameValue)
    const fetchUrl = requireRemoteUrl(fetchUrlValue)
    const pushUrl = requireOptionalRemoteUrl(pushUrlValue)
    await this.runner.run(cwd, ['remote', 'set-url', currentName, fetchUrl])
    if (pushUrl === undefined || pushUrl === fetchUrl) {
      await this.runner.run(cwd, ['config', '--unset-all', `remote.${currentName}.pushurl`], [0, 5])
    } else {
      await this.runner.run(cwd, ['remote', 'set-url', '--push', currentName, pushUrl])
    }
    if (name !== currentName) await this.runner.run(cwd, ['remote', 'rename', currentName, name])
    this.ctx.logger.info(`workbench-layout: updated Git remote ${JSON.stringify(currentName)} as ${JSON.stringify(name)}`)
    return this.remotes(workspaceId)
  }

  async deleteRemote(workspaceId: unknown, nameValue: unknown): Promise<GitRemotes> {
    const cwd = await this.runner.repositoryRoot(workspaceId)
    const name = await this.runner.requireRemote(cwd, nameValue)
    await this.runner.run(cwd, ['remote', 'remove', name])
    this.ctx.logger.info(`workbench-layout: removed Git remote ${JSON.stringify(name)}`)
    return this.remotes(workspaceId)
  }

  async targetRemoteOperation(
    workspaceId: unknown,
    operationValue: unknown,
    remoteValue: unknown,
    branchValue?: unknown,
  ): Promise<GitTargetRemoteResult> {
    if (typeof operationValue !== 'string' || !TARGET_REMOTE_OPERATIONS.has(operationValue as GitTargetRemoteOperation)) {
      throw new WorkbenchHttpError(400, 'GIT_REMOTE_OPERATION_INVALID', '不支持该指定远端 Git 操作。')
    }
    const operation = operationValue as GitTargetRemoteOperation
    const cwd = await this.runner.repositoryRoot(workspaceId)
    const remote = await this.runner.requireRemote(cwd, remoteValue)
    if (operation === 'fetch') {
      await this.runner.run(cwd, ['fetch', '--prune', '--', remote])
      this.ctx.logger.info(`workbench-layout: fetched explicit Git remote ${JSON.stringify(remote)}`)
      return { operation, remote }
    }
    const status = await this.status(workspaceId)
    if (status.branch === undefined) {
      throw new WorkbenchHttpError(409, 'GIT_BRANCH_CURRENT_UNAVAILABLE', '游离 HEAD 状态下不能拉取或推送当前分支。')
    }
    const branch = await this.runner.requireRefName(cwd, branchValue ?? status.branch)
    if (operation === 'pull') await this.runner.run(cwd, ['pull', '--ff-only', '--', remote, branch])
    else await this.runner.run(cwd, ['push', '--set-upstream', '--', remote, `${status.branch}:${branch}`])
    this.ctx.logger.info(`workbench-layout: completed explicit Git ${operation} with remote ${JSON.stringify(remote)} branch ${JSON.stringify(branch)}`)
    return { operation, remote, branch }
  }

  async commitFiles(workspaceId: unknown, revisionValue: unknown): Promise<GitCommitFiles> {
    const cwd = await this.runner.repositoryRoot(workspaceId)
    const details = await this.loadCommitFiles(cwd, revisionValue)
    this.ctx.logger.info(`workbench-layout: listed files for Git commit ${details.commit.shortHash}`)
    return details
  }

  async commitFileDiff(workspaceId: unknown, revisionValue: unknown, pathValue: unknown): Promise<GitFileDiff> {
    const path = await this.workspace.assertGitPath(workspaceId, pathValue)
    const cwd = await this.runner.repositoryRoot(workspaceId)
    const details = await this.loadCommitFiles(cwd, revisionValue)
    const file = details.files.find(candidate => candidate.path === path)
    if (file === undefined) throw new WorkbenchHttpError(404, 'GIT_COMMIT_FILE_NOT_FOUND', '该提交中找不到所选文件。')
    if (file.originalPath !== undefined) await this.workspace.assertGitPath(workspaceId, file.originalPath)

    const original = details.parentRevision === undefined || file.status === 'A'
      ? emptyGitText()
      : await this.runner.readGitBlob(cwd, `${details.parentRevision}:${file.originalPath ?? file.path}`)
    const modified = file.status === 'D'
      ? emptyGitText()
      : await this.runner.readGitBlob(cwd, `${details.commit.hash}:${file.path}`)
    const stat = await this.commitStat(cwd, details, file)
    this.ctx.logger.info(`workbench-layout: opened Git commit file diff ${details.commit.shortHash} ${JSON.stringify(path)}`)
    return this.buildFileDiff({
      kind: 'commit',
      path: file.path,
      originalPath: file.originalPath,
      status: normalizeStatus(file.status),
      revision: details.commit.hash,
      parentRevision: details.parentRevision,
      commit: details.commit,
      original,
      modified,
      stat,
    })
  }

  async comparisonFiles(workspaceId: unknown, revisionValue: unknown): Promise<GitCommitFiles> {
    const cwd = await this.runner.repositoryRoot(workspaceId)
    const revision = requireRevision(revisionValue)
    const commit = await this.loadCommit(cwd, revision)
    const files = parseGitNameStatus((await this.runner.run(cwd, [
      'diff', '--name-status', '-z', '--find-renames', '--find-copies', revision, '--',
    ])).stdout)
    const listed = new Set(files.map(file => file.path))
    const untracked = (await this.status(workspaceId)).files
      .filter(file => file.index === '?' && !listed.has(file.path))
      .map(file => ({ path: file.path, status: 'A' }))
    this.ctx.logger.info(`workbench-layout: compared Git commit ${commit.shortHash} with the current workspace`)
    return { commit, files: [...files, ...untracked] }
  }

  async comparisonFileDiff(workspaceId: unknown, revisionValue: unknown, pathValue: unknown): Promise<GitFileDiff> {
    const path = await this.workspace.assertGitPath(workspaceId, pathValue)
    const cwd = await this.runner.repositoryRoot(workspaceId)
    const details = await this.comparisonFiles(workspaceId, revisionValue)
    const file = details.files.find(candidate => candidate.path === path)
    if (file === undefined) throw new WorkbenchHttpError(404, 'GIT_CHANGE_NOT_FOUND', '该文件不在提交与当前工作区的比较中。')
    const original = await this.runner.readGitBlobMaybe(cwd, `${details.commit.hash}:${file.originalPath ?? file.path}`)
    const modified = file.status === 'D' ? emptyGitText() : await this.workspace.readGitText(workspaceId, file.path)
    const stat = original.text === '' && !original.binary && file.status === 'A'
      ? modified.binary ? { path, binary: true } : { path, additions: contentLineCount(modified.text), deletions: 0, binary: false }
      : parseGitNumstat((await this.runner.run(cwd, [
          'diff', '--numstat', '-z', '--find-renames', '--find-copies', details.commit.hash, '--',
          ...file.originalPath === undefined ? [file.path] : [file.originalPath, file.path],
        ])).stdout)[0]
    this.ctx.logger.info(`workbench-layout: opened workspace comparison for ${details.commit.shortHash} ${JSON.stringify(path)}`)
    return this.buildFileDiff({
      kind: 'comparison',
      path,
      originalPath: file.originalPath,
      status: normalizeStatus(file.status),
      revision: details.commit.hash,
      commit: details.commit,
      original,
      modified,
      stat,
    })
  }

  async commitAction(workspaceId: unknown, operationValue: unknown, revisionValue: unknown): Promise<GitCommitActionResult> {
    if (typeof operationValue !== 'string' || !COMMIT_ACTIONS.has(operationValue as GitCommitAction)) {
      throw new WorkbenchHttpError(400, 'GIT_COMMIT_ACTION_INVALID', '不支持该提交操作。')
    }
    const operation = operationValue as GitCommitAction
    const revision = requireRevision(revisionValue)
    const cwd = await this.runner.repositoryRoot(workspaceId)
    const commit = await this.loadCommit(cwd, revision)
    if ((await this.status(workspaceId)).files.length > 0) {
      throw new WorkbenchHttpError(409, 'GIT_WORKTREE_NOT_CLEAN', '请先提交、暂存或放弃当前更改，再执行提交操作。')
    }
    try {
      const result = await this.runner.run(cwd, operation === 'cherry-pick'
        ? ['cherry-pick', revision]
        : ['revert', '--no-edit', revision])
      const summary = result.stdout.trim().split(/\r?\n/u)[0] ?? `${operation} completed`
      this.ctx.logger.info(`workbench-layout: completed explicit Git ${operation} for ${commit.shortHash}`)
      return { operation, summary }
    } catch (error: unknown) {
      await this.runner.run(cwd, [operation, '--abort'], [0, 128])
      this.ctx.logger.info(`workbench-layout: aborted conflicted Git ${operation} for ${commit.shortHash}`)
      throw error
    }
  }

  /** Run fixed Git commands from the repository root, then return the refreshed status. */
  private async mutate(workspaceId: unknown, logMessage: string, commands: string[][]): Promise<GitStatus> {
    const cwd = await this.runner.repositoryRoot(workspaceId)
    for (const command of commands) await this.runner.run(cwd, command)
    this.ctx.logger.info(`workbench-layout: ${logMessage}`)
    return this.status(workspaceId)
  }

  async stage(workspaceId: unknown, pathValue: unknown): Promise<GitStatus> {
    const path = await this.workspace.assertGitPath(workspaceId, pathValue)
    return this.mutate(workspaceId, `staged Git path ${JSON.stringify(path)}`, [['add', '--', path]])
  }

  async stageAll(workspaceId: unknown): Promise<GitStatus> {
    return this.mutate(workspaceId, 'staged all Git changes', [['add', '-A', '--', '.']])
  }

  async unstage(workspaceId: unknown, pathValue: unknown): Promise<GitStatus> {
    const path = await this.workspace.assertGitPath(workspaceId, pathValue)
    const cwd = await this.runner.repositoryRoot(workspaceId)
    if (await this.runner.hasHead(cwd)) {
      await this.runner.run(cwd, ['restore', '--staged', '--', path])
    } else {
      await this.runner.run(cwd, ['rm', '--cached', '--ignore-unmatch', '--', path])
    }
    this.ctx.logger.info(`workbench-layout: unstaged Git path ${JSON.stringify(path)}`)
    return this.status(workspaceId)
  }

  async unstageAll(workspaceId: unknown): Promise<GitStatus> {
    const cwd = await this.runner.repositoryRoot(workspaceId)
    if (await this.runner.hasHead(cwd)) {
      await this.runner.run(cwd, ['restore', '--staged', '--', '.'])
    } else {
      await this.runner.run(cwd, ['rm', '--cached', '-r', '--ignore-unmatch', '--', '.'])
    }
    this.ctx.logger.info('workbench-layout: unstaged all Git changes')
    return this.status(workspaceId)
  }

  async discard(workspaceId: unknown, pathValue: unknown): Promise<GitStatus> {
    const path = await this.workspace.assertGitPath(workspaceId, pathValue)
    const cwd = await this.runner.repositoryRoot(workspaceId)
    const file = (await this.status(workspaceId)).files.find(candidate => candidate.path === path)
    if (file === undefined || !hasWorktreeChange(file)) {
      throw new WorkbenchHttpError(404, 'GIT_CHANGE_NOT_WORKTREE', '该文件没有可放弃的工作区更改。')
    }
    if (file.index === '?') await this.runner.run(cwd, ['clean', '-f', '--', path])
    else await this.runner.run(cwd, ['restore', '--worktree', '--', path])
    this.ctx.logger.info(`workbench-layout: discarded Git worktree change for ${JSON.stringify(path)}`)
    return this.status(workspaceId)
  }

  async discardAll(workspaceId: unknown): Promise<GitStatus> {
    return this.mutate(workspaceId, 'discarded all Git worktree changes and untracked files', [['restore', '--worktree', '--', '.'], ['clean', '-fd', '--', '.']])
  }

  async commit(workspaceId: unknown, messageValue: unknown): Promise<GitCommitResult> {
    if (typeof messageValue !== 'string' || messageValue.trim() === '') {
      throw new WorkbenchHttpError(400, 'COMMIT_MESSAGE_REQUIRED', '请输入提交说明。')
    }
    const message = messageValue.trim()
    if (message.length > 5000) throw new WorkbenchHttpError(400, 'COMMIT_MESSAGE_TOO_LONG', '提交说明过长。')
    const cwd = await this.runner.repositoryRoot(workspaceId)
    const result = await this.runner.run(cwd, ['commit', '-m', message])
    const summary = result.stdout.trim().split(/\r?\n/u)[0] ?? 'Git 提交完成。'
    this.ctx.logger.info('workbench-layout: Git commit created from explicit user action')
    return { summary }
  }

  /** 统一构造 GitFileDiff：收敛 binary 判定与可选字段的条件展开样板。 */
  private buildFileDiff(input: {
    kind: GitFileDiff['kind']
    path: string
    status: GitFileDiff['status']
    original: GitText
    modified: GitText | WorkspaceGitText
    originalPath?: string | undefined
    revision?: string | undefined
    parentRevision?: string | undefined
    commit?: GitCommit | undefined
    stat?: GitNumstat | undefined
  }): GitFileDiff {
    const binary = input.original.binary || input.modified.binary || input.stat?.binary === true
    return {
      kind: input.kind,
      path: input.path,
      ...(input.originalPath === undefined ? {} : { originalPath: input.originalPath }),
      status: input.status,
      ...(input.revision === undefined ? {} : { revision: input.revision }),
      ...(input.parentRevision === undefined ? {} : { parentRevision: input.parentRevision }),
      ...(input.commit === undefined ? {} : { commit: input.commit }),
      original: binary ? '' : input.original.text,
      modified: binary ? '' : input.modified.text,
      binary,
      ...(input.stat?.additions === undefined ? {} : { additions: input.stat.additions }),
      ...(input.stat?.deletions === undefined ? {} : { deletions: input.stat.deletions }),
    }
  }

  private async stagedSides(cwd: string, file: GitFileStatus): Promise<[GitText, GitText]> {
    const original = !await this.runner.hasHead(cwd) || file.index === 'A'
      ? emptyGitText()
      : await this.runner.readGitBlobMaybe(cwd, `HEAD:${file.originalPath ?? file.path}`)
    const modified = file.index === 'D'
      ? emptyGitText()
      : await this.runner.readGitBlob(cwd, `:${file.path}`)
    return [original, modified]
  }

  private async worktreeSides(workspaceId: unknown, cwd: string, file: GitFileStatus): Promise<[GitText, WorkspaceGitText]> {
    const conflict = isConflict(file)
    const original = file.index === '?'
      ? emptyGitText()
      : conflict
        ? await this.runner.readGitBlobMaybe(cwd, `HEAD:${file.originalPath ?? file.path}`)
        : await this.runner.readGitBlob(cwd, `:${file.originalPath ?? file.path}`)
    const modified = file.worktree === 'D'
      ? emptyGitText()
      : await this.workspace.readGitText(workspaceId, file.path)
    return [original, modified]
  }

  private async changeStat(
    cwd: string,
    path: string,
    staged: boolean,
    file: GitFileStatus,
    modified: WorkspaceGitText,
  ): Promise<GitNumstat | undefined> {
    if (!staged && file.index === '?') {
      return modified.binary
        ? { path, binary: true }
        : { path, additions: contentLineCount(modified.text), deletions: 0, binary: false }
    }
    const args = staged
      ? ['diff', '--cached', '--numstat', '-z', '--no-ext-diff', '--', path]
      : ['diff', '--numstat', '-z', '--no-ext-diff', '--', path]
    return parseGitNumstat((await this.runner.run(cwd, args)).stdout)[0]
  }

  private async loadCommitFiles(cwd: string, revisionValue: unknown): Promise<GitCommitFiles> {
    const revision = requireRevision(revisionValue)
    const commit = await this.loadCommit(cwd, revision)
    const parentRevision = commit.parents[0]
    const result = parentRevision === undefined
      ? await this.runner.run(cwd, [
          'diff-tree', '--root', '--no-commit-id', '--name-status', '-z', '-r',
          '--find-renames', '--find-copies', commit.hash, '--',
        ])
      : await this.runner.run(cwd, [
          'diff', '--name-status', '-z', '--find-renames', '--find-copies',
          parentRevision, commit.hash, '--',
        ])
    return {
      commit,
      ...(parentRevision === undefined ? {} : { parentRevision }),
      files: parseGitNameStatus(result.stdout),
    }
  }

  private async loadCommit(cwd: string, revision: string): Promise<GitCommit> {
    const metadata = await this.runner.run(cwd, [
      'show', '-s', '--date=iso-strict', '--decorate=full',
      '--format=%H%x00%h%x00%P%x00%an%x00%aI%x00%s%x00%D', revision,
    ])
    const commit = parseGitGraph(metadata.stdout)[0]
    if (commit === undefined) throw new WorkbenchHttpError(404, 'GIT_COMMIT_NOT_FOUND', '找不到该提交。')
    return commit
  }

  private async commitStat(cwd: string, details: GitCommitFiles, file: GitCommitFile): Promise<GitNumstat | undefined> {
    const paths = file.originalPath === undefined ? [file.path] : [file.originalPath, file.path]
    const result = details.parentRevision === undefined
      ? await this.runner.run(cwd, [
          'show', '--format=', '--numstat', '-z', '--find-renames', '--find-copies',
          details.commit.hash, '--', ...paths,
        ])
      : await this.runner.run(cwd, [
          'diff', '--numstat', '-z', '--find-renames', '--find-copies',
          details.parentRevision, details.commit.hash, '--', ...paths,
        ])
    return parseGitNumstat(result.stdout)[0]
  }

}

function graphOffset(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new WorkbenchHttpError(400, 'GIT_GRAPH_OFFSET_INVALID', '提交图分页位置无效。')
  }
  return value
}

function requireRevision(value: unknown): string {
  if (typeof value !== 'string' || !REVISION_PATTERN.test(value)) {
    throw new WorkbenchHttpError(400, 'GIT_REVISION_INVALID', '提交版本无效。')
  }
  return value
}

function requireRemoteUrl(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 4096 || /[\0\r\n]/u.test(value)) {
    throw new WorkbenchHttpError(400, 'GIT_REMOTE_URL_INVALID', '请输入有效的远端地址。')
  }
  return value.trim()
}

function requireOptionalRemoteUrl(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return requireRemoteUrl(value)
}

function isStaged(file: GitFileStatus): boolean {
  return file.index !== ' ' && file.index !== '?'
}

function hasWorktreeChange(file: GitFileStatus): boolean {
  return file.worktree !== ' ' || file.index === '?'
}

function isConflict(file: GitFileStatus): boolean {
  return file.index === 'U' || file.worktree === 'U'
    || (file.index === 'A' && file.worktree === 'A')
    || (file.index === 'D' && file.worktree === 'D')
}

function normalizeStatus(status: string): string {
  return status === '?' ? 'U' : status === ' ' ? 'M' : status
}

function contentLineCount(text: string): number {
  if (text === '') return 0
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n').length
}
