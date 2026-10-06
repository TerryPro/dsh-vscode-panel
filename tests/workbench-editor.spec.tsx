// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkbenchFileTab, WorkbenchState } from '../src/client/core/controller.ts'
import { zh } from '../src/client/core/locales.ts'
import { WorkbenchEditor, type WorkbenchEditorProps } from '../src/client/editor/WorkbenchEditor.tsx'

const workbenchState = vi.hoisted(() => ({ current: {} as WorkbenchState }))

vi.mock('../src/client/core/use-workbench.ts', () => ({ useWorkbench: () => workbenchState.current }))
vi.mock('../src/client/editor/CodeEditor.tsx', () => ({
  CodeEditor: ({ ariaLabel, gitOriginal, gitLabels }: {
    ariaLabel: string
    gitOriginal?: string
    gitLabels?: { modified: string }
  }) => (
    <textarea aria-label={ariaLabel} data-git-original={gitOriginal} data-git-modified-label={gitLabels?.modified} />
  ),
}))
vi.mock('../src/client/git/GitDiffEditor.tsx', () => ({ GitDiffEditor: () => <div>diff</div> }))
vi.mock('../src/client/terminal/TerminalSurface.tsx', () => ({
  TerminalSurface: ({ tab }: { tab: { id: string } }) => <div data-terminal-surface={tab.id}>terminal</div>,
}))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ children, variant: _variant, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...props}>{children}</button>,
  FishLogo: () => <span data-fish-logo="" />,
  IconCloseOutlineMedium: () => <span data-close-icon="" />,
  MarkdownText: ({ text }: { text: string }) => <article>{text}</article>,
  Modal: ({ open, title, description, footer }: { open: boolean; title: string; description?: string; footer?: React.ReactNode }) => open
    ? <div role="dialog" aria-label={title}><p>{description}</p>{footer}</div>
    : null,
  Tooltip: ({ children, label }: { children: React.ReactNode; label: string }) => <span data-tooltip-label={label}>{children}</span>,
}))

beforeEach(() => {
  workbenchState.current = state()
})
afterEach(() => { cleanup() })

describe('WorkbenchEditor multi-file tabs', () => {
  it('renders open files without a persistent Save button and saves the active tab with Ctrl+S', () => {
    const controller = controllerFake()
    const view = renderEditor(controller)
    expect(view.getAllByRole('tab')).toHaveLength(2)
    expect(view.getByRole('tab', { name: 'README.md' }).getAttribute('aria-selected')).toBe('true')
    expect(view.queryByRole('button', { name: '保存' })).toBeNull()

    fireEvent.keyDown(window, { key: 's', ctrlKey: true })
    expect(controller.save).toHaveBeenCalledWith('file:README.md')
  })

  it('selects an existing file tab instead of reopening it', () => {
    const controller = controllerFake()
    const view = renderEditor(controller)
    fireEvent.click(view.getByRole('tab', { name: 'a.ts' }))
    expect(controller.selectTab).toHaveBeenCalledWith('file:src/a.ts')
  })

  it('loads the HEAD baseline for a source tab and passes it to the normal editor', () => {
    focusPrimaryTab('file:src/a.ts')
    const source = workbenchState.current.tabs[0]
    if (source?.kind === 'file') {
      source.gitBaseline = {
        path: source.path,
        available: true,
        original: 'const a = 0',
        binary: false,
        revision: 'a'.repeat(40),
      }
    }
    const controller = controllerFake()
    const view = renderEditor(controller)

    expect(controller.ensureGitBaseline).toHaveBeenCalledWith('file:src/a.ts')
    const editor = view.getByRole('textbox', { name: 'src/a.ts' })
    expect(editor.dataset.gitOriginal).toBe('const a = 0')
    expect(editor.dataset.gitModifiedLabel).toBe('修改变更')
  })

  it('toggles the inline Git diff for its own pane tab', () => {
    focusPrimaryTab('file:src/a.ts')
    const source = workbenchState.current.tabs[0]
    if (source?.kind === 'file') {
      source.inlineDiff = true
      source.gitBaseline = {
        path: source.path,
        available: true,
        original: 'const a = 0',
        binary: false,
        revision: 'a'.repeat(40),
      }
    }
    const controller = controllerFake()
    const view = renderEditor(controller)

    // 默认开启内联差异；切换按该 pane 自身标签操作。
    expect(view.getByRole('button', { name: '显示差异' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(view.getByRole('button', { name: '显示差异' }))
    expect(controller.setEditorInlineDiff).toHaveBeenCalledWith('file:src/a.ts', false)
  })

  it('toggles word wrap for its own pane tab from the status bar', () => {
    focusPrimaryTab('file:src/a.ts')
    const controller = controllerFake()
    const view = renderEditor(controller)
    fireEvent.click(view.getByRole('button', { name: '自动换行' }))
    expect(controller.setEditorWrap).toHaveBeenCalledWith('file:src/a.ts', false)
  })

  it('renders a status bar with the view switch even in Markdown preview mode', () => {
    // Default active tab is README.md (markdown, preview mode).
    const controller = controllerFake()
    const view = renderEditor(controller)
    expect(view.getByRole('contentinfo')).toBeTruthy()
    // The source toggle lives in the status bar so preview can switch back.
    fireEvent.click(view.getByRole('button', { name: '源码' }))
    expect(controller.setMarkdownMode).toHaveBeenCalledWith('source', 'file:README.md')
    // No editable surface in preview, so no wrap toggle.
    expect(view.queryByRole('button', { name: '自动换行' })).toBeNull()
  })

  it('toggles the Markdown outline panel from the status bar in preview mode', () => {
    const controller = controllerFake()
    const view = renderEditor(controller)
    fireEvent.click(view.getByRole('button', { name: '大纲' }))
    expect(controller.toggleMarkdownOutline).toHaveBeenCalledWith('file:README.md')
  })

  it('renders the outline headings once the panel is enabled', () => {
    fileTab(1).outlineVisible = true
    const controller = controllerFake()
    const view = renderEditor(controller)
    expect(view.getByRole('navigation', { name: '大纲' })).toBeTruthy()
    expect(view.getByRole('button', { name: 'Readme' })).toBeTruthy()
  })

  it('hides the outline toggle while Markdown is in source mode', () => {
    fileTab(1).markdownMode = 'source'
    const controller = controllerFake()
    const view = renderEditor(controller)
    expect(view.queryByRole('button', { name: '大纲' })).toBeNull()
  })

  it('uses a DSH modal before discarding an unsaved tab', () => {
    fileTab(0).dirty = true
    const controller = controllerFake()
    const view = renderEditor(controller)
    fireEvent.click(view.getByRole('button', { name: '关闭 a.ts' }))
    expect(controller.selectTab).toHaveBeenCalledWith('file:src/a.ts')
    expect(view.getByRole('dialog', { name: '关闭未保存的文件？' })).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: '放弃更改' }))
    expect(controller.closeTab).toHaveBeenCalledWith('file:src/a.ts', true)
  })

  it('renders Diff as a normal closable editor tab beside files', () => {
    workbenchState.current.tabs.push(diffTab('src/a.ts'))
    focusPrimaryTab('diff:worktree::src/a.ts')
    const controller = controllerFake()
    const view = renderEditor(controller)

    expect(view.getAllByRole('tab')).toHaveLength(3)
    expect(view.getByRole('tab', { name: 'a.ts (工作区差异)' }).getAttribute('aria-selected')).toBe('true')
    expect(view.getByText('diff')).toBeTruthy()
    fireEvent.keyDown(window, { key: 's', ctrlKey: true })
    expect(controller.save).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('button', { name: '关闭 a.ts (工作区差异)' }))
    expect(controller.closeTab).toHaveBeenCalledWith('diff:worktree::src/a.ts')
    expect(view.queryByRole('dialog')).toBeNull()
  })

  it('renders a Workspace terminal as a normal tab and does not route Ctrl+S to it', () => {
    workbenchState.current.tabs.push(terminalTab(1))
    focusPrimaryTab('terminal:1')
    const controller = controllerFake()
    const view = renderEditor(controller)

    expect(view.getByRole('tab', { name: '终端 1' }).getAttribute('aria-selected')).toBe('true')
    expect(view.getByText('terminal')).toBeTruthy()
    fireEvent.keyDown(window, { key: 's', ctrlKey: true })
    expect(controller.save).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('button', { name: '关闭 终端 1' }))
    expect(controller.closeTab).toHaveBeenCalledWith('terminal:1')
  })

  it('offers explicit choices instead of overwriting a draft changed by another program', () => {
    workbenchState.current.tabs[1] = {
      ...fileTab(1),
      dirty: true,
      externalChange: {
        kind: 'changed',
        file: { path: 'README.md', content: '# Outside', version: '2', size: 9, markdown: true },
      },
    }
    const controller = controllerFake()
    const view = renderEditor(controller)

    expect(view.getByText('文件已在其他程序中修改。请选择要保留的内容。')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: '重新加载' }))
    expect(controller.reloadExternalFile).toHaveBeenCalledWith('file:README.md')
    fireEvent.click(view.getByRole('button', { name: '保留当前内容' }))
    expect(controller.keepCurrentDraft).toHaveBeenCalledWith('file:README.md')
  })

  it('offers a three-way Markdown view switch and selects split', () => {
    const controller = controllerFake()
    const view = renderEditor(controller)
    expect(view.getByRole('button', { name: '预览' })).toBeTruthy()
    expect(view.getByRole('button', { name: '分栏' })).toBeTruthy()
    expect(view.getByRole('button', { name: '源码' })).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: '分栏' }))
    expect(controller.setMarkdownMode).toHaveBeenCalledWith('split', 'file:README.md')
  })

  it('renders source and preview together with the format toolbar in split mode', () => {
    fileTab(1).markdownMode = 'split'
    const controller = controllerFake()
    const view = renderEditor(controller)
    expect(view.getByRole('textbox', { name: 'README.md' })).toBeTruthy()
    expect(view.getByText('# Readme')).toBeTruthy()
    expect(view.getByRole('button', { name: '加粗' })).toBeTruthy()
  })

  it('hides the format toolbar while Markdown is in preview-only mode', () => {
    const controller = controllerFake()
    const view = renderEditor(controller)
    expect(view.queryByRole('button', { name: '加粗' })).toBeNull()
  })

  it('opens a split editor from the header control', () => {
    const controller = controllerFake()
    const view = renderEditor(controller)
    fireEvent.click(view.getByRole('button', { name: '向右分栏编辑' }))
    expect(controller.toggleSplit).toHaveBeenCalledWith('horizontal')
    fireEvent.click(view.getByRole('button', { name: '向下分栏编辑' }))
    expect(controller.toggleSplit).toHaveBeenCalledWith('vertical')
  })

  it('renders an independent tab bar per split pane with a draggable divider', () => {
    fileTab(1).markdownMode = 'source'
    workbenchState.current.activeTabId = 'file:src/a.ts'
    workbenchState.current.editorSplit = true
    workbenchState.current.activePane = 'primary'
    workbenchState.current.panes = {
      primary: { tabIds: ['file:src/a.ts'], activeTabId: 'file:src/a.ts' },
      secondary: { tabIds: ['file:README.md'], activeTabId: 'file:README.md' },
    }
    const controller = controllerFake()
    const view = renderEditor(controller)

    // Each pane shows its own tab strip, so there are two tablists.
    expect(view.getAllByRole('tablist')).toHaveLength(2)
    // Primary shows the active src/a.ts, secondary shows README.md.
    expect(view.getByRole('textbox', { name: 'src/a.ts' })).toBeTruthy()
    expect(view.getByRole('textbox', { name: 'README.md' })).toBeTruthy()
    expect(view.getByRole('separator', { name: '拖拽调整分栏大小' })).toBeTruthy()

    fireEvent.click(view.getByRole('button', { name: '关闭分栏' }))
    expect(controller.toggleSplit).toHaveBeenCalledWith()
  })

  it('routes a secondary-pane tab click to that pane', () => {
    fileTab(1).markdownMode = 'source'
    workbenchState.current.activeTabId = 'file:src/a.ts'
    workbenchState.current.editorSplit = true
    workbenchState.current.activePane = 'primary'
    workbenchState.current.panes = {
      primary: { tabIds: ['file:src/a.ts'], activeTabId: 'file:src/a.ts' },
      secondary: { tabIds: ['file:README.md'], activeTabId: 'file:README.md' },
    }
    const controller = controllerFake()
    const view = renderEditor(controller)
    // The secondary pane holds a second README tab; clicking it selects within that pane.
    const readmes = view.getAllByRole('tab', { name: 'README.md' })
    fireEvent.click(readmes[readmes.length - 1]!)
    expect(controller.selectTab).toHaveBeenCalledWith('file:README.md')
  })

  it('moves a dragged tab into the drop target pane', () => {
    fileTab(1).markdownMode = 'source'
    workbenchState.current.activeTabId = 'file:src/a.ts'
    workbenchState.current.editorSplit = true
    workbenchState.current.activePane = 'primary'
    workbenchState.current.panes = {
      primary: { tabIds: ['file:src/a.ts'], activeTabId: 'file:src/a.ts' },
      secondary: { tabIds: ['file:README.md'], activeTabId: 'file:README.md' },
    }
    const controller = controllerFake()
    const view = renderEditor(controller)
    const secondaryPane = view.container.querySelector('[data-dsh-editor-pane="secondary"]')
    expect(secondaryPane).not.toBeNull()
    const dataTransfer = { getData: () => 'file:src/a.ts', setData: vi.fn(), dropEffect: '', effectAllowed: '' }
    fireEvent.drop(secondaryPane as Element, { dataTransfer })
    expect(controller.moveTabToPane).toHaveBeenCalledWith('file:src/a.ts', 'secondary')
  })

  it('does not open a second pane when only one tab is available', () => {
    workbenchState.current.tabs = [tab('src/a.ts', 'const a = 1', false)]
    workbenchState.current.activeTabId = 'file:src/a.ts'
    workbenchState.current.panes = {
      primary: { tabIds: ['file:src/a.ts'], activeTabId: 'file:src/a.ts' },
      secondary: { tabIds: [] },
    }
    const controller = controllerFake()
    const view = renderEditor(controller)
    fireEvent.click(view.getByRole('button', { name: '向右分栏编辑' }))
    expect(controller.toggleSplit).toHaveBeenCalledWith('horizontal')
    expect(view.queryByRole('separator')).toBeNull()
  })

  it('previews an HTML file in a sandboxed frame and switches to source on demand', () => {
    workbenchState.current.tabs.push(tab('index.html', '<h1>Hi</h1>', false))
    focusPrimaryTab('file:index.html')
    const controller = controllerFake()
    const view = renderEditor(controller)

    const frame = view.getByTitle('HTML 预览') as HTMLIFrameElement
    expect(frame.tagName.toLowerCase()).toBe('iframe')
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(frame.getAttribute('srcdoc')).toContain('Content-Security-Policy')
    expect(view.queryByRole('textbox', { name: 'index.html' })).toBeNull()

    fireEvent.click(view.getByRole('button', { name: '交互' }))
    expect(controller.setHtmlMode).toHaveBeenCalledWith('interactive', 'file:index.html')
    fireEvent.click(view.getByRole('button', { name: '源码' }))
    expect(controller.setHtmlMode).toHaveBeenCalledWith('source', 'file:index.html')
  })
})

function editorProps(controller: ReturnType<typeof controllerFake>): WorkbenchEditorProps {
  return {
    sessionId: 'session-1',
    useSessions: (selector: (snapshot: {
      byId: Record<string, { updatedAt: number; retainedBy: { mainView: number } }>
    }) => unknown) => selector({
      byId: { 'session-1': { updatedAt: 1, retainedBy: { mainView: 1 } } },
    }),
    useWorkspaces: (selector: (snapshot: {
      items: Array<{ workspaceId: string; path: string; sessionIds: string[] }>
    }) => unknown) => selector({
      items: [{ workspaceId: 'workspace-1', path: '/workspace/one', sessionIds: ['session-1'] }],
    }),
    controller,
    activateWorkspace: vi.fn(),
    t: (key: keyof typeof zh, values?: Record<string, string>) => interpolate(zh[key], values),
  } as unknown as WorkbenchEditorProps
}

function renderEditor(controller: ReturnType<typeof controllerFake>) {
  return render(<WorkbenchEditor {...editorProps(controller)} />)
}

function controllerFake() {
  return {
    store: { getSnapshot: () => workbenchState.current },
    save: vi.fn(() => Promise.resolve(true)),
    selectTab: vi.fn(),
    closeTab: vi.fn(() => true),
    setMarkdownMode: vi.fn(),
    toggleMarkdownOutline: vi.fn(),
    setHtmlMode: vi.fn(),
    setEditorWrap: vi.fn(),
    setEditorInlineDiff: vi.fn(),
    revert: vi.fn(),
    reloadExternalFile: vi.fn(),
    keepCurrentDraft: vi.fn(),
    setDraft: vi.fn(),
    ensureGitBaseline: vi.fn(() => Promise.resolve()),
    setDiffViewMode: vi.fn(),
    setSession: vi.fn(),
    toggleConversation: vi.fn(),
    toggleSplit: vi.fn(),
    setSplitRatio: vi.fn(),
    focusPane: vi.fn(),
    moveTabToPane: vi.fn(),
  }
}

function state(): WorkbenchState {
  return {
    sidebarMode: 'files',
    editorExpanded: true,
    conversationExpanded: true,
    workspaceId: 'workspace-1',
    tabs: [
      tab('src/a.ts', 'const a = 1', false),
      tab('README.md', '# Readme', true),
    ],
    activeTabId: 'file:README.md',
    diffViewMode: 'split',
    gitView: 'changes',
    gitChangeLayout: 'list',
    gitGraphFileLayout: 'list',
    gitDecorations: {},
    gitLineVersions: {},
    editorSplit: false,
    editorSplitOrientation: 'horizontal',
    editorSplitRatio: 0.5,
    activePane: 'primary',
    panes: {
      primary: { tabIds: ['file:src/a.ts', 'file:README.md'], activeTabId: 'file:README.md' },
      secondary: { tabIds: [] },
    },
  }
}

/** The open file tab at `index`; the fixture only ever opens file tabs here. */
function fileTab(index: number): WorkbenchFileTab {
  const candidate = workbenchState.current.tabs[index]
  if (candidate?.kind !== 'file') throw new Error(`fixture tab ${index} is not a file tab`)
  return candidate
}

function tab(path: string, content: string, markdown: boolean) {
  return {
    id: `file:${path}`,
    kind: 'file' as const,
    path,
    file: { path, content, version: '1', size: content.length, markdown },
    image: null,
    draft: content,
    dirty: false,
    markdownMode: (markdown ? 'preview' : 'source') as WorkbenchFileTab['markdownMode'],
    wrap: true,
    inlineDiff: true,
    loading: false,
    saving: false,
    externalChange: null,
    error: null,
  }
}

function diffTab(path: string) {
  return {
    id: `diff:worktree::${path}`,
    kind: 'diff' as const,
    path,
    diffKind: 'worktree' as const,
    diff: { kind: 'worktree' as const, path, status: 'M', original: 'old', modified: 'new', binary: false },
    loading: false,
    error: null,
  }
}

function terminalTab(sequence: number) {
  return {
    id: `terminal:${sequence}`,
    kind: 'terminal' as const,
    sequence,
    contentId: `wbterm:workspace-1:terminal:${sequence}`,
    status: 'running' as const,
  }
}

function interpolate(template: string, values: Record<string, string> | undefined): string {
  if (values === undefined) return template
  return Object.entries(values).reduce((text, [key, value]) => text.replace(`{${key}}`, value), template)
}

/** Select a tab in the primary pane so the split-pane view renders it there. */
function focusPrimaryTab(tabId: string): void {
  const state = workbenchState.current
  if (!state.panes.primary.tabIds.includes(tabId)) state.panes.primary.tabIds.push(tabId)
  state.panes.primary.activeTabId = tabId
  state.activeTabId = tabId
  state.activePane = 'primary'
}
