/** 直接执行 Git 命令的低层封装：进程调用、仓库定位、blob 读取与引用校验。 */

import { execFile } from 'node:child_process'
import { relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { WorkbenchHttpError } from '../http.ts'
import type { GitLimits } from '../git-backend.ts'
import type { WorkspaceBackend } from '../workspace-backend.ts'

const execFileAsync = promisify(execFile)

export interface GitText {
  text: string
  binary: boolean
}

interface GitRunResult {
  stdout: string
  stderr: string
  exitCode: number
}

interface GitBytesResult {
  stdout: Buffer
  stderr: Buffer
}

function nonInteractiveGitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
  }
}

function failureFields(error: unknown): { exitCode?: number; stdout: string; stderr: string } {
  const failure = error !== null && typeof error === 'object'
    ? error as { code?: unknown; stdout?: unknown; stderr?: unknown }
    : undefined
  return {
    ...(typeof failure?.code === 'number' ? { exitCode: failure.code } : {}),
    stdout: typeof failure?.stdout === 'string' ? failure.stdout : '',
    stderr: typeof failure?.stderr === 'string' ? failure.stderr : '',
  }
}

export function emptyGitText(): GitText {
  return { text: '', binary: false }
}

export class GitRunner {
  constructor(
    private readonly ctx: Context,
    private readonly workspace: WorkspaceBackend,
    private readonly limits: GitLimits,
  ) {}

  async readGitBlobMaybe(cwd: string, spec: string): Promise<GitText> {
    const exists = await this.run(cwd, ['cat-file', '-e', spec], [0, 1, 128])
    return exists.exitCode === 0 ? this.readGitBlob(cwd, spec) : emptyGitText()
  }

  async readGitBlob(cwd: string, spec: string): Promise<GitText> {
    const sizeText = (await this.run(cwd, ['cat-file', '-s', spec])).stdout.trim()
    const size = Number(sizeText)
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new WorkbenchHttpError(502, 'GIT_BLOB_SIZE_INVALID', 'Git 返回了无效的文件大小。')
    }
    if (size > this.limits.maxOutputBytes) {
      throw new WorkbenchHttpError(413, 'GIT_DIFF_TOO_LARGE', '文件超过 Diff 视图允许的大小。')
    }
    const bytes = (await this.runBytes(cwd, ['cat-file', 'blob', spec])).stdout
    if (bytes.includes(0)) return { text: '', binary: true }
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), binary: false }
    } catch {
      return { text: '', binary: true }
    }
  }

  async repositoryRoot(workspaceId: unknown): Promise<string> {
    const workspace = await this.workspace.rootProcessPath(workspaceId)
    let top: GitRunResult
    try {
      top = await this.run(workspace.cwd, ['rev-parse', '--show-toplevel'])
    } catch {
      throw new WorkbenchHttpError(409, 'GIT_UNAVAILABLE', '当前工作区不是 Git 仓库。')
    }
    const repo = resolve(top.stdout.trim())
    const root = resolve(workspace.cwd)
    if (relative(root, repo) !== '') {
      throw new WorkbenchHttpError(409, 'GIT_UNAVAILABLE', '请从 Git 仓库根目录打开工作区。')
    }
    return repo
  }

  async hasHead(cwd: string): Promise<boolean> {
    return await this.headRevision(cwd) !== undefined
  }

  async headRevision(cwd: string): Promise<string | undefined> {
    const result = await this.run(cwd, ['rev-parse', '--verify', 'HEAD'], [0, 1, 128])
    const revision = result.stdout.trim()
    return result.exitCode === 0 && revision !== '' ? revision : undefined
  }

  async requireBranchName(cwd: string, value: unknown): Promise<string> {
    if (typeof value !== 'string' || value.trim() === '' || value.length > 255) {
      throw new WorkbenchHttpError(400, 'GIT_BRANCH_NAME_INVALID', '请输入有效的分支名称。')
    }
    const name = value.trim()
    const valid = await this.run(cwd, ['check-ref-format', '--branch', name], [0, 1, 128])
    if (valid.exitCode !== 0) throw new WorkbenchHttpError(400, 'GIT_BRANCH_NAME_INVALID', '分支名称不符合 Git 规则。')
    const exists = await this.run(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`], [0, 1, 128])
    if (exists.exitCode === 0) throw new WorkbenchHttpError(409, 'GIT_BRANCH_EXISTS', '同名本地分支已经存在。')
    return name
  }

  async remoteNames(cwd: string): Promise<string[]> {
    return (await this.run(cwd, ['remote'])).stdout.split(/\r?\n/u).map(name => name.trim()).filter(name => name !== '')
  }

  async requireRemote(cwd: string, value: unknown): Promise<string> {
    if (typeof value !== 'string' || value === '') {
      throw new WorkbenchHttpError(400, 'GIT_REMOTE_REQUIRED', '请选择远端。')
    }
    const name = (await this.remoteNames(cwd)).find(candidate => candidate === value)
    if (name === undefined) throw new WorkbenchHttpError(404, 'GIT_REMOTE_UNAVAILABLE', '找不到所选远端。')
    return name
  }

  async requireRemoteName(cwd: string, value: unknown): Promise<string> {
    if (typeof value !== 'string' || value.trim() === '' || value.length > 255) {
      throw new WorkbenchHttpError(400, 'GIT_REMOTE_NAME_INVALID', '请输入有效的远端名称。')
    }
    const name = value.trim()
    const valid = await this.run(cwd, ['check-ref-format', `refs/remotes/${name}/probe`], [0, 1, 128])
    if (valid.exitCode !== 0) throw new WorkbenchHttpError(400, 'GIT_REMOTE_NAME_INVALID', '远端名称不符合 Git 规则。')
    if ((await this.remoteNames(cwd)).includes(name)) {
      throw new WorkbenchHttpError(409, 'GIT_REMOTE_EXISTS', '同名远端已经存在。')
    }
    return name
  }

  async requireRefName(cwd: string, value: unknown): Promise<string> {
    if (typeof value !== 'string' || value.trim() === '' || value.length > 255) {
      throw new WorkbenchHttpError(400, 'GIT_BRANCH_NAME_INVALID', '请输入有效的远端分支名称。')
    }
    const name = value.trim()
    const valid = await this.run(cwd, ['check-ref-format', '--branch', name], [0, 1, 128])
    if (valid.exitCode !== 0) throw new WorkbenchHttpError(400, 'GIT_BRANCH_NAME_INVALID', '远端分支名称不符合 Git 规则。')
    return name
  }

  async run(
    cwd: string,
    args: string[],
    acceptedExitCodes: readonly number[] = [0],
    environment: NodeJS.ProcessEnv = {},
  ): Promise<GitRunResult> {
    try {
      const result = await execFileAsync('git', ['-C', cwd, ...args], {
        encoding: 'utf8',
        env: { ...nonInteractiveGitEnvironment(), ...environment },
        maxBuffer: this.limits.maxOutputBytes,
        timeout: this.limits.timeoutMs,
        windowsHide: true,
      })
      return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 }
    } catch (error: unknown) {
      const failure = failureFields(error)
      if (failure.exitCode !== undefined && acceptedExitCodes.includes(failure.exitCode)) {
        return { stdout: failure.stdout, stderr: failure.stderr, exitCode: failure.exitCode }
      }
      throw this.gitFailure(error, args, failure.stderr)
    }
  }

  runBytes(cwd: string, args: string[]): Promise<GitBytesResult> {
    return new Promise((resolveRun, rejectRun) => {
      execFile('git', ['-C', cwd, ...args], {
        encoding: null,
        env: nonInteractiveGitEnvironment(),
        maxBuffer: this.limits.maxOutputBytes,
        timeout: this.limits.timeoutMs,
        windowsHide: true,
      }, (error, stdout, stderr) => {
        if (error === null) {
          resolveRun({ stdout, stderr })
          return
        }
        rejectRun(this.gitFailure(error, args, stderr.toString('utf8')))
      })
    })
  }

  gitFailure(error: unknown, args: string[], stderr: string): WorkbenchHttpError {
    this.ctx.logger.warn(`workbench-layout: Git command failed (${args[0] ?? 'unknown'})`)
    const code = error !== null && typeof error === 'object' && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined
    if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      return new WorkbenchHttpError(413, 'GIT_DIFF_TOO_LARGE', 'Git 输出超过 Diff 视图允许的大小。')
    }
    const detail = stderr.trim().split(/\r?\n/u)[0]
    return new WorkbenchHttpError(400, 'GIT_COMMAND_FAILED', detail === undefined || detail === '' ? 'Git 操作失败。' : detail)
  }
}
