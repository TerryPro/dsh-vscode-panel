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
    inlineDiff: true,
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
