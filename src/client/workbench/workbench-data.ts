/** Workspace data runtime: tab loading/saving, diff tabs, Git baseline/decorations, refresh. */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { GitCommit, GitFileDiff, GitStatus } from '../../shared/contracts.ts'
import { imageMimeTypeForPath } from '../../shared/contracts.ts'
import type { WorkbenchApi } from '../core/api.ts'
import { isHtmlPath } from '../editor/html-preview.ts'
import { buildGitDecorations } from '../git/git-decorations.ts'
import {
  buildGitLineVersions,
  gitBaselineKey,
  sameDecorations,
  sameStringMap,
} from '../core/git-decoration-state.ts'
import { cloneState, INITIAL_STATE, stripWorkspaceEphemera } from './workbench-snapshot.ts'
import { focusedPaneId, placeTabInPane, reconcilePanes, selectInPanes } from '../core/editor-pane-model.ts'
import {
  diffTabId,
  emptyDiffTab,
  emptyFileTab,
  fileTabId,
  isSameOrDescendantPath,
  messageOf,
  tabRequestKey,
} from '../core/tab-model.ts'
import type {
  DiffViewMode,
  WorkbenchDiffTab,
  WorkbenchFileTab,
  WorkbenchLogger,
  WorkbenchState,
} from './workbench-types.ts'

/** The shell hook the data runtime needs to reveal the editor without importing the controller. */
export interface DataHost {
  revealEditor(): void
}

/** Owns async tab IO, the per-Workspace snapshot cache, and the request-race fencing. */
export class WorkbenchData {
  private requestId = 0
  private readonly fileRequests = new Map<string, number>()
  private readonly gitBaselineRequests = new Map<string, number>()
  private readonly diffRequests = new Map<string, number>()
  private readonly workspaceStates = new Map<string, WorkbenchState>()
  private refreshPromise: Promise<void> | undefined
  private refreshFailureActive = false
  private readonly gitRefreshes = new Map<string, Promise<void>>()
  private readonly gitRefreshFailures = new Set<string>()
  private readonly gitStatusGenerations = new Map<string, number>()

  constructor(
    private readonly store: SnapshotStore<WorkbenchState>,
    private readonly api: WorkbenchApi,
    private readonly logger: WorkbenchLogger,
    private readonly host: DataHost,
  ) {}

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

  async openFile(workspaceId: string, path: string): Promise<void> {
    this.setWorkspace(workspaceId)
    this.host.revealEditor()
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

  /** Drop in-flight request fences for a tab the shell is closing. */
  forgetRequests(workspaceId: string | undefined, tabId: string): void {
    const requestKey = tabRequestKey(workspaceId, tabId)
    this.fileRequests.delete(requestKey)
    this.gitBaselineRequests.delete(requestKey)
    this.diffRequests.delete(requestKey)
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

  private async openDiffTab(
    workspaceId: string,
    descriptor: Pick<WorkbenchDiffTab, 'id' | 'path' | 'diffKind' | 'revision'>,
    load: () => Promise<GitFileDiff>,
    logLabel: string,
  ): Promise<void> {
    this.setWorkspace(workspaceId)
    this.host.revealEditor()
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
}
