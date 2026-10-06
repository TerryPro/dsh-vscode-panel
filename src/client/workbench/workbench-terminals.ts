/** Official-terminal integration: open a tab, mirror its phase, and resolve/close its process. */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ClientTerminals, TerminalView } from '@deepseek-ai/dsh-api-terminal-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TerminalStatus, WorkbenchLogger, WorkbenchState, WorkbenchTerminalTab } from './workbench-types.ts'
import { focusedPaneId, placeTabInPane, selectInPanes } from '../core/editor-pane-model.ts'

/** The shell hooks the terminal runtime needs from the controller without importing it. */
export interface TerminalHost {
  revealEditor(): void
  setWorkspace(workspaceId: string | undefined): void
}

export class WorkbenchTerminals {
  private terminalId = 0

  constructor(
    private readonly store: SnapshotStore<WorkbenchState>,
    private readonly logger: WorkbenchLogger,
    private readonly host: TerminalHost,
    private readonly terminals?: ClientTerminals,
  ) {}

  openTerminal(workspaceId = this.store.getSnapshot().workspaceId): string | undefined {
    if (workspaceId === undefined) return undefined
    this.host.setWorkspace(workspaceId)
    this.host.revealEditor()
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
  closeTerminalProcess(tab: WorkbenchTerminalTab): void {
    const { sessionId } = this.store.getSnapshot()
    if (this.terminals === undefined || sessionId === undefined) return
    try {
      this.terminals.close(sessionId as SessionId, tab.id, tab.contentId)
    } catch {
      this.logger.warn(`workbench-layout: failed to close workspace terminal ${JSON.stringify(tab.id)}`)
    }
  }
}
