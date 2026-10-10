// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { zh } from '../src/client/core/locales.ts'
import type { NotebookLabels } from '../src/client/notebook/NotebookSurface.tsx'
import type { NotebookKernelFrame, NotebookOutputItem } from '../src/shared/notebook-protocol.ts'

// The store package pulls zustand/immer, which are not installed for tests.
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

// CodeMirror cannot run in jsdom; a textarea keeps the cell editor assertable.
vi.mock('../src/client/editor/CodeEditor.tsx', () => ({
  CodeEditor: ({ value, onChange, ariaLabel, cell, path }: {
    value: string
    ariaLabel: string
    onChange: (value: string) => void
    cell?: boolean
    path?: string
  }) => (
    <textarea
      aria-label={ariaLabel}
      value={value}
      data-cell={cell === true || undefined}
      data-lang-path={path}
      data-testid={`cell-editor-${ariaLabel.split(' ')[0]}`}
      onChange={event => { onChange(event.target.value) }}
    />
  ),
}))

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  MarkdownText: ({ text }: { text: string }) => <div data-testid="markdown">{text}</div>,
}))

let NotebookRuntime: typeof import('../src/client/notebook/notebook-runtime.ts').NotebookRuntime
let NotebookSurface: typeof import('../src/client/notebook/NotebookSurface.tsx').NotebookSurface

beforeAll(async () => {
  NotebookRuntime = (await import('../src/client/notebook/notebook-runtime.ts')).NotebookRuntime
  NotebookSurface = (await import('../src/client/notebook/NotebookSurface.tsx')).NotebookSurface
})

afterEach(() => {
  cleanup()
})

const labels = new Proxy({} as Record<string, string>, {
  // Reuse the real dictionary rather than restating it: a renamed key must fail the
  // build, not silently pass a test that asserts a string nobody sees.
  get: (_target, key: string) => zh[`notebook.${key}` as keyof typeof zh] ?? key,
}) as unknown as NotebookLabels

const nb = (cells: unknown[]) => JSON.stringify({
  cells,
  metadata: { language_info: { name: 'python' } },
  nbformat: 4,
  nbformat_minor: 5,
}, null, 1)

const code = (id: string, source: string, extra: Record<string, unknown> = {}) => ({
  cell_type: 'code', id, source, outputs: [], execution_count: null, metadata: {}, ...extra,
})

function apiStub() {
  return {
    kernelDiscover: vi.fn().mockResolvedValue({ usable: true, kernels: [], environments: [] }),
    kernelStart: vi.fn().mockResolvedValue({
      kernelId: 'k1', token: 't1', displayName: 'Python 3', specName: 'python3', language: 'python', phase: 'ready', sequence: 1,
    }),
    kernelExecute: vi.fn().mockResolvedValue({ msgId: 'm1', executionCount: 1, phase: 'busy' }),
    kernelInterrupt: vi.fn(),
    kernelInput: vi.fn().mockResolvedValue({ accepted: true }),
    kernelPoll: vi.fn().mockResolvedValue({ frames: [], nextSequence: 1, phase: 'ready', executionCount: 0, resynced: false }),
    kernelRestart: vi.fn(),
    kernelShutdown: vi.fn(),
    kernelStatus: vi.fn(),
    kernelComplete: vi.fn(),
    kernelInspect: vi.fn(),
    kernelIsComplete: vi.fn(),
  }
}

/**
 * Mount one notebook surface with the controller contract it needs.
 *
 * The surface reads run state through the real runtime and writes draft text through
 * `onEdit`, so a spec can assert both the cells shown and the notebook file produced.
 */
function setup(draft: string, options: { editable?: boolean; discover?: unknown } = {}) {
  const api = apiStub()
  // The surface asks the host which kernels this workspace can run as soon as it
  // mounts, so a test that cares about the answer has to set it before rendering.
  if (options.discover !== undefined) api.kernelDiscover.mockResolvedValue(options.discover)
  const holder = { draft }
  const runtime = new NotebookRuntime(api as never, { info: vi.fn(), warn: vi.fn() }, {
    getDraft: () => holder.draft,
    setDraft: (_tabId, text) => { holder.draft = text },
  })
  const onEdit = vi.fn((text: string) => { holder.draft = text })
  const view = render(<NotebookSurface
    tabId="tab-1"
    path="nb.ipynb"
    workspaceId="ws-1"
    draft={holder.draft}
    editable={options.editable ?? true}
    runtime={runtime}
    onEdit={onEdit}
    labels={labels}
    markdownLabels={{ code: { copyLabel: 'copy', copiedLabel: 'copied' }, footnotes: 'notes' } as never}
  />)
  return { ...view, api, runtime, holder, onEdit }
}
/** Push a frame the way the Host's stream would. */
function frame(runtime: InstanceType<typeof NotebookRuntime>, sequence: number, event: Record<string, unknown>): void {
  act(() => {
    runtime.acceptFrame('tab-1', { ...event, sequence } as NotebookKernelFrame)
  })
}

describe('notebook surface rendering', () => {
  it('shows one editable cell per notebook cell, with its prompt', () => {
    const draft = nb([code('c1', 'x = 1'), code('c2', 'print(x)')])
    const { getAllByTestId, getAllByText } = setup(draft)
    expect(getAllByTestId(/^cell-editor-/u)).toHaveLength(2)
    // A cell that has never run shows Jupyter's empty prompt rather than a number.
    expect(getAllByText('[ ]')).toHaveLength(2)
    // The cell editor is mounted in cell form, which drops the whole-file editor's
    // scroll padding; without it a blank band separates the code from its output.
    for (const editor of getAllByTestId(/^cell-editor-/u)) {
      expect(editor.getAttribute('data-cell')).toBe('true')
    }
  })

  it('renders a markdown cell as markdown', () => {
    const draft = nb([{ cell_type: 'markdown', id: 'm1', source: '# Title', metadata: {} }])
    const { getByTestId, getByLabelText } = setup(draft)
    expect(getByTestId('markdown').textContent).toBe('# Title')
    // A markdown cell has no run button; its kind control can still convert it.
    expect(document.querySelectorAll(`[aria-label="${labels.runCell}"]`)).toHaveLength(0)
    const kind = getByLabelText(labels.changeKind) as HTMLSelectElement
    expect(kind.value).toBe('markdown')
  })

  it('shows no prompt number on a cell that cannot be executed', () => {
    // `[ ]` beside a Markdown cell reads as "not run yet" for something that never
    // runs. Only a code cell has an execution number to report.
    const draft = nb([
      { cell_type: 'markdown', id: 'm1', source: '# Title', metadata: {} },
      { cell_type: 'raw', id: 'r1', source: 'text', metadata: {} },
      code('c1', 'x = 1'),
    ])
    const { getAllByText, container } = setup(draft)
    expect(getAllByText('[ ]')).toHaveLength(1)
    // The non-code rows keep their kind label, so the header does not collapse.
    const kinds = [...container.querySelectorAll('span[class*="cellKind"]')].map(node => node.textContent)
    expect(kinds).toEqual([labels.markdownCell, labels.rawCell, labels.codeCell])
  })

  it('renders no output region for a cell that has never run', () => {
    // A "no output yet" box under every cell of a fresh notebook is noise, and it
    // reads as a result when none exists.
    const draft = nb([code('c1', 'x = 1'), code('c2', 'print(x)')])
    const { container } = setup(draft)
    expect(container.textContent).not.toContain(labels.noOutputsYet)
    expect(container.textContent).not.toContain(labels.output)
  })

  it('says so when a cell ran and produced nothing', () => {
    // The absence of output *is* the result here, which is why this case is kept.
    const draft = nb([code('c1', 'pass')])
    const { container, runtime } = setup(draft)
    frame(runtime, 1, { type: 'cell_started', msgId: 'm1', cellId: 'c1', code: 'pass', executionCount: 1 })
    frame(runtime, 2, { type: 'cell_completed', msgId: 'm1', cellId: 'c1', status: 'ok', executionCount: 1 })
    expect(container.textContent).toContain(labels.noOutputsYet)
  })

  it('keeps an input() prompt visible even though the cell has emitted no output', () => {
    // A cell parked on `input()` has produced nothing, so an output region keyed on
    // "has output items" would swallow the answer box and wedge the kernel behind an
    // invisible question.
    const draft = nb([code('c1', 'name = input("who? ")')])
    const { container, getByLabelText, runtime } = setup(draft)
    frame(runtime, 1, { type: 'cell_started', msgId: 'm1', cellId: 'c1', code: 'x', executionCount: 1 })
    frame(runtime, 2, { type: 'input_request', msgId: 'm1', cellId: 'c1', prompt: 'who? ', password: false })
    expect(container.textContent).toContain('who?')
    expect(getByLabelText(labels.answerInput)).toBeTruthy()
    expect(container.textContent).not.toContain(labels.noOutputsYet)
  })

  it('numbers a text result before the value, the way Jupyter writes it', () => {
    const draft = nb([code('c1', '1 + 1', {
      outputs: [{ output_type: 'execute_result', execution_count: 2, data: { 'text/plain': '4' }, metadata: {} }],
    })])
    const { container } = setup(draft)
    const line = container.querySelector('[class*="outputResultLine"]')
    // `Out[2]: 4` on one line. Absolutely positioning the label over the value made it
    // collide with the first line, which is unreadable for a one-line result.
    expect(line?.textContent).toBe('Out[2]:4')
    expect(container.textContent).not.toContain('Out[undefined]')
  })

  it('toggles a text cell between rendered and edited with a button', () => {
    const draft = nb([{ cell_type: 'markdown', id: 'm1', source: '# Title', metadata: {} }])
    const { getByLabelText, getByTestId, queryByTestId } = setup(draft)
    // A text cell opens rendered, and the control offered is the way *into* the source.
    expect(getByTestId('markdown')).toBeTruthy()
    const edit = getByLabelText(labels.editMarkdown)
    expect(edit.getAttribute('disabled')).toBeNull()
    fireEvent.click(edit)
    expect(getByTestId('cell-editor-m1')).toBeTruthy()
    // The same slot now offers the way back, so the reader is never left in a source
    // box with no visible exit.
    fireEvent.click(getByLabelText(labels.renderMarkdown))
    expect(queryByTestId('cell-editor-m1')).toBeNull()
    expect(getByTestId('markdown')).toBeTruthy()
  })

  it('leaves a text cell editor on Escape', () => {
    const draft = nb([{ cell_type: 'markdown', id: 'm1', source: '# Title', metadata: {} }])
    const { getByLabelText, getByTestId, queryByTestId } = setup(draft)
    fireEvent.click(getByLabelText(labels.editMarkdown))
    const editor = getByTestId('cell-editor-m1')
    expect(editor).toBeTruthy()
    fireEvent.keyDown(editor, { key: 'Escape' })
    expect(queryByTestId('cell-editor-m1')).toBeNull()
  })

  it('highlights a text cell as Markdown and a raw cell as plain text', () => {
    // Only a code cell runs on the kernel. Highlighting a text cell with the kernel's
    // grammar painted `# Title` as a Python comment and made a raw cell look runnable.
    const draft = nb([
      code('c1', 'x = 1'),
      { cell_type: 'markdown', id: 'm1', source: '# Title', metadata: {} },
      { cell_type: 'raw', id: 'r1', source: 'plain', metadata: {} },
    ])
    const { getByLabelText, getByTestId } = setup(draft)
    expect(getByTestId('cell-editor-c1').getAttribute('data-lang-path')).toBe('nb.ipynb.py')
    fireEvent.click(getByLabelText(labels.editMarkdown))
    expect(getByTestId('cell-editor-m1').getAttribute('data-lang-path')).toBe('nb.ipynb.md')
    expect(getByTestId('cell-editor-r1').getAttribute('data-lang-path')).toBe('nb.ipynb.txt')
  })

  it('shows the stored output of a cell without running anything', () => {
    const draft = nb([code('c1', 'x', {
      outputs: [{ output_type: 'stream', name: 'stdout', text: 'stored\n' }],
      execution_count: 5,
    })])
    const { container } = setup(draft)
    // The file's own output renders as soon as the notebook opens: a saved notebook
    // must not look empty until the reader re-runs every cell.
    expect(container.textContent).toContain('stored')
    // The prompt number the file carries is honoured, not replaced with an empty one.
    expect(container.textContent).toContain('[5]')
  })

  it('draws an image output from its base64 payload', () => {
    const draft = nb([code('c1', 'plot()', {
      outputs: [{ output_type: 'display_data', data: { 'image/png': 'iVBORw0' }, metadata: {} }],
    })])
    setup(draft)
    const img = document.querySelector('img')
    // The image renders from a data URL built off the mime type, never a remote fetch.
    expect(img?.getAttribute('src')).toBe('data:image/png;base64,iVBORw0')
    expect(img?.getAttribute('loading')).toBe('lazy')
  })

  it('renders html output sanitized, not raw', () => {
    const draft = nb([code('c1', 'show()', {
      outputs: [{
        output_type: 'execute_result',
        execution_count: 1,
        data: { 'text/html': '<table><tr><td>a</td></tr></table><script>window.x=1</script>' },
        metadata: {},
      }],
    })])
    setup(draft)
    const host = document.querySelector('[class*="outputHtml"]')
    expect(host?.textContent).toContain('a')
    // The sanitizer is what makes this safe; the view must not re-add what it removed.
    expect(host?.innerHTML).not.toContain('script')
    expect(host?.querySelector('table')).not.toBeNull()
  })

  it('renders an error traceback as a coloured block', () => {
    const draft = nb([code('c1', '1/0', {
      outputs: [{ output_type: 'error', ename: 'ZeroDivisionError', evalue: 'division by zero', traceback: ['\u001b[31mZeroDivisionError\u001b[39m boom'] }],
    })])
    const { container } = setup(draft)
    const error = container.querySelector('[role="alert"]')
    expect(error?.textContent).toContain('ZeroDivisionError')
    // ANSI colour from the kernel becomes a styled span rather than raw escape codes.
    expect(error?.innerHTML).toContain('color:')
    expect(error?.textContent).not.toContain('\u001b')
  })

  it('shows an empty-state message for a notebook with no cells', () => {
    const { getByText } = setup(nb([]))
    expect(getByText(labels.emptyNotebook)).toBeTruthy()
  })

  it('names the failure rather than blanking on invalid notebook json', () => {
    const { getByText } = setup('{ not json at all')
    expect(getByText(labels.invalidNotebook)).toBeTruthy()
  })

  it('turns a blank new file into a real notebook on the first cell', () => {
    // A notebook created from the file tree is zero bytes, so the surface has no JSON
    // tree to insert into. Its first cell seeds a document Jupyter can open.
    const { getByText, onEdit } = setup('')
    expect(getByText(labels.blankNotebook)).toBeTruthy()
    fireEvent.click(getByText(labels.addCodeCell))
    const written = onEdit.mock.calls[0]![0] as string
    const parsed = JSON.parse(written) as { nbformat: number; cells: { cell_type: string }[] }
    expect(parsed.nbformat).toBe(4)
    expect(parsed.cells[0]?.cell_type).toBe('code')
  })

  it('offers no first-cell button while the file is externally modified', () => {
    const { queryByText } = setup('', { editable: false })
    expect(queryByText(labels.addCodeCell)).toBeNull()
  })

  it('refuses to edit an unreadable notebook into a different one', () => {
    // `editable: false` is the external-change state; structural actions must be inert.
    const draft = nb([code('c1', 'x')])
    const { getByLabelText } = setup(draft, { editable: false })
    expect((getByLabelText(labels.addCodeCell) as HTMLButtonElement).disabled).toBe(true)
    expect((getByLabelText(labels.deleteCell) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('notebook surface editing', () => {
  it('writes a cell edit back in the shape each cell already used', () => {
    // c1 stores source as a string, c2 as a list of lines; each must be written back
    // the way it came in, so the file diff stays one line rather than a reflow.
    const draft = nb([
      { cell_type: 'code', id: 'c1', source: 'x = 1', outputs: [], execution_count: null, metadata: {} },
      { cell_type: 'code', id: 'c2', source: ['print(x)'], outputs: [], execution_count: null, metadata: {} },
    ])
    const { getByTestId, onEdit } = setup(draft)
    fireEvent.change(getByTestId('cell-editor-c1'), { target: { value: 'y = 2' } })
    expect(onEdit).toHaveBeenCalledTimes(1)
    const parsed = JSON.parse(onEdit.mock.calls[0]![0] as string) as { cells: { id: string; source: string[] | string }[] }
    expect(parsed.cells[0]?.source).toBe('y = 2')
    expect(parsed.cells[1]?.source).toEqual(['print(x)'])
  })

  it('inserts a cell and keeps every existing id', () => {
    const draft = nb([code('c1', 'a'), code('c2', 'b')])
    const { getByLabelText, onEdit } = setup(draft)
    fireEvent.click(getByLabelText(labels.addCodeCell))
    const parsed = JSON.parse(onEdit.mock.calls[0]![0] as string) as { cells: { id: string }[] }
    expect(parsed.cells).toHaveLength(3)
    expect(parsed.cells[0]?.id).toBe('c1')
    expect(parsed.cells[1]?.id).toBe('c2')
    expect(parsed.cells[2]?.id).toMatch(/^dsh/u)
  })

  it('deletes the cell it was asked about', () => {
    const draft = nb([code('c1', 'a'), code('c2', 'b')])
    const { getAllByLabelText, onEdit } = setup(draft)
    const deleteButtons = getAllByLabelText(labels.deleteCell)
    expect(deleteButtons).toHaveLength(2)
    fireEvent.click(deleteButtons[1]!)
    const parsed = JSON.parse(onEdit.mock.calls[0]![0] as string) as { cells: { id: string }[] }
    expect(parsed.cells.map(cell => cell.id)).toEqual(['c1'])
  })

  it('moves a cell down and disables the control at the edge', () => {
    const draft = nb([code('c1', 'a'), code('c2', 'b')])
    const { getAllByLabelText, onEdit } = setup(draft)
    const up = getAllByLabelText(labels.moveUp)
    // The first cell cannot move up, so the button is inert rather than misleading.
    expect((up[0] as HTMLButtonElement).disabled).toBe(true)
    expect((up[1] as HTMLButtonElement).disabled).toBe(false)
    const down = getAllByLabelText(labels.moveDown)
    expect((down[1] as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(down[0]!)
    const parsed = JSON.parse(onEdit.mock.calls[0]![0] as string) as { cells: { id: string }[] }
    expect(parsed.cells.map(cell => cell.id)).toEqual(['c2', 'c1'])
  })

  it('converts a cell kind and adjusts only the fields that kind owns', () => {
    const draft = nb([code('c1', 'a')])
    const { getByLabelText, onEdit } = setup(draft)
    const kind = getByLabelText(labels.changeKind) as HTMLSelectElement
    fireEvent.change(kind, { target: { value: 'markdown' } })
    const cell = (JSON.parse(onEdit.mock.calls[0]![0] as string) as { cells: Record<string, unknown>[] }).cells[0]
    expect(cell).not.toHaveProperty('outputs')
    expect(cell).not.toHaveProperty('execution_count')
    expect(cell?.['cell_type']).toBe('markdown')
  })

  it('clears every output and prompt number in one edit', () => {
    const draft = nb([
      code('c1', 'a', { outputs: [{ output_type: 'stream', name: 'stdout', text: 'x' }], execution_count: 2 }),
      code('c2', 'b', { outputs: [{ output_type: 'stream', name: 'stdout', text: 'y' }], execution_count: 3 }),
    ])
    const { getByLabelText, onEdit } = setup(draft)
    fireEvent.click(getByLabelText(labels.clearAllOutputs))
    const parsed = JSON.parse(onEdit.mock.calls[0]![0] as string) as { cells: { outputs: unknown[]; execution_count: unknown }[] }
    expect(parsed.cells.every(cell => cell.outputs.length === 0)).toBe(true)
    expect(parsed.cells.every(cell => cell.execution_count === null)).toBe(true)
  })
})

describe('notebook surface execution', () => {
  it('starts the kernel and sends the focused cell on Ctrl+Enter', async () => {
    const draft = nb([code('c1', 'x = 1')])
    const { api, getByTestId, getByLabelText } = setup(draft)
    const editor = getByTestId('cell-editor-c1')
    fireEvent.focus(editor)
    await act(async () => {
      fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true, bubbles: true })
    })
    expect(api.kernelStart).toHaveBeenCalledWith('ws-1', 'nb.ipynb', undefined)
    expect(api.kernelExecute).toHaveBeenCalledWith(expect.objectContaining({ code: 'x = 1', cellId: 'c1' }))
    void getByLabelText
  })

  it('runs a single cell from its own run button', async () => {
    const draft = nb([code('c1', 'a'), code('c2', 'b')])
    const { api, getAllByLabelText } = setup(draft)
    await act(async () => {
      fireEvent.click(getAllByLabelText(labels.runCell)[1]!)
    })
    expect(api.kernelExecute.mock.calls[0]![0]).toMatchObject({ cellId: 'c2', code: 'b' })
  })

  it('runs every non-blank code cell from Run All, in order', async () => {
    const draft = nb([
      code('c1', 'a'),
      { cell_type: 'markdown', id: 'm', source: '# skip', metadata: {} },
      code('c2', 'b'),
      code('c3', '   '),
    ])
    const { api, getByLabelText, runtime } = setup(draft)
    await act(async () => {
      fireEvent.click(getByLabelText(labels.runAll))
    })
    // The first cell goes now; the rest queue behind it and drain on kernel idle.
    expect(api.kernelExecute).toHaveBeenCalledTimes(1)
    expect(api.kernelExecute.mock.calls[0]![0]).toMatchObject({ cellId: 'c1' })
    expect(runtime.pendingQueueLength('tab-1')).toBe(1)
    // A cell that only went idle after its neighbour finished is the next one sent.
    frame(runtime, 1, { type: 'cell_completed', msgId: 'm1', cellId: 'c1', status: 'ok', executionCount: 1 })
    frame(runtime, 2, { type: 'phase', phase: 'ready' })
    await vi.waitFor(() => { expect(api.kernelExecute).toHaveBeenCalledTimes(2) })
    // `c3` is blank, so it is never sent and never consumes an execution number.
    expect(api.kernelExecute.mock.calls[1]![0]).toMatchObject({ cellId: 'c2' })
    await new Promise(resolve => { setTimeout(resolve, 60) })
    expect(api.kernelExecute).toHaveBeenCalledTimes(2)
  })

  it('does not start a kernel for a blank cell', async () => {
    const draft = nb([code('c1', '   ')])
    const { api, getAllByLabelText } = setup(draft)
    await act(async () => {
      fireEvent.click(getAllByLabelText(labels.runCell)[0]!)
    })
    expect(api.kernelStart).not.toHaveBeenCalled()
    expect(api.kernelExecute).not.toHaveBeenCalled()
  })

  it('shows a cell as running while its run is live', async () => {
    const draft = nb([code('c1', 'a')])
    const { api, getByText, runtime } = setup(draft)
    await act(async () => {
      fireEvent.click(document.querySelectorAll('button')[0]!)
    })
    void api
    frame(runtime, 1, { type: 'cell_started', msgId: 'm1', cellId: 'c1', code: 'a', executionCount: 4 })
    expect(getByText('[*]')).toBeTruthy()
    expect(getByText(labels.running)).toBeTruthy()
  })

  it('appends streamed output to the cell as it arrives', async () => {
    const draft = nb([code('c1', 'a')])
    const { container, runtime } = setup(draft)
    frame(runtime, 1, { type: 'cell_started', msgId: 'm1', cellId: 'c1', code: 'a', executionCount: 1 })
    frame(runtime, 2, {
      type: 'cell_output', msgId: 'm1', cellId: 'c1', truncated: false,
      item: { kind: 'stream', name: 'stdout', text: 'live output\n' } as NotebookOutputItem,
    })
    // Output renders as it arrives, not only when the run ends. It is styled through
    // `ansiToHtml`, which escapes into a code element, so the text is asserted on the
    // container rather than by a role query.
    expect(container.textContent).toContain('live output')
  })

  it('writes a finished run into the draft exactly once', async () => {
    const draft = nb([code('c1', 'a')])
    // The runtime writes the draft through its bridge, not through the surface's
    // onEdit (which is only the cell editor's own change). Assert the file content.
    const { holder, runtime } = setup(draft)
    await act(async () => {
      await runtime.ensureKernel('tab-1', 'ws-1', 'nb.ipynb')
    })
    frame(runtime, 1, { type: 'cell_started', msgId: 'm1', cellId: 'c1', code: 'a', executionCount: 1 })
    frame(runtime, 2, {
      type: 'cell_output', msgId: 'm1', cellId: 'c1', truncated: false,
      item: { kind: 'execute_result', executionCount: 1, data: { 'text/plain': 'done' }, metadata: {} } as NotebookOutputItem,
    })
    // Output is buffered while the run is live, so it is not in the file yet.
    expect(holder.draft).not.toContain('done')
    frame(runtime, 3, { type: 'cell_completed', msgId: 'm1', cellId: 'c1', status: 'ok', executionCount: 1 })
    // One write per finished run: the screen and the file agree at a save point.
    expect(holder.draft).toContain('done')
    expect(holder.draft).toMatch(/"execution_count": 1/u)
  })

  it('interrupts the running kernel from the toolbar', async () => {
    const draft = nb([code('c1', 'a')])
    const { api, getByLabelText, runtime } = setup(draft)
    await act(async () => {
      await runtime.ensureKernel('tab-1', 'ws-1', 'nb.ipynb')
    })
    frame(runtime, 1, { type: 'cell_started', msgId: 'm1', cellId: 'c1', code: 'a', executionCount: 1 })
    await act(async () => {
      fireEvent.click(getByLabelText(labels.interrupt))
    })
    expect(api.kernelInterrupt).toHaveBeenCalledWith('k1', 't1', 'ws-1')
  })

  it('offers no interrupt until something is running', () => {
    const { getByLabelText } = setup(nb([code('c1', 'a')]))
    expect((getByLabelText(labels.interrupt) as HTMLButtonElement).disabled).toBe(true)
  })

  it('asks the kernel to restart and re-attaches under a new id', async () => {
    const draft = nb([code('c1', 'a')])
    const { api, runtime, getByLabelText } = setup(draft)
    await act(async () => {
      await runtime.ensureKernel('tab-1', 'ws-1', 'nb.ipynb')
    })
    api.kernelRestart.mockResolvedValue({
      kernelId: 'k2', token: 't2', displayName: 'Python 3', specName: 'python3', language: 'python', phase: 'ready', sequence: 1,
    })
    await act(async () => {
      fireEvent.click(getByLabelText(labels.restartKernel))
    })
    expect(api.kernelRestart).toHaveBeenCalledTimes(1)
    expect(runtime.state('tab-1').kernel.kernelId).toBe('k2')
  })

  it('stops the kernel and reports no kernel afterwards', async () => {
    const draft = nb([code('c1', 'a')])
    const { api, runtime, getByLabelText } = setup(draft)
    await act(async () => {
      await runtime.ensureKernel('tab-1', 'ws-1', 'nb.ipynb')
    })
    await act(async () => {
      fireEvent.click(getByLabelText(labels.stopKernel))
    })
    expect(api.kernelShutdown).toHaveBeenCalled()
    expect(getByLabelText(labels.kernelLabel).textContent).toContain(labels.kernelDisconnected)
  })

  it('asks the host which kernels this workspace can run, once', async () => {
    const { api } = setup(nb([code('c1', 'a')]))
    await act(async () => {
      await Promise.resolve()
    })
    expect(api.kernelDiscover).toHaveBeenCalledTimes(1)
    expect(api.kernelDiscover).toHaveBeenCalledWith('ws-1')
  })

  it('surfaces a discovery message when nothing here can run', async () => {
    const { container } = setup(nb([code('c1', 'a')]), {
      discover: {
        usable: false,
        environments: [],
        kernels: [],
        message: 'install ipykernel into the environment you want to use',
      },
    })
    // The reader is told why the picker is empty rather than staring at a dead control.
    await act(async () => {
      await vi.waitFor(() => {
        const status = container.querySelector('[data-phase]')
        return (status?.getAttribute('title') ?? '').includes('install ipykernel')
      })
    })
    expect(container.querySelector('[data-phase]')?.getAttribute('title')).toContain('install ipykernel')
  })

  it('lets the reader pick a different kernel explicitly', async () => {
    const { api, getByLabelText } = setup(nb([code('c1', 'a')]), {
      // Choices arrive through the same path the surface uses, so the list the reader
      // was shown is the list they can choose from.
      discover: {
        usable: true,
        environments: [],
        kernels: [
          { name: 'python3', displayName: 'Python 3', language: 'python', available: true, source: 'venv' },
          { name: 'ir', displayName: 'R', language: 'R', available: true, source: 'kernelspec' },
          { name: 'other', displayName: 'Other', language: 'python', available: false, reason: 'no ipykernel', source: 'kernelspec' },
        ],
      },
    })
    await act(async () => {
      await vi.waitFor(() => { expect(api.kernelDiscover).toHaveBeenCalled() })
    })
    const select = getByLabelText(labels.selectKernel) as HTMLSelectElement
    // An unavailable kernel is listed with its reason but cannot be chosen.
    const options = [...select.options]
    expect((options.find(option => option.value === 'other') as HTMLOptionElement | undefined)?.disabled).toBe(true)
    const other = options.find(option => option.value === 'other')
    expect(other?.textContent).toContain('no ipykernel')
    // Auto-connect already started the workspace's best guess; picking a *different*
    // kernel must swap it rather than be shadowed by the connected one.
    await act(async () => {
      fireEvent.change(select, { target: { value: 'ir' } })
    })
    expect(api.kernelStart).toHaveBeenLastCalledWith('ws-1', 'nb.ipynb', 'ir')
  })

  it('auto-connects the kernel the notebook names on open', async () => {
    const withSpec = JSON.stringify({
      cells: [code('c1', 'a')],
      metadata: { kernelspec: { name: 'ir', display_name: 'R', language: 'R' }, language_info: { name: 'R' } },
      nbformat: 4,
      nbformat_minor: 5,
    }, null, 1)
    const { api } = setup(withSpec, {
      discover: {
        usable: true,
        environments: [],
        kernels: [
          { name: 'python3', displayName: 'Python 3', language: 'python', available: true, source: 'venv' },
          { name: 'ir', displayName: 'R', language: 'R', available: true, source: 'kernelspec' },
        ],
      },
    })
    // No cell was run: opening the notebook is enough to connect, and it connects to the
    // kernel the file asks for, not the workspace default.
    await act(async () => {
      await vi.waitFor(() => { expect(api.kernelStart).toHaveBeenCalledWith('ws-1', 'nb.ipynb', 'ir') })
    })
  })

  it('does not auto-connect when nothing in the workspace is startable', async () => {
    const { api } = setup(nb([code('c1', 'a')]), {
      discover: {
        usable: false,
        environments: [],
        kernels: [{ name: 'python3', displayName: 'Python 3', language: 'python', available: false, reason: 'no ipykernel', source: 'venv' }],
      },
    })
    await act(async () => {
      await vi.waitFor(() => { expect(api.kernelDiscover).toHaveBeenCalled() })
    })
    // A workspace with no usable kernel says so through the picker; it must not raise a
    // start failure the reader never asked for.
    await new Promise(resolve => { setTimeout(resolve, 40) })
    expect(api.kernelStart).not.toHaveBeenCalled()
  })
})


