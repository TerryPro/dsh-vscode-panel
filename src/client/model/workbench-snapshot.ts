/** Structural state cloning and per-Workspace snapshot trimming. */

import type { WorkbenchState } from './workbench-types.ts'

export const INITIAL_STATE: WorkbenchState = {
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

export function cloneState(state: WorkbenchState): WorkbenchState {
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

/**
 * Rail requests are one-shot and never enter a Workspace snapshot.
 *
 * Terminal tabs deliberately *do* survive a Workspace switch: their Host
 * processes live in the browser's official terminal model, which a switch never
 * touches, so dropping the tabs would orphan processes the user can no longer
 * reach and hold their Session's terminal quota open. The kept list is the only
 * handle back to them, and each tab keeps being addressed through the Session
 * that allocated its process, so it stays live across the switch rather than
 * going blank or reconnecting under a Session that owns nothing for it.
 */
export function stripWorkspaceEphemera(state: WorkbenchState): WorkbenchState {
  const cloned = cloneState(state)
  delete cloned.sidebarAction
  return cloned
}
