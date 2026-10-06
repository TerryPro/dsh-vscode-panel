/** Pure editor-pane math: the two panes stay a clean partition of the tab pool. */

import type { EditorGroup, EditorPaneId, WorkbenchState } from './workbench-types.ts'

/** Assign-or-delete an optional active tab id under `exactOptionalPropertyTypes`. */
export function assignGroupActive(group: EditorGroup, tabId: string | undefined): void {
  if (tabId === undefined) delete group.activeTabId
  else group.activeTabId = tabId
}

export function assignActiveTab(state: WorkbenchState, tabId: string | undefined): void {
  if (tabId === undefined) delete state.activeTabId
  else state.activeTabId = tabId
}

export function focusedPaneId(state: WorkbenchState): EditorPaneId {
  return state.editorSplit ? state.activePane : 'primary'
}

export function findPane(state: WorkbenchState, tabId: string): EditorPaneId | undefined {
  if (state.panes.primary.tabIds.includes(tabId)) return 'primary'
  if (state.panes.secondary.tabIds.includes(tabId)) return 'secondary'
  return undefined
}

/** Move a tab into a pane (leaving any other pane) without changing selection. */
export function placeTabInPane(state: WorkbenchState, pane: EditorPaneId, tabId: string): void {
  for (const id of ['primary', 'secondary'] as EditorPaneId[]) {
    if (id !== pane) state.panes[id].tabIds = state.panes[id].tabIds.filter(existing => existing !== tabId)
  }
  const group = state.panes[pane]
  if (!group.tabIds.includes(tabId)) group.tabIds.push(tabId)
}

/** Select a tab in the pane that already holds it (or the focused pane) and focus that pane. */
export function selectInPanes(state: WorkbenchState, tabId: string): void {
  const pane = findPane(state, tabId) ?? focusedPaneId(state)
  placeTabInPane(state, pane, tabId)
  const group = state.panes[pane]
  group.activeTabId = tabId
  state.activePane = pane
  state.activeTabId = tabId
}

/** Merge the secondary pane back into the primary and drop the split. */
export function closeSplit(state: WorkbenchState): void {
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
export function reconcilePanes(state: WorkbenchState): void {
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
