/** Shared browser state joining the root-scoped sidebar and Session-scoped editor. */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ClientTerminals, TerminalView } from '@deepseek-ai/dsh-api-terminal-controller/client'
import type { GitCommit, GitStatus } from '../../shared/contracts.ts'
import { WorkbenchApi } from './api.ts'
import type { GitHunkPeekStorageOperation } from '../git/git-hunk-peek-resize.ts'
import type { GitFileLayout } from '../git/git-tree.ts'
import type {
  DiffViewMode,
  DraftChangeSource,
  EditorPaneId,
  EditorSplitOrientation,
  GitView,
  CsvViewMode,
  HtmlViewMode,
  MarkdownViewMode,
  MermaidViewMode,
  SidebarMode,
  TerminalStatus,
  WorkbenchEditorLayout,
  WorkbenchLogger,
  WorkbenchSidebarAction,
  WorkbenchState,
  WorkbenchTerminalTab,
} from './workbench-types.ts'
import {
  assignActiveTab,
  assignGroupActive,
  closeSplit,
  findPane,
  reconcilePanes,
  selectInPanes,
} from './editor-pane-model.ts'
import { tabIdentity } from './tab-model.ts'
import { INITIAL_STATE } from './workbench-snapshot.ts'
import { WorkbenchData } from './workbench-data.ts'
import { WorkbenchEdits } from './workbench-edits.ts'
import { WorkbenchTerminals } from './workbench-terminals.ts'

export * from './workbench-types.ts'

/**
 * Own unified tabs, editor visibility, async races, dirty state, and the sidebar shadow.
 * Delegates tab IO to {@link WorkbenchData}, file edits to {@link WorkbenchEdits}, and the
 * official terminal to {@link WorkbenchTerminals}; keeps only the shell and pane orchestration.
 */
export class WorkbenchController {
  readonly store: SnapshotStore<WorkbenchState> = createSnapshotStore(INITIAL_STATE)
  readonly api: WorkbenchApi

  private sidebarActionId = 0
  private setSidebarShadow: ((active: boolean) => void) | undefined
  readonly fileTreeExpanded = new Map<string, Set<string>>()
  private readonly data: WorkbenchData
  private readonly edits: WorkbenchEdits
  private readonly terminalRuntime: WorkbenchTerminals

  constructor(
    api: WorkbenchApi = new WorkbenchApi(),
    private readonly logger: WorkbenchLogger = console,
    private readonly editorLayout?: WorkbenchEditorLayout,
    terminals?: ClientTerminals,
  ) {
    this.api = api
    this.data = new WorkbenchData(this.store, api, logger, this)
    this.edits = new WorkbenchEdits(this.store, logger)
    this.terminalRuntime = new WorkbenchTerminals(this.store, logger, this, terminals)
  }

  attachSidebarShadow(setActive: (active: boolean) => void): () => void {
    this.setSidebarShadow = setActive
    setActive(this.store.getSnapshot().sidebarMode !== 'sessions')
    return () => {
      if (this.setSidebarShadow === setActive) this.setSidebarShadow = undefined
    }
  }

  setSidebarMode(mode: SidebarMode): void {
    this.store.update((state) => { state.sidebarMode = mode })
    this.setSidebarShadow?.(mode !== 'sessions')
    this.logger.info(`workbench-layout: sidebar mode changed to ${mode}`)
    const state = this.store.getSnapshot()
    if (mode === 'terminal' && state.workspaceId !== undefined
      && !state.tabs.some(tab => tab.kind === 'terminal')) {
      this.openTerminal(state.workspaceId)
    }
  }

  setGitView(view: GitView): void {
    if (this.store.getSnapshot().gitView === view) return
    this.store.update((state) => { state.gitView = view })
    this.logger.info(`workbench-layout: Git main view changed to ${view}`)
  }

  toggleGitView(): void {
    this.setGitView(this.store.getSnapshot().gitView === 'changes' ? 'graph' : 'changes')
  }

  setGitFileLayout(view: GitView, layout: GitFileLayout): void {
    const key = view === 'changes' ? 'gitChangeLayout' : 'gitGraphFileLayout'
    if (this.store.getSnapshot()[key] === layout) return
    this.store.update((state) => { state[key] = layout })
    this.logger.info(`workbench-layout: Git ${view} file layout changed to ${layout}`)
  }

  requestSidebarAction(
    action: WorkbenchSidebarAction,
    workspaceId = this.store.getSnapshot().workspaceId,
  ): number | undefined {
    if (workspaceId === undefined) return undefined
    const id = ++this.sidebarActionId
    this.store.update((state) => { state.sidebarAction = { id, action, workspaceId } })
    this.logger.info(`workbench-layout: queued collapsed sidebar action ${action} for ${JSON.stringify(workspaceId)}`)
    return id
  }

  consumeSidebarAction(id: number): void {
    const request = this.store.getSnapshot().sidebarAction
    if (request?.id !== id) return
    this.store.update((state) => { delete state.sidebarAction })
    this.logger.info(`workbench-layout: consumed collapsed sidebar action ${request.action}`)
  }

  setWorkspace(workspaceId: string | undefined): void {
    this.data.setWorkspace(workspaceId)
  }

  /** Store Git file decorations in the Workspace snapshot shared by the tree and editor tabs. */
  acceptGitStatus(workspaceId: string, status: GitStatus): void {
    this.data.acceptGitStatus(workspaceId, status)
  }

  /** Load and cache the HEAD-side text for one editable source tab. */
  ensureGitBaseline(tabId = this.store.getSnapshot().activeTabId): Promise<void> {
    return this.data.ensureGitBaseline(tabId)
  }

  /** Coalesce background Git status checks independently for each Workspace. */
  refreshGitDecorations(workspaceId = this.store.getSnapshot().workspaceId): Promise<void> {
    return this.data.refreshGitDecorations(workspaceId)
  }

  /** Reapply the remembered middle-column state after AppFrame or Session remounts. */
  synchronizeEditorLayout(): void {
    if (this.store.getSnapshot().editorExpanded) this.editorLayout?.openRightbar(true, false)
    else this.editorLayout?.closeRightbar()
  }

  toggleEditor(): void {
    this.setEditorExpanded(!this.store.getSnapshot().editorExpanded, 'sidebar control')
  }

  /** Collapse or restore the right conversation column so the editor can take the full width. */
  toggleConversation(): void {
    const expanded = !this.store.getSnapshot().conversationExpanded
    this.store.update((state) => { state.conversationExpanded = expanded })
    this.logger.info(`workbench-layout: ${expanded ? 'expanded' : 'collapsed'} conversation column from editor header`)
  }

  /** Reveal content selected from the sidebar without coupling panels to individual views. */
  revealEditor(): void {
    this.setEditorExpanded(true, 'content selection')
  }

  async openFile(workspaceId: string, path: string): Promise<void> {
    await this.data.openFile(workspaceId, path)
  }

  /** Route DSH's native conversation file control through the current Workspace editor. */
  async openConversationFile(workspaceId: string, path: string): Promise<void> {
    await this.data.openConversationFile(workspaceId, path)
  }

  openTerminal(workspaceId = this.store.getSnapshot().workspaceId): string | undefined {
    return this.terminalRuntime.openTerminal(workspaceId)
  }

  /** Mirror the official view phase onto the tab so the tab and rail dots stay in sync. */
  setTerminalStatus(tabId: string, status: TerminalStatus): void {
    this.terminalRuntime.setTerminalStatus(tabId, status)
  }

  /** Record the Session the active Workspace belongs to so official terminal views scope to it. */
  setSession(sessionId: string | undefined): void {
    this.terminalRuntime.setSession(sessionId)
  }

  /** Resolve the official terminal model for one tab, or undefined without a Session or service. */
  terminalView(tab: WorkbenchTerminalTab): TerminalView | undefined {
    return this.terminalRuntime.terminalView(tab)
  }

  /** Open the second pane on the neighbouring tab, flip the divider, or close it. */
  toggleSplit(orientation?: EditorSplitOrientation): void {
    const state = this.store.getSnapshot()
    if (state.editorSplit && (orientation === undefined || orientation === state.editorSplitOrientation)) {
      this.store.update((draft) => { closeSplit(draft) })
      this.logger.info('workbench-layout: closed split editor')
      return
    }
    if (!state.editorSplit) {
      const primary = state.panes.primary
      const index = primary.tabIds.indexOf(primary.activeTabId ?? '')
      const moveId = primary.tabIds[index - 1]
        ?? primary.tabIds[index + 1]
        ?? primary.tabIds.find(id => id !== primary.activeTabId)
      if (moveId === undefined) {
        this.logger.info('workbench-layout: split editor needs two tabs')
        return
      }
      this.store.update((draft) => {
        const group = draft.panes.primary
        group.tabIds = group.tabIds.filter(id => id !== moveId)
        draft.panes.secondary = { tabIds: [moveId], activeTabId: moveId }
        draft.editorSplit = true
        draft.activePane = 'primary'
        assignActiveTab(draft, group.activeTabId)
      })
      this.logger.info('workbench-layout: opened split editor')
    }
    if (orientation !== undefined) {
      this.store.update((draft) => { draft.editorSplitOrientation = orientation })
      this.logger.info(`workbench-layout: split editor orientation changed to ${orientation}`)
    }
  }

  setSplitRatio(ratio: number): void {
    const clamped = Math.min(0.8, Math.max(0.2, ratio))
    if (this.store.getSnapshot().editorSplitRatio === clamped) return
    this.store.update((state) => { state.editorSplitRatio = clamped })
  }

  /** Make one pane the active one so it holds the globally focused tab. */
  focusPane(pane: EditorPaneId): void {
    const state = this.store.getSnapshot()
    if (!state.editorSplit || pane === state.activePane) return
    this.store.update((draft) => {
      draft.activePane = pane
      assignActiveTab(draft, draft.panes[pane].activeTabId)
    })
  }

  /** Move one tab into another pane by drag; the source pane falls back to a neighbour. */
  moveTabToPane(tabId: string, targetPane: EditorPaneId): void {
    const state = this.store.getSnapshot()
    if (!state.editorSplit || !state.tabs.some(tab => tab.id === tabId)) return
    const source = findPane(state, tabId)
    if (source === targetPane) return
    this.store.update((draft) => {
      if (source !== undefined) {
        const group = draft.panes[source]
        const position = group.tabIds.indexOf(tabId)
        const wasActive = group.activeTabId === tabId
        group.tabIds = group.tabIds.filter(id => id !== tabId)
        if (wasActive) {
          assignGroupActive(group, group.tabIds[position] ?? group.tabIds[position - 1] ?? group.tabIds.at(-1))
        }
      }
      const destination = draft.panes[targetPane]
      if (!destination.tabIds.includes(tabId)) destination.tabIds.push(tabId)
      destination.activeTabId = tabId
      draft.activePane = targetPane
      draft.activeTabId = tabId
      reconcilePanes(draft)
    })
    this.logger.info(`workbench-layout: moved tab ${JSON.stringify(tabId)} into the ${targetPane} pane`)
  }

  selectTab(tabId: string): void {
    const state = this.store.getSnapshot()
    const tab = state.tabs.find(candidate => candidate.id === tabId)
    if (tab === undefined) return
    this.revealEditor()
    this.store.update((draft) => { selectInPanes(draft, tabId) })
    this.logger.info(`workbench-layout: selected ${tab.kind} tab ${JSON.stringify(tabIdentity(tab))}`)
  }

  closeTab(tabId: string, discardDirty = false): boolean {
    const state = this.store.getSnapshot()
    const index = state.tabs.findIndex(tab => tab.id === tabId)
    const tab = state.tabs[index]
    if (tab === undefined || (tab.kind === 'file' && tab.dirty && !discardDirty)) return false
    if (tab.kind === 'terminal') this.terminalRuntime.closeTerminalProcess(tab)
    this.data.forgetRequests(state.workspaceId, tabId)
    this.store.update((draft) => {
      draft.tabs.splice(index, 1)
      for (const group of [draft.panes.primary, draft.panes.secondary]) {
        if (!group.tabIds.includes(tabId)) continue
        const position = group.tabIds.indexOf(tabId)
        const wasActive = group.activeTabId === tabId
        group.tabIds = group.tabIds.filter(id => id !== tabId)
        if (wasActive) {
          assignGroupActive(group, group.tabIds[position] ?? group.tabIds[position - 1] ?? group.tabIds.at(-1))
        }
      }
      reconcilePanes(draft)
    })
    this.logger.info(`workbench-layout: closed ${tab.kind} tab ${JSON.stringify(tabIdentity(tab))}`)
    return true
  }

  setDraft(value: string, source: DraftChangeSource = 'input', tabId?: string): void {
    this.edits.setDraft(value, source, tabId)
  }

  logGitHunkOpen(path: string): void {
    this.logger.info(`workbench-layout: opened local Git Diff hunk for ${JSON.stringify(path)}`)
  }

  logGitHunkResize(path: string, width: number): void {
    this.logger.info(
      `workbench-layout: resized local Git Diff hunk for ${JSON.stringify(path)} to ${width}px wide`,
    )
  }

  logGitHunkResizeStorageError(operation: GitHunkPeekStorageOperation): void {
    this.logger.warn(`workbench-layout: could not ${operation} local Git Diff hunk width preference`)
  }

  logGitHunkDismissOutside(path: string): void {
    this.logger.info(`workbench-layout: dismissed local Git Diff hunk outside ${JSON.stringify(path)}`)
  }

  revert(tabId = this.store.getSnapshot().activeTabId): void {
    this.edits.revert(tabId)
  }

  /** Replace the draft with the externally changed version after explicit user confirmation. */
  reloadExternalFile(tabId = this.store.getSnapshot().activeTabId): void {
    this.edits.reloadExternalFile(tabId)
  }

  /** Keep the current draft while adopting the external version as the next guarded save base. */
  keepCurrentDraft(tabId = this.store.getSnapshot().activeTabId): void {
    this.edits.keepCurrentDraft(tabId)
  }

  /** Refresh all loaded file tabs in one request; concurrent visibility/focus triggers share the same run. */
  refreshOpenFiles(): Promise<void> {
    return this.data.refreshOpenFiles()
  }

  setMarkdownMode(mode: MarkdownViewMode, tabId = this.store.getSnapshot().activeTabId): void {
    this.edits.setMarkdownMode(mode, tabId)
  }

  /** Toggle word wrap for one file tab, independent of any sibling split pane. */
  setEditorWrap(tabId: string, wrap: boolean): void {
    this.edits.setEditorWrap(tabId, wrap)
  }

  /** Toggle the Markdown outline panel for one file tab, independent of sibling panes. */
  toggleMarkdownOutline(tabId = this.store.getSnapshot().activeTabId): void {
    this.edits.toggleMarkdownOutline(tabId)
  }

  /** Toggle the inline Git diff overlay for one file tab. */
  setEditorInlineDiff(tabId: string, inlineDiff: boolean): void {
    this.edits.setEditorInlineDiff(tabId, inlineDiff)
  }

  setHtmlMode(mode: HtmlViewMode, tabId = this.store.getSnapshot().activeTabId): void {
    this.edits.setHtmlMode(mode, tabId)
  }

  /** Switch one Mermaid file tab between preview, split and source views. */
  setMermaidMode(mode: MermaidViewMode, tabId = this.store.getSnapshot().activeTabId): void {
    this.edits.setMermaidMode(mode, tabId)
  }

  /** Switch one CSV/TSV file tab between table, split and source views. */
  setCsvMode(mode: CsvViewMode, tabId = this.store.getSnapshot().activeTabId): void {
    this.edits.setCsvMode(mode, tabId)
  }

  async save(tabId = this.store.getSnapshot().activeTabId): Promise<boolean> {
    return this.data.save(tabId)
  }

  async openDiff(workspaceId: string, path: string, staged: boolean): Promise<void> {
    await this.data.openDiff(workspaceId, path, staged)
  }

  async openCommitDiff(workspaceId: string, commit: GitCommit, path: string): Promise<void> {
    await this.data.openCommitDiff(workspaceId, commit, path)
  }

  async openComparisonDiff(workspaceId: string, commit: GitCommit, path: string): Promise<void> {
    await this.data.openComparisonDiff(workspaceId, commit, path)
  }

  setDiffViewMode(mode: DiffViewMode): void {
    this.data.setDiffViewMode(mode)
  }

  /** 关闭已失效的 Diff 标签，同时保留普通文件及其草稿。 */
  closeDiffTabs(workspaceId = this.store.getSnapshot().workspaceId): void {
    this.data.closeDiffTabs(workspaceId)
  }

  /** Clear file and Diff tabs after Git changes one Workspace; live terminals remain attached. */
  resetWorkspaceView(workspaceId = this.store.getSnapshot().workspaceId): void {
    this.data.resetWorkspaceView(workspaceId)
  }

  /** Close tabs whose backing file is one entry or a descendant of one renamed/deleted directory. */
  closeWorkspaceEntries(workspaceId: string, path: string): void {
    this.data.closeWorkspaceEntries(workspaceId, path)
  }

  private setEditorExpanded(expanded: boolean, source: string): void {
    const current = this.store.getSnapshot().editorExpanded
    if (current !== expanded) {
      this.store.update((state) => { state.editorExpanded = expanded })
      this.logger.info(`workbench-layout: ${expanded ? 'expanded' : 'collapsed'} middle editor from ${source}`)
    }
    if (expanded) this.editorLayout?.openRightbar(true, false)
    else this.editorLayout?.closeRightbar()
  }
}
