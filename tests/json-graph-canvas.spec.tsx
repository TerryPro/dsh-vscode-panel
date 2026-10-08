// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { editorCodeFontFamily, editorCodeFontSize } from '../src/client/editor/editor-theme.ts'
import { JsonGraph, type JsonGraphLabels } from '../src/client/json/JsonGraph.tsx'
import { copyTextToClipboard } from '../src/client/core/clipboard.ts'
import { GRAPH_PAGE_SIZE, GRAPH_ROW_HEIGHT } from '../src/client/json/json-graph.ts'

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
  panHint: 'PAN_HINT',
}

/** Mirrors the private key prefix; kept literal so a rename surfaces as a failure. */
const KEY_PREFIX = 'dsh-workbench:json-collapse:'

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

  it('wires the cards with labelled edges', () => {
    const view = renderGraph()
    expect(view.container.querySelectorAll('path')).toHaveLength(3)
    expect(Array.from(view.container.querySelectorAll('text')).map(node => node.textContent)).toEqual(['deps', 'b', 'list'])
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
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 140, clientY: 120 })
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
