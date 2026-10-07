/** JSON vocabulary shared by the workbench Host and browser halves. */

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
