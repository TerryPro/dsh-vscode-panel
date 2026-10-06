import { describe, expect, it } from 'vitest'
import {
  resolveCurrentSessionId,
  resolveWorkbenchWorkspace,
  resolveWorkbenchWorkspaceId,
  type SessionActivityIndex,
} from '../src/client/workspace-binding.ts'

const workspaces = [
  { workspaceId: 'workspace-a', path: '/workspace/alpha', sessionIds: ['session-a1', 'session-a2'] },
  { workspaceId: 'workspace-b', path: '/workspace/beta', sessionIds: ['session-b1'] },
]

/** Session rows keyed by identity, with the main-view retention flag DSH publishes. */
function sessions(rows: Record<string, { updatedAt: number; mainView?: number }>): SessionActivityIndex {
  return Object.fromEntries(Object.entries(rows).map(([id, row]) => [
    id,
    { updatedAt: row.updatedAt, retainedBy: row.mainView === undefined ? {} : { mainView: row.mainView } },
  ]))
}

describe('Workspace membership binding', () => {
  it('maps multiple Sessions in one Workspace to the same stable id', () => {
    const activity = sessions({ 'session-a1': { updatedAt: 1 }, 'session-a2': { updatedAt: 2 } })
    expect(resolveWorkbenchWorkspaceId(workspaces, 'session-a1', activity)).toBe('workspace-a')
    expect(resolveWorkbenchWorkspaceId(workspaces, 'session-a2', activity)).toBe('workspace-a')
  })

  it('reads the current Session from the main-view retention flag', () => {
    const activity = sessions({
      'session-a1': { updatedAt: 90 },
      'session-b1': { updatedAt: 10, mainView: 1 },
    })
    expect(resolveCurrentSessionId(activity)).toBe('session-b1')
    // The current Session wins over recency, which would otherwise pick workspace-a.
    expect(resolveWorkbenchWorkspaceId(workspaces, resolveCurrentSessionId(activity), activity))
      .toBe('workspace-b')
  })

  it('has no current Session while nothing is retained by the main view', () => {
    expect(resolveCurrentSessionId(sessions({
      'session-a1': { updatedAt: 1 },
      'session-b1': { updatedAt: 2, mainView: 0 },
    }))).toBeUndefined()
    expect(resolveCurrentSessionId({})).toBeUndefined()
  })

  it('ranks Workspaces by their most recently updated member Session', () => {
    const activity = sessions({
      'session-a1': { updatedAt: 10 },
      'session-a2': { updatedAt: 40 },
      'session-b1': { updatedAt: 25 },
    })
    expect(resolveWorkbenchWorkspaceId(workspaces, undefined, activity)).toBe('workspace-a')
  })

  it('ranks a Workspace with no listed Session by its own creation instant', () => {
    const projections = [
      { workspaceId: 'workspace-a', path: '/workspace/alpha', sessionIds: [], createdAt: '2026-08-01T00:00:00Z' },
      { workspaceId: 'workspace-b', path: '/workspace/beta', sessionIds: [], createdAt: '2026-08-02T00:00:00Z' },
    ]
    expect(resolveWorkbenchWorkspaceId(projections, undefined, {})).toBe('workspace-b')
  })

  it('keeps the earlier Workspace when no recency fact separates them', () => {
    expect(resolveWorkbenchWorkspaceId(workspaces, undefined, {})).toBe('workspace-a')
    expect(resolveWorkbenchWorkspaceId([], undefined, {})).toBeUndefined()
  })

  it('keeps a Workspace with no Session usable before its first message', () => {
    const emptyWorkspace = [{
      workspaceId: 'workspace-empty', path: '/workspace/empty', sessionIds: [], createdAt: '2026-08-01T00:00:00Z',
    }]
    expect(resolveWorkbenchWorkspaceId(emptyWorkspace, undefined, {})).toBe('workspace-empty')
    expect(resolveWorkbenchWorkspaceId(emptyWorkspace, 'blank-session', {})).toBe('workspace-empty')
  })

  it('falls back for an unaccounted Session instead of inventing a Workspace', () => {
    const activity = sessions({ 'session-a1': { updatedAt: 10 }, 'session-b1': { updatedAt: 25 } })
    expect(resolveWorkbenchWorkspaceId(workspaces, 'session-missing', activity)).toBe('workspace-b')
  })

  it('returns the complete official Workspace projection for display metadata', () => {
    const projections = [
      { workspaceId: 'workspace-a', path: '/workspace/alpha', title: 'alpha', sessionIds: ['session-a1'] },
      {
        workspaceId: 'workspace-b',
        path: '/workspace/beta',
        title: 'beta',
        sessionIds: [],
        createdAt: '2030-01-01T00:00:00Z',
      },
    ]
    const activity = sessions({ 'session-a1': { updatedAt: 10 } })
    expect(resolveWorkbenchWorkspace(projections, 'session-a1', activity)).toBe(projections[0])
    // No current Session: recency still yields a full projection to read metadata from.
    expect(resolveWorkbenchWorkspace(projections, undefined, activity)?.path).toBe('/workspace/beta')
  })
})
