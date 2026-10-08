/** Shared browser-state type contract for the workbench controller. */

import type { GitEditorBaseline, GitFileDiff, WorkspaceFile, WorkspaceImageFile } from '../../shared/contracts.ts'
import type { GitDecorationMap } from '../git/git-decorations.ts'
import type { GitFileLayout } from '../git/git-tree.ts'

export type SidebarMode = 'sessions' | 'files' | 'git' | 'terminal'
export type DiffViewMode = 'split' | 'unified' | 'inline'
export type MarkdownViewMode = 'preview' | 'source' | 'split'
export type HtmlViewMode = 'preview' | 'interactive' | 'source'
export type MermaidViewMode = 'preview' | 'source' | 'split'
export type CsvViewMode = 'table' | 'source' | 'split'
export type JsonViewMode = 'graph' | 'tree' | 'source' | 'split'
export type GitView = 'changes' | 'graph'
export type TerminalStatus = 'connecting' | 'running' | 'exited' | 'error'
export type DraftChangeSource = 'input' | 'git-revert'
/** Direction of the divider between the two split editor panes. */
export type EditorSplitOrientation = 'horizontal' | 'vertical'
/** Identity of one editor pane; each pane owns an independent tab list. */
export type EditorPaneId = 'primary' | 'secondary'

/** One pane's tab strip: an ordered list of pool tab ids plus its own selection. */
export interface EditorGroup {
  tabIds: string[]
  activeTabId?: string
}

export interface EditorPanes {
  primary: EditorGroup
  secondary: EditorGroup
}
export type WorkbenchSidebarAction =
  | 'files.newFile'
  | 'files.newDirectory'

export interface WorkbenchSidebarActionRequest {
  id: number
  action: WorkbenchSidebarAction
  workspaceId: string
}

export interface WorkbenchFileTab {
  id: string
  kind: 'file'
  path: string
  file: WorkspaceFile | null
  image: WorkspaceImageFile | null
  draft: string
  dirty: boolean
  markdownMode: MarkdownViewMode
  htmlMode?: HtmlViewMode
  /** Mermaid diagram view state; only meaningful for `.mmd`/`.mermaid` files. */
  mermaidMode?: MermaidViewMode
  /** Tabular view state; only meaningful for `.csv`/`.tsv` files. */
  csvMode?: CsvViewMode
  /** Structured view state (graph, tree, split, source); only meaningful for `.json`/`.jsonc` files. */
  jsonMode?: JsonViewMode
  /** Per-file editing view toggles so each split pane keeps its own wrapping and diff. */
  wrap: boolean
  inlineDiff: boolean
  /** Whether the Markdown preview shows its right-hand outline (table of contents) panel. */
  outlineVisible?: boolean
  loading: boolean
  saving: boolean
  externalChange: ExternalFileChange | null
  error: string | null
  gitBaseline?: GitEditorBaseline | null
  gitBaselineKey?: string
  gitBaselineLoading?: boolean
}

export type ExternalFileChange =
  | { kind: 'changed'; file: WorkspaceFile }
  | { kind: 'deleted' }

export interface WorkbenchDiffTab {
  id: string
  kind: 'diff'
  path: string
  diffKind: GitFileDiff['kind']
  revision?: string
  diff: GitFileDiff | null
  loading: boolean
  error: string | null
}

export interface WorkbenchTerminalTab {
  id: string
  kind: 'terminal'
  sequence: number
  /** Globally unique content identity the official terminal model binds a Session process to. */
  contentId: string
  /** Lightweight mirror of the official view phase for tab and rail status dots. */
  status: TerminalStatus
}

export type WorkbenchTab = WorkbenchFileTab | WorkbenchDiffTab | WorkbenchTerminalTab

export interface WorkbenchState {
  sidebarMode: SidebarMode
  editorExpanded: boolean
  conversationExpanded: boolean
  workspaceId?: string
  /** Session the current Workspace belongs to; scopes official terminal processes. */
  sessionId?: string
  tabs: WorkbenchTab[]
  activeTabId?: string
  diffViewMode: DiffViewMode
  gitView: GitView
  gitChangeLayout: GitFileLayout
  gitGraphFileLayout: GitFileLayout
  gitDecorations: GitDecorationMap
  gitHead?: string
  gitLineVersions?: Record<string, string>
  sidebarAction?: WorkbenchSidebarActionRequest
  /** Second editor pane sharing the tab list, opened from the header split controls. */
  editorSplit: boolean
  editorSplitOrientation: EditorSplitOrientation
  /** Share of the editor column owned by the primary pane, 0.2–0.8. */
  editorSplitRatio: number
  /** Pane that receives tab clicks and the next open; holds the globally active tab. */
  activePane: EditorPaneId
  /** Each pane's independent tab strip. `secondary` is empty while unsplit. */
  panes: EditorPanes
}

export interface WorkbenchLogger {
  info(message: string): void
  warn(message: string): void
}

export interface WorkbenchEditorLayout {
  openRightbar(track: boolean, fullscreen: boolean): void
  closeRightbar(): void
}
