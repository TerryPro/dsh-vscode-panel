/** Pure tab identity, factory, and path helpers for the workbench tab pool. */

import type { GitFileDiff } from '../../shared/contracts.ts'
import type { WorkbenchDiffTab, WorkbenchFileTab, WorkbenchTab } from './workbench-types.ts'

export function fileTabId(path: string): string {
  return `file:${path}`
}

export function diffTabId(kind: GitFileDiff['kind'], path: string, revision = ''): string {
  return `diff:${kind}:${revision}:${path}`
}

export function tabRequestKey(workspaceId: string | undefined, tabId: string): string {
  return `${workspaceId ?? ''}\0${tabId}`
}

export function tabIdentity(tab: WorkbenchTab): string {
  return tab.kind === 'terminal' ? `terminal-${tab.sequence}` : tab.path
}

export function isSameOrDescendantPath(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}/`)
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The batch-close subset the tab context menu needs: which pool tabs one action
 * selects. Pure so the menu's semantics stay testable without a DOM.
 */
export function tabsForCloseScope(
  tabs: readonly WorkbenchTab[],
  tabId: string,
  scope: 'others' | 'right' | 'saved' | 'all',
): WorkbenchTab[] {
  const index = tabs.findIndex(tab => tab.id === tabId)
  switch (scope) {
    case 'others':
      return tabs.filter(tab => tab.id !== tabId)
    case 'right':
      return index < 0 ? [] : tabs.slice(index + 1)
    case 'saved':
      // A terminal holds a live process, so it is never "saved"; a file tab only
      // counts once its draft matches disk.
      return tabs.filter(tab => tab.kind === 'diff' || (tab.kind === 'file' && !tab.dirty))
    case 'all':
      return [...tabs]
  }
}

export function emptyFileTab(path: string): WorkbenchFileTab {
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
    // Open a file showing its plain contents; the inline Git diff overlay stays
    // off until the reader turns it on from the status bar.
    inlineDiff: false,
    loading: true,
    saving: false,
    externalChange: null,
    error: null,
  }
}

export function emptyDiffTab(
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
