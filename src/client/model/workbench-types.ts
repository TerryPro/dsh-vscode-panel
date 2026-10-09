/** Shared browser-state type contract for the workbench controller. */

import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { GitEditorBaseline, GitFileDiff, WorkspaceFile, WorkspaceImageFile } from '../../shared/contracts.ts'
import type { GitDecorationMap } from '../git/git-decorations.ts'
import type { GitFileLayout } from '../git/git-tree.ts'

export type SidebarMode = 'sessions' | 'files' | 'git' | 'terminal'
export type DiffViewMode = 'split' | 'unified' | 'inline'
export type MarkdownViewMode = 'preview' | 'source' | 'split'
export type HtmlViewMode = 'preview' | 'interactive' | 'source'
export type MermaidViewMode = 'preview' | 'source' | 'split'
export type CsvViewMode = 'table' | 'source' | 'split'
export type StructuredViewMode = 'graph' | 'source' | 'split'
export type GitView = 'changes' | 'graph'
export type TerminalStatus = 'connecting' | 'running' | 'exited' | 'error'
/**
 * What a tab's status dot may claim.
 *
 * `unclaimed` is not a process phase: it marks a tab that has no Session to
 * allocate its process in yet, so the dot must not claim a phase nothing has
 * confirmed.
 */
export type TerminalDot = TerminalStatus | 'unclaimed'
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
  | 'files.reveal'

export interface WorkbenchSidebarActionRequest {
  id: number
  action: WorkbenchSidebarAction
  workspaceId: string
  /** Workspace-relative path the action targets; only `files.reveal` needs one. */
  path?: string
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
  /** Structured graph view state; only meaningful for JSON and YAML files. */
  structuredMode?: StructuredViewMode
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
  /**
   * Shell this tab was opened with, as a Host-discovered executable path.
   * Absent means "no choice yet": the official model then uses the remembered
   * available shell or the execution environment's default. The resolved shell
   * of a running process is always readable from its view state, so this field
   * only records the *intent* for tabs that have not allocated a process yet.
   */
  shellPath?: string
  /**
   * Shell the running process actually reports (`pwsh`, `cmd`, `zsh`), mirrored
   * from the official view state. This is what the row shows: it names the
   * resolved shell of a restored process too, which `shellPath` never can.
   */
  shellName?: string
  /**
   * Session that owns this tab's Host process.
   *
   * The official service addresses a terminal through the Agent of the Session
   * that allocated it — `follow`, `write`, `resize`, and `close` all take that
   * Agent — so the tab records its owner and keeps being driven through *it*
   * even after the Workspace moves on to another Session. That is what lets a
   * terminal survive a Session switch: the Host resolves the owning Session's
   * Agent on demand, so nothing here has to reconnect or reallocate.
   */
  ownerSessionId?: string
  /**
   * Name the user gave this terminal, shown over `terminal.name`.
   *
   * Mirrored to the Host as the terminal's own title, so a restored process
   * reports it back and the name survives a reload rather than living only in
   * this window.
   */
  title?: string
  /**
   * Process facts the Host reports, mirrored for the status line.
   *
   * `cwd` is the directory the shell *started* in: the Host documents that a
   * shell changing directory does not update it, so the status line labels it as
   * the launch directory rather than pretending to track `cd`.
   */
  runtime?: TerminalRuntime
}

/** Host-reported facts about one running terminal process. */
export interface TerminalRuntime {
  readonly cwd: string
  readonly cols: number
  readonly rows: number
  /** Exit code once the process ended; null while it runs. */
  readonly exitCode: number | null
}

/**
 * Whether one terminal tab has a Session to address its process through.
 *
 * There is deliberately no "belongs to another Session" case: a tab keeps being
 * driven through its own owner, which is exactly how a terminal outlives a
 * Session switch. `noSession` is only the state before anything exists to
 * allocate the process against.
 */
export type TerminalBinding = 'ready' | 'noSession'

/**
 * One Host-discovered shell offered at the workbench's new-terminal menu: the
 * verified executable path the official model accepts as `shellPath`, plus its
 * file name (`pwsh`, `bash`, `cmd`) for the row label.
 */
export interface WorkbenchShellChoice {
  path: string
  name: string
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

/**
 * The official root layout's global-panel navigation face (`ctx.layout`).
 * A `main` panel — the Plugins page, or one another plugin registers — replaces
 * the Conversation in DSH's center column, and the shell offers no control that
 * leaves it: its sidebar rows only ever select a panel, never clear one. The
 * activity dock drives `selectPanel(null)` so the workbench can supply the
 * missing way back to the conversation.
 */
export interface WorkbenchPanelNavigation {
  /** Selected central panel; `null` displays the current Conversation. */
  readonly panelInfo: ObservableSnapshot<{ activePanelId: string | null }>
  /** Clear the selected global panel and show the Conversation. */
  selectPanel(panelId: null): void
}
