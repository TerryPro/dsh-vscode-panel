/** Official-terminal integration: open a tab, mirror its phase, and resolve/close its process. */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ClientTerminals, TerminalView } from '@deepseek-ai/dsh-api-terminal-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WebTerminalInfo } from '@deepseek-ai/dsh-api-terminal-controller/types'
import type {
  TerminalBinding,
  TerminalStatus,
  WorkbenchLogger,
  WorkbenchShellChoice,
  WorkbenchState,
  WorkbenchTerminalTab,
} from './workbench-types.ts'
import { focusedPaneId, placeTabInPane, selectInPanes } from './editor-pane-model.ts'

/** The shell hooks the terminal runtime needs from the controller without importing it. */
export interface TerminalHost {
  revealEditor(): void
  setWorkspace(workspaceId: string | undefined): void
}

/**
 * Mint a globally unique content identity for one new terminal tab.
 *
 * The official model persists `contentId -> Host terminal id` in localStorage and
 * treats an existing association as "restore this process, never allocate another"
 * (its docs: *layout-local tab ids are not persistence keys*). Deriving the
 * identity from a layout counter restarts at 1 on every page load, so a refreshed
 * page's first terminal collided with the previous page's saved binding, resolved
 * to a long-dead Host terminal, reported an unrecoverable `missingTerminal`, and
 * retrying re-read the same stale binding and failed identically.
 */
function newContentId(): string {
  return `wbterm:${uniqueSuffix()}`
}

/**
 * A collision-free suffix that survives an insecure context.
 *
 * `crypto.randomUUID` exists only in secure contexts, and DSH Web is reachable
 * over plain HTTP on a LAN address — where it is `undefined` and opening any
 * terminal would throw. `getRandomValues` remains available there, so the same
 * v4 layout is assembled by hand, falling back to a random string only if the
 * platform offers neither.
 */
function uniqueSuffix(): string {
  const bytes = new Uint8Array(16)
  if (globalThis.crypto?.getRandomValues === undefined) return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  globalThis.crypto.getRandomValues(bytes)
  // Set the v4 version and variant bits so the value keeps UUID shape.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export class WorkbenchTerminals {
  private terminalId = 0
  /**
   * The Session each tab's model was first resolved against.
   *
   * A tab opened before any Session was bound has no owner recorded yet, and the
   * owner is only written down once its process answers. Until then the tab must
   * keep asking for the *same* Session it started to allocate in, or switching
   * away mid-allocation would resolve a second identity and leave the first
   * process orphaned under the Session it was created in.
   */
  private readonly pendingOwner = new Map<string, string>()

  constructor(
    private readonly store: SnapshotStore<WorkbenchState>,
    private readonly logger: WorkbenchLogger,
    private readonly host: TerminalHost,
    private readonly terminals?: ClientTerminals,
  ) {}

  openTerminal(
    workspaceId = this.store.getSnapshot().workspaceId,
    shellPath?: string,
  ): string | undefined {
    if (workspaceId === undefined) return undefined
    this.host.setWorkspace(workspaceId)
    this.host.revealEditor()
    const state = this.store.getSnapshot()
    const sequence = state.tabs.reduce((highest, tab) => tab.kind === 'terminal'
      ? Math.max(highest, tab.sequence)
      : highest, 0) + 1
    const id = `terminal:${++this.terminalId}`
    this.store.update((draft) => {
      const tab: WorkbenchTerminalTab = {
        id,
        kind: 'terminal',
        sequence,
        contentId: newContentId(),
        status: 'connecting',
        // The Session on screen owns the process the official model allocates, so
        // the tab records it now; a tab with no Session yet allocates nothing.
        ...(draft.sessionId === undefined ? {} : { ownerSessionId: draft.sessionId }),
        ...(shellPath === undefined ? {} : { shellPath }),
      }
      draft.tabs.push(tab)
      placeTabInPane(draft, focusedPaneId(draft), id)
      selectInPanes(draft, id)
    })
    this.logger.info(`workbench-layout: opened workspace terminal ${sequence} in ${JSON.stringify(workspaceId)}`
      + (shellPath === undefined ? '' : ` with ${JSON.stringify(shellPath)}`))
    return id
  }

  /**
   * Whether one tab has a Session to address its process through at all.
   *
   * There is no "belongs to another Session" case any more, and there never
   * really was one: the Host resolves the owning Session's Agent on demand
   * (`resolveAgent` returns the live Agent or resumes it), so a tab keeps being
   * driven through the Session that allocated it even after the Workspace has
   * moved on. That is what lets a terminal outlive a Session switch instead of
   * being cut off from a process the Host reports is still running.
   */
  terminalBinding(tab: WorkbenchTerminalTab): TerminalBinding {
    if (this.terminals === undefined) return 'noSession'
    return this.resolveSession(tab) === undefined ? 'noSession' : 'ready'
  }

  /**
   * Give one tab a fresh process, keeping its identity, position, and chosen shell.
   *
   * This is no longer the answer to a Session switch — a switched-away tab stays
   * live through its own owner — but it is still the only recovery for a tab whose
   * Host terminal has disappeared. The official model treats such a tab as a
   * *restore* view, which is explicitly forbidden from allocating a replacement: it
   * reports `missingTerminal` and every retry repeats the same miss. So the tab
   * closes its old identity through the Session that still owns it, which also
   * drops the saved content binding, and takes a new identity that the next view
   * lookup allocates cleanly.
   * @returns false when no Session is bound, leaving the tab as it was.
   */
  reopenTerminalHere(tabId: string): boolean {
    const state = this.store.getSnapshot()
    const { sessionId } = state
    if (this.terminals === undefined || sessionId === undefined) return false
    const tab = state.tabs.find(candidate => candidate.id === tabId)
    if (tab?.kind !== 'terminal') return false
    this.closeTerminalProcess(tab)
    this.pendingOwner.delete(tabId)
    this.store.update((draft) => {
      const target = draft.tabs.find(candidate => candidate.id === tabId)
      if (target?.kind !== 'terminal') return
      target.contentId = newContentId()
      target.status = 'connecting'
      target.ownerSessionId = sessionId
      delete target.shellName
      delete target.runtime
    })
    this.logger.info(`workbench-layout: reopened workspace terminal ${JSON.stringify(tabId)} in session ${JSON.stringify(sessionId)}`)
    return true
  }

  /**
   * List the shells the Host verifies in the current Session's execution
   * environment, so the new-terminal menu offers PowerShell, CMD, and whatever
   * else is installed rather than assuming the process default.
   *
   * Discovery needs a Session: the official service scopes shell probing to the
   * Session's provider, and a Workspace with no Session has no environment to
   * read. Without a service or Session the caller gets an empty list, which the
   * menu renders as "no explicit choice" rather than an error.
   * @returns available shells, `selectedShell` being the browser's remembered choice.
   */
  async listShells(signal: AbortSignal): Promise<{ shells: readonly WorkbenchShellChoice[]; selectedShell: string | undefined }> {
    const { sessionId } = this.store.getSnapshot()
    if (this.terminals === undefined || sessionId === undefined) return { shells: [], selectedShell: undefined }
    try {
      const discovered = await this.terminals.launchShells(sessionId as SessionId, signal)
      return {
        shells: discovered.shells.map(shell => ({ path: shell.path, name: shell.name })),
        selectedShell: discovered.selectedShell,
      }
    } catch {
      // A cancelled probe is the menu being reopened or closed, not a failure
      // worth a warning; only a probe that died on its own is diagnosed.
      if (signal.aborted) return { shells: [], selectedShell: undefined }
      this.logger.warn('workbench-layout: failed to discover workspace terminal shells')
      return { shells: [], selectedShell: undefined }
    }
  }

  /** Remember the picked shell as this browser's default for terminals without an explicit choice. */
  selectShell(path: string): void {
    if (this.terminals === undefined) return
    this.terminals.selectShell(path)
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

  /**
   * Mirror the shell the official process actually reports onto the tab.
   *
   * The Host names the shell it resolved, so this is the only reliable label for
   * a restored terminal, whose process predates any choice made in this window.
   * @param shellName - resolved executable name, or undefined to leave the tab unlabelled.
   */
  setTerminalShell(tabId: string, shellName: string | undefined): void {
    const current = this.store.getSnapshot().tabs.find(tab => tab.id === tabId)
    if (current?.kind !== 'terminal' || current.shellName === shellName) return
    this.store.update((state) => {
      const tab = state.tabs.find(candidate => candidate.id === tabId)
      if (tab?.kind !== 'terminal') return
      if (shellName === undefined) delete tab.shellName
      else tab.shellName = shellName
    })
  }

  /**
   * Mirror the Host's terminal title onto the tab, without ever erasing a name.
   *
   * The Host names a fresh terminal after its shell, so a title still equal to
   * the shell name is the default rather than something the user chose, and
   * adopting it would replace "Terminal 3" with "pwsh" on every unnamed tab.
   *
   * A tab that already carries a name keeps it: that name came from the user in
   * this window, and overwriting it with the Host's copy would silently undo a
   * rename — including one whose new name happens to equal the shell name.
   */
  setTerminalTitle(tabId: string, title: string | undefined, shellName: string | undefined): void {
    const current = this.store.getSnapshot().tabs.find(tab => tab.id === tabId)
    if (current?.kind !== 'terminal' || current.title !== undefined) return
    const custom = title !== undefined && title !== shellName ? title : undefined
    if (custom === undefined) return
    this.store.update((state) => {
      const tab = state.tabs.find(candidate => candidate.id === tabId)
      if (tab?.kind === 'terminal') tab.title = custom
    })
  }

  /**
   * Mirror the process facts the status line reports.
   *
   * `cwd` is the directory the shell *started* in — the Host documents that a
   * shell changing directory never updates it — so the caller labels it as such
   * rather than pretending to track `cd`.
   */
  setTerminalRuntime(tabId: string, info: WebTerminalInfo | undefined): void {
    const current = this.store.getSnapshot().tabs.find(tab => tab.id === tabId)
    if (current?.kind !== 'terminal') return
    const next = info === undefined
      ? undefined
      : { cwd: info.cwd, cols: info.cols, rows: info.rows, exitCode: info.exitCode }
    const previous = current.runtime
    if (previous?.cwd === next?.cwd && previous?.cols === next?.cols
      && previous?.rows === next?.rows && previous?.exitCode === next?.exitCode) return
    this.store.update((state) => {
      const tab = state.tabs.find(candidate => candidate.id === tabId)
      if (tab?.kind !== 'terminal') return
      if (next === undefined) delete tab.runtime
      else tab.runtime = next
    })
  }

  /**
   * Rename one terminal, locally first and then on the Host.
   *
   * The name is written to the tab before the round trip so the row updates at
   * once and never waits on the network. Pushing it to the Host as well is what
   * makes the name the *process* carries rather than only this window's label:
   * the Host publishes the title to every attached view, so the same terminal
   * opened again later — or from another window that restores it — reports the
   * name back through {@link setTerminalTitle}.
   */
  renameTerminal(tabId: string, title: string): void {
    const trimmed = title.trim()
    if (trimmed === '') return
    const tab = this.store.getSnapshot().tabs.find(candidate => candidate.id === tabId)
    if (tab?.kind !== 'terminal') return
    this.store.update((state) => {
      const target = state.tabs.find(candidate => candidate.id === tabId)
      if (target?.kind !== 'terminal') return
      target.title = trimmed
    })
    this.logger.info(`workbench-layout: renamed workspace terminal ${JSON.stringify(tabId)} to ${JSON.stringify(trimmed)}`)
    // A tab that has no process yet only carries the name in this window; the
    // Host learns it as soon as the terminal allocates.
    void this.terminalView(tab)?.rename(trimmed)
  }

  /** Record the Session the active Workspace belongs to so official terminal views scope to it. */
  setSession(sessionId: string | undefined): void {
    if (this.store.getSnapshot().sessionId === sessionId) return
    this.store.update((state) => {
      if (sessionId === undefined) delete state.sessionId
      else state.sessionId = sessionId
    })
  }

  /**
   * Resolve the official terminal model for one tab.
   *
   * Returns nothing only when there is no Session to address at all. The tab is
   * resolved through its **owning** Session rather than the one on screen: the
   * official service keys its view cache by Session, so asking for the owner
   * hands back the very same model instance the tab had before the switch, with
   * its stream, screen, and attachment intact.
   *
   * Asking for the Session on screen instead is what used to break a terminal:
   * the owner's binding is not found under another Session, and the model
   * allocates a *new* process there, silently replacing the tab's terminal with
   * a blank one.
   *
   * A tab's recorded `shellPath` is forwarded so an explicit menu choice starts that
   * executable; tabs opened without a choice pass nothing and the official model
   * falls back to the remembered available shell, then the environment default.
   * A restored process ignores it — its own shell already runs.
   */
  terminalView(tab: WorkbenchTerminalTab): TerminalView | undefined {
    const sessionId = this.resolveSession(tab)
    if (this.terminals === undefined || sessionId === undefined) return undefined
    // An unowned tab remembers what it started to allocate in, so a switch
    // mid-allocation cannot make it resolve a second identity.
    if (tab.ownerSessionId === undefined) this.pendingOwner.set(tab.id, sessionId)
    return this.terminals.view(sessionId as SessionId, tab.contentId, tab.contentId, undefined, tab.shellPath)
  }

  /**
   * Record the Session that allocated a tab's process, once and from the Session
   * the view really runs under. A tab opened before any Session existed has no
   * owner to compare against until its first process answers.
   */
  recordTerminalOwner(tabId: string): void {
    const current = this.store.getSnapshot().tabs.find(tab => tab.id === tabId)
    if (current?.kind !== 'terminal') return
    // The Session the view was actually asked to allocate in, which a tab opened
    // before any Session existed has already been resolved against. Falling back
    // to the Session on screen would record the wrong owner if the Workspace
    // moved while this tab's process was still starting.
    const owner = this.resolveSession(current)
    if (owner === undefined || current.ownerSessionId === owner) return
    this.pendingOwner.delete(tabId)
    this.store.update((state) => {
      const tab = state.tabs.find(candidate => candidate.id === tabId)
      if (tab?.kind === 'terminal') tab.ownerSessionId = owner
    })
  }

  /**
   * Ask the official model to terminate one tab's process.
   *
   * The close is addressed to the tab's **owning** Session, not the one on
   * screen: the official service resolves a content identity through
   * `[sessionId, contentId]`, so closing a tab left behind by a switch under the
   * current Session would find no identity and return without releasing anything.
   */
  closeTerminalProcess(tab: WorkbenchTerminalTab): void {
    const ownerSessionId = this.resolveSession(tab)
    this.pendingOwner.delete(tab.id)
    if (this.terminals === undefined || ownerSessionId === undefined) return
    try {
      // The content identity doubles as the occurrence key, matching terminalView.
      this.terminals.close(ownerSessionId as SessionId, tab.contentId, tab.contentId)
    } catch {
      this.logger.warn(`workbench-layout: failed to close workspace terminal ${JSON.stringify(tab.id)}`)
    }
  }

  /** The Session a tab's process is addressed through: its owner, else the one on screen. */
  private resolveSession(tab: WorkbenchTerminalTab): string | undefined {
    return tab.ownerSessionId
      ?? this.pendingOwner.get(tab.id)
      ?? this.store.getSnapshot().sessionId
  }
}
