// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalBinding, WorkbenchState } from '../src/client/model/controller.ts'
import { zh } from '../src/client/core/locales.ts'
import { TerminalPanel } from '../src/client/terminal/TerminalPanel.tsx'

const current = vi.hoisted(() => ({ state: {} as WorkbenchState }))
vi.mock('../src/client/model/use-workbench.ts', () => ({ useWorkbench: () => current.state }))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconCloseOutlineMedium: () => <span />,
  IconPlusOutlineMedium: () => <span />,
  IconEditOutlineMedium: () => <span data-icon="edit" />,
  IconChevronDownOutlineRegular: () => <span data-icon="chevron" />,
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  // The rename modal only needs its field and buttons addressable inline.
  Modal: ({ open, children, footer }: { open: boolean; children: React.ReactNode; footer: React.ReactNode }) => (
    open ? <div role="dialog">{children}{footer}</div> : null
  ),
  Input: (props: Record<string, unknown>) => <input {...props} />,
  Button: ({ children, variant: _variant, size: _size, ...props }: Record<string, unknown>) => (
    <button type="button" {...(props as React.ButtonHTMLAttributes<HTMLButtonElement>)}>{children as React.ReactNode}</button>
  ),
  // The official Menu is a portal-driven anchored list; tests only need its
  // open/items/selection contract rendered inline so rows are addressable.
  Menu: ({ anchor, open, items, selectedId, onSelect }: {
    anchor: React.ReactNode
    open: boolean
    items: Array<{ id: string; label?: React.ReactNode; type?: string; text?: string; disabled?: boolean }>
    selectedId?: string | undefined
    onSelect: (id: string) => void
  }) => (
    <span>
      {anchor}
      {open && <div role="menu">{items.filter(item => item.type === undefined).map(item => (
        <button type="button" key={item.id} data-selected={item.id === selectedId || undefined} onClick={() => { onSelect(item.id) }}>{item.label}</button>
      ))}</div>}
    </span>
  ),
}))

afterEach(() => { cleanup() })

describe('终端左栏', () => {
  /**
   * The regression this whole change exists for: a terminal opened under one
   * Session and left behind when the Workspace moved to another must keep
   * reporting its real phase rather than going blank or inert, because it is
   * still driven through the Session that owns its process.
   */
  it('属于其他会话的终端仍报告真实阶段，而不是变成惰性占位', () => {
    current.state = {
      sidebarMode: 'terminal', editorExpanded: true, workspaceId: 'workspace-1', diffViewMode: 'split',
      gitView: 'changes', gitChangeLayout: 'list', gitGraphFileLayout: 'list',
      tabs: [
        { id: 'terminal:1', kind: 'terminal', sequence: 1, contentId: 'wbterm:workspace-1:terminal:1', status: 'running', shellName: 'pwsh.exe', shellPath: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', ownerSessionId: 'session-1' },
      ],
    }
    const view = renderPanel(controllerFixture(undefined, 'ready'))

    expect(view.getByText('正在运行')).toBeTruthy()
    expect(view.queryByText('其他会话')).toBeNull()
    expect(view.queryByText('尚未分配会话')).toBeNull()
    // The full path stays available on hover so the row can still be identified.
    expect(view.getByTitle('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBeTruthy()
  })

  it('没有会话可寻址的终端报告未分配，而不是伪造一个阶段', () => {
    current.state = {
      sidebarMode: 'terminal', editorExpanded: true, workspaceId: 'workspace-1', diffViewMode: 'split',
      gitView: 'changes', gitChangeLayout: 'list', gitGraphFileLayout: 'list',
      tabs: [
        { id: 'terminal:1', kind: 'terminal', sequence: 1, contentId: 'wbterm:workspace-1:terminal:1', status: 'connecting' },
      ],
    }
    const view = renderPanel(controllerFixture(undefined, 'noSession'))

    expect(view.getByText('尚未分配会话')).toBeTruthy()
    expect(view.queryByText('正在启动')).toBeNull()
  })

  it('管理当前工作区的多个终端并显示运行状态', () => {
    current.state = {
      sidebarMode: 'terminal', editorExpanded: true, workspaceId: 'workspace-1', activeTabId: 'terminal:1', diffViewMode: 'split',
      gitView: 'changes', gitChangeLayout: 'list', gitGraphFileLayout: 'list',
      tabs: [
        { id: 'terminal:1', kind: 'terminal', sequence: 1, contentId: 'wbterm:workspace-1:terminal:1', status: 'running' },
        { id: 'terminal:2', kind: 'terminal', sequence: 2, contentId: 'wbterm:workspace-1:terminal:2', status: 'exited' },
      ],
    }
    const controller = controllerFixture()
    const view = renderPanel(controller)

    expect(view.getByText('正在运行')).toBeTruthy()
    expect(view.getByText('已退出')).toBeTruthy()
    fireEvent.click(view.getByText('终端 2'))
    expect(controller.selectTab).toHaveBeenCalledWith('terminal:2')
    fireEvent.click(view.getByRole('button', { name: '关闭 终端 1' }))
    expect(controller.closeTab).toHaveBeenCalledWith('terminal:1')
  })

  it('状态栏报告宿主解析的 Shell、网格与启动目录', () => {
    current.state = {
      sidebarMode: 'terminal', editorExpanded: true, workspaceId: 'workspace-1', diffViewMode: 'split',
      gitView: 'changes', gitChangeLayout: 'list', gitGraphFileLayout: 'list',
      tabs: [
        {
          id: 'terminal:1', kind: 'terminal', sequence: 1, contentId: 'wbterm:workspace-1:terminal:1',
          status: 'running', shellName: 'pwsh.exe', runtime: { cwd: 'F:\\repo', cols: 120, rows: 40, exitCode: null },
        },
        { id: 'terminal:2', kind: 'terminal', sequence: 2, contentId: 'wbterm:workspace-1:terminal:2', status: 'connecting' },
      ],
    }
    const view = renderPanel(controllerFixture())

    // Every segment is a Host-reported fact, labelled as such.
    expect(view.getByText('pwsh')).toBeTruthy()
    expect(view.getByText('120×40')).toBeTruthy()
    expect(view.getByText('F:\\repo')).toBeTruthy()
    expect(view.getByText('Shell')).toBeTruthy()
    expect(view.getByText('启动目录')).toBeTruthy()
    // The row itself keeps the phase, which is what changes most often.
    expect(view.getByText('正在运行')).toBeTruthy()
    // A terminal with no process yet gets no status line rather than placeholders.
    expect(view.getByText('正在启动')).toBeTruthy()
    expect(view.getAllByText('Shell')).toHaveLength(1)
  })

  it('进程退出后状态栏补充退出码', () => {
    current.state = {
      sidebarMode: 'terminal', editorExpanded: true, workspaceId: 'workspace-1', diffViewMode: 'split',
      gitView: 'changes', gitChangeLayout: 'list', gitGraphFileLayout: 'list',
      tabs: [
        {
          id: 'terminal:1', kind: 'terminal', sequence: 1, contentId: 'wbterm:workspace-1:terminal:1',
          status: 'exited', shellName: 'cmd.exe', runtime: { cwd: 'F:\\repo', cols: 80, rows: 24, exitCode: 3 },
        },
      ],
    }
    const view = renderPanel(controllerFixture())

    expect(view.getByText('退出码 3')).toBeTruthy()
    expect(view.getByText('已退出')).toBeTruthy()
  })

  it('使用用户起的名字，没有名字时才回落到编号', () => {
    current.state = {
      sidebarMode: 'terminal', editorExpanded: true, workspaceId: 'workspace-1', diffViewMode: 'split',
      gitView: 'changes', gitChangeLayout: 'list', gitGraphFileLayout: 'list',
      tabs: [
        { id: 'terminal:1', kind: 'terminal', sequence: 1, contentId: 'wbterm:workspace-1:terminal:1', status: 'running', title: '构建服务' },
        { id: 'terminal:2', kind: 'terminal', sequence: 2, contentId: 'wbterm:workspace-1:terminal:2', status: 'running' },
      ],
    }
    const view = renderPanel(controllerFixture())

    expect(view.getByText('构建服务')).toBeTruthy()
    expect(view.getByText('终端 2')).toBeTruthy()
    // The close affordance names the same thing the row shows.
    expect(view.getByRole('button', { name: '关闭 构建服务' })).toBeTruthy()
  })

  it('重命名对话框把新名字交给控制器', () => {
    current.state = {
      sidebarMode: 'terminal', editorExpanded: true, workspaceId: 'workspace-1', diffViewMode: 'split',
      gitView: 'changes', gitChangeLayout: 'list', gitGraphFileLayout: 'list',
      tabs: [
        { id: 'terminal:1', kind: 'terminal', sequence: 1, contentId: 'wbterm:workspace-1:terminal:1', status: 'running' },
      ],
    }
    const controller = controllerFixture()
    const view = renderPanel(controller)

    fireEvent.click(view.getByRole('button', { name: '重命名终端' }))
    const dialog = view.getByRole('dialog')
    const field = dialog.querySelector('input') as HTMLInputElement
    // The draft starts from the current name so editing it is not retyping.
    expect(field.value).toBe('终端 1')
    fireEvent.change(field, { target: { value: '  测试数据库  ' } })
    const confirm = view.getByRole('button', { name: '重命名' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)

    expect(controller.renameTerminal).toHaveBeenCalledWith('terminal:1', '测试数据库')
  })

  it('名字没变或为空时不提交重命名', () => {
    current.state = {
      sidebarMode: 'terminal', editorExpanded: true, workspaceId: 'workspace-1', diffViewMode: 'split',
      gitView: 'changes', gitChangeLayout: 'list', gitGraphFileLayout: 'list',
      tabs: [
        { id: 'terminal:1', kind: 'terminal', sequence: 1, contentId: 'wbterm:workspace-1:terminal:1', status: 'running', title: '构建服务' },
      ],
    }
    const controller = controllerFixture()
    const view = renderPanel(controller)

    fireEvent.click(view.getByRole('button', { name: '重命名终端' }))
    const field = view.getByRole('dialog').querySelector('input') as HTMLInputElement
    const confirm = view.getByRole('button', { name: '重命名' }) as HTMLButtonElement

    // Unchanged from the stored name.
    fireEvent.change(field, { target: { value: '构建服务' } })
    expect(confirm.disabled).toBe(true)
    // Nothing but whitespace is not a name.
    fireEvent.change(field, { target: { value: '   ' } })
    expect(confirm.disabled).toBe(true)
    expect(controller.renameTerminal).not.toHaveBeenCalled()
  })

  it('新建按钮展开 Shell 列表，选中后记住该 Shell 并按它开终端', async () => {
    current.state = {
      sidebarMode: 'terminal', editorExpanded: true, workspaceId: 'workspace-1', diffViewMode: 'split', tabs: [],
      gitView: 'changes', gitChangeLayout: 'list', gitGraphFileLayout: 'list',
    }
    const controller = controllerFixture()
    const view = renderPanel(controller)

    fireEvent.click(view.getByRole('button', { name: '新建终端' }))
    await waitFor(() => { expect(controller.listShells).toHaveBeenCalled() })
    const pwsh = await view.findByRole('button', { name: 'pwsh' })
    fireEvent.click(pwsh)

    expect(controller.selectShell).toHaveBeenCalledWith('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
    expect(controller.openTerminal).toHaveBeenCalledWith('workspace-1', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe')
  })

  it('列表中的默认项不指定 Shell，交回官方模型选择', async () => {
    current.state = {
      sidebarMode: 'terminal', editorExpanded: true, workspaceId: 'workspace-1', diffViewMode: 'split', tabs: [],
      gitView: 'changes', gitChangeLayout: 'list', gitGraphFileLayout: 'list',
    }
    const controller = controllerFixture()
    const view = renderPanel(controller)

    fireEvent.click(view.getByRole('button', { name: '新建终端' }))
    fireEvent.click(await view.findByRole('button', { name: '默认 Shell' }))

    expect(controller.selectShell).not.toHaveBeenCalled()
    // The panel's own first-entry auto-create already called openTerminal once,
    // so the menu row is judged on the newest call: no shell argument at all.
    expect(lastOpen(controller)).toEqual(['workspace-1'])
  })

  it('探测不到 Shell 时仍保留一个可用的新建入口', async () => {
    current.state = {
      sidebarMode: 'terminal', editorExpanded: true, workspaceId: 'workspace-1', diffViewMode: 'split', tabs: [],
      gitView: 'changes', gitChangeLayout: 'list', gitGraphFileLayout: 'list',
    }
    const controller = controllerFixture({ shells: [] })
    const view = renderPanel(controller)

    fireEvent.click(view.getByRole('button', { name: '新建终端' }))
    const only = await view.findByRole('button', { name: '默认 Shell' })
    fireEvent.click(only)
    expect(lastOpen(controller)).toEqual(['workspace-1'])
  })

  it('首次进入空终端视图时创建一个终端，但关闭最后一个后不循环重建', () => {
    current.state = {
      sidebarMode: 'terminal', editorExpanded: true, workspaceId: 'workspace-1', diffViewMode: 'split', tabs: [],
      gitView: 'changes', gitChangeLayout: 'list', gitGraphFileLayout: 'list',
    }
    const controller = controllerFixture()
    const view = renderPanel(controller)
    expect(controller.openTerminal).toHaveBeenCalledTimes(1)
    view.rerender(renderPanelArgs(controller))
    expect(controller.openTerminal).toHaveBeenCalledTimes(1)
  })
})

/** The newest `openTerminal` call's arguments, so the panel's auto-create cannot skew a menu assertion. */
function lastOpen(controller: { openTerminal: ReturnType<typeof vi.fn> }): unknown[] {
  const calls = controller.openTerminal.mock.calls as unknown[][]
  return calls[calls.length - 1]!
}

function controllerFixture(discovery: { shells: Array<{ path: string; name: string }>; selectedShell?: string } = {
  // The Host reports Windows shells with their extension, like `pwsh.exe`.
  shells: [
    { path: 'C:\\Windows\\System32\\cmd.exe', name: 'cmd.exe' },
    { path: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', name: 'pwsh.exe' },
  ],
  selectedShell: 'C:\\Windows\\System32\\cmd.exe',
}, binding: TerminalBinding = 'ready') {
  return {
    openTerminal: vi.fn(),
    selectTab: vi.fn(),
    closeTab: vi.fn(),
    selectShell: vi.fn(),
    renameTerminal: vi.fn(),
    listShells: vi.fn(() => Promise.resolve(discovery)),
    terminalBinding: vi.fn(() => binding),
  }
}

function renderPanel(controller: ReturnType<typeof controllerFixture>) {
  return render(renderPanelArgs(controller))
}

function renderPanelArgs(controller: ReturnType<typeof controllerFixture>) {
  return (
    <TerminalPanel
      controller={controller as never}
      workspaceId="workspace-1"
      t={(key, values) => interpolate(zh[key], values as Record<string, string> | undefined)}
    />
  )
}

function interpolate(template: string, values: Record<string, string> | undefined): string {
  if (values === undefined) return template
  return Object.entries(values).reduce((text, [key, value]) => text.replace(`{${key}}`, value), template)
}
