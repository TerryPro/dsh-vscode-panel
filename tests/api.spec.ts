import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchApi } from '../src/client/model/api.ts'

afterEach(() => { vi.unstubAllGlobals() })

describe('Workbench browser API', () => {
  it('addresses file and Git requests by official Workspace id', async () => {
    const fetch = vi.fn((_input: string, _init?: RequestInit) => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ path: '', entries: [], truncated: false }),
    }))
    vi.stubGlobal('fetch', fetch)
    const api = new WorkbenchApi()

    await api.listDirectory('workspace-1', 'src')
    await api.refreshFiles('workspace-1', [{ path: 'src/a.ts', version: 'v1' }])
    await api.createFile('workspace-1', 'src/new.ts')
    await api.createDirectory('workspace-1', 'docs')
    await api.renameEntry('workspace-1', 'docs', 'notes')
    await api.deleteEntry('workspace-1', 'notes')
    await api.absolutePath('workspace-1', 'README.md')
    await api.relativePath('workspace-1', 'README.md')
    await api.gitStatus('workspace-1')
    await api.gitEditorBaseline('workspace-1', 'src/a.ts')
    await api.gitGraph('workspace-1')

    const fileRequest = fetch.mock.calls[0]?.[1] as RequestInit
    const refreshRequest = fetch.mock.calls[1]?.[1] as RequestInit
    const createFileRequest = fetch.mock.calls[2]?.[1] as RequestInit
    const createDirectoryRequest = fetch.mock.calls[3]?.[1] as RequestInit
    const renameRequest = fetch.mock.calls[4]?.[1] as RequestInit
    const deleteRequest = fetch.mock.calls[5]?.[1] as RequestInit
    const absoluteRequest = fetch.mock.calls[6]?.[1] as RequestInit
    const relativeRequest = fetch.mock.calls[7]?.[1] as RequestInit
    const gitStatusRequest = fetch.mock.calls[8]?.[1] as RequestInit
    const gitBaselineRequest = fetch.mock.calls[9]?.[1] as RequestInit
    const gitGraphRequest = fetch.mock.calls[10]?.[1] as RequestInit
    expect(fetch.mock.calls[1]?.[0]).toBe('/dsh-workbench-layout/files/refresh')
    expect(fetch.mock.calls[2]?.[0]).toBe('/dsh-workbench-layout/file/create')
    expect(fetch.mock.calls[3]?.[0]).toBe('/dsh-workbench-layout/directory/create')
    expect(fetch.mock.calls[4]?.[0]).toBe('/dsh-workbench-layout/entry/rename')
    expect(fetch.mock.calls[5]?.[0]).toBe('/dsh-workbench-layout/entry/delete')
    expect(fetch.mock.calls[6]?.[0]).toBe('/dsh-workbench-layout/path/absolute')
    expect(fetch.mock.calls[7]?.[0]).toBe('/dsh-workbench-layout/path/relative')
    expect(fetch.mock.calls[9]?.[0]).toBe('/dsh-workbench-layout/git/editor-baseline')
    expect(fetch.mock.calls[10]?.[0]).toBe('/dsh-workbench-layout/git/graph')
    expect(JSON.parse(String(fileRequest.body))).toEqual({ workspaceId: 'workspace-1', path: 'src' })
    expect(JSON.parse(String(refreshRequest.body))).toEqual({
      workspaceId: 'workspace-1', files: [{ path: 'src/a.ts', version: 'v1' }],
    })
    expect(JSON.parse(String(createFileRequest.body))).toEqual({ workspaceId: 'workspace-1', path: 'src/new.ts' })
    expect(JSON.parse(String(createDirectoryRequest.body))).toEqual({ workspaceId: 'workspace-1', path: 'docs' })
    expect(JSON.parse(String(renameRequest.body))).toEqual({ workspaceId: 'workspace-1', path: 'docs', name: 'notes' })
    expect(JSON.parse(String(deleteRequest.body))).toEqual({ workspaceId: 'workspace-1', path: 'notes' })
    expect(JSON.parse(String(absoluteRequest.body))).toEqual({ workspaceId: 'workspace-1', path: 'README.md' })
    expect(JSON.parse(String(relativeRequest.body))).toEqual({ workspaceId: 'workspace-1', path: 'README.md' })
    expect(JSON.parse(String(gitStatusRequest.body))).toEqual({ workspaceId: 'workspace-1' })
    expect(JSON.parse(String(gitBaselineRequest.body))).toEqual({ workspaceId: 'workspace-1', path: 'src/a.ts' })
    expect(JSON.parse(String(gitGraphRequest.body))).toEqual({ workspaceId: 'workspace-1', offset: 0 })
    expect(`${String(fileRequest.body)}${String(gitGraphRequest.body)}`).not.toContain('sessionId')
  })

  it('addresses every kernel request by its own sub-path, never the bare prefix', async () => {
    // The Host dispatches the kernel API by exact sub-path and answers the bare prefix
    // with ENDPOINT_NOT_FOUND. `discover` once called `postKernel('')`, so the picker
    // was permanently empty and auto-connect never fired — a bug invisible above the
    // facade, because every caller mocks this class. Asserting the URLs here is the
    // only place that can catch it.
    const fetch = vi.fn((_input: string, _init?: RequestInit) => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }))
    vi.stubGlobal('fetch', fetch)
    const api = new WorkbenchApi()

    await api.kernelDiscover('ws-1')
    await api.kernelStart('ws-1', 'nb.ipynb', 'python3')
    await api.kernelStatus('k1', 't1', 'ws-1')
    await api.kernelExecute({ kernelId: 'k1', token: 't1', workspaceId: 'ws-1', code: 'x', cellId: 'c1' })
    await api.kernelInterrupt('k1', 't1', 'ws-1')
    await api.kernelInput('k1', 't1', 'ws-1', 'answer')
    await api.kernelComplete({ kernelId: 'k1', token: 't1', workspaceId: 'ws-1', code: 'pr', cursorPos: 2 })
    await api.kernelInspect({ kernelId: 'k1', token: 't1', workspaceId: 'ws-1', code: 'print', cursorPos: 5 })
    await api.kernelIsComplete({ kernelId: 'k1', token: 't1', workspaceId: 'ws-1', code: 'x = 1' })
    await api.kernelRestart({ kernelId: 'k1', token: 't1', workspaceId: 'ws-1', path: 'nb.ipynb' })
    await api.kernelShutdown('k1', 't1', 'ws-1')

    expect(fetch.mock.calls.map(call => call[0])).toEqual([
      '/dsh-workbench-layout/kernel/discover',
      '/dsh-workbench-layout/kernel/start',
      '/dsh-workbench-layout/kernel/status',
      '/dsh-workbench-layout/kernel/execute',
      '/dsh-workbench-layout/kernel/interrupt',
      '/dsh-workbench-layout/kernel/input',
      '/dsh-workbench-layout/kernel/complete',
      '/dsh-workbench-layout/kernel/inspect',
      '/dsh-workbench-layout/kernel/is-complete',
      '/dsh-workbench-layout/kernel/restart',
      '/dsh-workbench-layout/kernel/shutdown',
    ])
    // None may collapse onto the bare prefix that the Host refuses.
    for (const call of fetch.mock.calls) {
      expect(call[0]).not.toBe('/dsh-workbench-layout/kernel')
    }
    expect(JSON.parse(String((fetch.mock.calls[0]![1] as RequestInit).body))).toEqual({ workspaceId: 'ws-1' })
  })
})
