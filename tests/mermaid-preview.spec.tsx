// @vitest-environment jsdom

import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MermaidRuntime } from '../src/client/mermaid/mermaid-loader.ts'

vi.mock('../src/client/mermaid/mermaid-loader.ts', () => ({
  loadMermaidRuntime: vi.fn(),
  renderMermaidDiagram: vi.fn(),
  shellIsDark: vi.fn(),
  configureMermaid: vi.fn(),
}))

import { MermaidPreview, type MermaidPreviewLabels } from '../src/client/mermaid/MermaidPreview.tsx'
import * as loader from '../src/client/mermaid/mermaid-loader.ts'

const labels: MermaidPreviewLabels = {
  loading: 'LOADING',
  missing: 'MISSING',
  renderError: 'RENDER_ERROR',
  empty: 'EMPTY',
  line: 'LINE',
  zoomIn: 'IN',
  zoomOut: 'OUT',
  zoomFit: 'FIT',
  zoomReset: 'RESET',
}

const fakeRuntime: MermaidRuntime = {
  initialize: () => {},
  render: async () => ({ svg: '' }),
}

beforeEach(() => {
  vi.mocked(loader.loadMermaidRuntime).mockReset()
  vi.mocked(loader.loadMermaidRuntime).mockResolvedValue(fakeRuntime)
  vi.mocked(loader.renderMermaidDiagram).mockReset()
  vi.mocked(loader.shellIsDark).mockReset()
  vi.mocked(loader.shellIsDark).mockReturnValue(false)
})
afterEach(() => { cleanup() })

describe('MermaidPreview', () => {
  it('renders the diagram SVG once the runtime is ready', async () => {
    vi.mocked(loader.renderMermaidDiagram).mockResolvedValue('<svg data-diagram="ok"></svg>')
    const view = render(<MermaidPreview source="graph TD;A-->B" labels={labels} />)

    await waitFor(() => {
      expect(view.container.querySelector('svg[data-diagram="ok"]')).not.toBeNull()
    })
    expect(loader.renderMermaidDiagram).toHaveBeenCalledWith(false, 'graph TD;A-->B')
    // The zoom bar appears only once a diagram is on screen.
    expect(view.getByRole('button', { name: 'IN' })).toBeTruthy()
  })

  it('shows the empty state and skips rendering for blank source', async () => {
    const view = render(<MermaidPreview source="   " labels={labels} />)
    expect(await waitFor(() => view.getByText('EMPTY'))).toBeTruthy()
    expect(loader.renderMermaidDiagram).not.toHaveBeenCalled()
  })

  it('surfaces a render error with the offending source line', async () => {
    vi.mocked(loader.renderMermaidDiagram).mockRejectedValue(new Error('Parse error on line 7: bad token'))
    const view = render(<MermaidPreview source="nonsense" labels={labels} />)

    const alert = await waitFor(() => view.getByRole('alert'))
    expect(alert.textContent).toContain('RENDER_ERROR')
    expect(alert.textContent).toContain('LINE 7')
    expect(alert.textContent).toContain('Parse error on line 7')
  })

  it('reports a missing runtime instead of a blank pane', async () => {
    vi.mocked(loader.loadMermaidRuntime).mockReset()
    vi.mocked(loader.loadMermaidRuntime).mockRejectedValue(new Error('runtime 404'))
    const view = render(<MermaidPreview source="graph TD" labels={labels} />)

    const alert = await waitFor(() => view.getByRole('alert'))
    expect(alert.textContent).toBe('MISSING')
    expect(loader.renderMermaidDiagram).not.toHaveBeenCalled()
  })

  it('marks the split variant with an extra divider class', () => {
    const plain = render(<MermaidPreview source="" labels={labels} />)
    const plainClass = plain.container.querySelector('[data-mermaid-preview]')?.className ?? ''
    cleanup()
    const split = render(<MermaidPreview source="" labels={labels} split />)
    const splitClass = split.container.querySelector('[data-mermaid-preview]')?.className ?? ''
    // The split pane keeps the base class and appends the divider class, however
    // the CSS-module names resolve under the test runner.
    expect(splitClass).not.toBe(plainClass)
    expect(splitClass.startsWith(plainClass)).toBe(true)
  })
})
