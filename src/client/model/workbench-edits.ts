/** File-tab editing: draft, external-change reconciliation, and per-pane view toggles. */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  DraftChangeSource,
  CsvViewMode,
  HtmlViewMode,
  StructuredViewMode,
  MarkdownViewMode,
  MermaidViewMode,
  WorkbenchFileTab,
  WorkbenchLogger,
  WorkbenchState,
} from './workbench-types.ts'

export class WorkbenchEdits {
  constructor(
    private readonly store: SnapshotStore<WorkbenchState>,
    private readonly logger: WorkbenchLogger,
  ) {}

  /** Resolve the current file tab for a read/guard, or undefined for a non-file or missing id. */
  private fileTabAt(tabId: string | undefined): WorkbenchFileTab | undefined {
    if (tabId === undefined) return undefined
    const tab = this.store.getSnapshot().tabs.find(candidate => candidate.id === tabId)
    return tab?.kind === 'file' ? tab : undefined
  }

  /** Mutate one file tab in the live store, ignoring missing or non-file ids. */
  private patchFileTab(tabId: string | undefined, patch: (tab: WorkbenchFileTab) => void): void {
    if (tabId === undefined) return
    this.store.update((state) => {
      const tab = state.tabs.find(candidate => candidate.id === tabId)
      if (tab?.kind === 'file') patch(tab)
    })
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

  revert(tabId = this.store.getSnapshot().activeTabId): void {
    const selected = this.fileTabAt(tabId)
    if (selected === undefined) return
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
    const selected = this.fileTabAt(tabId)
    if (selected === undefined || selected.externalChange?.kind !== 'changed') return
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
    const selected = this.fileTabAt(tabId)
    if (selected === undefined || selected.externalChange?.kind !== 'changed') return
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

  setMarkdownMode(mode: MarkdownViewMode, tabId = this.store.getSnapshot().activeTabId): void {
    this.patchFileTab(tabId, (tab) => { tab.markdownMode = mode })
  }

  /** Toggle word wrap for one file tab, independent of any sibling split pane. */
  setEditorWrap(tabId: string, wrap: boolean): void {
    this.patchFileTab(tabId, (tab) => { tab.wrap = wrap })
  }

  /** Toggle the Markdown outline panel for one file tab, independent of sibling panes. */
  toggleMarkdownOutline(tabId = this.store.getSnapshot().activeTabId): void {
    this.patchFileTab(tabId, (tab) => { tab.outlineVisible = tab.outlineVisible !== true })
  }

  /** Toggle the inline Git diff overlay for one file tab. */
  setEditorInlineDiff(tabId: string, inlineDiff: boolean): void {
    this.patchFileTab(tabId, (tab) => { tab.inlineDiff = inlineDiff })
  }

  setHtmlMode(mode: HtmlViewMode, tabId = this.store.getSnapshot().activeTabId): void {
    this.patchFileTab(tabId, (tab) => { tab.htmlMode = mode })
  }

  /** Switch one Mermaid file tab between preview, split and source views. */
  setMermaidMode(mode: MermaidViewMode, tabId = this.store.getSnapshot().activeTabId): void {
    this.patchFileTab(tabId, (tab) => { tab.mermaidMode = mode })
  }

  /** Switch one CSV/TSV file tab between table, split and source views. */
  setCsvMode(mode: CsvViewMode, tabId = this.store.getSnapshot().activeTabId): void {
    this.patchFileTab(tabId, (tab) => { tab.csvMode = mode })
  }

  /** Switch one structured (JSON/YAML) file tab between graph, split and source views. */
  setStructuredMode(mode: StructuredViewMode, tabId = this.store.getSnapshot().activeTabId): void {
    this.patchFileTab(tabId, (tab) => { tab.structuredMode = mode })
  }
}
