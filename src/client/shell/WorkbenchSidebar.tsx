import { useEffect, useMemo } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkbenchController } from '../model/controller.ts'
import type { WorkbenchKey } from '../core/locales.ts'
import { FileTree } from '../files/FileTree.tsx'
import { GitPanel } from '../git/GitPanel.tsx'
import { TerminalPanel } from '../terminal/TerminalPanel.tsx'
import { useWorkbench } from '../model/use-workbench.ts'
import { WorkbenchRail } from './WorkbenchRail.tsx'
import { resolveCurrentSessionId, resolveWorkbenchWorkspace } from '../model/workspace-binding.ts'
import css from './shell.module.css'

export type WorkbenchSidebarProps = PropsRuntime<'sidebar.workspaces'> & PropsLocale<'workbench'> & {
  controller: WorkbenchController
}

/**
 * Present on the document root while this seat shadows the official sessions
 * browser (files/Git/terminal). The shell's persistent New Session button and
 * global panel rows sit above the shadowed region, so CSS hides them only while
 * this marker is set and reveals them again once the seat returns to sessions.
 */
export const SIDEBAR_SHADOWED_ATTRIBUTE = 'data-dsh-workbench-sidebar-shadowed'

/** Sidebar replacement body; the official shell, brand, controls, and settings stay mounted. */
export function WorkbenchSidebar({ wide, expandSidebar, useSessions, useWorkspaces, controller, t }: WorkbenchSidebarProps) {
  const state = useWorkbench(controller)
  // This seat is root-scoped, so the current Session is read the way the
  // official Workspace browser reads it: the row the main view retains.
  const sessions = useSessions(snapshot => snapshot.byId)
  const workspaces = useWorkspaces(snapshot => snapshot.items)
  const workspace = useMemo(
    () => resolveWorkbenchWorkspace(workspaces, resolveCurrentSessionId(sessions), sessions),
    [sessions, workspaces],
  )
  const workspaceId = workspace?.workspaceId
  useEffect(() => { controller.setWorkspace(workspaceId) }, [controller, workspaceId])
  // This component mounts exactly while the shadow is active, so the marker's
  // lifecycle tracks the shadow: set on mount, cleared when the seat releases.
  useEffect(() => {
    const root = document.documentElement
    root.setAttribute(SIDEBAR_SHADOWED_ATTRIBUTE, '')
    return () => { root.removeAttribute(SIDEBAR_SHADOWED_ATTRIBUTE) }
  }, [])
  if (!wide) {
    return (
      <WorkbenchRail
        controller={controller}
        workspaceId={workspaceId}
        expandSidebar={expandSidebar}
        t={t}
      />
    )
  }
  return (
    <div className={css.sidebarBody}>
      {state.sidebarMode === 'git'
        ? <GitPanel controller={controller} workspaceId={workspaceId} t={t} />
        : state.sidebarMode === 'terminal'
          ? <TerminalPanel controller={controller} workspaceId={workspaceId} t={t} />
          : <FileTree controller={controller} workspaceId={workspaceId} workspacePath={workspace?.path} t={t} />}
    </div>
  )
}
