/** Structural state cloning and per-Workspace snapshot trimming. */

import type { WorkbenchState } from './workbench-types.ts'
import { reconcilePanes } from '../core/editor-pane-model.ts'

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

/** Terminal processes are page-live resources and never survive a Workspace switch. */
function stripTerminalTabs(state: WorkbenchState): WorkbenchState {
  const cloned = cloneState(state)
  cloned.tabs = cloned.tabs.filter(tab => tab.kind !== 'terminal')
  reconcilePanes(cloned)
  return cloned
}

/** Rail requests and terminal processes are page-live and never enter a Workspace snapshot. */
export function stripWorkspaceEphemera(state: WorkbenchState): WorkbenchState {
  const stripped = stripTerminalTabs(state)
  delete stripped.sidebarAction
  return stripped
}
