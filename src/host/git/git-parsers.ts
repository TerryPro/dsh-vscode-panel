/** Git 文本输出的纯解析器；输入均来自固定 argv 的 Git 命令。 */

import type { GitBranch, GitCommit, GitCommitFile, GitCommitStats, GitFileStatus, GitReference } from '../../shared/contracts.ts'
import { WorkbenchHttpError } from '../http.ts'

export const REVISION_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u

export interface GitNumstat {
  path: string
  originalPath?: string
  additions?: number
  deletions?: number
  binary: boolean
}

/** 将 `--decorate=full` 的引用转换成可直接渲染的分支/标签标志。 */
export function parseGitReferences(value: string): GitReference[] {
  if (value === '') return []
  const references: GitReference[] = []
  for (const raw of value.split(', ')) {
    if (raw.startsWith('HEAD -> refs/heads/')) {
      references.push({ name: raw.slice('HEAD -> refs/heads/'.length), kind: 'head' })
    } else if (raw === 'HEAD') {
      references.push({ name: 'HEAD', kind: 'head' })
    } else if (raw.startsWith('refs/heads/')) {
      references.push({ name: raw.slice('refs/heads/'.length), kind: 'local' })
    } else if (raw.startsWith('refs/remotes/')) {
      const name = raw.slice('refs/remotes/'.length)
      if (!name.endsWith('/HEAD')) references.push({ name, kind: 'remote' })
    } else if (raw.startsWith('tag: refs/tags/')) {
      references.push({ name: raw.slice('tag: refs/tags/'.length), kind: 'tag' })
    }
  }
  return references
}

/** 解析 `git status --porcelain=v1 -z`，保留重命名前后的路径。 */
export function parsePorcelainStatus(output: string): GitFileStatus[] {
  const fields = output.split('\0')
  const files: GitFileStatus[] = []
  for (let index = 0; index < fields.length;) {
    const record = fields[index++]
    if (record === undefined || record === '') continue
    if (record.length < 4 || record[2] !== ' ') {
      throw new WorkbenchHttpError(502, 'GIT_STATUS_INVALID', 'Git 返回了无法识别的状态。')
    }
    const indexStatus = record[0] ?? ' '
    const worktreeStatus = record[1] ?? ' '
    const path = record.slice(3)
    const renamed = indexStatus === 'R' || indexStatus === 'C' || worktreeStatus === 'R' || worktreeStatus === 'C'
    const originalPath = renamed ? fields[index++] : undefined
    files.push({
      path,
      ...(originalPath === undefined || originalPath === '' ? {} : { originalPath }),
      index: indexStatus,
      worktree: worktreeStatus,
    })
  }
  return files
}

/** 解析每行使用 NUL 字段的 Git Graph 记录，并校验全部父提交。 */
export function parseGitGraph(output: string): GitCommit[] {
  if (output.trim() === '') return []
  return output.trimEnd().split('\n').map(parseGitGraphRecord)
}

/** 解析带记录边界和 `--shortstat` 的提交图，避免从提交说明中猜测变更量。 */
export function parseGitGraphWithStats(output: string): GitCommit[] {
  if (output.trim() === '') return []
  const [prefix, ...records] = output.split('\x1e')
  if (prefix?.trim() !== '' || records.length === 0) {
    throw new WorkbenchHttpError(502, 'GIT_GRAPH_INVALID', 'Git 返回了无法识别的提交图统计数据。')
  }
  return records.filter(record => record !== '').map((record) => {
    const [hash, shortHash, parentList, author, authoredAt, subject, decorations, shortstat, ...extra] = record.split('\0')
    if (shortstat === undefined || extra.length > 0) {
      throw new WorkbenchHttpError(502, 'GIT_GRAPH_INVALID', 'Git 返回了无法识别的提交图统计数据。')
    }
    const commit = parseGitGraphRecord([
      hash, shortHash, parentList, author, authoredAt, subject, decorations,
    ].join('\0'))
    return { ...commit, stats: parseGitShortstat(shortstat) }
  })
}

/** 解析固定为英文的 `--shortstat` 汇总；没有统计行代表空提交。 */
export function parseGitShortstat(value: string): GitCommitStats {
  const summary = value.trim()
  if (summary === '') return { filesChanged: 0, additions: 0, deletions: 0 }
  const match = /^(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?$/u.exec(summary)
  if (match === null) {
    throw new WorkbenchHttpError(502, 'GIT_GRAPH_INVALID', 'Git 返回了无法识别的提交变更统计。')
  }
  const filesChanged = Number(match[1])
  const additions = Number(match[2] ?? 0)
  const deletions = Number(match[3] ?? 0)
  if (![filesChanged, additions, deletions].every(Number.isSafeInteger)) {
    throw new WorkbenchHttpError(502, 'GIT_GRAPH_INVALID', 'Git 返回了超出范围的提交变更统计。')
  }
  return { filesChanged, additions, deletions }
}

function parseGitGraphRecord(record: string): GitCommit {
  const [hash, shortHash, parentList, author, authoredAt, subject, decorations, ...extra] = record.split('\0')
  if (hash === undefined || shortHash === undefined || author === undefined
    || parentList === undefined || authoredAt === undefined || subject === undefined || decorations === undefined || extra.length > 0
    || !REVISION_PATTERN.test(hash)) {
    throw new WorkbenchHttpError(502, 'GIT_GRAPH_INVALID', 'Git 返回了无法识别的提交图数据。')
  }
  const parents = parentList === '' ? [] : parentList.split(' ')
  if (parents.some(parent => !REVISION_PATTERN.test(parent))) {
    throw new WorkbenchHttpError(502, 'GIT_GRAPH_INVALID', 'Git 返回了无法识别的提交图父节点。')
  }
  return { hash, shortHash, parents, author, authoredAt, subject, references: parseGitReferences(decorations) }
}

/** 解析本地与远程分支；符号引用（例如 origin/HEAD）不会成为可切换项。 */
export function parseGitBranches(output: string): GitBranch[] {
  if (output.trim() === '') return []
  const branches: GitBranch[] = []
  for (const record of output.trimEnd().split('\n')) {
    const [ref, name, head, upstream, symref, ...extra] = record.split('\0')
    if (ref === undefined || name === undefined || head === undefined || upstream === undefined
      || symref === undefined || extra.length > 0 || (head !== ' ' && head !== '*')) {
      throw new WorkbenchHttpError(502, 'GIT_BRANCHES_INVALID', 'Git 返回了无法识别的分支列表。')
    }
    if (symref !== '') continue
    const kind = ref.startsWith('refs/heads/') ? 'local' : ref.startsWith('refs/remotes/') ? 'remote' : undefined
    if (kind === undefined || name === '') {
      throw new WorkbenchHttpError(502, 'GIT_BRANCHES_INVALID', 'Git 返回了无法识别的分支列表。')
    }
    branches.push({
      ref,
      name,
      kind,
      current: head === '*',
      ...(upstream === '' ? {} : { upstream }),
    })
  }
  return branches.sort((left, right) => Number(right.current) - Number(left.current)
    || Number(left.kind === 'remote') - Number(right.kind === 'remote')
    || left.name.localeCompare(right.name))
}

/** 解析 `--name-status -z`，一个提交图条目只代表一个文件。 */
export function parseGitNameStatus(output: string): GitCommitFile[] {
  const fields = output.split('\0')
  const files: GitCommitFile[] = []
  for (let index = 0; index < fields.length;) {
    const token = fields[index++]
    if (token === undefined || token === '') continue
    if (!/^[A-Z][0-9]*$/u.test(token)) {
      throw new WorkbenchHttpError(502, 'GIT_COMMIT_FILES_INVALID', 'Git 返回了无法识别的提交文件。')
    }
    const status = token[0] as string
    if (status === 'R' || status === 'C') {
      const originalPath = fields[index++]
      const path = fields[index++]
      if (originalPath === undefined || originalPath === '' || path === undefined || path === '') {
        throw new WorkbenchHttpError(502, 'GIT_COMMIT_FILES_INVALID', 'Git 返回了不完整的重命名记录。')
      }
      files.push({ path, originalPath, status })
      continue
    }
    const path = fields[index++]
    if (path === undefined || path === '') {
      throw new WorkbenchHttpError(502, 'GIT_COMMIT_FILES_INVALID', 'Git 返回了不完整的提交文件记录。')
    }
    files.push({ path, status })
  }
  return files
}

/** 解析 `--numstat -z`，兼容普通路径与重命名路径。 */
export function parseGitNumstat(output: string): GitNumstat[] {
  const fields = output.split('\0')
  const stats: GitNumstat[] = []
  for (let index = 0; index < fields.length;) {
    const record = fields[index++]
    if (record === undefined || record === '') continue
    const firstTab = record.indexOf('\t')
    const secondTab = firstTab < 0 ? -1 : record.indexOf('\t', firstTab + 1)
    if (firstTab < 1 || secondTab < firstTab + 2) {
      throw new WorkbenchHttpError(502, 'GIT_NUMSTAT_INVALID', 'Git 返回了无法识别的变更统计。')
    }
    const added = record.slice(0, firstTab)
    const deleted = record.slice(firstTab + 1, secondTab)
    const embeddedPath = record.slice(secondTab + 1)
    let path = embeddedPath
    let originalPath: string | undefined
    if (embeddedPath === '') {
      originalPath = fields[index++]
      path = fields[index++] ?? ''
    }
    if (path === '' || (added !== '-' && !/^\d+$/u.test(added)) || (deleted !== '-' && !/^\d+$/u.test(deleted))) {
      throw new WorkbenchHttpError(502, 'GIT_NUMSTAT_INVALID', 'Git 返回了不完整的变更统计。')
    }
    const binary = added === '-' || deleted === '-'
    stats.push({
      path,
      ...(originalPath === undefined || originalPath === '' ? {} : { originalPath }),
      ...(binary ? {} : { additions: Number(added), deletions: Number(deleted) }),
      binary,
    })
  }
  return stats
}

export function parseAheadBehind(output: string): { ahead: number; behind: number } {
  const [aheadText, behindText, ...extra] = output.trim().split(/\s+/u)
  const ahead = Number(aheadText)
  const behind = Number(behindText)
  if (extra.length > 0 || !Number.isSafeInteger(ahead) || ahead < 0 || !Number.isSafeInteger(behind) || behind < 0) {
    throw new WorkbenchHttpError(502, 'GIT_SYNC_STATUS_INVALID', 'Git 返回了无法识别的同步状态。')
  }
  return { ahead, behind }
}
