/** Pure Git decoration/line-version state derivation for the controller. */

import type { GitStatus } from '../../shared/contracts.ts'
import type { GitDecorationMap } from '../git/git-decorations.ts'
import type { WorkbenchFileTab, WorkbenchState } from '../workbench/workbench-types.ts'

export function buildGitLineVersions(files: readonly GitStatus['files'][number][]): Record<string, string> {
  return Object.fromEntries(files.map(file => [
    file.path,
    `${file.originalPath ?? ''}\0${file.index}${file.worktree}`,
  ]))
}

export function gitBaselineKey(state: WorkbenchState, tab: WorkbenchFileTab): string {
  return [tab.file?.version ?? '', state.gitHead ?? '', state.gitLineVersions?.[tab.path] ?? ''].join('\0')
}

export function sameDecorations(left: GitDecorationMap, right: GitDecorationMap): boolean {
  const leftEntries = Object.entries(left)
  const rightEntries = Object.entries(right)
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([path, decoration]) => right[path] === decoration)
}

export function sameStringMap(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftEntries = Object.entries(left)
  const rightEntries = Object.entries(right)
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([path, value]) => right[path] === value)
}
