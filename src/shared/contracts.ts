/** JSON vocabulary shared by the workbench Host and browser halves. */

import { route, type RouteTable } from './route.ts'

export const WORKBENCH_API_PREFIX = '/dsh-workbench-layout'

/**
 * Public GET path the Host serves the built Mermaid runtime bundle from. The
 * browser half imports this URL lazily (see `src/client/mermaid/mermaid-loader.ts`)
 * so the multi-megabyte diagram library never lands in the eagerly-loaded client
 * bundle; the Host side that answers it lives in `src/host/mermaid-runtime.ts`.
 */
export const MERMAID_RUNTIME_PATH = `${WORKBENCH_API_PREFIX}/mermaid-runtime.js`

export type WorkspaceEntryKind = 'file' | 'directory' | 'symlink' | 'other'

export interface WorkspaceEntry {
  name: string
  path: string
  kind: WorkspaceEntryKind
  size?: number
}

export interface DirectoryListing {
  path: string
  entries: WorkspaceEntry[]
  truncated: boolean
}

export interface WorkspaceFile {
  path: string
  content: string
  version: string
  size: number
  markdown: boolean
}

/** A workspace image read as raw bytes and carried to the browser as base64. */
export interface WorkspaceImageFile {
  path: string
  /** Base64-encoded bytes without a data-URL prefix. */
  content: string
  mimeType: string
  version: string
  size: number
}

/** Lowercase file extensions the workbench previews as inline images. */
export const IMAGE_MIME_TYPES: Record<string, string> = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  ico: 'image/vnd.microsoft.icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
}

/** Resolve the preview MIME type for a workspace path, or `undefined` for non-images. */
export function imageMimeTypeForPath(path: string): string | undefined {
  const name = path.replace(/\\/gu, '/').split('/').pop()?.toLowerCase() ?? ''
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return undefined
  return IMAGE_MIME_TYPES[name.slice(dot + 1)]
}

export interface WorkspaceFileObservation {
  path: string
  version: string
}

export type WorkspaceFileRefresh =
  | { path: string; status: 'unchanged' }
  | { path: string; status: 'changed'; file: WorkspaceFile }
  | { path: string; status: 'deleted' }

export interface WorkspaceFilesRefresh {
  files: WorkspaceFileRefresh[]
}

export interface SavedWorkspaceFile {
  path: string
  version: string
  size: number
}

export interface CreatedWorkspaceEntry {
  name: string
  path: string
  kind: 'file' | 'directory'
  size?: number
}

export interface RenamedWorkspaceEntry {
  from: string
  path: string
  name: string
  kind: 'file' | 'directory'
}

export interface DeletedWorkspaceEntry {
  path: string
  kind: 'file' | 'directory'
}

export interface WorkspaceAbsolutePath {
  path: string
  absolutePath: string
}

export interface WorkspaceRelativePath {
  path: string
}

export interface GitFileStatus {
  path: string
  originalPath?: string
  index: string
  worktree: string
}

export interface GitStatus {
  available: boolean
  head?: string
  branch?: string
  detached?: boolean
  upstream?: string
  ahead?: number
  behind?: number
  hasRemote?: boolean
  remotes?: string[]
  files: GitFileStatus[]
  message?: string
}

export interface GitEditorBaseline {
  path: string
  available: boolean
  original: string
  binary: boolean
  revision?: string
}

export type GitReferenceKind = 'head' | 'local' | 'remote' | 'tag'

export interface GitReference {
  name: string
  kind: GitReferenceKind
}

export interface GitCommitStats {
  filesChanged: number
  additions: number
  deletions: number
}

export interface GitCommit {
  hash: string
  shortHash: string
  parents: string[]
  subject: string
  author: string
  authoredAt: string
  references: GitReference[]
  stats?: GitCommitStats
}

export const GIT_GRAPH_PAGE_SIZE = 40

export interface GitGraph {
  commits: GitCommit[]
  truncated: boolean
  nextOffset: number
}

export type GitDiffKind = 'worktree' | 'staged' | 'commit' | 'comparison'

export interface GitCommitFile {
  path: string
  originalPath?: string
  status: string
}

export interface GitCommitFiles {
  commit: GitCommit
  parentRevision?: string
  files: GitCommitFile[]
}

export interface GitFileDiff {
  kind: GitDiffKind
  path: string
  originalPath?: string
  status: string
  revision?: string
  parentRevision?: string
  commit?: GitCommit
  original: string
  modified: string
  binary: boolean
  additions?: number
  deletions?: number
}

export interface GitCommitResult {
  summary: string
}

export type GitCommitAction = 'cherry-pick' | 'revert'

export interface GitCommitActionResult {
  operation: GitCommitAction
  summary: string
}

export type GitBranchKind = 'local' | 'remote'

export interface GitBranch {
  ref: string
  name: string
  kind: GitBranchKind
  current: boolean
  upstream?: string
}

export interface GitBranches {
  current?: string
  detached: boolean
  branches: GitBranch[]
}

export type GitRemoteOperation = 'fetch' | 'pull' | 'push' | 'sync'

export interface GitRemoteResult {
  operation: GitRemoteOperation
}

export interface GitRemote {
  name: string
  fetchUrl: string
  pushUrl: string
  separatePushUrl: boolean
}

export interface GitRemotes {
  remotes: GitRemote[]
}

export type GitTargetRemoteOperation = 'fetch' | 'pull' | 'push'

export interface GitTargetRemoteResult {
  operation: GitTargetRemoteOperation
  remote: string
  branch?: string
}

export interface WorkbenchErrorBody {
  error: {
    code: string
    message: string
  }
}

/**
 * 文件与目录那一组路由的声明。
 *
 * 一条路由只在这里声明一次：路径、客户端照它写的参数、宿主 handler 照它检查的回值。
 * 客户端写错参数名过不了编译，宿主少写一个 handler 也过不了编译。
 */
export const FILE_ROUTES = {
  listDirectory: route<{ workspaceId: string; path: string }, DirectoryListing>(`${WORKBENCH_API_PREFIX}/tree`),
  readFile: route<{ workspaceId: string; path: string }, WorkspaceFile>(`${WORKBENCH_API_PREFIX}/file/read`),
  readImage: route<{ workspaceId: string; path: string }, WorkspaceImageFile>(`${WORKBENCH_API_PREFIX}/file/image`),
  refreshFiles: route<{ workspaceId: string; files: WorkspaceFileObservation[] }, WorkspaceFilesRefresh>(
    `${WORKBENCH_API_PREFIX}/files/refresh`,
  ),
  saveFile: route<{ workspaceId: string; path: string; content: string; version: string }, SavedWorkspaceFile>(
    `${WORKBENCH_API_PREFIX}/file/save`,
  ),
  createFile: route<{ workspaceId: string; path: string }, CreatedWorkspaceEntry>(`${WORKBENCH_API_PREFIX}/file/create`),
  createDirectory: route<{ workspaceId: string; path: string }, CreatedWorkspaceEntry>(
    `${WORKBENCH_API_PREFIX}/directory/create`,
  ),
  renameEntry: route<{ workspaceId: string; path: string; name: string }, RenamedWorkspaceEntry>(
    `${WORKBENCH_API_PREFIX}/entry/rename`,
  ),
  deleteEntry: route<{ workspaceId: string; path: string }, DeletedWorkspaceEntry>(`${WORKBENCH_API_PREFIX}/entry/delete`),
  absolutePath: route<{ workspaceId: string; path: string }, WorkspaceAbsolutePath>(`${WORKBENCH_API_PREFIX}/path/absolute`),
  revealPath: route<{ workspaceId: string; path: string }, WorkspaceRelativePath>(`${WORKBENCH_API_PREFIX}/path/reveal`),
  relativePath: route<{ workspaceId: string; path: string }, WorkspaceRelativePath>(`${WORKBENCH_API_PREFIX}/path/relative`),
} satisfies RouteTable

/**
 * Git 那一组路由的声明。
 *
 * 与 `FILE_ROUTES` 同住在契约模块里，因为它们的参数与回值都是这个模块里的类型：
 * 一条路由的声明离它的类型越远，越容易有一天两边说的不是同一件事。
 */
export const GIT_ROUTES = {
  gitStatus: route<{ workspaceId: string }, GitStatus>(`${WORKBENCH_API_PREFIX}/git/status`),
  gitDiff: route<{ workspaceId: string; path: string; staged: boolean }, GitFileDiff>(`${WORKBENCH_API_PREFIX}/git/diff`),
  gitEditorBaseline: route<{ workspaceId: string; path: string }, GitEditorBaseline>(
    `${WORKBENCH_API_PREFIX}/git/editor-baseline`,
  ),
  gitGraph: route<{ workspaceId: string; offset: number }, GitGraph>(`${WORKBENCH_API_PREFIX}/git/graph`),
  gitBranches: route<{ workspaceId: string }, GitBranches>(`${WORKBENCH_API_PREFIX}/git/branches`),
  gitSwitchBranch: route<{ workspaceId: string; ref: string }, GitStatus>(`${WORKBENCH_API_PREFIX}/git/branch/switch`),
  gitCreateBranch: route<{ workspaceId: string; name: string; source?: string }, GitStatus>(
    `${WORKBENCH_API_PREFIX}/git/branch/create`,
  ),
  gitRenameBranch: route<{ workspaceId: string; name: string }, GitStatus>(`${WORKBENCH_API_PREFIX}/git/branch/rename`),
  gitDeleteBranch: route<{ workspaceId: string; ref: string }, GitStatus>(`${WORKBENCH_API_PREFIX}/git/branch/delete`),
  gitRemoteOperation: route<{ workspaceId: string; operation: GitRemoteOperation }, GitRemoteResult>(
    `${WORKBENCH_API_PREFIX}/git/remote`,
  ),
  gitRemotes: route<{ workspaceId: string }, GitRemotes>(`${WORKBENCH_API_PREFIX}/git/remotes`),
  gitAddRemote: route<{ workspaceId: string; name: string; fetchUrl: string; pushUrl?: string }, GitRemotes>(
    `${WORKBENCH_API_PREFIX}/git/remote/add`,
  ),
  gitUpdateRemote: route<
    { workspaceId: string; currentName: string; name: string; fetchUrl: string; pushUrl?: string },
    GitRemotes
  >(`${WORKBENCH_API_PREFIX}/git/remote/update`),
  gitDeleteRemote: route<{ workspaceId: string; name: string }, GitRemotes>(`${WORKBENCH_API_PREFIX}/git/remote/delete`),
  gitTargetRemoteOperation: route<
    { workspaceId: string; operation: GitTargetRemoteOperation; remote: string; branch?: string },
    GitTargetRemoteResult
  >(`${WORKBENCH_API_PREFIX}/git/remote/target`),
  gitCommitFiles: route<{ workspaceId: string; revision: string }, GitCommitFiles>(
    `${WORKBENCH_API_PREFIX}/git/commit/files`,
  ),
  gitCommitFileDiff: route<{ workspaceId: string; revision: string; path: string }, GitFileDiff>(
    `${WORKBENCH_API_PREFIX}/git/commit/file`,
  ),
  gitComparisonFiles: route<{ workspaceId: string; revision: string }, GitCommitFiles>(
    `${WORKBENCH_API_PREFIX}/git/comparison/files`,
  ),
  gitComparisonFileDiff: route<{ workspaceId: string; revision: string; path: string }, GitFileDiff>(
    `${WORKBENCH_API_PREFIX}/git/comparison/file`,
  ),
  gitCommitAction: route<{ workspaceId: string; operation: GitCommitAction; revision: string }, GitCommitActionResult>(
    `${WORKBENCH_API_PREFIX}/git/commit/action`,
  ),
  gitStage: route<{ workspaceId: string; path: string }, GitStatus>(`${WORKBENCH_API_PREFIX}/git/stage`),
  gitStageAll: route<{ workspaceId: string }, GitStatus>(`${WORKBENCH_API_PREFIX}/git/stage-all`),
  gitUnstage: route<{ workspaceId: string; path: string }, GitStatus>(`${WORKBENCH_API_PREFIX}/git/unstage`),
  gitUnstageAll: route<{ workspaceId: string }, GitStatus>(`${WORKBENCH_API_PREFIX}/git/unstage-all`),
  gitDiscard: route<{ workspaceId: string; path: string }, GitStatus>(`${WORKBENCH_API_PREFIX}/git/discard`),
  gitDiscardAll: route<{ workspaceId: string }, GitStatus>(`${WORKBENCH_API_PREFIX}/git/discard-all`),
  gitCommit: route<{ workspaceId: string; message: string }, GitCommitResult>(`${WORKBENCH_API_PREFIX}/git/commit`),
} satisfies RouteTable
