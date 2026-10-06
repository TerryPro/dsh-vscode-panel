import { describe, expect, it } from 'vitest'
import {
  closeSplit,
  findPane,
  focusedPaneId,
  placeTabInPane,
  reconcilePanes,
  selectInPanes,
} from '../src/client/model/editor-pane-model.ts'
import { emptyFileTab } from '../src/client/model/tab-model.ts'
import { cloneState, stripWorkspaceEphemera } from '../src/client/model/workbench-snapshot.ts'
import type { WorkbenchState } from '../src/client/model/workbench-types.ts'

function makeState(overrides: Partial<WorkbenchState> = {}): WorkbenchState {
  return {
    sidebarMode: 'files',
    editorExpanded: true,
    conversationExpanded: true,
    tabs: [],
    diffViewMode: 'split',
    gitView: 'changes',
    gitChangeLayout: 'list',
    gitGraphFileLayout: 'list',
    gitDecorations: {},
    editorSplit: false,
    editorSplitOrientation: 'horizontal',
    editorSplitRatio: 0.5,
    activePane: 'primary',
    panes: { primary: { tabIds: [] }, secondary: { tabIds: [] } },
    ...overrides,
  }
}

describe('editor-pane-model', () => {
  it('routes the focused pane to the active one only while split', () => {
    expect(focusedPaneId(makeState({ editorSplit: false, activePane: 'secondary' }))).toBe('primary')
    expect(focusedPaneId(makeState({ editorSplit: true, activePane: 'secondary' }))).toBe('secondary')
  })

  it('finds the pane that holds a tab', () => {
    const a = emptyFileTab('a.ts')
    const state = makeState({ tabs: [a], panes: { primary: { tabIds: [] }, secondary: { tabIds: [a.id] } } })
    expect(findPane(state, a.id)).toBe('secondary')
    expect(findPane(state, 'missing')).toBeUndefined()
  })

  it('keeps panes a disjoint partition when placing a tab', () => {
    const a = emptyFileTab('a.ts')
    const state = makeState({ tabs: [a], panes: { primary: { tabIds: [a.id] }, secondary: { tabIds: [a.id] } } })
    placeTabInPane(state, 'secondary', a.id)
    expect(state.panes.primary.tabIds).not.toContain(a.id)
    expect(state.panes.secondary.tabIds).toContain(a.id)
  })

  it('selectInPanes focuses the holding pane and the global active tab', () => {
    const a = emptyFileTab('a.ts')
    const b = emptyFileTab('b.ts')
    const state = makeState({
      editorSplit: true,
      activePane: 'primary',
      tabs: [a, b],
      panes: { primary: { tabIds: [a.id], activeTabId: a.id }, secondary: { tabIds: [b.id] } },
    })
    selectInPanes(state, b.id)
    expect(state.activePane).toBe('secondary')
    expect(state.activeTabId).toBe(b.id)
    expect(state.panes.secondary.activeTabId).toBe(b.id)
  })

  it('closeSplit merges secondary into primary and drops the split', () => {
    const a = emptyFileTab('a.ts')
    const b = emptyFileTab('b.ts')
    const state = makeState({
      editorSplit: true,
      tabs: [a, b],
      panes: { primary: { tabIds: [a.id], activeTabId: a.id }, secondary: { tabIds: [b.id], activeTabId: b.id } },
    })
    closeSplit(state)
    expect(state.editorSplit).toBe(false)
    expect(state.panes.secondary.tabIds).toEqual([])
    expect(state.panes.primary.tabIds).toContain(b.id)
  })

  it('reconcilePanes drops stale ids and auto-closes a split that lost a pane', () => {
    const a = emptyFileTab('a.ts')
    const state = makeState({
      editorSplit: true,
      tabs: [a],
      panes: { primary: { tabIds: [a.id], activeTabId: a.id }, secondary: { tabIds: ['ghost'] } },
    })
    reconcilePanes(state)
    expect(state.editorSplit).toBe(false)
    expect(state.panes.primary.tabIds).toEqual([a.id])
    expect(state.activeTabId).toBe(a.id)
  })
})

describe('workbench-snapshot', () => {
  it('cloneState deep-copies panes and tabs so later edits do not leak', () => {
    const a = emptyFileTab('a.ts')
    const state = makeState({ tabs: [a], panes: { primary: { tabIds: [a.id] }, secondary: { tabIds: [] } } })
    const clone = cloneState(state)
    clone.panes.primary.tabIds.push('late')
    clone.tabs.push(emptyFileTab('z.ts'))
    expect(state.panes.primary.tabIds).toEqual([a.id])
    expect(state.tabs).toHaveLength(1)
  })

  it('stripWorkspaceEphemera removes page-live terminal tabs and the pending rail action', () => {
    const file = emptyFileTab('a.ts')
    const state = makeState({
      tabs: [file, { id: 'terminal:1', kind: 'terminal', sequence: 1, contentId: 'c', status: 'running' }],
      sidebarAction: { id: 1, action: 'files.newFile', workspaceId: 'ws' },
      panes: { primary: { tabIds: [file.id, 'terminal:1'] }, secondary: { tabIds: [] } },
    })
    const stripped = stripWorkspaceEphemera(state)
    expect(stripped.tabs.every(tab => tab.kind !== 'terminal')).toBe(true)
    expect(stripped.sidebarAction).toBeUndefined()
    expect(stripped.panes.primary.tabIds).toEqual([file.id])
  })
})
