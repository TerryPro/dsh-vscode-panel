// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { editorCodeFontFamily, editorCodeFontSize } from '../src/client/editor/editor-theme.ts'
import { JsonGraph, type JsonGraphLabels } from '../src/client/json/JsonGraph.tsx'
import { copyTextToClipboard } from '../src/client/core/clipboard.ts'
import { GRAPH_DETAIL_MAX_CHARS, GRAPH_PAGE_SIZE, GRAPH_ROW_HEIGHT } from '../src/client/json/json-graph.ts'

vi.mock('../src/client/core/clipboard.ts', () => ({
  copyTextToClipboard: vi.fn(() => Promise.resolve()),
}))

const labels: JsonGraphLabels = {
  graph: 'GRAPH',
  empty: 'EMPTY',
  invalid: 'INVALID',
  tooLarge: 'TOO_LARGE',
  truncated: count => `TRUNCATED_${count}`,
  large: 'LARGE',
  search: 'SEARCH',
  noMatches: 'NO_MATCHES',
  matches: count => `MATCHES_${count}`,
  nextMatch: 'NEXT_MATCH',
  expandAll: 'EXPAND_ALL',
  collapseAll: 'COLLAPSE_ALL',
  selectedValue: 'SELECTED_VALUE',
  valueTruncated: (shown, total) => `DETAIL_${shown}_${total}`,
  fit: 'FIT',
  zoomIn: 'ZOOM_IN',
  zoomOut: 'ZOOM_OUT',
  zoomReset: 'ZOOM_RESET',
  copyValue: 'COPY_VALUE',
  copyPath: 'COPY_PATH',
  copied: 'COPIED',
  copyFailed: 'COPY_FAILED',
  expandNode: 'EXPAND',
  collapseNode: 'COLLAPSE',
  showMore: count => `SHOW_MORE_${count}`,
  aliasOf: path => `ALIAS_OF_${path}`,
  pan: 'PAN',
  grid: 'GRID',
}

/** Mirrors the private key prefix; kept literal so a rename surfaces as a failure. */
const KEY_PREFIX = 'dsh-workbench:json-collapse:'
const GRID_KEY = 'dsh-workbench:json-grid'

const SOURCE = '{"name": "w", "deps": {"a": 1, "b": {"c": 2}}, "list": [1, 2]}'

type View = ReturnType<typeof renderGraph>

function renderGraph(source = SOURCE, path = 'cfg.json', view?: unknown) {
  return render(<JsonGraph source={source} path={path} labels={labels} view={view as never} />)
}

function cards(view: View): string[] {
  return Array.from(view.container.querySelectorAll<HTMLElement>('[data-card]')).map(card => card.dataset.card ?? '')
}

function rowOf(view: View, pathKey: string): HTMLElement {
  const row = view.container.querySelector<HTMLElement>(`[data-row="${pathKey}"]`)
  if (row === null) throw new Error(`no row for ${pathKey}`)
  return row
}

function canvasStyle(view: View): string {
  const canvas = view.container.querySelector<HTMLElement>('[data-canvas]')
  if (canvas === null) throw new Error('no canvas')
  return canvas.style.transform
}

function viewport(view: View): HTMLElement {
  const surface = view.container.querySelector<HTMLElement>('[data-viewport]')
  if (surface === null) throw new Error('no viewport')
  return surface
}

function stubPointerCapture(element: HTMLElement): void {
  element.setPointerCapture = () => {}
  element.releasePointerCapture = () => {}
}

beforeEach(() => { localStorage.clear() })
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('JsonGraph rendering', () => {
  it('draws one card per object and array, with a row per member', () => {
    const view = renderGraph()
    expect(cards(view)).toEqual(['$', '$.deps', '$.deps.b', '$.list'])
    expect(rowOf(view, '$.name').textContent).toBe('name:"w"')
    expect(rowOf(view, '$.deps.b').textContent).toBe('−b:{1}')
    expect(rowOf(view, '$.list[1]').textContent).toBe('[1]:2')
    expect(view.getByText('100%')).toBeTruthy()
  })

  it('wires the cards with plain wires, without text on them', () => {
    const view = renderGraph()
    // Scoped to the wires layer; the control bar's own glyphs are paths too.
    const wires = view.container.querySelector('[data-canvas] > svg')
    expect(wires?.querySelectorAll('path')).toHaveLength(3)
    expect(wires?.querySelectorAll('text')).toHaveLength(0)
  })

  it('shows the empty and error notes like the other structured views', () => {
    expect(renderGraph('').getByText('EMPTY')).toBeTruthy()
    expect(renderGraph('{"a": tru}').getByText('INVALID')).toBeTruthy()
    expect(renderGraph(`{"text": "${'x'.repeat(2 * 1024 * 1024 + 8)}"}`).getByText('TOO_LARGE')).toBeTruthy()
  })

  it('gives up on a document too wide to read as a graph', () => {
    const members = Array.from({ length: 600 }, (_, index) => `"k${index}": { "a": ${index} }`).join(',')
    expect(renderGraph(`{${members}}`).getByText('LARGE')).toBeTruthy()
  })
})

describe('JsonGraph folding', () => {
  it('collapses a branch from its row and remembers it per file', () => {
    const view = renderGraph()
    fireEvent.click(within(rowOf(view, '$.deps')).getByRole('button', { name: 'COLLAPSE' }))
    expect(cards(view)).toEqual(['$', '$.list'])
    expect(within(rowOf(view, '$.deps')).getByRole('button', { name: 'EXPAND' })).toBeTruthy()
    expect(localStorage.getItem(`${KEY_PREFIX}cfg.json`)).toBe('["$.deps"]')
  })

  it('restores remembered folding on the next render', () => {
    localStorage.setItem(`${KEY_PREFIX}cfg.json`, '["$.deps"]')
    const view = renderGraph()
    expect(cards(view)).toEqual(['$', '$.list'])
  })

  it('does not treat a fold click as a row selection', () => {
    const view = renderGraph()
    fireEvent.click(within(rowOf(view, '$.deps')).getByRole('button', { name: 'COLLAPSE' }))
    expect(view.getByRole('button', { name: 'COPY_PATH' }).hasAttribute('disabled')).toBe(true)
  })

  it('folds through a press-release-click the canvas must not steal', () => {
    const view = renderGraph()
    const surface = viewport(view)
    let captures = 0
    surface.setPointerCapture = () => { captures += 1 }
    surface.releasePointerCapture = () => {}
    const before = canvasStyle(view)
    const toggle = within(rowOf(view, '$.deps')).getByRole('button', { name: 'COLLAPSE' })
    fireEvent.pointerDown(toggle, { button: 0, pointerId: 1, clientX: 10, clientY: 10 })
    fireEvent.pointerUp(toggle, { pointerId: 1 })
    fireEvent.click(toggle)
    // A press that never travels is a click: no capture, so it reaches the control.
    expect(captures).toBe(0)
    expect(canvasStyle(view)).toBe(before)
    expect(cards(view)).toEqual(['$', '$.list'])
  })

  it('pans from a press that starts on a card, once it travels', () => {
    const view = renderGraph()
    const surface = viewport(view)
    let captures = 0
    surface.setPointerCapture = () => { captures += 1 }
    surface.releasePointerCapture = () => {}
    const row = rowOf(view, '$.name')
    fireEvent.pointerDown(row, { button: 0, pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(row, { pointerId: 1, clientX: 130, clientY: 115 })
    expect(canvasStyle(view)).toContain('translate(54px, 39px)')
    expect(captures).toBe(1)
    fireEvent.pointerUp(row, { pointerId: 1 })
    expect(surface.dataset.dragging).toBeUndefined()
  })

  it('treats a press that barely moves as a click on the row', () => {
    const view = renderGraph()
    const surface = viewport(view)
    let captures = 0
    surface.setPointerCapture = () => { captures += 1 }
    surface.releasePointerCapture = () => {}
    const before = canvasStyle(view)
    const row = rowOf(view, '$.name')
    fireEvent.pointerDown(row, { button: 0, pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(row, { pointerId: 1, clientX: 102, clientY: 101 })
    fireEvent.pointerUp(row, { pointerId: 1 })
    fireEvent.click(row)
    expect(captures).toBe(0)
    expect(canvasStyle(view)).toBe(before)
    expect(row.className).toContain('graphRowSelected')
  })

  it('collapses every branch at once and opens them back', () => {
    const view = renderGraph()
    fireEvent.click(view.getByRole('button', { name: 'COLLAPSE_ALL' }))
    expect(cards(view)).toEqual(['$'])
    expect(localStorage.getItem(`${KEY_PREFIX}cfg.json`)).toBe('["$.deps","$.deps.b","$.list"]')
    expect(rowOf(view, '$.deps').textContent).toContain('+')
    fireEvent.click(view.getByRole('button', { name: 'EXPAND_ALL' }))
    expect(cards(view)).toEqual(['$', '$.deps', '$.deps.b', '$.list'])
    expect(localStorage.getItem(`${KEY_PREFIX}cfg.json`)).toBe('[]')
  })

  it('pages a long array and reveals the rest', () => {
    const view = renderGraph(`[${Array.from({ length: GRAPH_PAGE_SIZE + 3 }, (_, index) => index).join(',')}]`)
    fireEvent.click(view.getByRole('button', { name: 'SHOW_MORE_3' }))
    expect(view.queryByRole('button', { name: 'SHOW_MORE_3' })).toBeNull()
    expect(view.container.querySelectorAll('[data-row]')).toHaveLength(GRAPH_PAGE_SIZE + 3)
  })
})

describe('JsonGraph canvas', () => {
  it('zooms with the wheel around the cursor and reports the percentage', () => {
    const view = renderGraph()
    const before = canvasStyle(view)
    fireEvent.wheel(viewport(view), { deltaY: -100, clientX: 200, clientY: 100 })
    expect(canvasStyle(view)).not.toBe(before)
    expect(canvasStyle(view)).toContain('scale(1.1)')
    expect(view.getByText('110%')).toBeTruthy()
  })

  it('zooms from the toolbar and resets to actual size', () => {
    const view = renderGraph()
    fireEvent.click(view.getByRole('button', { name: 'ZOOM_IN' }))
    expect(view.getByText('125%')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'ZOOM_OUT' }))
    expect(view.getByText('100%')).toBeTruthy()
  })

  it('pans by dragging the viewport', () => {
    const view = renderGraph()
    const surface = viewport(view)
    stubPointerCapture(surface)
    const before = canvasStyle(view)
    fireEvent.pointerDown(surface, { button: 0, pointerId: 1, clientX: 100, clientY: 100 })
    expect(surface.dataset.dragging).toBeUndefined()
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 140, clientY: 120 })
    expect(surface.dataset.dragging).toBe('1')
    expect(canvasStyle(view)).toContain('translate(64px, 44px)')
    fireEvent.pointerUp(surface, { pointerId: 1 })
    expect(canvasStyle(view)).not.toBe(before)
    expect(surface.dataset.dragging).toBeUndefined()
  })

  it('fits the document when asked', () => {
    const view = renderGraph()
    fireEvent.click(view.getByRole('button', { name: 'FIT' }))
    expect(canvasStyle(view)).toContain('scale(1)')
  })

  it('toggles the background grid and remembers the choice', () => {
    const view = renderGraph()
    const toggle = view.getByRole('button', { name: 'GRID' })
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(viewport(view).className).toContain('graphViewportGrid')
    fireEvent.click(toggle)
    expect(view.getByRole('button', { name: 'GRID' }).getAttribute('aria-pressed')).toBe('false')
    expect(viewport(view).className).not.toContain('graphViewportGrid')
    expect(localStorage.getItem(GRID_KEY)).toBe('0')
  })

  it('starts with the grid hidden when that was remembered', () => {
    localStorage.setItem(GRID_KEY, '0')
    const view = renderGraph()
    expect(viewport(view).className).not.toContain('graphViewportGrid')
    expect(view.getByRole('button', { name: 'GRID' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('only pans while the move tool is armed', () => {
    const view = renderGraph()
    const surface = viewport(view)
    stubPointerCapture(surface)
    fireEvent.click(view.getByRole('button', { name: 'PAN' }))
    const before = canvasStyle(view)
    fireEvent.pointerDown(surface, { button: 0, pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 160, clientY: 130 })
    fireEvent.pointerUp(surface, { pointerId: 1 })
    expect(canvasStyle(view)).toBe(before)
    expect(view.getByRole('button', { name: 'PAN' }).getAttribute('aria-pressed')).toBe('false')
  })
})

describe('JsonGraph selection', () => {
  it('copies the path and the decoded value of a row', async () => {
    const view = renderGraph()
    fireEvent.click(rowOf(view, '$.name'))
    fireEvent.click(view.getByRole('button', { name: 'COPY_PATH' }))
    await waitFor(() => { expect(copyTextToClipboard).toHaveBeenCalledWith('$.name') })
    fireEvent.click(view.getByRole('button', { name: 'COPY_VALUE' }))
    await waitFor(() => { expect(copyTextToClipboard).toHaveBeenLastCalledWith('w') })
    expect(view.getByText('COPIED')).toBeTruthy()
  })

  it('copies the source text of a container row', async () => {
    const view = renderGraph()
    fireEvent.click(rowOf(view, '$.deps'))
    fireEvent.click(view.getByRole('button', { name: 'COPY_VALUE' }))
    await waitFor(() => { expect(copyTextToClipboard).toHaveBeenLastCalledWith('{"a": 1, "b": {"c": 2}}') })
  })

  it('reveals a clicked row in the editor when one is on screen', () => {
    const dispatch = vi.fn()
    const view = renderGraph(SOURCE, 'cfg.json', { dispatch })
    fireEvent.click(rowOf(view, '$.list[1]'))
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      selection: { anchor: SOURCE.indexOf('2', SOURCE.indexOf('[')), head: SOURCE.indexOf('2', SOURCE.indexOf('[')) + 1 },
    }))
  })

  it('marks the selected row', () => {
    const view = renderGraph()
    fireEvent.click(rowOf(view, '$.name'))
    expect(rowOf(view, '$.name').className).toContain('graphRowSelected')
  })

  it('selects a row on a press-release inside a card', () => {
    const view = renderGraph()
    const surface = viewport(view)
    surface.setPointerCapture = () => { throw new Error('a still press must not hand the pointer to the canvas') }
    surface.releasePointerCapture = () => {}
    const row = rowOf(view, '$.name')
    fireEvent.pointerDown(row, { button: 0, pointerId: 1 })
    fireEvent.pointerUp(row, { pointerId: 1 })
    fireEvent.click(row)
    expect(row.className).toContain('graphRowSelected')
  })
})

describe('JsonGraph search', () => {
  it('counts matches, outlines their cards and jumps with Enter', () => {
    const view = renderGraph()
    const search = view.getByRole('searchbox', { name: 'SEARCH' })
    const before = canvasStyle(view)
    fireEvent.change(search, { target: { value: 'deps' } })
    expect(view.getByText('MATCHES_2')).toBeTruthy()
    expect(view.container.querySelector<HTMLElement>('[data-card="$.deps"]')?.className).toContain('graphCardMatch')
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(canvasStyle(view)).not.toBe(before)
  })

  it('says so when nothing matches', () => {
    const view = renderGraph()
    fireEvent.change(view.getByRole('searchbox', { name: 'SEARCH' }), { target: { value: 'absent' } })
    expect(view.getByText('NO_MATCHES')).toBeTruthy()
    expect(view.getByRole('button', { name: 'NEXT_MATCH' }).hasAttribute('disabled')).toBe(true)
  })
})

describe('JsonGraph details panel', () => {
  const panel = (view: View): HTMLElement | null => view.container.querySelector('pre')

  it('stays hidden until a row is chosen', () => {
    expect(panel(renderGraph())).toBeNull()
  })

  it('spells out a value the card had to clip', () => {
    const long = 'q'.repeat(300)
    const view = renderGraph(`{"note": "${long}"}`)
    const row = rowOf(view, '$.note')
    expect(row.textContent).toContain('…')
    expect(row.title).toContain(long)
    fireEvent.click(row)
    expect(panel(view)?.textContent).toBe(long)
    expect(view.getByText('SELECTED_VALUE')).toBeTruthy()
    expect(view.getByText('$.note')).toBeTruthy()
  })

  it('shows the source text of a container row', () => {
    const view = renderGraph()
    fireEvent.click(rowOf(view, '$.deps'))
    expect(panel(view)?.textContent).toBe('{"a": 1, "b": {"c": 2}}')
  })

  it('says so when a value is longer than the panel can hold', () => {
    const view = renderGraph(`{"note": "${'w'.repeat(5000)}"}`)
    fireEvent.click(rowOf(view, '$.note'))
    expect(panel(view)?.textContent).toHaveLength(GRAPH_DETAIL_MAX_CHARS)
    expect(view.getByText(`DETAIL_${GRAPH_DETAIL_MAX_CHARS}_5000`)).toBeTruthy()
  })
})

describe('JsonGraph with YAML', () => {
  it('badges an anchor and points an alias at its target', () => {
    const view = renderGraph('base: &b\n  x: 1\ncopy: *b\n', 'cfg.yaml')
    expect(rowOf(view, '$.base').textContent).toContain('&b')
    const copy = rowOf(view, '$.copy')
    expect(copy.dataset.alias).toBe('$.base')
    expect(copy.title).toBe('ALIAS_OF_$.base')
    expect(copy.textContent).toContain('*b')
    // The alias is a pointer, so it gets no card of its own.
    expect(cards(view)).toEqual(['$', '$.base'])
  })

  it('shows a block scalar as one line and in full in the panel', () => {
    const view = renderGraph('script: |\n  line1\n  line2\n', 'cfg.yaml')
    const row = rowOf(view, '$.script')
    expect(row.textContent).toContain('| line1')
    fireEvent.click(row)
    expect(view.container.querySelector('pre')?.textContent).toBe('line1\nline2\n')
  })

  it('draws one row per document in a stream', () => {
    const view = renderGraph('a: 1\n---\nb: 2\n', 'multi.yaml')
    expect(cards(view)).toEqual(['$', '$[0]', '$[1]'])
    expect(rowOf(view, '$[0]').textContent).toContain('document 1')
  })

  it('reads the repository’s own YAML patch file without complaints', () => {
    const source = readFileSync(resolve(process.cwd(), 'cordis.patch.yml'), 'utf8')
    const view = renderGraph(source, 'cordis.patch.yml')
    expect(view.queryByText('INVALID')).toBeNull()
    expect(view.queryByText('TOO_LARGE')).toBeNull()
    expect(cards(view).length).toBeGreaterThan(1)
  })
})

describe('JsonGraph typography', () => {
  it('draws cards in the source editor’s face and at its size', () => {
    const stylesheet = readFileSync(resolve(process.cwd(), 'src/client/json/json.module.css'), 'utf8')
    const card = stylesheet.match(/\.graphCard\s*\{[^}]+\}/u)?.[0] ?? ''
    const row = stylesheet.match(/\.graphRow\s*\{[^}]+\}/u)?.[0] ?? ''
    expect(card).toContain(`font-family: ${editorCodeFontFamily};`)
    expect(card).toContain(`font-size: ${editorCodeFontSize};`)
    // Row height is the layout unit json-graph.ts places cards and edges by.
    expect(row).toContain(`height: ${GRAPH_ROW_HEIGHT}px;`)
  })
})
