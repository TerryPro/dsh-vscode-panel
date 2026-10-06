/** Shared browser state joining the root-scoped sidebar and Session-scoped editor. */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ClientTerminals, TerminalView } from '@deepseek-ai/dsh-api-terminal-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { GitCommit, GitEditorBaseline, GitFileDiff, GitStatus, WorkspaceFile, WorkspaceImageFile } from '../contracts.ts'
import { imageMimeTypeForPath } from '../contracts.ts'
import { WorkbenchApi } from './api.ts'
import { isHtmlPath } from './html-preview.ts'
import { buildGitDecorations, type GitDecorationMap } from './git-decorations.ts'
import type { GitHunkPeekStorageOperation } from './git-hunk-peek-resize.ts'
import type { GitFileLayout } from './git-tree.ts'

export type SidebarMode = 'sessions' | 'files' | 'git' | 'terminal'
export type DiffViewMode = 'split' | 'unified' | 'inline'
export type MarkdownViewMode = 'preview' | 'source' | 'split'
export type HtmlViewMode = 'preview' | 'interactive' | 'source'
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

const INITIAL_STATE: WorkbenchState = {
  sidebarMode: 'files',
  editorExpanded: true,
  conversationExpanded: true,
  tabs: [],
  diffViewMode: 'split',
  gitView: 'changes',
  gitChangeLayout: 'list',
  gitGraphFileLayout: 'list',
  gitDecorations: {},
  gitLineVersions: {},
  editorSplit: false,
  editorSplitOrientation: 'horizontal',
  editorSplitRatio: 0.5,
  activePane: 'primary',
  panes: { primary: { tabIds: [] }, secondary: { tabIds: [] } },
}

export interface WorkbenchLogger {
  info(message: string): void
  warn(message: string): void
}

export interface WorkbenchEditorLayout {
  openRightbar(track: boolean, fullscreen: boolean): void
  closeRightbar(): void
}

/** Own unified tabs, editor visibility, async races, dirty state, and the sidebar shadow. */
export class WorkbenchController {
  readonly store: SnapshotStore<WorkbenchState> = createSnapshotStore(INITIAL_STATE)
  readonly api: WorkbenchApi

  private requestId = 0
  private sidebarActionId = 0
  private readonly fileRequests = new Map<string, number>()
  private readonly gitBaselineRequests = new Map<string, number>()
  private readonly diffRequests = new Map<string, number>()
  private terminalId = 0
  private setSidebarShadow: ((active: boolean) => void) | undefined
  private readonly workspaceStates = new Map<string, WorkbenchState>()
  private refreshPromise: Promise<void> | undefined
  private refreshFailureActive = false
  private readonly gitRefreshes = new Map<string, Promise<void>>()
  private readonly gitRefreshFailures = new Set<string>()
  private readonly gitStatusGenerations = new Map<string, number>()
  readonly fileTreeExpanded = new Map<string, Set<string>>()

  constructor(
    api: WorkbenchApi = new WorkbenchApi(),
    private readonly logger: WorkbenchLogger = console,
    private readonly editorLayout?: WorkbenchEditorLayout,
    private readonly terminals?: ClientTerminals,
  ) {
    this.api = api
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

  /** Store Git file decorations in the Workspace snapshot shared by the tree and editor tabs. */
  acceptGitStatus(workspaceId: string, status: GitStatus): void {
    this.gitStatusGenerations.set(workspaceId, (this.gitStatusGenerations.get(workspaceId) ?? 0) + 1)
    const decorations = status.available ? buildGitDecorations(status.files) : {}
    const lineVersions = status.available ? buildGitLineVersions(status.files) : {}
    const current = this.store.getSnapshot().workspaceId === workspaceId
      ? this.store.getSnapshot()
      : this.workspaceStates.get(workspaceId)
    if (current === undefined || (
      sameDecorations(current.gitDecorations, decorations)
      && current.gitHead === status.head
      && sameStringMap(current.gitLineVersions ?? {}, lineVersions)
    )) return
    this.updateWorkspaceState(workspaceId, (state) => {
      state.gitDecorations = decorations
      state.gitLineVersions = lineVersions
      if (status.head === undefined) delete state.gitHead
      else state.gitHead = status.head
    })
    this.logger.info(
      `workbench-layout: updated Git file and line decoration state in ${JSON.stringify(workspaceId)}`,
    )
  }

  /** Load and cache the HEAD-side text for one editable source tab. */
  async ensureGitBaseline(tabId = this.store.getSnapshot().activeTabId): Promise<void> {
    if (tabId === undefined) return
    const snapshot = this.store.getSnapshot()
    const workspaceId = snapshot.workspaceId
    const tab = snapshot.tabs.find(candidate => candidate.id === tabId)
    if (workspaceId === undefined || tab?.kind !== 'file' || tab.file === null) return
    const key = gitBaselineKey(snapshot, tab)
    if (tab.gitBaselineKey === key) return
    const requestKey = tabRequestKey(workspaceId, tabId)
    const requestId = ++this.requestId
    this.gitBaselineRequests.set(requestKey, requestId)
    this.updateFileTabState(workspaceId, tabId, (draft) => {
      draft.gitBaselineKey = key
      draft.gitBaselineLoading = true
    })
    try {
      const baseline = await this.api.gitEditorBaseline(workspaceId, tab.path)
      if (this.gitBaselineRequests.get(requestKey) !== requestId) return
      this.updateFileTabState(workspaceId, tabId, (draft) => {
        if (draft.gitBaselineKey !== key) return
        draft.gitBaseline = baseline
        draft.gitBaselineLoading = false
      })
      this.logger.info(`workbench-layout: prepared Git line decorations for ${JSON.stringify(tab.path)}`)
    } catch {
      if (this.gitBaselineRequests.get(requestKey) !== requestId) return
      this.updateFileTabState(workspaceId, tabId, (draft) => {
        if (draft.gitBaselineKey !== key) return
        draft.gitBaseline = null
        draft.gitBaselineLoading = false
      })
      this.logger.warn(`workbench-layout: failed to prepare Git line decorations for ${JSON.stringify(tab.path)}`)
    }
  }

  /** Coalesce background Git status checks independently for each Workspace. */
  refreshGitDecorations(workspaceId = this.store.getSnapshot().workspaceId): Promise<void> {
    if (workspaceId === undefined) return Promise.resolve()
    const existing = this.gitRefreshes.get(workspaceId)
    if (existing !== undefined) return existing
    const refresh = this.refreshGitDecorationsOnce(workspaceId).finally(() => {
      if (this.gitRefreshes.get(workspaceId) === refresh) this.gitRefreshes.delete(workspaceId)
    })
    this.gitRefreshes.set(workspaceId, refresh)
    return refresh
  }

  setWorkspace(workspaceId: string | undefined): void {
    const state = this.store.getSnapshot()
    if (state.workspaceId === workspaceId) return
    if (state.workspaceId !== undefined) this.workspaceStates.set(state.workspaceId, stripWorkspaceEphemera(state))
    if (workspaceId === undefined) {
      this.store.set({
        ...INITIAL_STATE,
        sidebarMode: state.sidebarMode,
        editorExpanded: state.editorExpanded,
        conversationExpanded: state.conversationExpanded,
      })
      return
    }
    const restored = this.workspaceStates.get(workspaceId)
    this.store.set(restored === undefined
      ? { ...INITIAL_STATE, sidebarMode: state.sidebarMode, editorExpanded: state.editorExpanded, conversationExpanded: state.conversationExpanded, workspaceId }
      : { ...cloneState(restored), sidebarMode: state.sidebarMode, editorExpanded: state.editorExpanded, conversationExpanded: state.conversationExpanded, workspaceId })
    this.logger.info(`workbench-layout: activated workspace ${JSON.stringify(workspaceId)}`)
    if (typeof this.api.gitStatus === 'function') void this.refreshGitDecorations(workspaceId)
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
    this.setWorkspace(workspaceId)
    this.revealEditor()
    const tabId = fileTabId(path)
    const current = this.store.getSnapshot()
    const existing = current.tabs.find(tab => tab.id === tabId)
    this.store.update((state) => {
      if (existing === undefined) state.tabs.push(emptyFileTab(path))
      placeTabInPane(state, focusedPaneId(state), tabId)
      selectInPanes(state, tabId)
    })
    if (existing?.kind === 'file' && (existing.file !== null || existing.image !== null)) {
      this.logger.info(`workbench-layout: selected open file tab ${JSON.stringify(path)}`)
      return
    }
    if (existing?.kind === 'file' && existing.loading) return

    const requestKey = tabRequestKey(workspaceId, tabId)
    const requestId = ++this.requestId
    this.fileRequests.set(requestKey, requestId)
    this.updateFileTabState(workspaceId, tabId, (tab) => {
      tab.loading = true
      tab.error = null
    })
    try {
      if (imageMimeTypeForPath(path) !== undefined) {
        const image = await this.api.readImage(workspaceId, path)
        if (this.fileRequests.get(requestKey) !== requestId) return
        this.updateFileTabState(workspaceId, tabId, (tab) => {
          tab.image = image
          tab.loading = false
          tab.error = null
        })
        this.logger.info(`workbench-layout: opened workspace image tab ${JSON.stringify(path)}`)
        return
      }
      const file = await this.api.readFile(workspaceId, path)
      if (this.fileRequests.get(requestKey) !== requestId) return
      this.updateFileTabState(workspaceId, tabId, (tab) => {
        const isMarkdown = file.markdown
        const nextMarkdownMode = tab.markdownMode === 'source' && isMarkdown
          ? 'preview'
          : tab.markdownMode === 'preview' && !isMarkdown
            ? 'source'
            : tab.markdownMode
        tab.file = file
        tab.draft = file.content
        tab.dirty = false
        tab.externalChange = null
        tab.markdownMode = nextMarkdownMode
        tab.htmlMode = isHtmlPath(path) ? 'preview' : 'source'
        tab.loading = false
        tab.error = null
      })
      this.logger.info(`workbench-layout: opened workspace file tab ${JSON.stringify(path)}`)
    } catch (error: unknown) {
      if (this.fileRequests.get(requestKey) !== requestId) return
      this.updateFileTabState(workspaceId, tabId, (tab) => {
        tab.loading = false
        tab.error = messageOf(error)
      })
      this.logger.warn(`workbench-layout: failed to open workspace file tab ${JSON.stringify(path)}`)
    }
  }

  /** Route DSH's native conversation file control through the current Workspace editor. */
  async openConversationFile(workspaceId: string, path: string): Promise<void> {
    try {
      const resolved = await this.api.relativePath(workspaceId, path)
      if (this.store.getSnapshot().workspaceId !== workspaceId) {
        this.logger.info('workbench-layout: ignored a stale conversation file reference after Workspace changed')
        return
      }
      this.logger.info(`workbench-layout: routed native conversation file reference to ${JSON.stringify(resolved.path)}`)
      await this.openFile(workspaceId, resolved.path)
    } catch {
      this.logger.warn('workbench-layout: failed to resolve native conversation file reference inside the current Workspace')
    }
  }

  openTerminal(workspaceId = this.store.getSnapshot().workspaceId): string | undefined {
    if (workspaceId === undefined) return undefined
    this.setWorkspace(workspaceId)
    this.revealEditor()
    const state = this.store.getSnapshot()
    const sequence = state.tabs.reduce((highest, tab) => tab.kind === 'terminal'
      ? Math.max(highest, tab.sequence)
      : highest, 0) + 1
    const id = `terminal:${++this.terminalId}`
    const contentId = `wbterm:${workspaceId}:${id}`
    this.store.update((draft) => {
      draft.tabs.push({ id, kind: 'terminal', sequence, contentId, status: 'connecting' })
      placeTabInPane(draft, focusedPaneId(draft), id)
      selectInPanes(draft, id)
    })
    this.logger.info(`workbench-layout: opened workspace terminal ${sequence} in ${JSON.stringify(workspaceId)}`)
    return id
  }

  /** Mirror the official view phase onto the tab so the tab and rail dots stay in sync. */
  setTerminalStatus(tabId: string, status: TerminalStatus): void {
    const current = this.store.getSnapshot().tabs.find(tab => tab.id === tabId)
    if (current?.kind !== 'terminal' || current.status === status) return
    this.store.update((state) => {
      const tab = state.tabs.find(candidate => candidate.id === tabId)
      if (tab?.kind === 'terminal') tab.status = status
    })
  }

  /** Record the Session the active Workspace belongs to so official terminal views scope to it. */
  setSession(sessionId: string | undefined): void {
    if (this.store.getSnapshot().sessionId === sessionId) return
    this.store.update((state) => {
      if (sessionId === undefined) delete state.sessionId
      else state.sessionId = sessionId
    })
  }

  /** Resolve the official terminal model for one tab, or undefined without a Session or service. */
  terminalView(tab: WorkbenchTerminalTab): TerminalView | undefined {
    const { sessionId } = this.store.getSnapshot()
    if (this.terminals === undefined || sessionId === undefined) return undefined
    return this.terminals.view(sessionId as SessionId, tab.id, tab.contentId)
  }

  /** Ask the official model to terminate one tab's process; a missing Session or service leaves it page-live. */
  private closeTerminalProcess(tab: WorkbenchTerminalTab): void {
    const { sessionId } = this.store.getSnapshot()
    if (this.terminals === undefined || sessionId === undefined) return
    try {
      this.terminals.close(sessionId as SessionId, tab.id, tab.contentId)
    } catch {
      this.logger.warn(`workbench-layout: failed to close workspace terminal ${JSON.stringify(tab.id)}`)
    }
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
    if (tab.kind === 'terminal') this.closeTerminalProcess(tab)
    const requestKey = tabRequestKey(state.workspaceId, tabId)
    this.fileRequests.delete(requestKey)
    this.gitBaselineRequests.delete(requestKey)
    this.diffRequests.delete(requestKey)
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
    const focusedTabId = tabId ?? this.store.getSnapshot().activeTabId
    if (focusedTabId === undefined) return
    let path: string | undefined
    this.store.update((state) => {
      const tab = state.tabs.find(candidate => candidate.id === focusedTabId)
      if (tab?.kind !== 'file' || tab.file === null) return
      path = tab.path
      tab.draft = value
      if (tab.externalChange?.kind === 'changed' && value === tab.externalChange.file.content) {
        tab.file = tab.externalChange.file
        tab.externalChange = null
        tab.dirty = false
        tab.error = null
        return
      }
      tab.dirty = value !== tab.file.content
      tab.error = null
    })
    if (source === 'git-revert' && path !== undefined) {
      this.logger.info(`workbench-layout: reverted one Git change block in ${JSON.stringify(path)}`)
    }
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
    if (tabId === undefined) return
    const selected = this.store.getSnapshot().tabs.find(tab => tab.id === tabId)
    if (selected?.kind !== 'file') return
    if (selected.externalChange?.kind === 'changed') {
      this.reloadExternalFile(tabId)
      return
    }
    this.store.update((state) => {
      const tab = state.tabs.find(candidate => candidate.id === tabId)
      if (tab?.kind !== 'file' || tab.file === null) return
      tab.draft = tab.file.content
      tab.dirty = false
      tab.error = null
    })
    this.logger.info(`workbench-layout: reverted file tab ${JSON.stringify(selected.path)}`)
  }

  /** Replace the draft with the externally changed version after explicit user confirmation. */
  reloadExternalFile(tabId = this.store.getSnapshot().activeTabId): void {
    if (tabId === undefined) return
    const selected = this.store.getSnapshot().tabs.find(tab => tab.id === tabId)
    if (selected?.kind !== 'file' || selected.externalChange?.kind !== 'changed') return
    this.store.update((state) => {
      const tab = state.tabs.find(candidate => candidate.id === tabId)
      if (tab?.kind !== 'file' || tab.externalChange?.kind !== 'changed') return
      tab.file = tab.externalChange.file
      tab.draft = tab.externalChange.file.content
      tab.dirty = false
      tab.externalChange = null
      tab.error = null
    })
    this.logger.info(`workbench-layout: reloaded externally changed file tab ${JSON.stringify(selected.path)}`)
  }

  /** Keep the current draft while adopting the external version as the next guarded save base. */
  keepCurrentDraft(tabId = this.store.getSnapshot().activeTabId): void {
    if (tabId === undefined) return
    const selected = this.store.getSnapshot().tabs.find(tab => tab.id === tabId)
    if (selected?.kind !== 'file' || selected.externalChange?.kind !== 'changed') return
    this.store.update((state) => {
      const tab = state.tabs.find(candidate => candidate.id === tabId)
      if (tab?.kind !== 'file' || tab.externalChange?.kind !== 'changed') return
      tab.file = tab.externalChange.file
      tab.dirty = tab.draft !== tab.externalChange.file.content
      tab.externalChange = null
      tab.error = null
    })
    this.logger.info(`workbench-layout: kept current draft over external file change ${JSON.stringify(selected.path)}`)
  }

  /** Refresh all loaded file tabs in one request; concurrent visibility/focus triggers share the same run. */
  refreshOpenFiles(): Promise<void> {
    if (this.refreshPromise !== undefined) return this.refreshPromise
    const refresh = this.refreshOpenFilesOnce().finally(() => {
      if (this.refreshPromise === refresh) this.refreshPromise = undefined
    })
    this.refreshPromise = refresh
    return refresh
  }

  setMarkdownMode(mode: MarkdownViewMode, tabId = this.store.getSnapshot().activeTabId): void {
    if (tabId === undefined) return
    this.store.update((state) => {
      const tab = state.tabs.find(candidate => candidate.id === tabId)
      if (tab?.kind === 'file') tab.markdownMode = mode
    })
  }

  /** Toggle word wrap for one file tab, independent of any sibling split pane. */
  setEditorWrap(tabId: string, wrap: boolean): void {
    this.store.update((state) => {
      const tab = state.tabs.find(candidate => candidate.id === tabId)
      if (tab?.kind === 'file') tab.wrap = wrap
    })
  }

  /** Toggle the Markdown outline panel for one file tab, independent of sibling panes. */
  toggleMarkdownOutline(tabId = this.store.getSnapshot().activeTabId): void {
    if (tabId === undefined) return
    this.store.update((state) => {
      const tab = state.tabs.find(candidate => candidate.id === tabId)
      if (tab?.kind === 'file') tab.outlineVisible = tab.outlineVisible !== true
    })
  }

  /** Toggle the inline Git diff overlay for one file tab. */
  setEditorInlineDiff(tabId: string, inlineDiff: boolean): void {
    this.store.update((state) => {
      const tab = state.tabs.find(candidate => candidate.id === tabId)
      if (tab?.kind === 'file') tab.inlineDiff = inlineDiff
    })
  }

  setHtmlMode(mode: HtmlViewMode, tabId = this.store.getSnapshot().activeTabId): void {
    if (tabId === undefined) return
    this.store.update((state) => {
      const tab = state.tabs.find(candidate => candidate.id === tabId)
      if (tab?.kind === 'file') tab.htmlMode = mode
    })
  }

  async save(tabId = this.store.getSnapshot().activeTabId): Promise<boolean> {
    const current = this.store.getSnapshot()
    const tab = current.tabs.find(candidate => candidate.id === tabId)
    if (tab?.kind !== 'file') return false
    if (tab.file === null || current.workspaceId === undefined || tab.saving || !tab.dirty) {
      return !tab.dirty
    }
    if (tab.externalChange !== null) {
      this.logger.warn(`workbench-layout: blocked save for externally changed file tab ${JSON.stringify(tab.path)}`)
      return false
    }
    const workspaceId = current.workspaceId
    const savedContent = tab.draft
    const version = tab.file.version
    this.updateFileTabState(workspaceId, tab.id, (draft) => {
      draft.saving = true
      draft.error = null
    })
    try {
      const saved = await this.api.saveFile(workspaceId, tab.path, savedContent, version)
      this.updateFileTabState(workspaceId, tab.id, (draft) => {
        if (draft.file === null) return
        draft.file = { ...draft.file, content: savedContent, version: saved.version, size: saved.size }
        draft.dirty = draft.draft !== savedContent
        draft.saving = false
        draft.externalChange = null
        draft.error = null
      })
      this.logger.info(`workbench-layout: saved file tab ${JSON.stringify(tab.path)}`)
      if (typeof this.api.gitStatus === 'function') void this.refreshGitDecorations(workspaceId)
      return true
    } catch (error: unknown) {
      this.updateFileTabState(workspaceId, tab.id, (draft) => {
        draft.saving = false
        draft.error = messageOf(error)
      })
      this.logger.warn(`workbench-layout: failed to save file tab ${JSON.stringify(tab.path)}`)
      return false
    }
  }

  async openDiff(workspaceId: string, path: string, staged: boolean): Promise<void> {
    const diffKind = staged ? 'staged' : 'worktree'
    await this.openDiffTab(
      workspaceId,
      { id: diffTabId(diffKind, path), path, diffKind },
      () => this.api.gitDiff(workspaceId, path, staged),
      `Git ${diffKind} diff ${JSON.stringify(path)}`,
    )
  }

  async openCommitDiff(workspaceId: string, commit: GitCommit, path: string): Promise<void> {
    await this.openDiffTab(
      workspaceId,
      { id: diffTabId('commit', path, commit.hash), path, diffKind: 'commit', revision: commit.hash },
      () => this.api.gitCommitFileDiff(workspaceId, commit.hash, path),
      `Git commit diff ${commit.shortHash} ${JSON.stringify(path)}`,
    )
  }

  async openComparisonDiff(workspaceId: string, commit: GitCommit, path: string): Promise<void> {
    await this.openDiffTab(
      workspaceId,
      { id: diffTabId('comparison', path, commit.hash), path, diffKind: 'comparison', revision: commit.hash },
      () => this.api.gitComparisonFileDiff(workspaceId, commit.hash, path),
      `Git workspace comparison ${commit.shortHash} ${JSON.stringify(path)}`,
    )
  }

  setDiffViewMode(mode: DiffViewMode): void {
    this.store.update((state) => { state.diffViewMode = mode })
    this.logger.info(`workbench-layout: Diff view mode changed to ${mode}`)
  }

  /** 关闭已失效的 Diff 标签，同时保留普通文件及其草稿。 */
  closeDiffTabs(workspaceId = this.store.getSnapshot().workspaceId): void {
    if (workspaceId === undefined) return
    this.updateWorkspaceState(workspaceId, (state) => {
      state.tabs = state.tabs.filter(tab => tab.kind !== 'diff')
      reconcilePanes(state)
    })
    this.logger.info(`workbench-layout: closed stale Diff tabs for workspace ${JSON.stringify(workspaceId)}`)
  }

  /** Clear file and Diff tabs after Git changes one Workspace; live terminals remain attached. */
  resetWorkspaceView(workspaceId = this.store.getSnapshot().workspaceId): void {
    if (workspaceId === undefined) return
    this.updateWorkspaceState(workspaceId, (state) => {
      state.tabs = state.tabs.filter(tab => tab.kind === 'terminal')
      reconcilePanes(state)
    })
    this.logger.info(`workbench-layout: cleared editor tabs after Git changed workspace ${JSON.stringify(workspaceId)}`)
  }

  /** Close tabs whose backing file is one entry or a descendant of one renamed/deleted directory. */
  closeWorkspaceEntries(workspaceId: string, path: string): void {
    const removedIds: string[] = []
    this.updateWorkspaceState(workspaceId, (state) => {
      state.tabs = state.tabs.filter((tab) => {
        if (tab.kind === 'terminal' || !isSameOrDescendantPath(tab.path, path)) return true
        removedIds.push(tab.id)
        return false
      })
      reconcilePanes(state)
    })
    for (const id of removedIds) {
      const key = tabRequestKey(workspaceId, id)
      this.fileRequests.delete(key)
      this.diffRequests.delete(key)
    }
    if (removedIds.length > 0) {
      this.logger.info(
        `workbench-layout: closed ${removedIds.length} tabs for changed workspace entry ${JSON.stringify(path)}`,
      )
    }
  }

  private async openDiffTab(
    workspaceId: string,
    descriptor: Pick<WorkbenchDiffTab, 'id' | 'path' | 'diffKind' | 'revision'>,
    load: () => Promise<GitFileDiff>,
    logLabel: string,
  ): Promise<void> {
    this.setWorkspace(workspaceId)
    this.revealEditor()
    const current = this.store.getSnapshot()
    const existing = current.tabs.find(tab => tab.id === descriptor.id)
    this.store.update((state) => {
      if (existing === undefined) state.tabs.push(emptyDiffTab(descriptor))
      placeTabInPane(state, focusedPaneId(state), descriptor.id)
      selectInPanes(state, descriptor.id)
    })
    if (existing?.kind === 'diff' && existing.diff !== null) {
      this.logger.info(`workbench-layout: selected open ${logLabel} tab`)
      return
    }
    if (existing?.kind === 'diff' && existing.loading) return

    const requestKey = tabRequestKey(workspaceId, descriptor.id)
    const requestId = ++this.requestId
    this.diffRequests.set(requestKey, requestId)
    this.updateDiffTabState(workspaceId, descriptor.id, (tab) => {
      tab.loading = true
      tab.error = null
    })
    try {
      const diff = await load()
      if (this.diffRequests.get(requestKey) !== requestId) return
      this.updateDiffTabState(workspaceId, descriptor.id, (tab) => {
        tab.diff = diff
        tab.loading = false
        tab.error = null
      })
      this.logger.info(`workbench-layout: opened ${logLabel} tab`)
    } catch (error: unknown) {
      if (this.diffRequests.get(requestKey) !== requestId) return
      this.updateDiffTabState(workspaceId, descriptor.id, (tab) => {
        tab.loading = false
        tab.error = messageOf(error)
      })
      this.logger.warn(`workbench-layout: failed to open ${logLabel} tab`)
    }
  }

  private async refreshOpenFilesOnce(): Promise<void> {
    const snapshot = this.store.getSnapshot()
    if (snapshot.workspaceId === undefined) return
    const workspaceId = snapshot.workspaceId
    const observations = snapshot.tabs.flatMap(tab => tab.kind === 'file'
      && tab.file !== null && !tab.loading && !tab.saving
      ? [{
          path: tab.path,
          version: tab.externalChange?.kind === 'changed' ? tab.externalChange.file.version : tab.file.version,
        }]
      : [])
    if (observations.length === 0) return
    const requestedVersions = new Map(observations.map(item => [item.path, item.version]))
    try {
      const refreshed = await this.api.refreshFiles(workspaceId, observations)
      let updated = 0
      let conflicted = 0
      this.updateWorkspaceState(workspaceId, (state) => {
        for (const result of refreshed.files) {
          if (result.status === 'unchanged') continue
          const requestedVersion = requestedVersions.get(result.path)
          const tab = state.tabs.find(candidate => candidate.kind === 'file' && candidate.path === result.path)
          if (requestedVersion === undefined || tab?.kind !== 'file' || tab.file === null || tab.saving) continue
          const currentVersion = tab.externalChange?.kind === 'changed'
            ? tab.externalChange.file.version
            : tab.file.version
          if (currentVersion !== requestedVersion) continue
          if (result.status === 'deleted') {
            if (tab.externalChange?.kind !== 'deleted') {
              tab.externalChange = { kind: 'deleted' }
              conflicted += 1
            }
            continue
          }
          if (!tab.dirty || tab.draft === result.file.content) {
            tab.file = result.file
            tab.draft = result.file.content
            tab.dirty = false
            tab.externalChange = null
            tab.error = null
            updated += 1
            continue
          }
          const alreadyObserved = tab.externalChange?.kind === 'changed'
            && tab.externalChange.file.version === result.file.version
          tab.externalChange = { kind: 'changed', file: result.file }
          if (!alreadyObserved) conflicted += 1
        }
      })
      if (updated > 0) {
        this.logger.info(`workbench-layout: refreshed ${updated} clean file tab(s) after external changes`)
      }
      if (conflicted > 0) {
        this.logger.warn(`workbench-layout: protected ${conflicted} file tab(s) from external overwrite`)
      }
      if (updated + conflicted > 0 && typeof this.api.gitStatus === 'function') {
        void this.refreshGitDecorations(workspaceId)
      }
      if (this.refreshFailureActive) {
        this.refreshFailureActive = false
        this.logger.info('workbench-layout: open file refresh recovered')
      }
    } catch {
      if (!this.refreshFailureActive) {
        this.refreshFailureActive = true
        this.logger.warn('workbench-layout: failed to refresh open file versions')
      }
    }
  }

  private async refreshGitDecorationsOnce(workspaceId: string): Promise<void> {
    const generation = this.gitStatusGenerations.get(workspaceId) ?? 0
    try {
      const status = await this.api.gitStatus(workspaceId)
      if ((this.gitStatusGenerations.get(workspaceId) ?? 0) !== generation) return
      this.acceptGitStatus(workspaceId, status)
      if (this.gitRefreshFailures.delete(workspaceId)) {
        this.logger.info(`workbench-layout: Git file decoration refresh recovered in ${JSON.stringify(workspaceId)}`)
      }
    } catch {
      if (!this.gitRefreshFailures.has(workspaceId)) {
        this.gitRefreshFailures.add(workspaceId)
        this.logger.warn(`workbench-layout: failed to refresh Git file decorations in ${JSON.stringify(workspaceId)}`)
      }
    }
  }

  /** Apply an async result only to the Workspace that started the operation. */
  private updateWorkspaceState(workspaceId: string, update: (state: WorkbenchState) => void): void {
    if (this.store.getSnapshot().workspaceId === workspaceId) {
      this.store.update(update)
      return
    }
    const cached = this.workspaceStates.get(workspaceId)
    if (cached === undefined) return
    const next = cloneState(cached)
    update(next)
    this.workspaceStates.set(workspaceId, next)
  }

  private updateFileTabState(workspaceId: string, tabId: string, update: (tab: WorkbenchFileTab) => void): void {
    this.updateWorkspaceState(workspaceId, (state) => {
      const tab = state.tabs.find(candidate => candidate.id === tabId)
      if (tab?.kind === 'file') update(tab)
    })
  }

  private updateDiffTabState(workspaceId: string, tabId: string, update: (tab: WorkbenchDiffTab) => void): void {
    this.updateWorkspaceState(workspaceId, (state) => {
      const tab = state.tabs.find(candidate => candidate.id === tabId)
      if (tab?.kind === 'diff') update(tab)
    })
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

function emptyFileTab(path: string): WorkbenchFileTab {
  return {
    id: fileTabId(path),
    kind: 'file',
    path,
    file: null,
    image: null,
    draft: '',
    dirty: false,
    markdownMode: 'source',
    wrap: true,
    inlineDiff: true,
    loading: true,
    saving: false,
    externalChange: null,
    error: null,
  }
}

function emptyDiffTab(
  descriptor: Pick<WorkbenchDiffTab, 'id' | 'path' | 'diffKind' | 'revision'>,
): WorkbenchDiffTab {
  return {
    ...descriptor,
    kind: 'diff',
    diff: null,
    loading: true,
    error: null,
  }
}

function cloneState(state: WorkbenchState): WorkbenchState {
  return {
    ...state,
    gitDecorations: { ...state.gitDecorations },
    gitLineVersions: { ...state.gitLineVersions },
    panes: {
      primary: { ...state.panes.primary, tabIds: [...state.panes.primary.tabIds] },
      secondary: { ...state.panes.secondary, tabIds: [...state.panes.secondary.tabIds] },
    },
    tabs: state.tabs.map((tab) => {
      if (tab.kind === 'file') return {
        ...tab,
        file: tab.file === null ? null : { ...tab.file },
        ...(tab.gitBaseline === undefined
          ? {}
          : { gitBaseline: tab.gitBaseline === null ? null : { ...tab.gitBaseline } }),
        externalChange: tab.externalChange?.kind === 'changed'
          ? { kind: 'changed', file: { ...tab.externalChange.file } }
          : tab.externalChange,
      }
      if (tab.kind === 'diff') return { ...tab, diff: tab.diff === null ? null : { ...tab.diff } }
      return { ...tab }
    }),
  }
}

function sameDecorations(left: GitDecorationMap, right: GitDecorationMap): boolean {
  const leftEntries = Object.entries(left)
  const rightEntries = Object.entries(right)
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([path, decoration]) => right[path] === decoration)
}

function sameStringMap(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftEntries = Object.entries(left)
  const rightEntries = Object.entries(right)
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([path, value]) => right[path] === value)
}

function buildGitLineVersions(files: readonly GitStatus['files'][number][]): Record<string, string> {
  return Object.fromEntries(files.map(file => [
    file.path,
    `${file.originalPath ?? ''}\0${file.index}${file.worktree}`,
  ]))
}

function gitBaselineKey(state: WorkbenchState, tab: WorkbenchFileTab): string {
  return [tab.file?.version ?? '', state.gitHead ?? '', state.gitLineVersions?.[tab.path] ?? ''].join('\0')
}

/** Terminal processes are page-live resources and never survive a Workspace switch. */
function stripTerminalTabs(state: WorkbenchState): WorkbenchState {
  const cloned = cloneState(state)
  cloned.tabs = cloned.tabs.filter(tab => tab.kind !== 'terminal')
  reconcilePanes(cloned)
  return cloned
}

/** Rail requests and terminal processes are page-live and never enter a Workspace snapshot. */
function stripWorkspaceEphemera(state: WorkbenchState): WorkbenchState {
  const stripped = stripTerminalTabs(state)
  delete stripped.sidebarAction
  return stripped
}

function fileTabId(path: string): string {
  return `file:${path}`
}

function diffTabId(kind: GitFileDiff['kind'], path: string, revision = ''): string {
  return `diff:${kind}:${revision}:${path}`
}

function tabRequestKey(workspaceId: string | undefined, tabId: string): string {
  return `${workspaceId ?? ''}\0${tabId}`
}

function tabIdentity(tab: WorkbenchTab): string {
  return tab.kind === 'terminal' ? `terminal-${tab.sequence}` : tab.path
}

function isSameOrDescendantPath(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}/`)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Assign-or-delete an optional active tab id under `exactOptionalPropertyTypes`. */
function assignGroupActive(group: EditorGroup, tabId: string | undefined): void {
  if (tabId === undefined) delete group.activeTabId
  else group.activeTabId = tabId
}

function assignActiveTab(state: WorkbenchState, tabId: string | undefined): void {
  if (tabId === undefined) delete state.activeTabId
  else state.activeTabId = tabId
}

function focusedPaneId(state: WorkbenchState): EditorPaneId {
  return state.editorSplit ? state.activePane : 'primary'
}

function findPane(state: WorkbenchState, tabId: string): EditorPaneId | undefined {
  if (state.panes.primary.tabIds.includes(tabId)) return 'primary'
  if (state.panes.secondary.tabIds.includes(tabId)) return 'secondary'
  return undefined
}

/** Move a tab into a pane (leaving any other pane) without changing selection. */
function placeTabInPane(state: WorkbenchState, pane: EditorPaneId, tabId: string): void {
  for (const id of ['primary', 'secondary'] as EditorPaneId[]) {
    if (id !== pane) state.panes[id].tabIds = state.panes[id].tabIds.filter(existing => existing !== tabId)
  }
  const group = state.panes[pane]
  if (!group.tabIds.includes(tabId)) group.tabIds.push(tabId)
}

/** Select a tab in the pane that already holds it (or the focused pane) and focus that pane. */
function selectInPanes(state: WorkbenchState, tabId: string): void {
  const pane = findPane(state, tabId) ?? focusedPaneId(state)
  placeTabInPane(state, pane, tabId)
  const group = state.panes[pane]
  group.activeTabId = tabId
  state.activePane = pane
  state.activeTabId = tabId
}

/** Merge the secondary pane back into the primary and drop the split. */
function closeSplit(state: WorkbenchState): void {
  const merged = [...state.panes.primary.tabIds]
  for (const id of state.panes.secondary.tabIds) if (!merged.includes(id)) merged.push(id)
  state.panes.primary.tabIds = merged
  state.panes.secondary = { tabIds: [] }
  state.editorSplit = false
  state.activePane = 'primary'
  const primary = state.panes.primary
  if (primary.activeTabId === undefined || !merged.includes(primary.activeTabId)) {
    assignGroupActive(primary, merged[0])
  }
  assignActiveTab(state, primary.activeTabId)
}

/** Keep panes a clean partition of the tab pool after the pool changed. */
function reconcilePanes(state: WorkbenchState): void {
  const valid = new Set(state.tabs.map(tab => tab.id))
  for (const group of [state.panes.primary, state.panes.secondary]) {
    group.tabIds = group.tabIds.filter(id => valid.has(id))
    if (group.activeTabId === undefined || !group.tabIds.includes(group.activeTabId)) {
      assignGroupActive(group, group.tabIds[0])
    }
  }
  for (const tab of state.tabs) {
    if (!state.panes.primary.tabIds.includes(tab.id) && !state.panes.secondary.tabIds.includes(tab.id)) {
      state.panes.primary.tabIds.push(tab.id)
    }
  }
  if (state.editorSplit && (state.panes.secondary.tabIds.length === 0 || state.panes.primary.tabIds.length === 0)) {
    closeSplit(state)
    return
  }
  assignActiveTab(state, state.panes[focusedPaneId(state)].activeTabId)
}
