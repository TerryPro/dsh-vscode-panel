/** Resolve the official Workspace that should own the workbench surfaces. */

import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'

export interface WorkspaceMembership {
  workspaceId: string
  path: string
  sessionIds: readonly string[]
  /** DSH Workspace creation instant; the recency fallback for a Workspace with no listed Session. */
  createdAt?: string
}

/** One Session list row, reduced to the facts Workspace resolution reads. */
export interface SessionActivityRow {
  /** Latest durable update instant, used to rank Workspaces when no Session is current. */
  readonly updatedAt: number
  /** Local retention counts; the main view marks the Session it shows. */
  readonly retainedBy?: Readonly<Record<string, number | undefined>> | undefined
}

/** The Session list indexed by identity, as `useSessions` exposes it. */
export type SessionActivityIndex = Readonly<Record<string, SessionActivityRow | undefined>>

/**
 * Compile-time anchor on the two host snapshots this module reads.
 *
 * Every `@deepseek-ai/dsh-*` client package declares no dependencies, so an
 * unlisted peer resolves to `any` and silently switches off every check on the
 * snapshot fields a plugin reads. `any extends X` collapses the conditional to
 * `boolean`, which fails `AssertTrue` — so a removed type dependency and a real
 * shape change both break the build instead of changing behavior at runtime.
 */
type AssertTrue<Condition extends true> = Condition

type WorkspaceViewSatisfiesMembership = AssertTrue<
  WorkspaceView extends WorkspaceMembership ? true : false
>

type SessionListRowsSatisfyActivityIndex = AssertTrue<
  SessionListState['byId'] extends SessionActivityIndex ? true : false
>

/**
 * The Session the main view currently shows.
 *
 * DSH 0.2 carries no `current` field on the Session list state: the main view
 * retains its Session through the `mainView` reference source, and the official
 * Workspace browser reads the same flag to highlight the active row.
 */
export function resolveCurrentSessionId(sessions: SessionActivityIndex): string | undefined {
  for (const [sessionId, session] of Object.entries(sessions)) {
    if (session !== undefined && (session.retainedBy?.mainView ?? 0) > 0) return sessionId
  }
  return undefined
}

/**
 * Follow the current Session's Workspace when it has one; otherwise mirror
 * DSH's own recent-Workspace rule so the no-Session and blank-Session surfaces
 * still address a Workspace. Never derive an identity from a filesystem path.
 */
export function resolveWorkbenchWorkspace<T extends WorkspaceMembership>(
  workspaces: readonly T[],
  sessionId: string | undefined,
  sessions: SessionActivityIndex,
): T | undefined {
  if (sessionId !== undefined) {
    const member = workspaces.find(workspace => workspace.sessionIds.includes(sessionId))
    if (member !== undefined) return member
  }
  return mostRecentlyUpdatedWorkspace(workspaces, sessions)
}

/** Resolve only the Workspace id for surfaces that hold no projection of their own. */
export function resolveWorkbenchWorkspaceId(
  workspaces: readonly WorkspaceMembership[],
  sessionId: string | undefined,
  sessions: SessionActivityIndex,
): string | undefined {
  return resolveWorkbenchWorkspace(workspaces, sessionId, sessions)?.workspaceId
}

/**
 * DSH's recent-Workspace solve: the Workspace with the most recently updated
 * member Session, or its own creation instant when it lists none. Ties keep the
 * Host Workspace order because only a strictly greater instant displaces the
 * current pick.
 */
function mostRecentlyUpdatedWorkspace<T extends WorkspaceMembership>(
  workspaces: readonly T[],
  sessions: SessionActivityIndex,
): T | undefined {
  let selected: T | undefined
  let selectedRecency = Number.NEGATIVE_INFINITY
  for (const workspace of workspaces) {
    const recency = workspaceRecency(workspace, sessions)
    if (selected === undefined || recency > selectedRecency) {
      selected = workspace
      selectedRecency = recency
    }
  }
  return selected
}

function workspaceRecency(workspace: WorkspaceMembership, sessions: SessionActivityIndex): number {
  let latest = Number.NEGATIVE_INFINITY
  for (const sessionId of workspace.sessionIds) {
    const updatedAt = sessions[sessionId]?.updatedAt
    if (typeof updatedAt === 'number' && Number.isFinite(updatedAt)) latest = Math.max(latest, updatedAt)
  }
  if (latest !== Number.NEGATIVE_INFINITY) return latest
  const created = workspace.createdAt === undefined ? Number.NaN : Date.parse(workspace.createdAt)
  return Number.isFinite(created) ? created : Number.NEGATIVE_INFINITY
}
