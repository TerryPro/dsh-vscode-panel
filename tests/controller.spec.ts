import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { ClientTerminals } from '@deepseek-ai/dsh-api-terminal-controller/client'
import type { WorkbenchTerminalTab } from '../src/client/model/controller.ts'
import { resolveWorkbenchWorkspaceId } from '../src/client/model/workspace-binding.ts'

vi.mock('@deepseek-ai/dsh-client-store', () => ({
  createSnapshotStore: <T,>(initial: T) => {
    let state = initial
    const listeners = new Set<() => void>()
    return {
      getSnapshot: () => state,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      set: (next: T) => { state = next; listeners.forEach(listener => { listener() }) },
      update: (mutator: (draft: T) => void) => {
        const next = structuredClone(state)
        mutator(next)
        state = next
        listeners.forEach(listener => { listener() })
      },
    }
  },
}))

let WorkbenchController: typeof import('../src/client/model/controller.ts').WorkbenchController

beforeAll(async () => {
  WorkbenchController = (await import('../src/client/model/controller.ts')).WorkbenchController
})

describe('WorkbenchController', () => {
  it('opens Markdown in preview mode and saves the active tab with its observed version', async () => {
    const api = {
      readFile: vi.fn(() => Promise.resolve(file('README.md', '# Title', 'v1', true))),
      saveFile: vi.fn(() => Promise.resolve({ path: 'README.md', version: 'v2', size: 8 })),
    }
    const controller = createController(api)
    await controller.openFile('workspace-1', 'README.md')

    expect(activeTab(controller)).toMatchObject({ path: 'README.md', markdownMode: 'preview', dirty: false, draft: '# Title' })
    controller.setDraft('# Title!')
    expect(activeTab(controller)?.dirty).toBe(true)
    await controller.save()
    expect(api.saveFile).toHaveBeenCalledWith('workspace-1', 'README.md', '# Title!', 'v1')
    expect(activeTab(controller)).toMatchObject({ dirty: false, saving: false, file: { version: 'v2' } })
  })

  it('opens JSON and YAML in the structured graph, and switches modes per tab', async () => {
    const api = {
      readFile: vi.fn(((_workspace: string, path: string) => Promise.resolve(
        file(path, path.endsWith('.yaml') ? 'a: 1\n' : '{"a": 1}', 'v1'),
      ))),
    }
    const controller = createController(api)
    await controller.openFile('workspace-1', 'cfg.yaml')
    expect(activeTab(controller)).toMatchObject({ path: 'cfg.yaml', structuredMode: 'graph' })

    controller.setStructuredMode('source')
    expect(activeTab(controller)?.structuredMode).toBe('source')

    await controller.openFile('workspace-1', 'cfg.json')
    expect(activeTab(controller)).toMatchObject({ path: 'cfg.json', structuredMode: 'graph' })
    // Each tab keeps its own mode choice.
    expect(controller.store.getSnapshot().tabs.find(tab => tab.path === 'cfg.yaml')?.structuredMode).toBe('source')
  })

  it('loads image files through the binary endpoint without a text read', async () => {
    const image = { path: 'assets/logo.png', content: 'AQID', mimeType: 'image/png', version: 'v1', size: 3 }
    const api = {
      readFile: vi.fn(() => Promise.reject(new Error('should not read text'))),
      readImage: vi.fn(() => Promise.resolve(image)),
    }
    const controller = createController(api)
    await controller.openFile('workspace-1', 'assets/logo.png')

    expect(api.readImage).toHaveBeenCalledWith('workspace-1', 'assets/logo.png')
    expect(api.readFile).not.toHaveBeenCalled()
    expect(activeTab(controller)).toMatchObject({ path: 'assets/logo.png', image, loading: false, file: null })

    await controller.openFile('workspace-1', 'assets/logo.png')
    expect(api.readImage).toHaveBeenCalledOnce()
  })

  it('logs local Git hunk interactions without logging normal typing', async () => {
    const logger = { info: vi.fn(), warn: vi.fn() }
    const controller = new WorkbenchController({
      readFile: vi.fn(() => Promise.resolve(file('src/a.ts', 'before', 'v1'))),
    } as never, logger)
    await controller.openFile('workspace-1', 'src/a.ts')
    logger.info.mockClear()

    controller.setDraft('typed', 'input')
    expect(logger.info).not.toHaveBeenCalled()
    controller.logGitHunkOpen('src/a.ts')
    expect(logger.info).toHaveBeenLastCalledWith(
      'workbench-layout: opened local Git Diff hunk for "src/a.ts"',
    )
    controller.logGitHunkResize('src/a.ts', 512)
    expect(logger.info).toHaveBeenLastCalledWith(
      'workbench-layout: resized local Git Diff hunk for "src/a.ts" to 512px wide',
    )
    controller.logGitHunkResizeStorageError('save')
    expect(logger.warn).toHaveBeenLastCalledWith(
      'workbench-layout: could not save local Git Diff hunk width preference',
    )
    controller.logGitHunkDismissOutside('src/a.ts')
    expect(logger.info).toHaveBeenLastCalledWith(
      'workbench-layout: dismissed local Git Diff hunk outside "src/a.ts"',
    )
    controller.setDraft('before', 'git-revert')

    expect(logger.info).toHaveBeenCalledWith(
      'workbench-layout: reverted one Git change block in "src/a.ts"',
    )
  })

  it('resolves a native conversation file reference before opening its Workspace tab', async () => {
    const api = {
      relativePath: vi.fn(() => Promise.resolve({ path: 'src/view.tsx' })),
      readFile: vi.fn(() => Promise.resolve(file('src/view.tsx', 'export {}', 'v1'))),
    }
    const controller = createController(api)
    controller.setWorkspace('workspace-1')

    await controller.openConversationFile('workspace-1', 'src/view.tsx')

    expect(api.relativePath).toHaveBeenCalledWith('workspace-1', 'src/view.tsx')
    expect(api.readFile).toHaveBeenCalledWith('workspace-1', 'src/view.tsx')
    expect(activeTab(controller)?.path).toBe('src/view.tsx')
  })

  it('does not reopen an old Workspace when file-reference resolution finishes late', async () => {
    let resolvePath: ((value: { path: string }) => void) | undefined
    const api = {
      relativePath: vi.fn(() => new Promise<{ path: string }>(resolve => { resolvePath = resolve })),
      readFile: vi.fn(),
    }
    const controller = createController(api)
    controller.setWorkspace('workspace-1')
    const request = controller.openConversationFile('workspace-1', 'src/old.ts')
    controller.setWorkspace('workspace-2')
    resolvePath?.({ path: 'src/old.ts' })
    await request

    expect(api.readFile).not.toHaveBeenCalled()
    expect(controller.store.getSnapshot().workspaceId).toBe('workspace-2')
  })

  it('opens multiple files and switches tabs without blocking an unsaved draft', async () => {
    const api = {
      readFile: vi.fn()
        .mockResolvedValueOnce(file('first.ts', 'one', '1'))
        .mockResolvedValueOnce(file('second.ts', 'two', '2')),
    }
    const controller = createController(api)
    await controller.openFile('workspace-1', 'first.ts')
    controller.setDraft('changed')
    await controller.openFile('workspace-1', 'second.ts')

    expect(controller.store.getSnapshot()).toMatchObject({
      tabs: [
        { path: 'first.ts', draft: 'changed', dirty: true },
        { path: 'second.ts', draft: 'two', dirty: false },
      ],
    })
    expect(activeTab(controller)?.path).toBe('second.ts')
    controller.selectTab(fileTab(controller, 'first.ts')!.id)
    expect(activeTab(controller)).toMatchObject({ path: 'first.ts', draft: 'changed', dirty: true })
  })

  it('loads concurrent file tabs independently without an older response stealing selection', async () => {
    let resolveFirst: ((value: unknown) => void) | undefined
    const first = new Promise(resolve => { resolveFirst = resolve })
    const api = {
      readFile: vi.fn()
        .mockReturnValueOnce(first)
        .mockResolvedValueOnce(file('new.ts', 'new', '2')),
    }
    const controller = createController(api)
    const oldRequest = controller.openFile('workspace-1', 'old.ts')
    await controller.openFile('workspace-1', 'new.ts')
    resolveFirst?.(file('old.ts', 'old', '1'))
    await oldRequest

    expect(activeTab(controller)?.path).toBe('new.ts')
    expect(controller.store.getSnapshot().tabs).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'old.ts', draft: 'old', loading: false }),
      expect.objectContaining({ path: 'new.ts', draft: 'new', loading: false }),
    ]))
  })

  it('selects an already open tab without reading the file again', async () => {
    const api = { readFile: vi.fn(() => Promise.resolve(file('same.ts', 'same', '1'))) }
    const controller = createController(api)
    await controller.openFile('workspace-1', 'same.ts')
    await controller.openFile('workspace-1', 'same.ts')
    expect(api.readFile).toHaveBeenCalledOnce()
    expect(controller.store.getSnapshot().tabs).toHaveLength(1)
  })

  it('protects a dirty tab from ordinary close and chooses an adjacent tab after confirmed close', async () => {
    const api = {
      readFile: vi.fn()
        .mockResolvedValueOnce(file('first.ts', 'one', '1'))
        .mockResolvedValueOnce(file('second.ts', 'two', '2')),
    }
    const controller = createController(api)
    await controller.openFile('workspace-1', 'first.ts')
    controller.setDraft('changed')
    await controller.openFile('workspace-1', 'second.ts')
    const firstTabId = fileTab(controller, 'first.ts')!.id
    expect(controller.closeTab(firstTabId)).toBe(false)
    expect(controller.closeTab(firstTabId, true)).toBe(true)
    expect(controller.store.getSnapshot().tabs.map(tab => tab.path)).toEqual(['second.ts'])
    expect(activeTab(controller)?.path).toBe('second.ts')
  })

  it('opens a split by moving the neighbouring tab into an independent secondary pane', async () => {
    const api = {
      readFile: vi.fn()
        .mockResolvedValueOnce(file('first.ts', 'one', '1'))
        .mockResolvedValueOnce(file('second.ts', 'two', '2'))
        .mockResolvedValueOnce(file('third.ts', 'three', '3')),
    }
    const controller = createController(api)
    await controller.openFile('workspace-1', 'first.ts')
    await controller.openFile('workspace-1', 'second.ts')
    await controller.openFile('workspace-1', 'third.ts')

    controller.toggleSplit('horizontal')
    const panes = controller.store.getSnapshot().panes
    expect(controller.store.getSnapshot().editorSplit).toBe(true)
    // The previous neighbour of the active tab moves out; the primary keeps the rest.
    expect(panes.secondary.tabIds).toEqual(['file:second.ts'])
    expect(panes.primary.tabIds).toEqual(['file:first.ts', 'file:third.ts'])
    expect(panes.primary.activeTabId).toBe('file:third.ts')
    expect(panes.secondary.activeTabId).toBe('file:second.ts')
  })

  it('opens files into the focused pane while each pane keeps its own selection', async () => {
    const api = {
      readFile: vi.fn()
        .mockResolvedValueOnce(file('first.ts', 'one', '1'))
        .mockResolvedValueOnce(file('second.ts', 'two', '2'))
        .mockResolvedValueOnce(file('third.ts', 'three', '3')),
    }
    const controller = createController(api)
    await controller.openFile('workspace-1', 'first.ts')
    await controller.openFile('workspace-1', 'second.ts')
    controller.toggleSplit()
    // Secondary now pins first.ts; primary keeps second.ts and stays focused.
    controller.focusPane('secondary')
    expect(activeTab(controller)?.path).toBe('first.ts')

    await controller.openFile('workspace-1', 'third.ts')
    const afterOpen = controller.store.getSnapshot().panes
    expect(afterOpen.secondary.tabIds).toEqual(['file:first.ts', 'file:third.ts'])
    expect(afterOpen.secondary.activeTabId).toBe('file:third.ts')
    expect(afterOpen.primary.tabIds).toEqual(['file:second.ts'])

    // Clicking a tab selects it in its own pane and focuses that pane, without losing the other selection.
    controller.selectTab('file:second.ts')
    const afterSelect = controller.store.getSnapshot().panes
    expect(controller.store.getSnapshot().activeTabId).toBe('file:second.ts')
    expect(afterSelect.secondary.activeTabId).toBe('file:third.ts')
  })

  it('collapses the split and merges tabs back when the secondary pane empties', async () => {
    const api = {
      readFile: vi.fn()
        .mockResolvedValueOnce(file('first.ts', 'one', '1'))
        .mockResolvedValueOnce(file('second.ts', 'two', '2')),
    }
    const controller = createController(api)
    await controller.openFile('workspace-1', 'first.ts')
    await controller.openFile('workspace-1', 'second.ts')
    controller.toggleSplit()
    expect(controller.store.getSnapshot().editorSplit).toBe(true)

    expect(controller.closeTab('file:first.ts', true)).toBe(true)
    const state = controller.store.getSnapshot()
    expect(state.editorSplit).toBe(false)
    expect(state.panes.secondary.tabIds).toEqual([])
    expect(state.tabs.map(tab => tab.path)).toEqual(['second.ts'])
    expect(activeTab(controller)?.path).toBe('second.ts')
  })

  it('refuses to split when there is no second non-terminal tab', async () => {
    const api = { readFile: vi.fn(() => Promise.resolve(file('only.ts', 'x', '1'))) }
    const controller = createController(api)
    await controller.openFile('workspace-1', 'only.ts')
    controller.toggleSplit()
    expect(controller.store.getSnapshot().editorSplit).toBe(false)
  })

  it('splits a terminal beside a file by pinning the file into the secondary pane', async () => {
    const api = { readFile: vi.fn(() => Promise.resolve(file('a.ts', 'x', '1'))) }
    const controller = createController(api)
    await controller.openFile('workspace-1', 'a.ts')
    const terminalId = controller.openTerminal()

    // Active is the terminal; its previous neighbour (the file) moves to the secondary pane.
    controller.toggleSplit()
    const panes = controller.store.getSnapshot().panes
    expect(controller.store.getSnapshot().editorSplit).toBe(true)
    expect(panes.secondary.tabIds).toEqual(['file:a.ts'])
    expect(panes.primary.tabIds).toEqual([terminalId])
    expect(controller.store.getSnapshot().activeTabId).toBe(terminalId)
  })

  it('moves a dragged tab into another pane and reselects the source pane', async () => {
    const api = {
      readFile: vi.fn()
        .mockResolvedValueOnce(file('first.ts', 'one', '1'))
        .mockResolvedValueOnce(file('second.ts', 'two', '2'))
        .mockResolvedValueOnce(file('third.ts', 'three', '3')),
    }
    const controller = createController(api)
    await controller.openFile('workspace-1', 'first.ts')
    await controller.openFile('workspace-1', 'second.ts')
    await controller.openFile('workspace-1', 'third.ts')
    controller.toggleSplit() // secondary pins second.ts, primary keeps first/third (active third)

    controller.moveTabToPane('file:first.ts', 'secondary')
    const panes = controller.store.getSnapshot().panes
    expect(panes.primary.tabIds).toEqual(['file:third.ts'])
    expect(panes.secondary.tabIds).toEqual(['file:second.ts', 'file:first.ts'])
    expect(panes.secondary.activeTabId).toBe('file:first.ts')
    expect(controller.store.getSnapshot().activeTabId).toBe('file:first.ts')
  })

  it('collapses the split when a drag empties the secondary pane', async () => {
    const api = {
      readFile: vi.fn()
        .mockResolvedValueOnce(file('first.ts', 'one', '1'))
        .mockResolvedValueOnce(file('second.ts', 'two', '2')),
    }
    const controller = createController(api)
    await controller.openFile('workspace-1', 'first.ts')
    await controller.openFile('workspace-1', 'second.ts')
    controller.toggleSplit() // secondary pins first.ts
    controller.focusPane('secondary')

    // Dragging first.ts back to the primary leaves the secondary pane empty.
    controller.moveTabToPane('file:first.ts', 'primary')
    const state = controller.store.getSnapshot()
    expect(state.editorSplit).toBe(false)
    expect(state.panes.secondary.tabIds).toEqual([])
    expect(state.panes.primary.tabIds).toEqual(['file:second.ts', 'file:first.ts'])
  })

  it('clamps the split ratio to the 0.2–0.8 range', () => {
    const controller = createController({ readFile: vi.fn() })
    controller.setSplitRatio(0.95)
    expect(controller.store.getSnapshot().editorSplitRatio).toBe(0.8)
    controller.setSplitRatio(0.01)
    expect(controller.store.getSnapshot().editorSplitRatio).toBe(0.2)
    controller.setSplitRatio(0.5)
    expect(controller.store.getSnapshot().editorSplitRatio).toBe(0.5)
  })

  it('keeps view toggles independent per file tab', async () => {
    const api = {
      readFile: vi.fn()
        .mockResolvedValueOnce(file('first.ts', 'one', '1'))
        .mockResolvedValueOnce(file('second.ts', 'two', '2'))
        .mockResolvedValueOnce(file('doc.md', '# Doc', '1', true)),
    }
    const controller = createController(api)
    await controller.openFile('workspace-1', 'first.ts')
    await controller.openFile('workspace-1', 'second.ts')
    await controller.openFile('workspace-1', 'doc.md')

    controller.setEditorWrap('file:first.ts', false)
    controller.setEditorInlineDiff('file:second.ts', true)
    controller.setMarkdownMode('source', 'file:doc.md')

    const state = controller.store.getSnapshot()
    const [first, second, doc] = state.tabs
    expect(first?.kind === 'file' && first.wrap).toBe(false)
    // first's inline diff was never toggled, so it stays at the off-by-default.
    expect(first?.kind === 'file' && first.inlineDiff).toBe(false)
    expect(second?.kind === 'file' && second.wrap).toBe(true)
    expect(second?.kind === 'file' && second.inlineDiff).toBe(true)
    expect(doc?.kind === 'file' && doc.markdownMode).toBe('source')
    // The active tab is untouched by these targeted toggles.
    expect(activeTab(controller)?.path).toBe('doc.md')
  })

  it('toggles the outline panel independently per Markdown file tab', async () => {
    const api = {
      readFile: vi.fn()
        .mockResolvedValueOnce(file('first.md', '# One', '1', true))
        .mockResolvedValueOnce(file('second.md', '# Two', '2', true)),
    }
    const controller = createController(api)
    await controller.openFile('workspace-1', 'first.md')
    await controller.openFile('workspace-1', 'second.md')

    controller.toggleMarkdownOutline('file:first.md')

    const [first, second] = controller.store.getSnapshot().tabs
    expect(first?.kind === 'file' && first.outlineVisible).toBe(true)
    expect(second?.kind === 'file' && second.outlineVisible).toBeUndefined()

    controller.toggleMarkdownOutline('file:first.md')
    const toggled = controller.store.getSnapshot().tabs[0]
    expect(toggled?.kind === 'file' && toggled.outlineVisible).toBe(false)
  })

  it('opens CSV files in table mode and switches their view independently per tab', async () => {
    const api = {
      readFile: vi.fn()
        .mockResolvedValueOnce(file('data.csv', 'a,b\n1,2', '1'))
        .mockResolvedValueOnce(file('other.csv', 'x,y\n3,4', '2')),
    }
    const controller = createController(api)
    await controller.openFile('workspace-1', 'data.csv')
    await controller.openFile('workspace-1', 'other.csv')

    expect(fileTab(controller, 'data.csv')).toMatchObject({ csvMode: 'table' })
    controller.setCsvMode('source', 'file:data.csv')
    const [first, second] = controller.store.getSnapshot().tabs
    expect(first?.kind === 'file' && first.csvMode).toBe('source')
    expect(second?.kind === 'file' && second.csvMode).toBe('table')
  })

  it('routes drafts to the pane that owns the edited tab while split is active', async () => {
    const api = {
      readFile: vi.fn()
        .mockResolvedValueOnce(file('first.ts', 'one', '1'))
        .mockResolvedValueOnce(file('second.ts', 'two', '2')),
    }
    const controller = createController(api)
    await controller.openFile('workspace-1', 'first.ts')
    await controller.openFile('workspace-1', 'second.ts')
    controller.toggleSplit()

    controller.setDraft('edited-secondary', 'input', 'file:first.ts')
    expect(fileTab(controller, 'first.ts')?.draft).toBe('edited-secondary')
    expect(activeTab(controller)?.path).toBe('second.ts')
  })

  it('retains all tabs and unsaved drafts while switching Workspaces', async () => {
    const api = { readFile: vi.fn(() => Promise.resolve(file('draft.txt', 'base', '1'))) }
    const controller = createController(api)
    await controller.openFile('workspace-1', 'draft.txt')
    controller.setDraft('unsaved')
    controller.setWorkspace('workspace-2')
    controller.setWorkspace('workspace-1')
    expect(controller.store.getSnapshot()).toMatchObject({
      workspaceId: 'workspace-1',
      tabs: [{ path: 'draft.txt', draft: 'unsaved', dirty: true }],
    })
    expect(activeTab(controller)?.path).toBe('draft.txt')
  })

  it('keeps file tabs when another Session resolves to the same Workspace', async () => {
    const api = { readFile: vi.fn(() => Promise.resolve(file('shared.txt', 'base', '1'))) }
    const controller = createController(api)
    await controller.openFile('workspace-shared', 'shared.txt')
    controller.setDraft('shared draft')
    const workspaces = [{ workspaceId: 'workspace-shared', sessionIds: ['one', 'two'] }]
    controller.setWorkspace(resolveWorkbenchWorkspaceId(workspaces, 'two', 'workspace-shared'))
    expect(activeTab(controller)).toMatchObject({ path: 'shared.txt', draft: 'shared draft', dirty: true })
  })

  it('applies a late save to its file and Workspace without mutating the active Workspace', async () => {
    let finishSave: ((value: { path: string; version: string; size: number }) => void) | undefined
    const api = {
      readFile: vi.fn((workspaceId: string, path: string) => Promise.resolve(file(path, workspaceId, '1'))),
      saveFile: vi.fn(() => new Promise(resolve => { finishSave = resolve })),
    }
    const controller = createController(api)
    await controller.openFile('workspace-a', 'a.txt')
    controller.setDraft('saved content')
    const saving = controller.save()
    await controller.openFile('workspace-b', 'b.txt')
    finishSave?.({ path: 'a.txt', version: '2', size: 13 })
    await saving

    expect(activeTab(controller)).toMatchObject({ path: 'b.txt', file: { version: '1' }, dirty: false })
    controller.setWorkspace('workspace-a')
    expect(activeTab(controller)).toMatchObject({ path: 'a.txt', file: { version: '2' }, dirty: false, saving: false })
  })

  it('updates the saved base while keeping newer edits dirty on that tab', async () => {
    let finishSave: ((value: { path: string; version: string; size: number }) => void) | undefined
    const api = {
      readFile: vi.fn(() => Promise.resolve(file('draft.txt', 'base', '1'))),
      saveFile: vi.fn(() => new Promise(resolve => { finishSave = resolve })),
    }
    const controller = createController(api)
    await controller.openFile('workspace-1', 'draft.txt')
    controller.setDraft('first draft')
    const saving = controller.save()
    controller.setDraft('newer draft')
    finishSave?.({ path: 'draft.txt', version: '2', size: 11 })
    await saving
    expect(activeTab(controller)).toMatchObject({
      file: { content: 'first draft', version: '2' }, draft: 'newer draft', dirty: true, saving: false,
    })
  })

  it('updates clean tabs after an external file change without creating a dirty marker', async () => {
    const api = {
      readFile: vi.fn(() => Promise.resolve(file('draft.txt', 'before', '1'))),
      refreshFiles: vi.fn(() => Promise.resolve({ files: [{
        path: 'draft.txt', status: 'changed', file: file('draft.txt', 'outside', '2'),
      }] })),
    }
    const controller = createController(api)
    await controller.openFile('workspace-1', 'draft.txt')
    await controller.refreshOpenFiles()

    expect(api.refreshFiles).toHaveBeenCalledWith('workspace-1', [{ path: 'draft.txt', version: '1' }])
    expect(activeTab(controller)).toMatchObject({
      draft: 'outside', dirty: false, file: { content: 'outside', version: '2' }, externalChange: null,
    })
  })

  it('protects a dirty draft when an external file change arrives and lets the user choose the version', async () => {
    const api = {
      readFile: vi.fn(() => Promise.resolve(file('draft.txt', 'before', '1'))),
      refreshFiles: vi.fn(() => Promise.resolve({ files: [{
        path: 'draft.txt', status: 'changed', file: file('draft.txt', 'outside', '2'),
      }] })),
    }
    const controller = createController(api)
    await controller.openFile('workspace-1', 'draft.txt')
    controller.setDraft('inside')
    await controller.refreshOpenFiles()

    expect(activeTab(controller)).toMatchObject({
      draft: 'inside', dirty: true,
      externalChange: { kind: 'changed', file: { content: 'outside', version: '2' } },
    })
    expect(await controller.save()).toBe(false)
    controller.keepCurrentDraft()
    expect(activeTab(controller)).toMatchObject({
      draft: 'inside', dirty: true, file: { content: 'outside', version: '2' }, externalChange: null,
    })
  })

  it('reports an externally deleted open file without erasing its current contents', async () => {
    const api = {
      readFile: vi.fn(() => Promise.resolve(file('draft.txt', 'visible', '1'))),
      refreshFiles: vi.fn(() => Promise.resolve({
        files: [{ path: 'draft.txt', status: 'deleted' }],
      })),
    }
    const controller = createController(api)
    await controller.openFile('workspace-1', 'draft.txt')
    await controller.refreshOpenFiles()

    expect(activeTab(controller)).toMatchObject({
      draft: 'visible', dirty: false, externalChange: { kind: 'deleted' },
    })
  })

  it('coalesces overlapping foreground refresh requests', async () => {
    let finishRefresh: ((value: { files: never[] }) => void) | undefined
    const api = {
      readFile: vi.fn(() => Promise.resolve(file('draft.txt', 'visible', '1'))),
      refreshFiles: vi.fn(() => new Promise<{ files: never[] }>(resolve => { finishRefresh = resolve })),
    }
    const controller = createController(api)
    await controller.openFile('workspace-1', 'draft.txt')
    const first = controller.refreshOpenFiles()
    const second = controller.refreshOpenFiles()

    expect(first).toBe(second)
    expect(api.refreshFiles).toHaveBeenCalledOnce()
    finishRefresh?.({ files: [] })
    await first
  })

  it('saves the requested inactive tab without switching the active tab', async () => {
    const api = {
      readFile: vi.fn()
        .mockResolvedValueOnce(file('first.ts', 'one', '1'))
        .mockResolvedValueOnce(file('second.ts', 'two', '2')),
      saveFile: vi.fn(() => Promise.resolve({ path: 'first.ts', version: '3', size: 7 })),
    }
    const controller = createController(api)
    await controller.openFile('workspace-1', 'first.ts')
    controller.setDraft('changed')
    await controller.openFile('workspace-1', 'second.ts')
    await controller.save(fileTab(controller, 'first.ts')!.id)
    expect(activeTab(controller)?.path).toBe('second.ts')
    expect(controller.store.getSnapshot().tabs.find(tab => tab.path === 'first.ts')).toMatchObject({ dirty: false })
  })

  it('opens commit and workspace-comparison Diffs as distinct tabs without discarding files', async () => {
    const commit = {
      hash: 'a'.repeat(40), shortHash: 'aaaaaaa', parents: ['b'.repeat(40)], subject: '图中提交', author: 'Tester', authoredAt: '2026-08-23T10:00:00Z',
      references: [],
    }
    const api = {
      readFile: vi.fn(() => Promise.resolve(file('kept.ts', 'kept', '1'))),
      gitCommitFileDiff: vi.fn(() => Promise.resolve({
        kind: 'commit', path: 'src/a.ts', status: 'M', revision: commit.hash,
        original: 'before', modified: 'after', binary: false,
      })),
      gitComparisonFileDiff: vi.fn(() => Promise.resolve({
        kind: 'comparison', path: 'src/a.ts', status: 'M', revision: commit.hash,
        original: 'before', modified: 'workspace', binary: false,
      })),
    }
    const controller = createController(api)
    await controller.openFile('workspace-1', 'kept.ts')
    await controller.openCommitDiff('workspace-1', commit, 'src/a.ts')
    await controller.openComparisonDiff('workspace-1', commit, 'src/a.ts')
    expect(controller.store.getSnapshot().tabs).toEqual([
      expect.objectContaining({ kind: 'file', path: 'kept.ts' }),
      expect.objectContaining({ kind: 'diff', diffKind: 'commit', path: 'src/a.ts' }),
      expect.objectContaining({ kind: 'diff', diffKind: 'comparison', path: 'src/a.ts', diff: expect.objectContaining({ modified: 'workspace' }) }),
    ])
    expect(activeTab(controller)).toMatchObject({ kind: 'diff', diffKind: 'comparison', path: 'src/a.ts' })
    controller.selectTab(fileTab(controller, 'kept.ts')!.id)
    expect(activeTab(controller)?.path).toBe('kept.ts')
  })

  it('loads multiple Diff tabs independently without an older response stealing selection', async () => {
    let resolveFirst: ((value: unknown) => void) | undefined
    const first = new Promise(resolve => { resolveFirst = resolve })
    const api = {
      gitDiff: vi.fn()
        .mockReturnValueOnce(first)
        .mockResolvedValueOnce({ kind: 'worktree', path: 'new.ts', status: 'M', original: 'before', modified: 'after', binary: false }),
    }
    const controller = createController(api)
    const oldRequest = controller.openDiff('workspace-1', 'old.ts', false)
    await controller.openDiff('workspace-1', 'new.ts', false)
    expect(activeTab(controller)).toMatchObject({ kind: 'diff', path: 'new.ts', loading: false })
    resolveFirst?.({ kind: 'worktree', path: 'old.ts', status: 'M', original: 'old', modified: 'older', binary: false })
    await oldRequest
    expect(activeTab(controller)?.path).toBe('new.ts')
    expect(controller.store.getSnapshot().tabs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'diff', path: 'old.ts', loading: false }),
      expect.objectContaining({ kind: 'diff', path: 'new.ts', loading: false }),
    ]))

    await controller.openDiff('workspace-1', 'new.ts', false)
    expect(api.gitDiff).toHaveBeenCalledTimes(2)
    expect(controller.store.getSnapshot().tabs).toHaveLength(2)
  })

  it('closes stale Diff tabs without discarding file drafts', async () => {
    const api = {
      readFile: vi.fn(() => Promise.resolve(file('kept.ts', 'base', '1'))),
      gitDiff: vi.fn(() => Promise.resolve({
        kind: 'worktree', path: 'changed.ts', status: 'M', original: 'old', modified: 'new', binary: false,
      })),
    }
    const controller = createController(api)
    await controller.openFile('workspace-1', 'kept.ts')
    controller.setDraft('draft')
    await controller.openDiff('workspace-1', 'changed.ts', false)
    controller.closeDiffTabs()
    expect(controller.store.getSnapshot().tabs).toEqual([
      expect.objectContaining({ kind: 'file', path: 'kept.ts', draft: 'draft', dirty: true }),
    ])
    expect(activeTab(controller)?.path).toBe('kept.ts')
  })

  it('stores the preferred Diff layout in the current Workspace state', () => {
    const logger = { info: vi.fn(), warn: vi.fn() }
    const controller = new WorkbenchController({} as never, logger)
    controller.setWorkspace('workspace-1')
    controller.setDiffViewMode('unified')
    expect(controller.store.getSnapshot().diffViewMode).toBe('unified')
    expect(logger.info).toHaveBeenCalledWith('workbench-layout: Diff view mode changed to unified')
  })

  it('binds Git presentation to each Workspace and exposes one-shot rail actions', () => {
    const logger = { info: vi.fn(), warn: vi.fn() }
    const controller = new WorkbenchController({} as never, logger)
    controller.setWorkspace('workspace-1')
    controller.setGitView('graph')
    controller.setGitFileLayout('graph', 'tree')
    const requestId = controller.requestSidebarAction('files.newFile')

    expect(controller.store.getSnapshot()).toMatchObject({
      gitView: 'graph',
      gitGraphFileLayout: 'tree',
      sidebarAction: { id: requestId, action: 'files.newFile', workspaceId: 'workspace-1' },
    })
    controller.consumeSidebarAction(requestId!)
    expect(controller.store.getSnapshot().sidebarAction).toBeUndefined()

    controller.setWorkspace('workspace-2')
    expect(controller.store.getSnapshot()).toMatchObject({ gitView: 'changes', gitGraphFileLayout: 'list' })
    controller.setWorkspace('workspace-1')
    expect(controller.store.getSnapshot()).toMatchObject({ gitView: 'graph', gitGraphFileLayout: 'tree' })
    expect(controller.store.getSnapshot().sidebarAction).toBeUndefined()
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('queued collapsed sidebar action files.newFile'))
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('consumed collapsed sidebar action files.newFile'))
  })

  it('queues a reveal action carrying the tab path for the file tree', () => {
    const controller = new WorkbenchController({} as never, { info: vi.fn(), warn: vi.fn() })
    controller.setWorkspace('workspace-1')
    const requestId = controller.requestSidebarAction('files.reveal', 'workspace-1', 'src/a.ts')

    expect(controller.store.getSnapshot().sidebarAction).toMatchObject({
      id: requestId,
      action: 'files.reveal',
      workspaceId: 'workspace-1',
      path: 'src/a.ts',
    })
  })

  it('splits the editor on a named tab and focuses the split-off pane', async () => {
    const api = {
      readFile: vi.fn()
        .mockResolvedValueOnce(file('first.ts', 'one', '1'))
        .mockResolvedValueOnce(file('second.ts', 'two', '2')),
    }
    const controller = createController(api)
    await controller.openFile('workspace-1', 'first.ts')
    await controller.openFile('workspace-1', 'second.ts')

    controller.splitWithTab('file:first.ts', 'horizontal')
    const state = controller.store.getSnapshot()
    expect(state.editorSplit).toBe(true)
    expect(state.editorSplitOrientation).toBe('horizontal')
    expect(state.panes.secondary.tabIds).toEqual(['file:first.ts'])
    expect(state.panes.primary.tabIds).toEqual(['file:second.ts'])
    // VS Code hands focus to the new pane's editor.
    expect(state.activeTabId).toBe('file:first.ts')
    expect(state.activePane).toBe('secondary')
  })

  it('keeps the split-off tab in its own pane when it already sits in the other pane', async () => {
    const api = {
      readFile: vi.fn()
        .mockResolvedValueOnce(file('first.ts', 'one', '1'))
        .mockResolvedValueOnce(file('second.ts', 'two', '2')),
    }
    const controller = createController(api)
    await controller.openFile('workspace-1', 'first.ts')
    await controller.openFile('workspace-1', 'second.ts')
    controller.toggleSplit('horizontal')

    controller.splitWithTab('file:first.ts', 'vertical')
    const state = controller.store.getSnapshot()
    expect(state.editorSplit).toBe(true)
    expect(state.editorSplitOrientation).toBe('vertical')
    expect(state.panes.secondary.tabIds).toEqual(['file:first.ts'])
    expect(state.panes.primary.tabIds).toEqual(['file:second.ts'])
  })

  it('keeps Git file decorations Workspace-scoped and coalesces status refreshes', async () => {
    let finishStatus: ((value: {
      available: boolean
      files: Array<{ path: string; index: string; worktree: string }>
    }) => void) | undefined
    const api = {
      gitStatus: vi.fn(() => new Promise(resolve => { finishStatus = resolve })),
    }
    const controller = createController(api)
    controller.setWorkspace('workspace-1')
    const first = controller.refreshGitDecorations()
    const second = controller.refreshGitDecorations()
    expect(first).toBe(second)
    expect(api.gitStatus).toHaveBeenCalledOnce()
    finishStatus?.({
      available: true,
      files: [{ path: 'src/new.ts', index: 'A', worktree: ' ' }],
    })
    await first
    expect(controller.store.getSnapshot().gitDecorations).toEqual({
      src: 'added',
      'src/new.ts': 'added',
    })

    controller.setWorkspace('workspace-2')
    expect(controller.store.getSnapshot().gitDecorations).toEqual({})
    controller.setWorkspace('workspace-1')
    expect(controller.store.getSnapshot().gitDecorations).toEqual({
      src: 'added',
      'src/new.ts': 'added',
    })
  })

  it('does not let an older background Git status overwrite a newer operation result', async () => {
    let finishStatus: ((value: {
      available: boolean
      files: Array<{ path: string; index: string; worktree: string }>
    }) => void) | undefined
    const api = {
      gitStatus: vi.fn(() => new Promise(resolve => { finishStatus = resolve })),
    }
    const controller = createController(api)
    controller.setWorkspace('workspace-1')
    const refresh = controller.refreshGitDecorations()
    controller.acceptGitStatus('workspace-1', {
      available: true,
      files: [{ path: 'new.ts', index: 'A', worktree: ' ' }],
    })
    finishStatus?.({
      available: true,
      files: [{ path: 'old.ts', index: ' ', worktree: 'M' }],
    })
    await refresh

    expect(controller.store.getSnapshot().gitDecorations).toEqual({ 'new.ts': 'added' })
  })

  it('caches editor Git baselines and reloads them when HEAD changes', async () => {
    const api = {
      readFile: vi.fn(() => Promise.resolve(file('src/a.ts', 'working', 'v1'))),
      gitEditorBaseline: vi.fn()
        .mockResolvedValueOnce({ path: 'src/a.ts', available: true, original: 'head one', binary: false, revision: '1'.repeat(40) })
        .mockResolvedValueOnce({ path: 'src/a.ts', available: true, original: 'head two', binary: false, revision: '2'.repeat(40) }),
    }
    const controller = createController(api)
    await controller.openFile('workspace-1', 'src/a.ts')
    controller.acceptGitStatus('workspace-1', {
      available: true,
      head: '1'.repeat(40),
      files: [{ path: 'src/a.ts', index: ' ', worktree: 'M' }],
    })

    await controller.ensureGitBaseline()
    await controller.ensureGitBaseline()
    expect(api.gitEditorBaseline).toHaveBeenCalledTimes(1)
    expect(activeTab(controller)).toMatchObject({
      gitBaseline: { available: true, original: 'head one', revision: '1'.repeat(40) },
      gitBaselineLoading: false,
    })

    controller.acceptGitStatus('workspace-1', {
      available: true,
      head: '2'.repeat(40),
      files: [{ path: 'src/a.ts', index: ' ', worktree: 'M' }],
    })
    await controller.ensureGitBaseline()
    expect(api.gitEditorBaseline).toHaveBeenCalledTimes(2)
    expect(activeTab(controller)).toMatchObject({ gitBaseline: { original: 'head two' } })
  })

  it('does not apply a stale editor baseline after HEAD changes', async () => {
    let finishOld: ((value: {
      path: string
      available: boolean
      original: string
      binary: boolean
      revision: string
    }) => void) | undefined
    const oldBaseline = new Promise(resolve => { finishOld = resolve })
    const api = {
      readFile: vi.fn(() => Promise.resolve(file('src/a.ts', 'working', 'v1'))),
      gitEditorBaseline: vi.fn()
        .mockReturnValueOnce(oldBaseline)
        .mockResolvedValueOnce({ path: 'src/a.ts', available: true, original: 'new head', binary: false, revision: '2'.repeat(40) }),
    }
    const controller = createController(api)
    await controller.openFile('workspace-1', 'src/a.ts')
    controller.acceptGitStatus('workspace-1', { available: true, head: '1'.repeat(40), files: [] })
    const oldRequest = controller.ensureGitBaseline()

    controller.acceptGitStatus('workspace-1', { available: true, head: '2'.repeat(40), files: [] })
    await controller.ensureGitBaseline()
    finishOld?.({ path: 'src/a.ts', available: true, original: 'old head', binary: false, revision: '1'.repeat(40) })
    await oldRequest

    expect(activeTab(controller)).toMatchObject({ gitBaseline: { original: 'new head', revision: '2'.repeat(40) } })
  })

  it('clears every file tab and Diff after Git changes the Workspace', async () => {
    const logger = { info: vi.fn(), warn: vi.fn() }
    const api = { readFile: vi.fn(() => Promise.resolve(file('src/a.ts', 'before', '1'))) }
    const controller = new WorkbenchController(api as never, logger)
    await controller.openFile('workspace-1', 'src/a.ts')
    controller.resetWorkspaceView()
    expect(controller.store.getSnapshot()).toMatchObject({ tabs: [] })
    expect(controller.store.getSnapshot().activeTabId).toBeUndefined()
    expect(logger.info).toHaveBeenCalledWith('workbench-layout: cleared editor tabs after Git changed workspace "workspace-1"')
  })

  it('invalidates an inactive Workspace without clearing active Workspace tabs', async () => {
    const api = { readFile: vi.fn((_workspaceId: string, path: string) => Promise.resolve(file(path, path, '1'))) }
    const controller = createController(api)
    await controller.openFile('workspace-a', 'workspace-a.ts')
    await controller.openFile('workspace-b', 'workspace-b.ts')
    controller.resetWorkspaceView('workspace-a')
    expect(activeTab(controller)?.path).toBe('workspace-b.ts')
    controller.setWorkspace('workspace-a')
    expect(controller.store.getSnapshot()).toMatchObject({ workspaceId: 'workspace-a', tabs: [] })
  })

  it('releases and restores the sidebar shadow when switching Sessions and Files', () => {
    const setActive = vi.fn()
    const controller = createController({})
    controller.attachSidebarShadow(setActive)
    controller.setSidebarMode('sessions')
    controller.setSidebarMode('files')
    expect(setActive.mock.calls).toEqual([[true], [false], [true]])
  })

  it('collapses the middle editor explicitly and reveals it for files, Diffs, terminals, and tab selections', async () => {
    const layout = { openRightbar: vi.fn(), closeRightbar: vi.fn() }
    const api = {
      readFile: vi.fn(() => Promise.resolve(file('src/a.ts', 'content', '1'))),
      gitDiff: vi.fn(() => Promise.resolve({
        kind: 'worktree', path: 'src/a.ts', status: 'M', original: 'before', modified: 'after', binary: false,
      })),
    }
    const logger = { info: vi.fn(), warn: vi.fn() }
    const controller = new WorkbenchController(api as never, logger, layout)
    controller.setWorkspace('workspace-1')
    controller.synchronizeEditorLayout()
    expect(layout.openRightbar).toHaveBeenCalledOnce()

    controller.toggleEditor()
    expect(controller.store.getSnapshot().editorExpanded).toBe(false)
    expect(layout.closeRightbar).toHaveBeenCalledOnce()
    await controller.openFile('workspace-1', 'src/a.ts')
    expect(controller.store.getSnapshot().editorExpanded).toBe(true)

    controller.toggleEditor()
    await controller.openDiff('workspace-1', 'src/a.ts', false)
    expect(controller.store.getSnapshot().editorExpanded).toBe(true)

    controller.toggleEditor()
    const terminalId = controller.openTerminal('workspace-1')
    expect(controller.store.getSnapshot().editorExpanded).toBe(true)

    controller.toggleEditor()
    controller.selectTab(terminalId!)
    expect(controller.store.getSnapshot().editorExpanded).toBe(true)
    expect(layout.openRightbar).toHaveBeenCalledTimes(5)
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('collapsed middle editor from sidebar control'))
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('expanded middle editor from content selection'))
  })

  it('opens a Workspace-bound terminal and mirrors the official view phase onto its tab', () => {
    const logger = { info: vi.fn(), warn: vi.fn() }
    const view = { id: 'term-1' }
    const terminals = { view: vi.fn(() => view), close: vi.fn() } as unknown as ClientTerminals
    const controller = new WorkbenchController({} as never, logger, undefined, terminals)
    controller.setWorkspace('workspace-1')
    controller.setSidebarMode('terminal')
    const terminal = activeTab(controller)
    expect(terminal?.kind).toBe('terminal')
    const tab = terminal as WorkbenchTerminalTab
    expect(tab).toMatchObject({ kind: 'terminal', sequence: 1, status: 'connecting' })
    expect(tab.contentId).toBeTruthy()

    // The official model is only reachable once a Session is bound.
    expect(controller.terminalView(tab)).toBeUndefined()
    controller.setSession('session-1')
    expect(controller.terminalView(tab)).toBe(view)
    // The content identity doubles as the occurrence key, so a reopened tab that
    // takes a new identity cannot be handed back its dead cached view.
    expect(terminals.view).toHaveBeenCalledWith('session-1', tab.contentId, tab.contentId, undefined, undefined)

    controller.setTerminalStatus(tab.id, 'running')
    expect(activeTab(controller)).toMatchObject({ kind: 'terminal', status: 'running' })
    controller.setTerminalStatus(tab.id, 'exited')
    expect(activeTab(controller)).toMatchObject({ kind: 'terminal', status: 'exited' })

    controller.closeTab(tab.id)
    expect(terminals.close).toHaveBeenCalledWith('session-1', tab.contentId, tab.contentId)
  })

  it('opens a terminal on a Host-discovered shell and mirrors its resolved name', async () => {
    const view = { id: 'term-1' }
    const terminals = {
      view: vi.fn(() => view),
      close: vi.fn(),
      selectShell: vi.fn(),
      launchShells: vi.fn(() => Promise.resolve({
        shells: [
          { path: 'C:\\Windows\\System32\\cmd.exe', name: 'cmd', args: [] },
          { path: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', name: 'pwsh', args: ['-NoLogo'] },
        ],
        selectedShell: 'C:\\Windows\\System32\\cmd.exe',
      })),
    } as unknown as ClientTerminals
    const controller = new WorkbenchController({} as never, { info: vi.fn(), warn: vi.fn() }, undefined, terminals)
    controller.setWorkspace('workspace-1')
    controller.setSession('session-1')

    const discovery = await controller.listShells(new AbortController().signal)
    expect(discovery.shells).toEqual([
      { path: 'C:\\Windows\\System32\\cmd.exe', name: 'cmd' },
      { path: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', name: 'pwsh' },
    ])
    expect(discovery.selectedShell).toBe('C:\\Windows\\System32\\cmd.exe')

    const pwsh = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
    controller.selectShell(pwsh)
    expect(terminals.selectShell).toHaveBeenCalledWith(pwsh)

    const terminalId = controller.openTerminal('workspace-1', pwsh)!
    const tab = controller.store.getSnapshot().tabs
      .find(candidate => candidate.id === terminalId) as WorkbenchTerminalTab
    expect(tab.shellPath).toBe(pwsh)
    // The picked path reaches the official model as its explicit shell choice.
    expect(controller.terminalView(tab)).toBe(view)
    expect(terminals.view).toHaveBeenCalledWith('session-1', tab.contentId, tab.contentId, undefined, pwsh)

    controller.setTerminalShell(terminalId, 'pwsh')
    expect(controller.store.getSnapshot().tabs
      .find(candidate => candidate.id === terminalId)).toMatchObject({ shellName: 'pwsh' })
    controller.setTerminalShell(terminalId, undefined)
    expect(controller.store.getSnapshot().tabs
      .find(candidate => candidate.id === terminalId)).not.toHaveProperty('shellName')
  })

  it('reports no shells without a Session instead of probing a bare Workspace', async () => {
    const terminals = {
      view: vi.fn(), close: vi.fn(), selectShell: vi.fn(), launchShells: vi.fn(),
    } as unknown as ClientTerminals
    const controller = new WorkbenchController({} as never, { info: vi.fn(), warn: vi.fn() }, undefined, terminals)
    controller.setWorkspace('workspace-1')

    await expect(controller.listShells(new AbortController().signal))
      .resolves.toEqual({ shells: [], selectedShell: undefined })
    expect(terminals.launchShells).not.toHaveBeenCalled()

    const terminalId = controller.openTerminal('workspace-1')!
    const tab = controller.store.getSnapshot().tabs
      .find(candidate => candidate.id === terminalId) as WorkbenchTerminalTab
    // No Session means no official model yet, and the tab carries no shell intent.
    expect(controller.terminalView(tab)).toBeUndefined()
    expect(tab).not.toHaveProperty('shellPath')
  })

  it('keeps a Workspace terminal tabs and their processes across a Workspace switch', async () => {
    const api = { readFile: vi.fn(() => Promise.resolve(file('kept.ts', 'kept', '1'))) }
    const terminals = { view: vi.fn(), close: vi.fn() } as unknown as ClientTerminals
    const controller = new WorkbenchController(api as never, { info: vi.fn(), warn: vi.fn() }, undefined, terminals)
    controller.setWorkspace('workspace-1')
    controller.setSession('session-1')
    await controller.openFile('workspace-1', 'kept.ts')
    const first = controller.openTerminal()!
    const second = controller.openTerminal()!
    const firstContentId = (controller.store.getSnapshot().tabs
      .find(candidate => candidate.id === first) as WorkbenchTerminalTab).contentId
    expect(controller.store.getSnapshot().tabs.filter(tab => tab.kind === 'terminal')).toHaveLength(2)
    expect(first).not.toBe(second)

    // Switching Workspaces must not close anything: the Host processes live in the
    // browser's terminal model, so dropping their tabs would orphan them and hold
    // their Session's terminal quota open with no way back.
    controller.setWorkspace('workspace-2')
    expect(terminals.close).not.toHaveBeenCalled()
    expect(controller.store.getSnapshot().tabs.filter(tab => tab.kind === 'terminal')).toHaveLength(0)

    controller.setWorkspace('workspace-1')
    const restored = controller.store.getSnapshot().tabs.filter(
      (tab): tab is WorkbenchTerminalTab => tab.kind === 'terminal',
    )
    expect(restored.map(tab => tab.id)).toEqual([first, second])
    // The same content identity comes back, so the official model reattaches to the
    // process that is still running rather than allocating a blank replacement.
    expect(restored[0]!.contentId).toBe(firstContentId)
  })

  /**
   * The contract behind "switching sessions must not disconnect a terminal".
   *
   * The Host resolves any Session's Agent on demand, so a tab keeps being
   * addressed through the Session that allocated its process. Asking for the
   * Session on screen instead is what used to orphan the process: the owner's
   * binding is not found there, and the model allocates a blank replacement.
   */
  it('keeps driving a kept tab through the Session that owns its process', () => {
    const view = { id: 'term-1' }
    const terminals = { view: vi.fn(() => view), close: vi.fn() } as unknown as ClientTerminals
    const controller = new WorkbenchController({} as never, { info: vi.fn(), warn: vi.fn() }, undefined, terminals)
    controller.setWorkspace('workspace-1')
    controller.setSession('session-1')
    const terminalId = controller.openTerminal()!
    const owned = () => controller.store.getSnapshot().tabs
      .find(candidate => candidate.id === terminalId) as WorkbenchTerminalTab
    expect(controller.terminalBinding(owned())).toBe('ready')
    expect(controller.terminalView(owned())).toBe(view)
    expect(terminals.view).toHaveBeenCalledTimes(1)
    expect(terminals.view).toHaveBeenCalledWith('session-1', expect.anything(), expect.anything(), undefined, undefined)

    // The Workspace moves to another Session: the tab stays live on its owner.
    controller.setSession('session-2')
    expect(controller.terminalBinding(owned())).toBe('ready')
    expect(controller.terminalView(owned())).toBe(view)
    // The same owning Session is addressed, so the official cache hands back the
    // very same model: same stream, same screen, no reallocation.
    expect(terminals.view).toHaveBeenLastCalledWith('session-1', expect.anything(), expect.anything(), undefined, undefined)
    expect(terminals.view.mock.calls.every(call => call[0] === 'session-1')).toBe(true)
  })

  /**
   * A tab opened before any Session existed starts allocating in whichever
   * Session appears first. If the Workspace moves on while that allocation is
   * still in flight, the owner must be recorded as the Session the process was
   * actually asked for, not the one that happens to be on screen when the first
   * frame arrives — otherwise the tab would later be addressed in a Session that
   * never allocated anything for it.
   */
  it('records the Session a tab really allocated in when the switch lands mid-allocation', () => {
    const view = { id: 'term-1' }
    const terminals = { view: vi.fn(() => view), close: vi.fn() } as unknown as ClientTerminals
    const controller = new WorkbenchController({} as never, { info: vi.fn(), warn: vi.fn() }, undefined, terminals)
    controller.setWorkspace('workspace-1')
    // Opened with no Session bound, so the tab has no owner yet.
    const terminalId = controller.openTerminal()!
    const owned = () => controller.store.getSnapshot().tabs
      .find(candidate => candidate.id === terminalId) as WorkbenchTerminalTab
    expect(owned().ownerSessionId).toBeUndefined()

    controller.setSession('session-1')
    controller.terminalView(owned())
    controller.setSession('session-2')
    controller.recordTerminalOwner(terminalId)

    expect(owned().ownerSessionId).toBe('session-1')
    expect(terminals.view).toHaveBeenLastCalledWith('session-1', expect.anything(), expect.anything(), undefined, undefined)
  })

  it('adopts a Host title only when it is not the shell default, and never erases a name', () => {
    const terminals = { view: vi.fn(() => ({ id: 'term-1', rename: vi.fn() })), close: vi.fn() } as unknown as ClientTerminals
    const controller = new WorkbenchController({} as never, { info: vi.fn(), warn: vi.fn() }, undefined, terminals)
    controller.setWorkspace('workspace-1')
    controller.setSession('session-1')
    const terminalId = controller.openTerminal()!
    const owned = () => controller.store.getSnapshot().tabs
      .find(candidate => candidate.id === terminalId) as WorkbenchTerminalTab

    // The Host titles a fresh terminal after its shell: that is not a user name.
    controller.setTerminalTitle(terminalId, 'pwsh', 'pwsh')
    expect(owned().title).toBeUndefined()
    controller.setTerminalTitle(terminalId, 'build server', 'pwsh')
    expect(owned().title).toBe('build server')
    // A later default-named frame must not undo the name the user chose.
    controller.setTerminalTitle(terminalId, 'pwsh', 'pwsh')
    expect(owned().title).toBe('build server')
  })

  it('names a terminal locally and pushes the same name to the Host', () => {
    const rename = vi.fn(() => Promise.resolve())
    const terminals = { view: vi.fn(() => ({ id: 'term-1', rename })), close: vi.fn() } as unknown as ClientTerminals
    const controller = new WorkbenchController({} as never, { info: vi.fn(), warn: vi.fn() }, undefined, terminals)
    controller.setWorkspace('workspace-1')
    controller.setSession('session-1')
    const terminalId = controller.openTerminal()!

    controller.renameTerminal(terminalId, '  测试数据库  ')

    const tab = controller.store.getSnapshot().tabs
      .find(candidate => candidate.id === terminalId) as WorkbenchTerminalTab
    expect(tab.title).toBe('测试数据库')
    expect(rename).toHaveBeenCalledWith('测试数据库')
    // A blank name is not a name: the row keeps what it had and nothing is sent.
    controller.renameTerminal(terminalId, '   ')
    expect(tab.title).toBe('测试数据库')
    expect(rename).toHaveBeenCalledTimes(1)
  })

  it('mirrors the Host process facts the status line reports', () => {
    const terminals = { view: vi.fn(() => ({ id: 'term-1' })), close: vi.fn() } as unknown as ClientTerminals
    const controller = new WorkbenchController({} as never, { info: vi.fn(), warn: vi.fn() }, undefined, terminals)
    controller.setWorkspace('workspace-1')
    controller.setSession('session-1')
    const terminalId = controller.openTerminal()!
    const owned = () => controller.store.getSnapshot().tabs
      .find(candidate => candidate.id === terminalId) as WorkbenchTerminalTab

    controller.setTerminalRuntime(terminalId, {
      id: 'term-1', title: 'pwsh', shell: { name: 'pwsh', path: '/pwsh', args: [] },
      cwd: 'F:\\repo', cols: 120, rows: 40, state: 'exited', exitCode: 3,
    } as never)
    expect(owned().runtime).toEqual({ cwd: 'F:\\repo', cols: 120, rows: 40, exitCode: 3 })
    // No info means no line, rather than a row of zeros left over from the last run.
    controller.setTerminalRuntime(terminalId, undefined)
    expect(owned().runtime).toBeUndefined()
  })

  /**
   * `reopenTerminalHere` is no longer the answer to a Session switch — a switched-
   * away tab stays live on its owner — but it is still the only recovery for a tab
   * whose Host process has disappeared, which the official model refuses to
   * re-allocate under the identity it still has bound.
   */
  it('reopens a lost tab with a new identity and closes the old process in its owner Session', () => {
    const terminals = { view: vi.fn(() => ({ id: 'term-1' })), close: vi.fn() } as unknown as ClientTerminals
    const controller = new WorkbenchController({} as never, { info: vi.fn(), warn: vi.fn() }, undefined, terminals)
    controller.setWorkspace('workspace-1')
    controller.setSession('session-1')
    const terminalId = controller.openTerminal('workspace-1', 'C:\\pwsh.exe')!
    const before = controller.store.getSnapshot().tabs
      .find(candidate => candidate.id === terminalId) as WorkbenchTerminalTab

    controller.setSession('session-2')
    expect(controller.reopenTerminalHere(terminalId)).toBe(true)
    const after = controller.store.getSnapshot().tabs
      .find(candidate => candidate.id === terminalId) as WorkbenchTerminalTab

    // The dead process is released through the Session that still owns it; closing
    // it under the current Session would resolve no identity and free nothing.
    expect(terminals.close).toHaveBeenCalledWith('session-1', before.contentId, before.contentId)
    // A fresh identity is required: the saved binding for the old one is what made
    // the model refuse to allocate a replacement in the first place.
    expect(after.contentId).not.toBe(before.contentId)
    expect(after.ownerSessionId).toBe('session-2')
    expect(after.status).toBe('connecting')
    // The tab keeps its position and its chosen shell across the recovery.
    expect(after.shellPath).toBe('C:\\pwsh.exe')
    expect(controller.terminalBinding(after)).toBe('ready')
  })

  it('still mints unique identities when crypto.randomUUID is unavailable', () => {
    // DSH Web is reachable over plain HTTP on a LAN address, where browsers
    // expose no `crypto.randomUUID`; deriving an identity must not throw there.
    const real = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
    Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true })
    try {
      const terminals = { view: vi.fn(() => ({ id: 'term-1' })), close: vi.fn() } as unknown as ClientTerminals
      const open = () => {
        const controller = new WorkbenchController({} as never, { info: vi.fn(), warn: vi.fn() }, undefined, terminals)
        controller.setWorkspace('workspace-1')
        controller.setSession('session-1')
        controller.openTerminal('workspace-1')
        return (controller.store.getSnapshot().tabs
          .find(candidate => candidate.kind === 'terminal') as WorkbenchTerminalTab).contentId
      }
      const first = open()
      expect(first).not.toBe(open())
      expect(first.startsWith('wbterm:')).toBe(true)
    } finally {
      if (real === undefined) delete globalThis.crypto
      else Object.defineProperty(globalThis, 'crypto', real)
    }
  })

  it('gives each page a fresh content identity so a reload cannot collide', () => {
    const terminals = { view: vi.fn(() => ({ id: 'term-1' })), close: vi.fn() } as unknown as ClientTerminals
    const open = () => {
      // A new controller is a new page: its tab-id counter restarts at 1.
      const controller = new WorkbenchController({} as never, { info: vi.fn(), warn: vi.fn() }, undefined, terminals)
      controller.setWorkspace('workspace-1')
      controller.setSession('session-1')
      controller.openTerminal('workspace-1')
      return (controller.store.getSnapshot().tabs
        .find(candidate => candidate.kind === 'terminal') as WorkbenchTerminalTab).contentId
    }

    // Content identities persist in localStorage across a reload while tab ids do
    // not. Deriving one from the other made a reloaded page's first terminal
    // inherit the previous page's binding, resolve to a dead Host terminal, and
    // fail `missingTerminal` on every retry.
    expect(open()).not.toBe(open())
  })

  it('preserves live terminal tabs when Git invalidates file and Diff tabs', async () => {
    const api = { readFile: vi.fn(() => Promise.resolve(file('src/a.ts', 'before', '1'))) }
    const controller = createController(api)
    await controller.openFile('workspace-1', 'src/a.ts')
    const terminalId = controller.openTerminal()
    controller.resetWorkspaceView()
    expect(controller.store.getSnapshot().tabs).toEqual([
      expect.objectContaining({ id: terminalId, kind: 'terminal' }),
    ])
    expect(controller.store.getSnapshot().activeTabId).toBe(terminalId)
  })

  it('closes only file and Diff tabs backed by a renamed or deleted entry', async () => {
    const api = {
      readFile: vi.fn((_workspaceId: string, path: string) => Promise.resolve(file(path, path, '1'))),
      gitDiff: vi.fn((_workspaceId: string, path: string) => Promise.resolve({
        kind: 'worktree', path, status: 'M', original: 'old', modified: 'new', binary: false,
      })),
    }
    const controller = createController(api)
    await controller.openFile('workspace-1', 'src/a.ts')
    await controller.openFile('workspace-1', 'src/nested/b.ts')
    await controller.openFile('workspace-1', 'kept.ts')
    await controller.openDiff('workspace-1', 'src/a.ts', false)
    const terminalId = controller.openTerminal()

    controller.closeWorkspaceEntries('workspace-1', 'src')

    expect(controller.store.getSnapshot().tabs).toEqual([
      expect.objectContaining({ kind: 'file', path: 'kept.ts' }),
      expect.objectContaining({ kind: 'terminal', id: terminalId }),
    ])
    expect(controller.store.getSnapshot().activeTabId).toBe(terminalId)
  })
})

function createController(api: object) {
  return new WorkbenchController(api as never, { info: vi.fn(), warn: vi.fn() })
}

function activeTab(controller: ReturnType<typeof createController>) {
  const state = controller.store.getSnapshot()
  return state.tabs.find(tab => tab.id === state.activeTabId)
}

function fileTab(controller: ReturnType<typeof createController>, path: string) {
  return controller.store.getSnapshot().tabs.find(tab => tab.kind === 'file' && tab.path === path)
}

function file(path: string, content: string, version: string, markdown = false) {
  return { path, content, version, size: content.length, markdown }
}
