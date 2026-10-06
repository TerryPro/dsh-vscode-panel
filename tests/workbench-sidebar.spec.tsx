// @vitest-environment jsdom

import { cleanup, render, waitFor, type RenderResult } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { WorkbenchSidebar, type WorkbenchSidebarProps } from '../src/client/WorkbenchSidebar.tsx'

vi.mock('../src/client/use-workbench.ts', () => ({ useWorkbench: () => ({ sidebarMode: 'files' }) }))
vi.mock('../src/client/FileTree.tsx', () => ({
  FileTree: ({ workspaceId, workspacePath }: { workspaceId?: string; workspacePath?: string }) => (
    <div data-probe="file-tree" data-workspace={workspaceId} data-path={workspacePath} />
  ),
}))
vi.mock('../src/client/GitPanel.tsx', () => ({ GitPanel: () => <div data-probe="git" /> }))
vi.mock('../src/client/TerminalPanel.tsx', () => ({ TerminalPanel: () => <div data-probe="terminal" /> }))
vi.mock('../src/client/WorkbenchRail.tsx', () => ({ WorkbenchRail: () => <div data-probe="rail" /> }))

afterEach(() => { cleanup() })

const workspaces = [
  { workspaceId: 'workspace-recent', path: '/workspace/recent', sessionIds: ['session-recent'] },
  { workspaceId: 'workspace-open', path: '/workspace/open', sessionIds: ['session-open'] },
]

describe('WorkbenchSidebar Workspace binding', () => {
  it('browses the Workspace of the Session the main view retains', async () => {
    const controller = { setWorkspace: vi.fn() }
    // Recency would pick workspace-recent; the retained Session must win.
    const view = renderSidebar(controller, {
      'session-recent': { updatedAt: 900, retainedBy: {} },
      'session-open': { updatedAt: 10, retainedBy: { mainView: 1 } },
    })

    await waitFor(() => { expect(fileTreeAttribute(view, 'data-workspace')).toBe('workspace-open') })
    expect(fileTreeAttribute(view, 'data-path')).toBe('/workspace/open')
    expect(controller.setWorkspace).toHaveBeenCalledWith('workspace-open')
  })

  it('falls back to the most recently updated Workspace with no retained Session', async () => {
    const controller = { setWorkspace: vi.fn() }
    const view = renderSidebar(controller, {
      'session-recent': { updatedAt: 900, retainedBy: {} },
      'session-open': { updatedAt: 10, retainedBy: {} },
    })

    await waitFor(() => { expect(fileTreeAttribute(view, 'data-workspace')).toBe('workspace-recent') })
    expect(controller.setWorkspace).toHaveBeenCalledWith('workspace-recent')
  })
})

function fileTreeAttribute(view: RenderResult, name: string): string | null {
  const probe = view.container.querySelector('[data-probe="file-tree"]')
  expect(probe).not.toBeNull()
  return probe?.getAttribute(name) ?? null
}

function renderSidebar(
  controller: { setWorkspace: (workspaceId: string | undefined) => void },
  byId: Record<string, { updatedAt: number; retainedBy: Record<string, number> }>,
): RenderResult {
  const props = {
    wide: true,
    expandSidebar: vi.fn(),
    useSessions: (selector: (snapshot: { byId: typeof byId }) => unknown) => selector({ byId }),
    useWorkspaces: (selector: (snapshot: { items: typeof workspaces }) => unknown) => selector({ items: workspaces }),
    controller,
    t: (key: keyof typeof zh) => zh[key],
  } as unknown as WorkbenchSidebarProps
  return render(<WorkbenchSidebar {...props} />)
}
