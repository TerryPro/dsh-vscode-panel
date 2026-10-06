// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkbenchState } from '../src/client/controller.ts'
import { zh } from '../src/client/locales.ts'
import { TerminalPanel } from '../src/client/terminal/TerminalPanel.tsx'

const current = vi.hoisted(() => ({ state: {} as WorkbenchState }))
vi.mock('../src/client/use-workbench.ts', () => ({ useWorkbench: () => current.state }))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconCloseOutlineMedium: () => <span />,
  IconPlusOutlineMedium: () => <span />,
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
}))

afterEach(() => { cleanup() })

describe('终端左栏', () => {
  it('管理当前工作区的多个终端并显示运行状态', () => {
    current.state = {
      sidebarMode: 'terminal', editorExpanded: true, workspaceId: 'workspace-1', activeTabId: 'terminal:1', diffViewMode: 'split',
      gitView: 'changes', gitChangeLayout: 'list', gitGraphFileLayout: 'list',
      tabs: [
        { id: 'terminal:1', kind: 'terminal', sequence: 1, contentId: 'wbterm:workspace-1:terminal:1', status: 'running' },
        { id: 'terminal:2', kind: 'terminal', sequence: 2, contentId: 'wbterm:workspace-1:terminal:2', status: 'exited' },
      ],
    }
    const controller = {
      openTerminal: vi.fn(), selectTab: vi.fn(), closeTab: vi.fn(),
    }
    const view = render(
      <TerminalPanel
        controller={controller as never}
        workspaceId="workspace-1"
        t={(key, values) => interpolate(zh[key], values as Record<string, string> | undefined)}
      />,
    )

    expect(view.getByText('正在运行')).toBeTruthy()
    expect(view.getByText('已退出')).toBeTruthy()
    fireEvent.click(view.getByText('终端 2'))
    expect(controller.selectTab).toHaveBeenCalledWith('terminal:2')
    fireEvent.click(view.getByRole('button', { name: '关闭 终端 1' }))
    expect(controller.closeTab).toHaveBeenCalledWith('terminal:1')
    fireEvent.click(view.getByRole('button', { name: '新建终端' }))
    expect(controller.openTerminal).toHaveBeenCalledWith('workspace-1')
  })

  it('首次进入空终端视图时创建一个终端，但关闭最后一个后不循环重建', () => {
    current.state = {
      sidebarMode: 'terminal', editorExpanded: true, workspaceId: 'workspace-1', diffViewMode: 'split', tabs: [],
      gitView: 'changes', gitChangeLayout: 'list', gitGraphFileLayout: 'list',
    }
    const controller = { openTerminal: vi.fn(), selectTab: vi.fn(), closeTab: vi.fn() }
    const view = render(
      <TerminalPanel
        controller={controller as never}
        workspaceId="workspace-1"
        t={(key, values) => interpolate(zh[key], values as Record<string, string> | undefined)}
      />,
    )
    expect(controller.openTerminal).toHaveBeenCalledTimes(1)
    view.rerender(
      <TerminalPanel
        controller={controller as never}
        workspaceId="workspace-1"
        t={(key, values) => interpolate(zh[key], values as Record<string, string> | undefined)}
      />,
    )
    expect(controller.openTerminal).toHaveBeenCalledTimes(1)
  })
})

function interpolate(template: string, values: Record<string, string> | undefined): string {
  if (values === undefined) return template
  return Object.entries(values).reduce((text, [key, value]) => text.replace(`{${key}}`, value), template)
}
