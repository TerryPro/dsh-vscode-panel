// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileTree } from '../src/client/files/FileTree.tsx'
import { zh } from '../src/client/core/locales.ts'

const workbench = vi.hoisted(() => ({
  current: {
    activeTabId: undefined as string | undefined,
    tabs: [] as Array<{ id: string; kind: 'file'; path: string; dirty: boolean }>,
    sidebarAction: undefined as { id: number; action: string; workspaceId: string; path?: string } | undefined,
    gitDecorations: {} as Record<string, 'conflict' | 'untracked' | 'deleted' | 'added' | 'modified' | 'renamed'>,
  },
}))

vi.mock('../src/client/model/use-workbench.ts', () => ({ useWorkbench: () => workbench.current }))

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Menu: ({ open, anchor, items, onSelect }: {
    open: boolean
    anchor: React.ReactNode
    items: Array<{ id: string; label?: React.ReactNode; type?: string; disabled?: boolean }>
    onSelect: (id: string) => void
  }) => <>{anchor}{open && <div role="menu">{items.filter(item => item.type === undefined).map(item => (
    <button key={item.id} role="menuitem" disabled={item.disabled} onClick={() => { onSelect(item.id) }}>{item.label}</button>
  ))}</div>}</>,
  Modal: ({ open, title, children, footer }: { open: boolean; title: string; children: React.ReactNode; footer: React.ReactNode }) => (
    open ? <div role="dialog" aria-label={title}><h2>{title}</h2>{children}{footer}</div> : null
  ),
  RiskConfirmation: (props: {
    open: boolean
    title: string
    description: string
    acknowledgeLabel: string
    confirmLabel: string
    acknowledged: boolean
    onAcknowledgedChange: (value: boolean) => void
    onConfirm: () => void
  }) => props.open ? <div role="dialog" aria-label={props.title}>
    <p>{props.description}</p>
    <label><input type="checkbox" checked={props.acknowledged} onChange={event => { props.onAcknowledgedChange(event.currentTarget.checked) }} />{props.acknowledgeLabel}</label>
    <button disabled={!props.acknowledged} onClick={props.onConfirm}>{props.confirmLabel}</button>
  </div> : null,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  FileTypeIcon: () => <span data-icon="file-type" />,
  classifyFileType: () => 'other',
  IconCopyOutlineMedium: () => <span />,
  IconEditOutlineMedium: () => <span />,
  IconChevronDownOutlineRegular: () => <span />,
  IconChevronRightOutlineRegular: () => <span />,
  IconFolderCloseMedium: () => <span data-icon="official-folder" />,
  IconFolderOpenMedium: () => <span />,
  IconFolderCloseRegular: () => <span data-icon="official-folder" />,
  IconFolderOpenRegular: () => <span />,
  IconFolderOpenOutlineMedium: () => <span />,
  IconPlusOutlineMedium: () => <span data-icon="official-plus" />,
  IconRefreshOutlineRegular: () => <span />,
  IconRefreshOutlineMedium: () => <span />,
  IconTrashOutlineMedium: () => <span />,
}))

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  workbench.current = { activeTabId: undefined, tabs: [], sidebarAction: undefined, gitDecorations: {} }
})

describe('文件目录', () => {
  it('用 Git 状态装饰文件但不把未跟踪红色传播到父目录', async () => {
    workbench.current.gitDecorations = {
      'src/new.ts': 'untracked',
      'README.md': 'modified',
    }
    const controller = {
      fileTreeExpanded: new Map<string, Set<string>>(),
      api: { listDirectory: vi.fn(() => Promise.resolve({
        path: '',
        truncated: false,
        entries: [
          { name: 'src', path: 'src', kind: 'directory' as const },
          { name: 'README.md', path: 'README.md', kind: 'file' as const },
        ],
      })) },
      refreshGitDecorations: vi.fn(() => Promise.resolve()),
      openFile: vi.fn(),
    }
    const view = render(
      <FileTree controller={controller as never} workspaceId="workspace-1" workspacePath="/workspace/project" t={key => zh[key]} />,
    )

    expect((await view.findByRole('treeitem', { name: 'src' })).dataset.gitDecoration).toBeUndefined()
    expect(view.getByRole('treeitem', { name: 'README.md' }).dataset.gitDecoration).toBe('modified')
    expect(controller.refreshGitDecorations).toHaveBeenCalledWith('workspace-1')
  })

  it('在所选目录内新建文件，并在所选文件的父目录中新建文件夹', async () => {
    const root = {
      path: '',
      truncated: false,
      entries: [
        { name: 'src', path: 'src', kind: 'directory' as const },
        { name: 'README.md', path: 'README.md', kind: 'file' as const },
      ],
    }
    const src = { path: 'src', truncated: false, entries: [] }
    const controller = {
      fileTreeExpanded: new Map<string, Set<string>>(),
      api: {
        listDirectory: vi.fn((_workspaceId: string, path: string) => Promise.resolve(path === 'src' ? src : root)),
        createFile: vi.fn(() => Promise.resolve({ name: 'new.ts', path: 'src/new.ts', kind: 'file' })),
        createDirectory: vi.fn(() => Promise.resolve({ name: 'docs', path: 'docs', kind: 'directory' })),
      },
      openFile: vi.fn(() => Promise.resolve()),
    }
    const view = render(
      <FileTree
        controller={controller as never}
        workspaceId="workspace-1"
        workspacePath="/workspace/project"
        t={key => zh[key]}
      />,
    )

    await waitFor(() => { expect(view.getByText('src')).toBeTruthy() })
    expect(view.getByText('/workspace/project').getAttribute('title')).toBe('/workspace/project')
    const fileAddIcon = view.getByRole('button', { name: '新建文件' }).querySelector('[data-icon="file-add"]')
    const folderAddIcon = view.getByRole('button', { name: '新建文件夹' }).querySelector('[data-icon="folder-add"]')
    expect(fileAddIcon).not.toBeNull()
    expect(folderAddIcon).not.toBeNull()
    expect(fileAddIcon?.querySelector('[data-icon="file"]')).not.toBeNull()
    expect(fileAddIcon?.querySelector('[data-icon="official-plus"]')).not.toBeNull()
    expect(folderAddIcon?.querySelector('[data-icon="official-folder"]')).not.toBeNull()
    expect(folderAddIcon?.querySelector('[data-icon="official-plus"]')).not.toBeNull()
    fireEvent.click(view.getByText('src'))
    fireEvent.click(view.getByRole('button', { name: '新建文件' }))
    const fileInput = await view.findByRole('textbox', { name: '文件名' })
    fireEvent.change(fileInput, { target: { value: 'new.ts' } })
    fireEvent.submit(fileInput.closest('form')!)
    await waitFor(() => {
      expect(controller.api.createFile).toHaveBeenCalledWith('workspace-1', 'src/new.ts')
      expect(controller.openFile).toHaveBeenCalledWith('workspace-1', 'src/new.ts')
    })

    fireEvent.click(view.getByText('README.md'))
    fireEvent.click(view.getByRole('button', { name: '新建文件夹' }))
    const directoryInput = await view.findByRole('textbox', { name: '文件夹名称' })
    fireEvent.change(directoryInput, { target: { value: 'docs' } })
    fireEvent.submit(directoryInput.closest('form')!)
    await waitFor(() => {
      expect(controller.api.createDirectory).toHaveBeenCalledWith('workspace-1', 'docs')
    })
  })

  it('展开后只消费一次收起栏的新建文件命令', async () => {
    workbench.current = {
      activeTabId: undefined,
      tabs: [],
      sidebarAction: { id: 7, action: 'files.newFile', workspaceId: 'workspace-1' },
    }
    const controller = {
      fileTreeExpanded: new Map<string, Set<string>>(),
      api: {
        listDirectory: vi.fn(() => Promise.resolve({ path: '', truncated: false, entries: [] })),
      },
      consumeSidebarAction: vi.fn(),
      openFile: vi.fn(),
    }
    const view = render(
      <FileTree controller={controller as never} workspaceId="workspace-1" workspacePath="/workspace/project" t={key => zh[key]} />,
    )

    expect(await view.findByRole('textbox', { name: '文件名' })).toBeTruthy()
    expect(controller.consumeSidebarAction).toHaveBeenCalledOnce()
    expect(controller.consumeSidebarAction).toHaveBeenCalledWith(7)
  })

  it('在文件目录中显示命令展开到目标文件并选中它', async () => {
    workbench.current = {
      activeTabId: 'file:src/deep/a.ts',
      tabs: [{ id: 'file:src/deep/a.ts', kind: 'file', path: 'src/deep/a.ts', dirty: false }],
      sidebarAction: { id: 9, action: 'files.reveal', workspaceId: 'workspace-1', path: 'src/deep/a.ts' },
    }
    const listing = (path: string) => ({
      path,
      truncated: false,
      entries: path === ''
        ? [{ name: 'src', path: 'src', kind: 'directory' as const }]
        : path === 'src'
          ? [{ name: 'deep', path: 'src/deep', kind: 'directory' as const }]
          : [{ name: 'a.ts', path: 'src/deep/a.ts', kind: 'file' as const }],
    })
    const controller = {
      fileTreeExpanded: new Map<string, Set<string>>(),
      api: { listDirectory: vi.fn(((_workspace: string, path: string) => Promise.resolve(listing(path)))) },
      consumeSidebarAction: vi.fn(),
      openFile: vi.fn(),
    }
    const view = render(
      <FileTree controller={controller as never} workspaceId="workspace-1" workspacePath="/workspace/project" t={key => zh[key]} />,
    )

    const revealed = await view.findByRole('treeitem', { name: 'a.ts' })
    expect(controller.consumeSidebarAction).toHaveBeenCalledWith(9)
    expect(revealed.getAttribute('data-selected')).toBe('true')
    // Every ancestor directory along the path is expanded, not just the root.
    expect(await view.findByRole('treeitem', { name: 'deep' })).toBeTruthy()
  })

  it('点击空白区域后取消文件高亮并将新建目标恢复到工作区根目录', async () => {
    workbench.current = {
      activeTabId: 'file:README.md',
      tabs: [{ id: 'file:README.md', kind: 'file', path: 'README.md', dirty: false }],
      sidebarAction: undefined,
    }
    const root = {
      path: '',
      truncated: false,
      entries: [{ name: 'README.md', path: 'README.md', kind: 'file' as const }],
    }
    const controller = {
      fileTreeExpanded: new Map<string, Set<string>>(),
      api: {
        listDirectory: vi.fn(() => Promise.resolve(root)),
        createDirectory: vi.fn(() => Promise.resolve({ name: 'docs', path: 'docs', kind: 'directory' })),
      },
      openFile: vi.fn(),
    }
    const view = render(
      <FileTree controller={controller as never} workspaceId="workspace-1" workspacePath="/workspace/project" t={key => zh[key]} />,
    )

    const fileRow = await view.findByRole('treeitem', { name: 'README.md' })
    expect(fileRow.getAttribute('data-selected')).toBe('true')
    const tree = view.getByRole('tree')
    fireEvent.click(tree)
    expect(tree.getAttribute('data-selection-root')).toBe('true')
    expect(fileRow.hasAttribute('data-selected')).toBe(false)

    fireEvent.click(view.getByRole('button', { name: '新建文件夹' }))
    const input = await view.findByRole('textbox', { name: '文件夹名称' })
    fireEvent.change(input, { target: { value: 'docs' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => {
      expect(controller.api.createDirectory).toHaveBeenCalledWith('workspace-1', 'docs')
    })
  })

  it('通过右键菜单复制绝对路径、重命名文件并递归删除文件夹', async () => {
    const clipboard = { writeText: vi.fn(() => Promise.resolve()) }
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard })
    const root = {
      path: '',
      truncated: false,
      entries: [
        { name: 'docs', path: 'docs', kind: 'directory' as const },
        { name: 'README.md', path: 'README.md', kind: 'file' as const },
      ],
    }
    const controller = {
      fileTreeExpanded: new Map<string, Set<string>>(),
      api: {
        listDirectory: vi.fn(() => Promise.resolve(root)),
        absolutePath: vi.fn(() => Promise.resolve({ path: 'README.md', absolutePath: '/resolved/project/README.md' })),
        renameEntry: vi.fn(() => Promise.resolve({ from: 'README.md', path: 'GUIDE.md', name: 'GUIDE.md', kind: 'file' })),
        deleteEntry: vi.fn(() => Promise.resolve({ path: 'docs', kind: 'directory' })),
      },
      openFile: vi.fn(),
      closeWorkspaceEntries: vi.fn(),
    }
    const view = render(
      <FileTree controller={controller as never} workspaceId="workspace-1" workspacePath="/workspace/project" t={key => zh[key]} />,
    )

    const fileRow = await view.findByRole('treeitem', { name: 'README.md' })
    fireEvent.contextMenu(fileRow, { clientX: 20, clientY: 30 })
    fireEvent.click(view.getByRole('menuitem', { name: '复制绝对路径' }))
    await waitFor(() => {
      expect(controller.api.absolutePath).toHaveBeenCalledWith('workspace-1', 'README.md')
      expect(clipboard.writeText).toHaveBeenCalledWith('/resolved/project/README.md')
    })

    fireEvent.contextMenu(fileRow, { clientX: 20, clientY: 30 })
    fireEvent.click(view.getByRole('menuitem', { name: '重命名…' }))
    const renameDialog = view.getByRole('dialog', { name: '重命名文件或文件夹' })
    const nameInput = renameDialog.querySelector('input')!
    fireEvent.change(nameInput, { target: { value: 'GUIDE.md' } })
    fireEvent.click(view.getByRole('button', { name: '重命名' }))
    await waitFor(() => {
      expect(controller.api.renameEntry).toHaveBeenCalledWith('workspace-1', 'README.md', 'GUIDE.md')
      expect(controller.closeWorkspaceEntries).toHaveBeenCalledWith('workspace-1', 'README.md')
    })

    const directoryRow = view.getByRole('treeitem', { name: 'docs' })
    fireEvent.contextMenu(directoryRow, { clientX: 20, clientY: 30 })
    fireEvent.click(view.getByRole('menuitem', { name: '删除…' }))
    const deleteDialog = view.getByRole('dialog', { name: '删除此文件夹及其中内容？' })
    fireEvent.click(deleteDialog.querySelector('input[type="checkbox"]')!)
    fireEvent.click(view.getByRole('button', { name: '删除' }))
    await waitFor(() => {
      expect(controller.api.deleteEntry).toHaveBeenCalledWith('workspace-1', 'docs')
      expect(controller.closeWorkspaceEntries).toHaveBeenCalledWith('workspace-1', 'docs')
    })
  })

  it('拦截包含未保存文件的目录重命名', async () => {
    workbench.current = {
      activeTabId: 'file:src/draft.ts',
      tabs: [{ id: 'file:src/draft.ts', kind: 'file', path: 'src/draft.ts', dirty: true }],
      sidebarAction: undefined,
    }
    const controller = {
      fileTreeExpanded: new Map<string, Set<string>>(),
      api: {
        listDirectory: vi.fn(() => Promise.resolve({
          path: '', truncated: false, entries: [{ name: 'src', path: 'src', kind: 'directory' as const }],
        })),
        renameEntry: vi.fn(),
      },
      openFile: vi.fn(),
      closeWorkspaceEntries: vi.fn(),
    }
    const view = render(
      <FileTree controller={controller as never} workspaceId="workspace-1" workspacePath="/workspace/project" t={key => zh[key]} />,
    )

    fireEvent.contextMenu(await view.findByRole('treeitem', { name: 'src' }), { clientX: 20, clientY: 30 })
    fireEvent.click(view.getByRole('menuitem', { name: '重命名…' }))
    expect(view.getByRole('alert').textContent).toContain('未保存内容')
    expect(view.queryByRole('dialog', { name: '重命名文件或文件夹' })).toBeNull()
    expect(controller.api.renameEntry).not.toHaveBeenCalled()
  })

  it('在目录空白处通过鼠标或键盘打开根目录菜单', async () => {
    const controller = {
      fileTreeExpanded: new Map<string, Set<string>>(),
      api: { listDirectory: vi.fn(() => Promise.resolve({ path: '', truncated: false, entries: [] })) },
      openFile: vi.fn(),
    }
    const view = render(
      <FileTree controller={controller as never} workspaceId="workspace-1" workspacePath="/workspace/project" t={key => zh[key]} />,
    )
    await view.findByText('此目录为空。')
    const tree = view.getByRole('tree')

    fireEvent.contextMenu(tree, { clientX: 20, clientY: 30 })
    expect(view.getByRole('menuitem', { name: '新建文件' })).toBeTruthy()
    fireEvent.click(view.getByRole('menuitem', { name: '刷新文件目录' }))
    await waitFor(() => { expect(view.queryByRole('menu')).toBeNull() })

    await view.findByText('此目录为空。')
    fireEvent.keyDown(view.getByRole('tree'), { key: 'ContextMenu' })
    expect(view.getByRole('menuitem', { name: '刷新文件目录' })).toBeTruthy()
  })

  it('复制相对路径到剪贴板并给出成功提示', async () => {
    const clipboard = { writeText: vi.fn(() => Promise.resolve()) }
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard })
    const controller = {
      fileTreeExpanded: new Map<string, Set<string>>(),
      api: { listDirectory: vi.fn(() => Promise.resolve({ path: '', truncated: false, entries: [{ name: 'README.md', path: 'README.md', kind: 'file' as const }] })) },
      openFile: vi.fn(),
    }
    const view = render(
      <FileTree controller={controller as never} workspaceId="workspace-1" workspacePath="/workspace/project" t={key => zh[key]} />,
    )
    const row = await view.findByRole('treeitem', { name: 'README.md' })
    fireEvent.contextMenu(row, { clientX: 20, clientY: 30 })
    fireEvent.click(view.getByRole('menuitem', { name: '复制相对路径' }))
    await waitFor(() => {
      expect(clipboard.writeText).toHaveBeenCalledWith('README.md')
      expect(view.getByRole('status').textContent).toContain('已复制相对路径。')
    })
  })

  it('通过右键菜单展开全部，递归加载并展开目录树', async () => {
    const listDirectory = vi.fn((_workspaceId: string, path: string) => Promise.resolve(
      path === 'docs'
        ? { path: 'docs', truncated: false, entries: [{ name: 'nested', path: 'docs/nested', kind: 'directory' as const }] }
        : path === 'docs/nested'
          ? { path: 'docs/nested', truncated: false, entries: [{ name: 'deep.txt', path: 'docs/nested/deep.txt', kind: 'file' as const }] }
          : { path: '', truncated: false, entries: [{ name: 'docs', path: 'docs', kind: 'directory' as const }] },
    ))
    const controller = { fileTreeExpanded: new Map<string, Set<string>>(), api: { listDirectory }, openFile: vi.fn() }
    const view = render(
      <FileTree controller={controller as never} workspaceId="workspace-1" workspacePath="/workspace/project" t={key => zh[key]} />,
    )
    const docsRow = await view.findByRole('treeitem', { name: 'docs' })
    expect(view.queryByRole('treeitem', { name: 'deep.txt' })).toBeNull()
    fireEvent.contextMenu(docsRow, { clientX: 20, clientY: 30 })
    fireEvent.click(view.getByRole('menuitem', { name: '展开全部' }))
    expect(await view.findByRole('treeitem', { name: 'deep.txt' })).toBeTruthy()
    const paths = listDirectory.mock.calls.map(call => call[1])
    expect(paths).toContain('docs')
    expect(paths).toContain('docs/nested')
  })

  it('通过右键菜单折叠全部，收起后代的展开状态', async () => {
    const listDirectory = vi.fn((_workspaceId: string, path: string) => Promise.resolve(
      path === 'docs'
        ? { path: 'docs', truncated: false, entries: [{ name: 'nested', path: 'docs/nested', kind: 'directory' as const }] }
        : path === 'docs/nested'
          ? { path: 'docs/nested', truncated: false, entries: [{ name: 'deep.txt', path: 'docs/nested/deep.txt', kind: 'file' as const }] }
          : { path: '', truncated: false, entries: [{ name: 'docs', path: 'docs', kind: 'directory' as const }] },
    ))
    const controller = { fileTreeExpanded: new Map<string, Set<string>>(), api: { listDirectory }, openFile: vi.fn() }
    const view = render(
      <FileTree controller={controller as never} workspaceId="workspace-1" workspacePath="/workspace/project" t={key => zh[key]} />,
    )
    const docsRow = await view.findByRole('treeitem', { name: 'docs' })
    fireEvent.contextMenu(docsRow, { clientX: 20, clientY: 30 })
    fireEvent.click(view.getByRole('menuitem', { name: '展开全部' }))
    await view.findByRole('treeitem', { name: 'deep.txt' })

    fireEvent.contextMenu(docsRow, { clientX: 20, clientY: 30 })
    fireEvent.click(view.getByRole('menuitem', { name: '折叠全部' }))
    await waitFor(() => {
      expect(view.queryByRole('treeitem', { name: 'deep.txt' })).toBeNull()
      expect(view.getByRole('treeitem', { name: 'nested' })).toBeTruthy()
      expect(view.getByRole('treeitem', { name: 'docs' })).toBeTruthy()
    })
  })

  it('头部刷新按钮重新列出已展开目录并渲染新增条目', async () => {
    const docsV1 = { path: 'docs', truncated: false, entries: [{ name: 'a.ts', path: 'docs/a.ts', kind: 'file' as const }] }
    const docsV2 = {
      path: 'docs',
      truncated: false,
      entries: [
        { name: 'a.ts', path: 'docs/a.ts', kind: 'file' as const },
        { name: 'b.ts', path: 'docs/b.ts', kind: 'file' as const },
      ],
    }
    let docsVersion = 1
    const listDirectory = vi.fn((_workspaceId: string, path: string) => Promise.resolve(
      path === 'docs'
        ? (docsVersion === 1 ? docsV1 : docsV2)
        : { path: '', truncated: false, entries: [{ name: 'docs', path: 'docs', kind: 'directory' as const }] },
    ))
    const controller = { fileTreeExpanded: new Map<string, Set<string>>(), api: { listDirectory }, openFile: vi.fn() }
    const view = render(
      <FileTree controller={controller as never} workspaceId="workspace-1" workspacePath="/workspace/project" t={key => zh[key]} />,
    )
    fireEvent.click(await view.findByRole('treeitem', { name: 'docs' }))
    await view.findByRole('treeitem', { name: 'a.ts' })
    expect(view.queryByRole('treeitem', { name: 'b.ts' })).toBeNull()

    docsVersion = 2
    const docsCallsBefore = listDirectory.mock.calls.filter(call => call[1] === 'docs').length
    fireEvent.click(view.getByRole('button', { name: '刷新文件目录' }))
    await waitFor(() => { expect(view.getByRole('treeitem', { name: 'b.ts' })).toBeTruthy() })
    expect(listDirectory.mock.calls.filter(call => call[1] === 'docs').length).toBeGreaterThan(docsCallsBefore)
  })

  it('页面可见时每 3 秒自动轮询刷新已展开目录', async () => {
    const root = { path: '', truncated: false, entries: [{ name: 'README.md', path: 'README.md', kind: 'file' as const }] }
    const listDirectory = vi.fn(() => Promise.resolve(root))
    const controller = { fileTreeExpanded: new Map<string, Set<string>>(), api: { listDirectory }, openFile: vi.fn() }
    vi.useFakeTimers()
    render(
      <FileTree controller={controller as never} workspaceId="workspace-1" workspacePath="/workspace/project" t={key => zh[key]} />,
    )
    await vi.advanceTimersByTimeAsync(5)
    const before = listDirectory.mock.calls.length
    await vi.advanceTimersByTimeAsync(3_000)
    expect(listDirectory.mock.calls.length).toBeGreaterThan(before)
  })
})
