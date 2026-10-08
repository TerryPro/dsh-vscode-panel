// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { editorCodeFontFamily, editorCodeFontSize, editorCodeLineHeight } from '../src/client/editor/editor-theme.ts'
import { JsonTree, type JsonTreeLabels } from '../src/client/json/JsonTree.tsx'
import { copyTextToClipboard } from '../src/client/core/clipboard.ts'
import { JSON_ARRAY_PAGE, JSON_LONG_STRING } from '../src/client/json/json-tree-view.ts'

vi.mock('../src/client/core/clipboard.ts', () => ({
  copyTextToClipboard: vi.fn(() => Promise.resolve()),
}))

// Replace the primitives' chevrons with identifiable marks for state assertions.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronDownOutlineRegular: () => <svg data-testid="chevron-down" />,
  IconChevronRightOutlineRegular: () => <svg data-testid="chevron-right" />,
}))

const labels: JsonTreeLabels = {
  tree: 'TREE',
  empty: 'EMPTY',
  invalid: 'INVALID',
  invalidValue: 'INVALID_VALUE',
  tooLarge: 'TOO_LARGE',
  truncated: count => `TRUNCATED_${count}`,
  nodes: count => `NODES_${count}`,
  search: 'SEARCH',
  noMatches: 'NO_MATCHES',
  matches: count => `MATCHES_${count}`,
  expandAll: 'EXPAND_ALL',
  collapseAll: 'COLLAPSE_ALL',
  depth: depth => `DEPTH_${depth}`,
  copyValue: 'COPY_VALUE',
  copyPath: 'COPY_PATH',
  copied: 'COPIED',
  copyFailed: 'COPY_FAILED',
  items: count => `ITEMS_${count}`,
  keys: count => `KEYS_${count}`,
  showMore: count => `SHOW_MORE_${count}`,
  expandString: 'EXPAND_STRING',
}

/** Mirrors the private key prefix; kept literal so a rename surfaces as a failure. */
const KEY_PREFIX = 'dsh-workbench:json-collapse:'

const SOURCE = '{\n  "name": "workbench",\n  "items": [1, 2],\n  "meta": { "deep": { "deeper": 1 } }\n}'

function renderTree(source = SOURCE, path = 'cfg.json') {
  return render(<JsonTree source={source} path={path} labels={labels} />)
}

function rows(view: ReturnType<typeof renderTree>) {
  return view.getAllByRole('treeitem')
}

function rowOf(view: ReturnType<typeof renderTree>, text: string): HTMLElement {
  const match = view.getByText(text)
  const row = match.closest('[role="treeitem"]')
  if (row === null) throw new Error(`no tree row for ${text}`)
  return row as HTMLElement
}

beforeEach(() => { localStorage.clear() })
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('JsonTree rendering', () => {
  it('renders one row per visible node and states the document size', () => {
    const view = renderTree()
    expect(rows(view)).toHaveLength(8)
    expect(view.getByText('NODES_8')).toBeTruthy()
    expect(view.getByRole('tree')).toBeTruthy()
    expect(rows(view)[0]?.getAttribute('aria-expanded')).toBe('true')
    expect(rows(view)[0]?.getAttribute('aria-level')).toBe('1')
  })

  it('quotes keys and values so they read as JSON', () => {
    const view = renderTree()
    expect(rowOf(view, '"name"').textContent).toContain('"workbench"')
    expect(rowOf(view, '"items"').textContent).toContain('[')
  })

  it('shows the empty state for an unreadable or blank document', () => {
    expect(renderTree('').getByText('EMPTY')).toBeTruthy()
  })

  it('flags a document with syntax problems', () => {
    const view = renderTree('{"a": tru, "b": 1}')
    expect(view.getByText('INVALID')).toBeTruthy()
    expect(view.getByText('tru')).toBeTruthy()
  })

  it('names an empty value the grammar could not read', () => {
    const view = renderTree('{"a": }')
    expect(rowOf(view, '"a"').textContent).toContain('INVALID_VALUE')
  })

  it('refuses to parse a document past the tree budget', () => {
    const view = renderTree(`{"text": "${'x'.repeat(2 * 1024 * 1024 + 8)}"}`)
    expect(view.getByText('TOO_LARGE')).toBeTruthy()
    expect(view.queryAllByRole('treeitem')).toHaveLength(0)
  })

  it('truncates a long value and expands it in place on click', () => {
    const long = 'y'.repeat(JSON_LONG_STRING + 60)
    const view = renderTree(`{"text": "${long}"}`)
    const row = rowOf(view, '"text"')
    expect(row.textContent).toContain('…')
    expect(row.textContent).not.toContain(long)
    fireEvent.click(row)
    expect(row.textContent).toContain(long)
  })
})

describe('JsonTree folding', () => {
  it('folds a branch on click, shows its summary and remembers it', () => {
    const view = renderTree()
    fireEvent.click(rowOf(view, '"items"'))
    expect(rows(view)).toHaveLength(6)
    expect(rowOf(view, '"items"').getAttribute('aria-expanded')).toBe('false')
    expect(rowOf(view, '"items"').textContent).toContain('ITEMS_2')
    expect(localStorage.getItem(`${KEY_PREFIX}cfg.json`)).toBe('["$.items"]')
  })

  it('restores the remembered folding on the next render', () => {
    localStorage.setItem(`${KEY_PREFIX}cfg.json`, '["$.meta"]')
    const view = renderTree()
    expect(rowOf(view, '"meta"').getAttribute('aria-expanded')).toBe('false')
    expect(rows(view)).toHaveLength(6)
  })

  it('keeps folding state per file', () => {
    const view = renderTree(SOURCE, 'other.json')
    fireEvent.click(rowOf(view, '"name"'))
    expect(localStorage.getItem(`${KEY_PREFIX}other.json`)).toBeNull()
    fireEvent.click(rowOf(view, '"items"'))
    expect(localStorage.getItem(`${KEY_PREFIX}other.json`)).toBe('["$.items"]')
  })

  it('collapses and re-expands everything from the toolbar', () => {
    const view = renderTree()
    fireEvent.click(view.getByRole('button', { name: 'COLLAPSE_ALL' }))
    expect(rows(view)).toHaveLength(4)
    expect(rowOf(view, '"meta"').textContent).toContain('KEYS_1')
    fireEvent.click(view.getByRole('button', { name: 'EXPAND_ALL' }))
    expect(rows(view)).toHaveLength(8)
  })

  it('cycles the expand depth preset', () => {
    const view = renderTree()
    fireEvent.click(view.getByRole('button', { name: 'DEPTH_3' }))
    expect(view.getByRole('button', { name: 'DEPTH_4' })).toBeTruthy()
    expect(rows(view)).toHaveLength(8)
    fireEvent.click(view.getByRole('button', { name: 'DEPTH_4' }))
    expect(view.getByRole('button', { name: 'DEPTH_1' })).toBeTruthy()
    expect(rows(view)).toHaveLength(4)
  })
})

describe('JsonTree paging', () => {
  it('lists one page of a long array and reveals the rest on request', () => {
    const view = renderTree(`[${Array.from({ length: JSON_ARRAY_PAGE + 30 }, (_, index) => index).join(',')}]`)
    expect(rows(view)).toHaveLength(JSON_ARRAY_PAGE + 1)
    fireEvent.click(view.getByRole('button', { name: 'SHOW_MORE_30' }))
    expect(rows(view)).toHaveLength(JSON_ARRAY_PAGE + 30 + 1)
    expect(view.queryByRole('button', { name: 'SHOW_MORE_30' })).toBeNull()
  })
})

describe('JsonTree search', () => {
  it('keeps a hit with its ancestors and counts matches', () => {
    const view = renderTree()
    fireEvent.change(view.getByRole('searchbox', { name: 'SEARCH' }), { target: { value: 'deeper' } })
    expect(rows(view)).toHaveLength(4)
    expect(view.getByText('MATCHES_1')).toBeTruthy()
  })

  it('says so when nothing matches', () => {
    const view = renderTree()
    fireEvent.change(view.getByRole('searchbox', { name: 'SEARCH' }), { target: { value: 'absent' } })
    expect(view.queryAllByRole('treeitem')).toHaveLength(0)
    expect(view.getByText('MATCHES_0')).toBeTruthy()
    expect(view.getByText('NO_MATCHES')).toBeTruthy()
  })
})

describe('JsonTree selection', () => {
  it('copies the path and value of the selected row', async () => {
    const view = renderTree()
    const copyPath = view.getByRole('button', { name: 'COPY_PATH' })
    expect(copyPath.hasAttribute('disabled')).toBe(true)
    fireEvent.click(rowOf(view, '"name"'))
    expect(copyPath.hasAttribute('disabled')).toBe(false)
    fireEvent.click(copyPath)
    await waitFor(() => { expect(copyTextToClipboard).toHaveBeenCalledWith('$.name') })
    expect(view.getByText('COPIED')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'COPY_VALUE' }))
    await waitFor(() => { expect(copyTextToClipboard).toHaveBeenLastCalledWith('"workbench"') })
  })

  it('reports a rejected copy', async () => {
    vi.mocked(copyTextToClipboard).mockRejectedValueOnce(new Error('Clipboard unavailable'))
    const view = renderTree()
    fireEvent.click(rowOf(view, '"items"'))
    fireEvent.click(view.getByRole('button', { name: 'COPY_PATH' }))
    await waitFor(() => { expect(view.getByText('COPY_FAILED')).toBeTruthy() })
  })
})

describe('JsonTree keyboard', () => {
  /** Keys are dispatched from the focused row, as a real keyboard would. */
  const press = (key: string): void => {
    fireEvent.keyDown(document.activeElement as HTMLElement, { key })
  }

  it('moves focus with the arrow keys', () => {
    const view = renderTree()
    const first = rows(view)[0] as HTMLElement
    first.focus()
    press('ArrowDown')
    expect(document.activeElement).toBe(rows(view)[1])
    press('End')
    expect(document.activeElement).toBe(rows(view)[rows(view).length - 1])
    press('Home')
    expect(document.activeElement).toBe(rows(view)[0])
  })

  it('expands and collapses containers with the arrow keys', () => {
    const view = renderTree()
    const items = rowOf(view, '"items"')
    items.focus()
    press('ArrowLeft')
    expect(items.getAttribute('aria-expanded')).toBe('false')
    press('ArrowRight')
    expect(items.getAttribute('aria-expanded')).toBe('true')
  })

  it('activates the focused row with Enter', () => {
    const view = renderTree()
    const name = rowOf(view, '"name"')
    name.focus()
    press('Enter')
    expect(name.getAttribute('aria-selected')).toBe('true')
  })
})

describe('JsonTree structure cues', () => {
  const rowsOf = (view: ReturnType<typeof renderTree>, selector: string): HTMLElement[] =>
    Array.from(view.container.querySelectorAll<HTMLElement>(selector))
  const closers = (view: ReturnType<typeof renderTree>): HTMLElement[] => rowsOf(view, '[data-closer]')
  const lit = (view: ReturnType<typeof renderTree>): HTMLElement[] =>
    rowsOf(view, '[data-depth]').filter(row => row.className.includes('jsonRowLit'))

  it('closes every opened container on its own row', () => {
    const view = renderTree()
    expect(closers(view).map(row => row.dataset.closer)).toEqual(['$.items', '$.meta.deep', '$.meta', '$'])
    expect(closers(view).map(row => row.textContent?.trim())).toEqual([']', '}', '}', '}'])
  })

  it('drops a closer together with its folded branch', () => {
    const view = renderTree()
    fireEvent.click(rowOf(view, '"items"'))
    expect(closers(view).map(row => row.dataset.closer)).toEqual(['$.meta.deep', '$.meta', '$'])
  })

  it('previews what a folded container holds', () => {
    const view = renderTree('{ "deps": { "a": 1, "b": 2, "c": 3 } }')
    fireEvent.click(rowOf(view, '"deps"'))
    const row = rowOf(view, '"deps"')
    expect(row.textContent).toContain('"a": 1, "b": 2 +1')
    expect(row.textContent).toContain('KEYS_3')
  })

  it('shows an empty container inline, without a closer', () => {
    const view = renderTree('{ "deps": {} }')
    expect(rowOf(view, '"deps"').textContent).toContain('{}')
    expect(closers(view).map(row => row.dataset.closer)).toEqual(['$'])
  })

  it('draws one indent guide per nesting level and aligns array indices', () => {
    const view = renderTree()
    // The second `items` element sits two levels deep, so it carries two rules.
    expect(rowsOf(view, '[data-row-index]')[4]?.querySelectorAll('[data-guide]')).toHaveLength(2)
    expect(view.getByText('0', { exact: true }).className).toContain('jsonIndex')
  })

  it('lights the guides of a container subtree while pointing at it', () => {
    const view = renderTree()
    const meta = rowOf(view, '"meta"')
    fireEvent.mouseEnter(meta)
    expect(lit(view)).toHaveLength(4)
    fireEvent.mouseLeave(meta)
    expect(lit(view)).toHaveLength(0)
  })

  it('pairs a selected container with its closing brace', () => {
    const view = renderTree()
    const items = rowOf(view, '"items"')
    fireEvent.click(items)
    fireEvent.click(items)
    const closer = rowsOf(view, '[data-closer="$.items"]')[0] as HTMLElement
    expect((closer.lastElementChild as HTMLElement).className).toContain('jsonPunctActive')
  })
})

describe('JsonTree typography', () => {
  it('sets rows in the source editor’s face and metrics', () => {
    const stylesheet = readFileSync(resolve(process.cwd(), 'src/client/json/json.module.css'), 'utf8')
    const rule = stylesheet.match(/\.jsonRow\s*\{[^}]+\}/u)?.[0] ?? ''
    expect(rule).toContain(`font-family: ${editorCodeFontFamily};`)
    expect(rule).toContain(`font-size: ${editorCodeFontSize};`)
    expect(rule).toContain(`line-height: ${editorCodeLineHeight};`)
  })
})
