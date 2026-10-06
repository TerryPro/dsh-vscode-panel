import { describe, expect, it } from 'vitest'
import {
  diffTabId,
  emptyDiffTab,
  emptyFileTab,
  fileTabId,
  isSameOrDescendantPath,
  messageOf,
  tabIdentity,
  tabRequestKey,
} from '../src/client/model/tab-model.ts'

describe('tab-model', () => {
  it('builds stable, collision-free tab ids', () => {
    expect(fileTabId('src/a.ts')).toBe('file:src/a.ts')
    expect(diffTabId('staged', 'a.ts')).toBe('diff:staged::a.ts')
    expect(diffTabId('commit', 'a.ts', 'deadbeef')).toBe('diff:commit:deadbeef:a.ts')
    expect(tabRequestKey(undefined, 'x')).toBe('\0x')
    expect(tabRequestKey('ws', 'x')).toBe('ws\0x')
  })

  it('identifies a tab for logging without leaking terminal internals', () => {
    expect(tabIdentity(emptyFileTab('a.ts'))).toBe('a.ts')
    expect(tabIdentity({ id: 'terminal:1', kind: 'terminal', sequence: 2, contentId: 'c', status: 'running' }))
      .toBe('terminal-2')
  })

  it('treats a path as its own ancestor only for exact or slash-bounded children', () => {
    expect(isSameOrDescendantPath('a', 'a')).toBe(true)
    expect(isSameOrDescendantPath('a/b', 'a')).toBe(true)
    expect(isSameOrDescendantPath('ab', 'a')).toBe(false)
  })

  it('normalizes unknown errors and seeds empty tabs', () => {
    expect(messageOf(new Error('boom'))).toBe('boom')
    expect(messageOf('plain')).toBe('plain')
    const file = emptyFileTab('a.ts')
    expect(file.id).toBe('file:a.ts')
    expect(file.kind).toBe('file')
    expect(file.dirty).toBe(false)
    expect(file.loading).toBe(true)
    const diff = emptyDiffTab({ id: 'd', path: 'a.ts', diffKind: 'worktree' })
    expect(diff.kind).toBe('diff')
    expect(diff.diff).toBeNull()
    expect(diff.loading).toBe(true)
  })
})
