// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { zh } from '../src/client/core/locales.ts'
import { WorkbenchRail } from '../src/client/shell/WorkbenchRail.tsx'

const workbench = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))

vi.mock('../src/client/model/use-workbench.ts', () => ({ useWorkbench: () => workbench.current }))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconFolderCloseMedium: () => <span data-icon="official-folder" />,
  IconListPenOutlineMedium: () => <span data-icon="changes" />,
  IconPlusOutlineMedium: ({ className }: { className?: string }) => <span data-icon="plus" className={className} />,
  IconRefreshOutlineMedium: () => <span data-icon="refresh" />,
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
}))

afterEach(() => {
  cleanup()
  workbench.current = {}
})

describe('模式化收起栏快捷操作', () => {
  it('为文件模式只保留两个新建入口并在发出一次性命令后展开侧栏', () => {
    workbench.current = state('files')
    const controller = controllerFixture()
    const expandSidebar = vi.fn()
    const view = renderRail(controller, expandSidebar)

    expect(view.getAllByRole('button')).toHaveLength(2)
    expect(view.queryByRole('button', { name: '刷新文件目录' })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: '新建文件' }))
    expect(controller.requestSidebarAction).toHaveBeenCalledWith('files.newFile', 'workspace-1')
    expect(expandSidebar).toHaveBeenCalledOnce()
  })

  it('让 Git 收起栏只保留与共享提交图状态一致的视图切换', () => {
    workbench.current = { ...state('git'), gitView: 'graph' }
    const controller = controllerFixture()
    const expandSidebar = vi.fn()
    const view = renderRail(controller, expandSidebar)

    expect(view.getByRole('button', { name: '切换到更改' }).getAttribute('aria-pressed')).toBe('true')
    expect(view.getAllByRole('button')).toHaveLength(1)
    expect(view.queryByRole('button', { name: '同步更改' })).toBeNull()
    expect(view.queryByRole('button', { name: '刷新 Git 状态' })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: '切换到更改' }))
    expect(controller.toggleGitView).toHaveBeenCalledOnce()
    expect(controller.requestSidebarAction).not.toHaveBeenCalled()
    expect(expandSidebar).toHaveBeenCalledOnce()
  })

  it('为终端模式提供新建入口和已有终端选择', () => {
    workbench.current = {
      ...state('terminal'),
      activeTabId: 'terminal:1',
      tabs: [
        { id: 'terminal:1', kind: 'terminal', sequence: 1, generation: 0, status: 'running', error: null },
        { id: 'terminal:2', kind: 'terminal', sequence: 2, generation: 0, status: 'exited', error: null },
      ],
    }
    const controller = controllerFixture()
    const view = renderRail(controller, vi.fn())

    expect(view.getByRole('button', { name: '终端 1' }).getAttribute('data-status')).toBe('running')
    fireEvent.click(view.getByRole('button', { name: '新建终端' }))
    expect(controller.openTerminal).toHaveBeenCalledWith('workspace-1')
    fireEvent.click(view.getByRole('button', { name: '终端 2' }))
    expect(controller.selectTab).toHaveBeenCalledWith('terminal:2')
  })

  it('为 SQL 模式给出三个快捷动作：打开笔记、刷新结构、新建笔记', async () => {
    const notebook = { id: 'file:query.sqlnb', kind: 'file' as const, path: 'query.sqlnb' }
    workbench.current = { ...state('files'), sidebarMode: 'sql', activeTabId: notebook.id, tabs: [notebook] }
    const controller = controllerFixture()
    const expandSidebar = vi.fn()
    const view = renderRail(controller, expandSidebar)

    expect(view.getAllByRole('button')).toHaveLength(3)
    fireEvent.click(view.getByRole('button', { name: '打开当前 SQL 笔记' }))
    expect(controller.selectTab).toHaveBeenCalledWith('file:query.sqlnb')

    // The panel owns the schema; the collapsed rail can only ask it to re-read.
    fireEvent.click(view.getByRole('button', { name: '刷新结构' }))
    expect(controller.requestSidebarAction).toHaveBeenCalledWith('sql.refreshSchema', 'workspace-1')
    expect(expandSidebar).toHaveBeenCalledOnce()

    // The same three steps the file tree takes when it makes one.
    fireEvent.click(view.getByRole('button', { name: '新建 SQL 笔记' }))
    await waitFor(() => { expect(controller.connectNewSqlNotebook).toHaveBeenCalledWith('workspace-1', 'query-1.sqlnb') })
    expect(controller.openFile).toHaveBeenCalledWith('workspace-1', 'query-1.sqlnb')
  })
})

function renderRail(controller: ReturnType<typeof controllerFixture>, expandSidebar: () => void) {
  return render(
    <WorkbenchRail
      controller={controller as never}
      workspaceId="workspace-1"
      expandSidebar={expandSidebar}
      t={(key, values) => interpolate(zh[key], values as Record<string, string> | undefined)}
    />,
  )
}

function state(sidebarMode: 'files' | 'git' | 'terminal') {
  return {
    sidebarMode,
    editorExpanded: true,
    workspaceId: 'workspace-1',
    tabs: [],
    diffViewMode: 'split',
    gitView: 'changes',
    gitChangeLayout: 'list',
    gitGraphFileLayout: 'list',
  }
}

function controllerFixture() {
  return {
    requestSidebarAction: vi.fn(),
    toggleGitView: vi.fn(),
    openTerminal: vi.fn(),
    selectTab: vi.fn(),
    terminalBinding: vi.fn(() => 'ready' as const),
    openFile: vi.fn(() => Promise.resolve()),
    connectNewSqlNotebook: vi.fn(() => Promise.resolve()),
    // The create pair the rail shares with the file tree: an empty file, a version to save against.
    api: {
      createFile: vi.fn(() => Promise.resolve({ name: 'query-1.sqlnb', path: 'query-1.sqlnb', kind: 'file' as const, size: 0 })),
      readFile: vi.fn(() => Promise.resolve({ path: 'query-1.sqlnb', content: '', version: 'v1', size: 0 })),
      saveFile: vi.fn(() => Promise.resolve({ version: 'v2' })),
    },
  }
}

function interpolate(template: string, values: Record<string, string> | undefined): string {
  if (values === undefined) return template
  return Object.entries(values).reduce((text, [key, value]) => text.replace(`{${key}}`, value), template)
}
