// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ReactNode } from 'react'
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
  CodeEditor: ({ value, onChange, ariaLabel, cell, path, onCursorChange }: {
    value: string
    ariaLabel: string
    onChange: (value: string) => void
    cell?: boolean
    path?: string
    onCursorChange?: (cursor: { offset: number }) => void
  }) => (
    <textarea
      aria-label={ariaLabel}
      value={value}
      data-cell={cell === true || undefined}
      data-lang-path={path}
      data-testid={`cell-editor-${ariaLabel.split(' ')[0]}`}
      onChange={event => {
        onChange(event.target.value)
        onCursorChange?.({ offset: event.target.selectionStart ?? 0 })
      }}
      onClick={event => {
        // A real editor reports the caret as the reader moves it; the cell needs that
        // offset to split where the cursor actually is.
        onCursorChange?.({ offset: (event.target as HTMLTextAreaElement).selectionStart ?? 0 })
      }}
    />
  ),
}))

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  MarkdownText: ({ text, pathImages }: {
    text: string
    pathImages?: { resolve: (destination: string) => string | undefined }
  }) => {
    // A stand-in for the real renderer's local-image contract: when the source references an
    // `attachment:` destination, ask the owner to resolve it and record the answer, so a test
    // can see whether this cell handed the renderer the bytes the reader put in the file.
    const reference = /attachment:[^\s)]+/u.exec(text)?.[0]
    return (
      <div
        data-testid="markdown"
        data-attachment-src={reference === undefined ? undefined : pathImages?.resolve(reference)}
      >{text}</div>
    )
  },
  // Replace DSH's native Menu with a plain list so its items are assertable, exactly as
  // the file tree's spec does: the anchor (the trigger the reader clicks) stays in the
  // tree, and an open list becomes role="menu" rows. The test still only observes public
  // behaviour — which rows appear, whether they are disabled, what the click writes.
  Menu: (props: {
    open?: boolean
    items?: { id: string; label?: string; disabled?: boolean }[]
    onSelect?: (id: string) => void
    anchor?: unknown
  }) => (
    <>
      {props.anchor as ReactNode}
      {props.open === true && (
        <div role="menu">
          {(props.items ?? []).filter(item => item.label !== undefined).map(item => (
            <button key={item.id} role="menuitem" disabled={item.disabled} onClick={() => { props.onSelect?.(item.id) }}>{item.label}</button>
          ))}
        </div>
      )}
    </>
  ),
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

/** A `DOMRect` good enough for the drag geometry this file needs (top and height only). */
function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left, top, width, height,
    right: left + width, bottom: top + height,
    x: left, y: top, toJSON: () => ({}),
  } as DOMRect
}

/**
 * Give three cells stacked one per 100px so a `clientY` says which half of which cell it
 * landed in: c1 occupies 0-100, c2 100-200, c3 200-300.
 */
function stubCellRects(container: HTMLElement): void {
  const cells = [...container.querySelectorAll('[data-cell-id]')]
  expect(cells).toHaveLength(3)
  cells.forEach((cell, index) => {
    cell.getBoundingClientRect = () => rect(0, index * 100, 400, 100)
  })
}

/** The header strip of one cell, which is where a drag of that cell starts. */
function cellHandle(container: HTMLElement, cellId: string): HTMLElement {
  const handle = container.querySelector<HTMLElement>(`[data-cell-id="${cellId}"] [data-cell-handle]`)
  if (handle === null) throw new Error(`no drag handle for ${cellId}`)
  return handle
}

/** One cell's whole row, which is the drop target. */
function cellRow(container: HTMLElement, cellId: string): HTMLElement {
  const row = container.querySelector<HTMLElement>(`[data-cell-id="${cellId}"]`)
  if (row === null) throw new Error(`no row for ${cellId}`)
  return row
}

/**
 * A `DataTransfer` stand-in that records what was stored rather than knowing the payload up
 * front. One object belongs to one gesture: the cell id only exists after a `dragStart` has
 * put it there, so a `drop` that never began on the drag handle has nothing to move. A stub
 * pre-filled with the id would pass even if the handle did nothing, which is precisely the
 * regression this gesture test must catch — a `draggable` row would turn selecting code into
 * moving cells, and only an honest payload tells them apart.
 *
 * `types` is a live view of what was stored, because that is all a `dragover` may read: the
 * browser locks payload *values* mid-drag so a page cannot sniff what is about to be dropped.
 */
function fakeTransfer(): {
  types: string[]
  getData: (requested: string) => string
  setData: (requested: string, value: string) => void
  dropEffect: string
  effectAllowed: string
} {
  const carried = new Map<string, string>()
  return {
    get types(): string[] { return [...carried.keys()] },
    getData: (requested: string) => carried.get(requested) ?? '',
    setData: (requested: string, value: string) => { carried.set(requested, value) },
    dropEffect: '',
    effectAllowed: '',
  }
}

/**
 * Fire a drag event that actually carries `clientY`.
 *
 * `fireEvent.dragOver(el, { clientY })` silently drops the coordinate in this environment:
 * jsdom exposes no constructible `DragEvent`, so testing-library builds a plain event and its
 * copy of leftover init keys dies on the setter-less `clientY` getter of the prototype. The
 * handler then sees `undefined`, every geometry comparison goes false, and the drag lands at
 * the end no matter where the pointer was — a test that would pass the *wrong* order. Defining
 * the properties on the event object is what makes the pointer position real.
 *
 * The `dataTransfer` is passed in, not created here, because one belongs to one gesture: the
 * id it carries has to have been stored by the `dragStart` on the handle for a later `drop`
 * to know it.
 */
function fireDrag(
  el: Element,
  type: 'dragStart' | 'dragOver' | 'drop' | 'dragEnd',
  transfer: ReturnType<typeof fakeTransfer>,
  clientY?: number,
): Event {
  // The name handed to `dispatchEvent` is the *native* one, all lowercase: React listens for
  // `dragover`, not the `onDragOver` prop name a caller of this helper writes. Dispatching a
  // camel-cased type silently fires nothing, and every assertion downstream reads as "the
  // feature does not work".
  const native = type.toLowerCase()
  const event = new Event(native, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: transfer })
  if (clientY !== undefined) Object.defineProperty(event, 'clientY', { value: clientY })
  act(() => {
    el.dispatchEvent(event)
  })
  // Returned so a test can ask whether the surface *consumed* the event. Taking a drag the
  // notebook was not part of is a bug no output-side assertion can see.
  return event
}

/**
 * One complete drag: start on the handle of `movedId`, aim at `clientY` inside `movedId`'s
 * sibling `overId`, release. Returns the notebook text the surface wrote, or `null` when it
 * refused to write.
 */
function dragTo(
  view: { container: HTMLElement; onEdit: { mock: { calls: unknown[][] } } },
  movedId: string,
  overId: string,
  clientY: number,
): string | null {
  const transfer = fakeTransfer()
  fireDrag(cellHandle(view.container, movedId), 'dragStart', transfer)
  const row = cellRow(view.container, overId)
  fireDrag(row, 'dragOver', transfer, clientY)
  fireDrag(row, 'drop', transfer)
  const calls = view.onEdit.mock.calls
  return calls.length === 0 ? null : String(calls.at(-1)![0])
}

function cellIds(text: string): string[] {
  return (JSON.parse(text) as { cells: { id: string }[] }).cells.map(cell => cell.id)
}

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
    kernelRestart: vi.fn().mockResolvedValue({
      kernelId: 'k2', token: 't2', displayName: 'Python 3', specName: 'python3',
      language: 'python', phase: 'ready', sequence: 1,
    }),
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
function setup(draft: string, options: {
  editable?: boolean
  discover?: unknown
  dirty?: boolean
  saving?: boolean
  onSave?: () => void
  outlineVisible?: boolean
} = {}) {
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
  const onSave = options.onSave ?? vi.fn()
  // One tree, rendered twice on demand: a test that needs to flip `editable` *after* a
  // menu opened (which is how an external modification actually arrives) re-renders the
  // same surface rather than mounting a second one.
  const surface = (overrides: Partial<typeof options> = {}) => {
    const next = { ...options, ...overrides }
    return <NotebookSurface
      tabId="tab-1"
      path="nb.ipynb"
      workspaceId="ws-1"
      draft={holder.draft}
      editable={next.editable ?? true}
      runtime={runtime}
      onEdit={onEdit}
      dirty={next.dirty ?? false}
      saving={next.saving ?? false}
      outlineVisible={next.outlineVisible === true}
      onSave={onSave}
      labels={labels}
      markdownLabels={{ code: { copyLabel: 'copy', copiedLabel: 'copied' }, footnotes: 'notes' } as never}
    />
  }
  const view = render(surface())
  return { ...view, api, runtime, holder, onEdit, onSave, rerenderSurface: (overrides: Partial<typeof options> = {}) => { view.rerender(surface(overrides)) } }
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

  it('offers only Code and Markdown as kinds to create', () => {
    const draft = nb([code('c1', 'x = 1'), { cell_type: 'markdown', id: 'm1', source: '# t', metadata: {} }])
    const { getAllByLabelText } = setup(draft)
    // Raw is not a kind a reader picks here, so the picker carries two options.
    const selects = getAllByLabelText(labels.changeKind) as HTMLSelectElement[]
    expect(selects).toHaveLength(2)
    for (const select of selects) {
      expect([...select.options].map(option => option.value)).toEqual(['code', 'markdown'])
    }
  })

  it('still names a raw cell that came from the file', () => {
    // A `<select>` whose value matches no option shows the *first* one, so dropping the
    // raw choice entirely would have a raw cell in the file announce itself as "Code".
    const draft = nb([{ cell_type: 'raw', id: 'r1', source: 'plain', metadata: {} }])
    const { getByLabelText } = setup(draft)
    const select = getByLabelText(labels.changeKind) as HTMLSelectElement
    expect(select.value).toBe('raw')
    expect([...select.options].map(option => option.value)).toEqual(['code', 'markdown', 'raw'])
  })

  it('highlights exactly the one cell that was clicked', () => {
    const draft = nb([code('c1', 'a'), code('c2', 'b'), code('c3', 'c')])
    const { container, getByTestId } = setup(draft)
    const focused = () => [...container.querySelectorAll('[data-focused="true"]')]
      .map(node => node.getAttribute('data-cell-id'))
    expect(focused()).toEqual([])
    fireEvent.click(getByTestId('cell-editor-c2'))
    expect(focused()).toEqual(['c2'])
    // The regression this guards: focus used to live in each cell's own view state,
    // set true on click and never cleared, so every cell a reader had visited stayed
    // lit and the highlight said nothing about where they actually were.
    fireEvent.click(getByTestId('cell-editor-c1'))
    expect(focused()).toEqual(['c1'])
  })

  it('clears focus when the focused cell is deleted', () => {
    const draft = nb([code('c1', 'a'), code('c2', 'b')])
    const { getByTestId, getAllByLabelText, onEdit, runtime } = setup(draft)
    fireEvent.click(getByTestId('cell-editor-c1'))
    expect(runtime.state('tab-1').focusedCellId).toBe('c1')
    fireEvent.click(getAllByLabelText(labels.deleteCell)[0] as Element)
    // A stale id would make the next Ctrl+Enter run nothing at all. Asserted on the
    // model rather than the DOM: this harness's `onEdit` records the written draft
    // without re-rendering, so the tree still shows the old cell.
    expect(runtime.state('tab-1').focusedCellId).toBeNull()
    const written = JSON.parse(onEdit.mock.calls.at(-1)![0] as string) as { cells: { id: string }[] }
    expect(written.cells.map(cell => cell.id)).toEqual(['c2'])
  })

  it('keeps focus when a different cell is deleted', () => {
    const draft = nb([code('c1', 'a'), code('c2', 'b')])
    const { getByTestId, getAllByLabelText, runtime } = setup(draft)
    fireEvent.click(getByTestId('cell-editor-c1'))
    // The second delete button belongs to c2, which is not focused.
    fireEvent.click(getAllByLabelText(labels.deleteCell)[1] as Element)
    expect(runtime.state('tab-1').focusedCellId).toBe('c1')
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

  it('saves the notebook from the toolbar', () => {
    const { getByLabelText, onSave } = setup(nb([code('c1', 'a')]), { dirty: true })
    fireEvent.click(getByLabelText(labels.save))
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('marks the save control rather than disabling it when there is nothing to save', () => {
    // A clean notebook still offers the action; going inert would read as a broken
    // button, and the reader cannot tell "saved" from "not working" by an icon.
    const { getByLabelText } = setup(nb([code('c1', 'a')]), { dirty: false })
    const button = getByLabelText(labels.save) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    expect(button.getAttribute('title')).toBe(labels.saveClean)
    expect(button.className).not.toContain('Active')
  })

  it('marks the save control while the file has unsaved changes', () => {
    const { getByLabelText } = setup(nb([code('c1', 'a')]), { dirty: true })
    const button = getByLabelText(labels.save) as HTMLButtonElement
    expect(button.getAttribute('title')).toBe(labels.saveDirty)
    expect(button.className).toContain('Active')
  })

  it('disables the save control while a save is in flight', () => {
    // A second save mid-flight would race the version token the first one is replacing.
    const { getByLabelText } = setup(nb([code('c1', 'a')]), { dirty: true, saving: true })
    expect((getByLabelText(labels.save) as HTMLButtonElement).disabled).toBe(true)
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

  it('restarts and runs the whole notebook from one toolbar command', async () => {
    const draft = nb([code('c1', 'a = 1'), { cell_type: 'markdown', id: 'm', source: '# prose', metadata: {} }, code('c2', 'print(a)')])
    const { api, getByLabelText, runtime } = setup(draft)
    await act(async () => {
      await runtime.ensureKernel('tab-1', 'ws-1', 'nb.ipynb')
    })
    await act(async () => {
      fireEvent.click(getByLabelText(labels.restartRunAll))
    })
    // One press: the restart happened and the first cell is already on its way, so the
    // reader does not have to wait for the kernel and press again.
    expect(api.kernelRestart).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => { expect(api.kernelExecute).toHaveBeenCalledTimes(1) })
    expect(api.kernelExecute.mock.calls[0]![0]).toMatchObject({ kernelId: 'k2', cellId: 'c1' })
    // The Markdown cell is not sent, and the second code cell waits in the queue the strip
    // reads, so the command reports what it still owes.
    expect(runtime.pendingQueueLength('tab-1')).toBe(1)
  })

  it('leaves nothing queued when the restart fails', async () => {
    const { api, getByLabelText, runtime } = setup(nb([code('c1', 'a = 1'), code('c2', 'print(a)')]))
    await act(async () => {
      await runtime.ensureKernel('tab-1', 'ws-1', 'nb.ipynb')
    })
    api.kernelRestart.mockRejectedValueOnce(new Error('the kernel could not be restarted'))
    await act(async () => {
      fireEvent.click(getByLabelText(labels.restartRunAll))
    })
    expect(api.kernelExecute).not.toHaveBeenCalled()
    expect(runtime.pendingQueueLength('tab-1')).toBe(0)
  })
})

describe('notebook cell menu', () => {
  /** One stored output, in the shape `.ipynb` keeps it. */
  const streamOutput = (text: string): Record<string, unknown> => ({
    output_type: 'stream', name: 'stdout', text: [text],
  })

  /** Open one cell's action menu. The trigger is identified by the menu's own label. */
  const openMenu = (view: ReturnType<typeof setup>, index = 0): void => {
    fireEvent.click(view.getAllByLabelText(labels.cellMenu)[index]!)
  }

  /** `.ipynb` stores source as a string or a list of kept-newline lines; read either. */
  const joinSource = (source: string | string[]): string =>
    typeof source === 'string' ? source : source.join('')

  it('clears only the cell whose menu was used', () => {
    // The per-cell action exists because clearing everything is not what a reader wants
    // after one noisy cell: the other cells' stored output must survive untouched.
    const draft = nb([
      { ...code('c1', 'print(1)', { execution_count: 4, outputs: [streamOutput('one\n')] }) },
      { ...code('c2', 'print(2)', { execution_count: 5, outputs: [streamOutput('two\n')] }) },
    ])
    const view = setup(draft)
    openMenu(view)
    fireEvent.click(view.getByRole('menuitem', { name: labels.clearCellOutputs }))
    const written = JSON.parse(view.onEdit.mock.calls[0]![0] as string) as {
      cells: { id: string; outputs: unknown[]; execution_count: number | null }[]
    }
    expect(written.cells[0]?.outputs).toEqual([])
    expect(written.cells[0]?.execution_count).toBeNull()
    expect(written.cells[1]?.outputs).toEqual([streamOutput('two\n')])
    expect(written.cells[1]?.execution_count).toBe(5)
    // Selecting a row closes the menu: the rows are a choice, not a persistent panel,
    // and every other menu in the workbench closes on select.
    expect(view.queryByRole('menu')).toBeNull()
  })

  it('clears a cell this session ran, not only the file\'s stored output', () => {
    // The screen shows what the reducer collected for a cell that has run here, and the
    // file shows what was written. Clearing only one of the two would leave the reader
    // staring at output they just asked to remove.
    const view = setup(nb([code('c1', 'print(1)')]))
    view.runtime.runCell('tab-1', 'ws-1', 'nb.ipynb', 'c1', 'print(1)')
    frame(view.runtime, 1, { type: 'cell_started', msgId: 'm1', cellId: 'c1', code: 'print(1)', executionCount: 1 })
    frame(view.runtime, 2, {
      type: 'cell_output', msgId: 'm1', cellId: 'c1', truncated: false,
      item: { kind: 'stream', name: 'stdout', text: 'shown\n' },
    })
    frame(view.runtime, 3, { type: 'cell_completed', msgId: 'm1', cellId: 'c1', status: 'ok', executionCount: 1 })
    expect(view.getByText('shown')).toBeTruthy()
    openMenu(view)
    fireEvent.click(view.getByRole('menuitem', { name: labels.clearCellOutputs }))
    expect(view.queryByText('shown')).toBeNull()
    expect(view.runtime.state('tab-1').cells['c1']).toBeUndefined()
  })

  it('merges the cell below into this one', () => {
    // Merge has to take the neighbour's output with its source: dropping it would make
    // the action destroy a result the reader can see on screen.
    const draft = nb([
      { ...code('c1', 'print(1)', { execution_count: 4, outputs: [streamOutput('one\n')] }) },
      { ...code('c2', 'print(2)', { execution_count: 5, outputs: [streamOutput('two\n')] }) },
    ])
    const view = setup(draft)
    openMenu(view)
    fireEvent.click(view.getByRole('menuitem', { name: labels.mergeDown }))
    const written = JSON.parse(view.onEdit.mock.calls[0]![0] as string) as {
      cells: { id: string; source: string[] | string; outputs: unknown[] }[]
    }
    expect(written.cells).toHaveLength(1)
    expect(joinSource(written.cells[0]!.source)).toBe('print(1)\nprint(2)')
    expect(written.cells[0]?.outputs).toHaveLength(2)
  })

  it('forgets both session copies when merging, so the screen shows the merged file', () => {
    // The file keeps both cells' output after a merge, but the screen renders *this
    // session's* copy of the surviving cell — which only ever had that cell's own output.
    // Without dropping both session copies the reader watches the vanished cell's output
    // disappear even though it is still in the file, so a merge has to clear the merged
    // cell and the cell that goes away.
    const view = setup(nb([code('c1', 'print(1)'), code('c2', 'print(2)')]))
    frame(view.runtime, 1, { type: 'cell_started', msgId: 'm1', cellId: 'c1', code: 'print(1)', executionCount: 1 })
    frame(view.runtime, 2, { type: 'cell_output', msgId: 'm1', cellId: 'c1', truncated: false, item: { kind: 'stream', name: 'stdout', text: 'one\n' } })
    frame(view.runtime, 3, { type: 'cell_completed', msgId: 'm1', cellId: 'c1', status: 'ok', executionCount: 1 })
    frame(view.runtime, 4, { type: 'cell_started', msgId: 'm2', cellId: 'c2', code: 'print(2)', executionCount: 2 })
    frame(view.runtime, 5, { type: 'cell_output', msgId: 'm2', cellId: 'c2', truncated: false, item: { kind: 'stream', name: 'stdout', text: 'two\n' } })
    frame(view.runtime, 6, { type: 'cell_completed', msgId: 'm2', cellId: 'c2', status: 'ok', executionCount: 2 })
    expect(view.runtime.state('tab-1').cells['c2']?.outputs).toHaveLength(1)
    openMenu(view)
    fireEvent.click(view.getByRole('menuitem', { name: labels.mergeDown }))
    expect(view.runtime.state('tab-1').cells['c1']).toBeUndefined()
    expect(view.runtime.state('tab-1').cells['c2']).toBeUndefined()
  })

  it('offers no merge row for the last cell', () => {
    // There is nothing below to merge with, and a row that cannot do anything reads as
    // a broken control rather than one that does not apply.
    const view = setup(nb([code('c1', 'only')]))
    openMenu(view)
    expect(view.getByRole('menuitem', { name: labels.mergeDown }).hasAttribute('disabled')).toBe(true)
  })

  it('splits the cell at the cursor the editor reported', () => {
    // The split point comes from the cell's own editor, not from a guess: a cell cut at
    // the wrong offset silently rearranges code, which is worse than not splitting.
    const view = setup(nb([code('c1', 'alpha\n')]))
    const editor = view.getByTestId('cell-editor-c1') as HTMLTextAreaElement
    editor.setSelectionRange(3, 3)
    fireEvent.click(editor)
    openMenu(view)
    fireEvent.click(view.getByRole('menuitem', { name: labels.splitCell }))
    const written = JSON.parse(view.onEdit.mock.calls.at(-1)![0] as string) as {
      cells: { id: string; source: string[] | string; outputs: unknown[]; execution_count: number | null }[]
    }
    expect(written.cells).toHaveLength(2)
    expect(joinSource(written.cells[0]!.source)).toBe('alp')
    expect(joinSource(written.cells[1]!.source)).toBe('ha\n')
    // The second half is a fresh cell: no output and no prompt number of its own.
    expect(written.cells[0]?.id).not.toBe(written.cells[1]?.id)
    expect(written.cells[1]?.outputs).toEqual([])
    expect(written.cells[1]?.execution_count).toBeNull()
  })

  it('offers no split row for a cell whose editor is not open', () => {
    // A rendered Markdown cell has no editor mounted, so there is no caret to split at.
    // (A code cell is never in this state: its editor reports the caret as soon as it
    // mounts, which is why the split rows below are live without any clicking.)
    const view = setup(nb([{ cell_type: 'markdown', id: 'm1', source: '# Title', metadata: {} }]))
    openMenu(view)
    expect(view.getByRole('menuitem', { name: labels.splitCell }).hasAttribute('disabled')).toBe(true)
  })

  it('refuses the menu while the file is externally modified', () => {
    // `editable: false` is the external-change state, and a structural edit made there
    // would be written into a file that no longer matches what is on disk.
    const view = setup(nb([code('c1', 'x = 1')]), { editable: false })
    expect((view.getByLabelText(labels.cellMenu) as HTMLButtonElement).disabled).toBe(true)
  })

  it("disables the open menu's structural rows when the file stops accepting edits", () => {
    // The trigger's own `disabled` cannot be the only guard: the modification is detected
    // on a poll, so a menu that is already open stays on screen while the file behind it
    // has become uneditable, and a row lit in that moment promises an edit the surface will
    // refuse. The two run rows keep working, because a run is not an edit: neither the
    // per-cell run button nor the toolbar's Run All is disabled in that state either.
    const view = setup(nb([
      code('c0', 'setup = 1'),
      { ...code('c1', 'print(1)', { execution_count: 1, outputs: [streamOutput('one\n')] }) },
      code('c2', 'y = 2'),
    ]))
    // A caret the editor reported, so the split row is genuinely available to begin with.
    fireEvent.click(view.getByTestId('cell-editor-c1'))
    // The middle cell, so every row has something it could act on: one runnable cell above,
    // one below, an output to clear and a neighbour to merge with.
    openMenu(view, 1)
    const editRows = [labels.splitCell, labels.clearCellOutputs, labels.mergeDown]
    const runRows = [labels.runAbove, labels.runBelow]
    for (const name of [...editRows, ...runRows]) {
      expect(view.getByRole('menuitem', { name }).hasAttribute('disabled'), name).toBe(false)
    }
    view.rerenderSurface({ editable: false })
    for (const name of editRows) {
      expect(view.getByRole('menuitem', { name }).hasAttribute('disabled'), name).toBe(true)
    }
    for (const name of runRows) {
      expect(view.getByRole('menuitem', { name }).hasAttribute('disabled'), name).toBe(false)
    }
  })

  it('offers no output-clearing row for a markdown cell', () => {
    // A Markdown cell has no output to clear: the row would promise an effect that
    // cannot exist for this kind.
    const view = setup(nb([
      { cell_type: 'markdown', id: 'm1', source: '# Title', metadata: {} },
      code('c1', 'x = 1'),
    ]))
    openMenu(view)
    expect(view.getByRole('menuitem', { name: labels.clearCellOutputs }).hasAttribute('disabled')).toBe(true)
    // Merging still applies: the cell below exists.
    expect(view.getByRole('menuitem', { name: labels.mergeDown }).hasAttribute('disabled')).toBe(false)
  })

  it('runs the cells below the menu\'s cell, in document order, skipping blanks', async () => {
    // The reader asks for "everything after this one" because a notebook only works in
    // sequence: the cells above define what the ones below compute. A cell with no code
    // in it must not be sent at all — the kernel would spend an execution number on
    // nothing and every later prompt would be off by one.
    const draft = nb([
      code('c1', 'a = 1'),
      { cell_type: 'markdown', id: 'm', source: '# skip', metadata: {} },
      code('c2', 'b = 2'),
      code('c3', '   '),
      code('c4', 'c = 3'),
    ])
    const view = setup(draft)
    openMenu(view, 0)
    await act(async () => {
      fireEvent.click(view.getByRole('menuitem', { name: labels.runBelow }))
    })
    // The first goes now; the rest queue behind it, so the readout can say what is owed.
    expect(view.api.kernelExecute).toHaveBeenCalledTimes(1)
    expect(view.api.kernelExecute.mock.calls[0]![0]).toMatchObject({ cellId: 'c2' })
    expect(view.runtime.pendingQueueLength('tab-1')).toBe(1)
    // The status bar reads the same queue through this exact accessor, so the stretch's
    // debt shows up in the strip without any per-command wiring.
    expect(view.runtime.peekPendingQueueLength('tab-1')).toBe(1)
    // The queue continues on the kernel's own idle signal, not on a timer.
    frame(view.runtime, 1, { type: 'cell_completed', msgId: 'm1', cellId: 'c2', status: 'ok', executionCount: 1 })
    frame(view.runtime, 2, { type: 'phase', phase: 'ready' })
    await vi.waitFor(() => { expect(view.api.kernelExecute).toHaveBeenCalledTimes(2) })
    expect(view.api.kernelExecute.mock.calls[1]![0]).toMatchObject({ cellId: 'c4' })
    await new Promise(resolve => { setTimeout(resolve, 60) })
    // `c3` is blank and `m` is Markdown: neither is ever sent.
    expect(view.api.kernelExecute).toHaveBeenCalledTimes(2)
  })

  it('runs the cells above the menu\'s cell, in document order', async () => {
    const draft = nb([code('c1', 'a = 1'), code('c2', 'b = 2'), code('c3', 'print(c1, c2)')])
    const view = setup(draft)
    openMenu(view, 2)
    await act(async () => {
      fireEvent.click(view.getByRole('menuitem', { name: labels.runAbove }))
    })
    expect(view.api.kernelExecute.mock.calls[0]![0]).toMatchObject({ cellId: 'c1' })
    expect(view.runtime.pendingQueueLength('tab-1')).toBe(1)
    frame(view.runtime, 1, { type: 'cell_completed', msgId: 'm1', cellId: 'c1', status: 'ok', executionCount: 1 })
    frame(view.runtime, 2, { type: 'phase', phase: 'ready' })
    await vi.waitFor(() => { expect(view.api.kernelExecute).toHaveBeenCalledTimes(2) })
    // The bounded cell itself is not run: "above" means what it depends on.
    expect(view.api.kernelExecute.mock.calls[1]![0]).toMatchObject({ cellId: 'c2' })
    await new Promise(resolve => { setTimeout(resolve, 60) })
    expect(view.api.kernelExecute).toHaveBeenCalledTimes(2)
  })

  it('abandons the rest of the run when the reader interrupts', async () => {
    // One interrupt has to stop the whole stretch, which is why the queue lives on the
    // tab instead of being a local list the click closed over.
    const draft = nb([code('c1', 'a'), code('c2', 'b'), code('c3', 'c'), code('c4', 'd')])
    const view = setup(draft)
    openMenu(view, 0)
    fireEvent.click(view.getByRole('menuitem', { name: labels.runBelow }))
    await act(async () => {
      await vi.waitFor(() => { expect(view.api.kernelExecute).toHaveBeenCalledTimes(1) })
    })
    expect(view.runtime.pendingQueueLength('tab-1')).toBe(2)
    await act(async () => {
      fireEvent.click(view.getByLabelText(labels.interrupt))
    })
    expect(view.runtime.pendingQueueLength('tab-1')).toBe(0)
    const after = view.api.kernelExecute.mock.calls.length
    frame(view.runtime, 1, { type: 'cell_completed', msgId: 'm1', cellId: 'c2', status: 'ok', executionCount: 1 })
    frame(view.runtime, 2, { type: 'phase', phase: 'ready' })
    await new Promise(resolve => { setTimeout(resolve, 60) })
    // Nothing half-queued survives: the kernel idle signal finds an empty queue.
    expect(view.api.kernelExecute).toHaveBeenCalledTimes(after)
  })

  it('bounds the run at the cell whose menu was used, not at the focused cell', async () => {
    // The row means "everything after *this* cell": the reader opened the menu on it, so
    // it is the cell they are pointing at. Following the model's focus instead would run
    // a stretch measured from some other cell they clicked earlier, and the row they chose
    // would quietly mean something else.
    const draft = nb([code('c1', 'a = 1'), code('c2', 'b = 2'), code('c3', 'print(a, b)')])
    const view = setup(draft)
    // Focus the first cell, then act on the last cell's menu.
    fireEvent.click(view.getByTestId('cell-editor-c1'))
    expect(view.runtime.state('tab-1').focusedCellId).toBe('c1')
    openMenu(view, 2)
    await act(async () => {
      fireEvent.click(view.getByRole('menuitem', { name: labels.runAbove }))
    })
    // Measured from c1 there is nothing above it; measured from c3 there are two cells.
    expect(view.api.kernelExecute.mock.calls[0]![0]).toMatchObject({ cellId: 'c1' })
    frame(view.runtime, 1, { type: 'cell_completed', msgId: 'm1', cellId: 'c1', status: 'ok', executionCount: 1 })
    frame(view.runtime, 2, { type: 'phase', phase: 'ready' })
    await vi.waitFor(() => { expect(view.api.kernelExecute).toHaveBeenCalledTimes(2) })
    expect(view.api.kernelExecute.mock.calls[1]![0]).toMatchObject({ cellId: 'c2' })
  })

  it('offers the raw kind as a cell to create', () => {
    // Raw was only ever recognised on read, so a reader who wants a plain-text block — the
    // usual reason for one, and what Jupyter's own "+ Raw" button exists for — had to
    // hand-edit the JSON to get it.
    const view = setup(nb([code('c1', 'x = 1')]))
    openMenu(view)
    fireEvent.click(view.getByRole('menuitem', { name: labels.insertRawBelow }))
    const written = JSON.parse(view.onEdit.mock.calls[0]![0] as string) as {
      cells: { cell_type: string; outputs?: unknown; execution_count?: unknown }[]
    }
    expect(written.cells).toHaveLength(2)
    // Raw's own field shape: no output and no prompt number, because a raw cell never runs.
    expect(written.cells[1]?.cell_type).toBe('raw')
    expect(written.cells[1]).not.toHaveProperty('outputs')
    expect(written.cells[1]).not.toHaveProperty('execution_count')
  })

  it('offers no run row when that side has nothing runnable', () => {
    // A row that can only ever submit an empty list reads as a control that broke, so it
    // is greyed out instead. Markdown and blank cells do not count as runnable.
    const view = setup(nb([
      { cell_type: 'markdown', id: 'm1', source: '# intro', metadata: {} },
      code('c1', 'a = 1'),
      { cell_type: 'markdown', id: 'm2', source: '# between', metadata: {} },
      code('c2', '   '),
      code('c3', 'print(a)'),
    ]))
    // c1 has only prose above it, so "run above" has nothing it could send.
    openMenu(view, 1)
    expect(view.getByRole('menuitem', { name: labels.runAbove }).hasAttribute('disabled')).toBe(true)
    // Below c1: a Markdown cell and a blank one (neither runnable) plus one real cell.
    expect(view.getByRole('menuitem', { name: labels.runBelow }).hasAttribute('disabled')).toBe(false)
    // From c3 the blank c2 is skipped, so "above" counts only c1 — one runnable cell.
    openMenu(view, 4)
    expect(view.getByRole('menuitem', { name: labels.runAbove }).hasAttribute('disabled')).toBe(false)
    expect(view.getByRole('menuitem', { name: labels.runBelow }).hasAttribute('disabled')).toBe(true)
  })
})

describe('notebook cell folding', () => {
  /** One stored output, in the shape `.ipynb` keeps it. */
  const streamOutput = (text: string): Record<string, unknown> => ({
    output_type: 'stream', name: 'stdout', text: [text],
  })

  it('collapses a cell to its header row, keeping the prompt and the kind readable', () => {
    // Folding exists so a long notebook can be skimmed: hiding the body is only useful if
    // what remains still says *which* cell it is and whether it ran.
    const view = setup(nb([
      { ...code('c1', 'secret = 1\nprint(secret)', { execution_count: 7, outputs: [streamOutput('1\n')] }) },
    ]))
    expect(view.getByTestId('cell-editor-c1')).toBeTruthy()
    fireEvent.click(view.getByLabelText(labels.collapseCell))
    // Body and output both go; the header keeps the number Jupyter gave this cell.
    expect(view.queryByTestId('cell-editor-c1')).toBeNull()
    expect(view.queryByText('1')).toBeNull()
    // A folded cell holds nothing but its header, so the cell's own text is the header's:
    // asking it for the prompt number says both survived and nothing else is left.
    const foldedCell = view.getByLabelText(labels.expandCell).closest('[data-cell-id]') as HTMLElement
    expect(foldedCell.textContent).toContain('[7]')
    // And the same control opens it again: a cell the reader cannot un-collapse would have
    // destroyed their work in the most convincing way.
    fireEvent.click(view.getByLabelText(labels.expandCell))
    expect(view.getByTestId('cell-editor-c1')).toBeTruthy()
  })

  it('collapses a markdown cell without leaving its rendered text behind', () => {
    // A text cell has two faces and folding has to cover both: collapsing the source while
    // the rendered prose stayed on screen would read as an action that half worked.
    const view = setup(nb([{ cell_type: 'markdown', id: 'm1', source: '# Title', metadata: {} }]))
    fireEvent.click(view.getByLabelText(labels.collapseCell))
    expect(view.queryByTestId('markdown')).toBeNull()
    expect(view.queryByTestId('cell-editor-m1')).toBeNull()
    // The row that is left names the kind it folded away.
    const foldedCell = view.getByLabelText(labels.expandCell).closest('[data-cell-id]') as HTMLElement
    expect(foldedCell.textContent).toContain(labels.markdownCell)
  })

  it('runs a collapsed cell and writes its output into the file anyway', async () => {
    // The reason folding is safe: it is a view state, not a change to the notebook. A
    // collapsed cell still runs and its output still lands — it is only not looked at
    // until the reader opens it again.
    const view = setup(nb([{ ...code('c1', 'print(1)', { execution_count: 1, outputs: [streamOutput('1\n')] }) }]))
    fireEvent.click(view.getByLabelText(labels.collapseCell))
    // Folded first, so this really is "run a hidden cell": the body is gone, only the
    // header's run control remains. Without this the test would pass on an unfolded cell too
    // and prove nothing about folding leaving the run path alone.
    expect(view.queryByTestId('cell-editor-c1')).toBeNull()
    await act(async () => {
      fireEvent.click(view.getByLabelText(labels.runCell))
    })
    expect(view.api.kernelExecute.mock.calls[0]![0]).toMatchObject({ cellId: 'c1', code: 'print(1)' })
    frame(view.runtime, 1, { type: 'cell_started', msgId: 'm1', cellId: 'c1', code: 'print(1)', executionCount: 2 })
    frame(view.runtime, 2, { type: 'cell_output', msgId: 'm1', cellId: 'c1', truncated: false, item: { kind: 'stream', name: 'stdout', text: '1\n' } })
    frame(view.runtime, 3, { type: 'cell_completed', msgId: 'm1', cellId: 'c1', status: 'ok', executionCount: 2 })
    // The run was committed to the draft even though nothing was visible while it happened.
    expect(view.holder.draft).toContain('"execution_count": 2')
  })
})

describe('notebook attachments', () => {
  it('hands a markdown cell\'s attachments to the renderer as a data URL', () => {
    // The whole point of reading `attachments` into the model: a figure dragged into a text
    // cell must show, not its alt text. The renderer is the boundary, so the assertion is
    // that this cell resolves the reference to the bytes the file carries.
    const draft = nb([{
      cell_type: 'markdown',
      id: 'm1',
      source: '![plot](attachment:plot.png)',
      metadata: {},
      attachments: { 'plot.png': { 'image/png': 'aGVsbG8=' } },
    }])
    const view = setup(draft)
    // A Markdown cell shows rendered by default, so its figure is visible without a click.
    expect(view.getByTestId('markdown').getAttribute('data-attachment-src')).toBe('data:image/png;base64,aGVsbG8=')
  })

  it('leaves an ordinary image path for the renderer\'s own rules', () => {
    // `a.png` is the author's relative path with no cell payload behind it; the surface has
    // no business resolving it, so it hands back nothing and the renderer decides.
    const view = setup(nb([{
      cell_type: 'markdown', id: 'm1', source: '![x](a.png)', metadata: {},
    }]))
    expect(view.getByTestId('markdown').getAttribute('data-attachment-src')).toBeNull()
  })
})

describe('notebook cell drag reorder', () => {
  const three = () => nb([code('c1', 'a'), code('c2', 'b'), code('c3', 'c')])

  it('drags from the header, not the whole row, so selecting text in a cell still works', () => {
    // The single most important thing a drag reorder can get wrong: `draggable` on the row
    // turns the reader's text selection inside the editor — or inside a rendered cell — into
    // a drag of the cell, so selecting code stops working. The handle is the header strip; the
    // row is only ever a target. Asserting the attribute location is what pins that down,
    // because the reorder itself behaves identically whichever element carries `draggable`.
    const view = setup(three())
    const row = cellRow(view.container, 'c1')
    expect(row.getAttribute('draggable')).not.toBe('true')
    expect(cellHandle(view.container, 'c1').getAttribute('draggable')).toBe('true')
  })

  it('moves the dragged cell to the gap the pointer is over, keeping its id', () => {
    // The whole point of a drag: any cell to any position, one gesture. Asserting the id
    // order (and that the cell's own source came with it) is what says the file really
    // reordered rather than the screen just looking reordered.
    const view = setup(three())
    stubCellRects(view.container)
    // The bottom half of the last cell means "after it", which is the end of the notebook.
    const text = dragTo(view, 'c1', 'c3', 260)
    expect(text !== null && cellIds(text)).toEqual(['c2', 'c3', 'c1'])
    const written = JSON.parse(text as string) as { cells: { id: string; source: string }[] }
    expect(written.cells[2]?.source).toBe('a')
  })

  it('has no off-by-one dropping into the first gap', () => {
    // The trap: aiming at the very top must put the cell *first*, not second. A removal
    // that is not accounted for lands it one short, and the reader's notebook is wrong.
    const view = setup(three())
    stubCellRects(view.container)
    // c3 upward, into the gap above the very first cell.
    const text = dragTo(view, 'c3', 'c1', 20)
    expect(text !== null && cellIds(text)).toEqual(['c3', 'c1', 'c2'])
  })

  it('has no off-by-one dropping past the last cell', () => {
    // The mirror trap, as its own mount: a second `render()` in one test would make the
    // first one's cells findable by the same test id.
    const view = setup(three())
    stubCellRects(view.container)
    // c1 downward, into the bottom half of the final cell.
    const text = dragTo(view, 'c1', 'c3', 299)
    expect(text !== null && cellIds(text)).toEqual(['c2', 'c3', 'c1'])
  })

  it('lands a downward drop in the middle of the notebook, not one short', () => {
    // Aiming *between* two cells is the case the ends hide: drop c1 into the top half of c3
    // and it belongs between c2 and c3. Ends clamp to the same answer whether or not the
    // lift-out shift is applied, so this middle case is what pins the adjustment down.
    const view = setup(three())
    stubCellRects(view.container)
    const text = dragTo(view, 'c1', 'c3', 210)
    expect(text !== null && cellIds(text)).toEqual(['c2', 'c1', 'c3'])
  })

  it('lands an upward drop in the middle of the notebook without over-shifting', () => {
    // The other half of the adjustment the ends cannot see: moving *up* is the branch where
    // the reported gap already sits at or above the lifted cell, so the shift must NOT apply.
    // c3 into the gap between c1 and c2 belongs as the second cell; an implementation that
    // subtracted unconditionally would put it first, and this is the only case that tells them
    // apart — the two middle-down tests pass under that bug, this one does not.
    const view = setup(three())
    stubCellRects(view.container)
    const text = dragTo(view, 'c3', 'c2', 120)
    expect(text !== null && cellIds(text)).toEqual(['c1', 'c3', 'c2'])
  })

  it('treats a drop into the gap beside a cell as the no-op it is', () => {
    // The top half of the cell below is the same position the dragged cell already holds, so
    // it must refuse the write. Left unchecked, a pointer that slips one row down marks a
    // saved notebook dirty for a gesture that moved nothing.
    const view = setup(three())
    stubCellRects(view.container)
    expect(dragTo(view, 'c1', 'c2', 120)).toBeNull()
  })

  it('leaves the file alone when a cell is dropped back on itself', () => {
    // A pointer that jitters on a cell fires a drop. Writing the same order back would mark
    // a saved notebook dirty for a gesture that changed nothing, so the edit is refused.
    const view = setup(three())
    stubCellRects(view.container)
    expect(dragTo(view, 'c2', 'c2', 120)).toBeNull()
  })

  it('shows one drop line at the gap being hovered, and clears it when the drag ends', () => {
    // The reader has to see *where* the cell will land, not just that a drag is happening:
    // the workbench's tab drag highlights its target the same way, and a reorder that drops
    // blind is how a notebook gets quietly mangled.
    const view = setup(three())
    stubCellRects(view.container)
    const transfer = fakeTransfer()
    fireDrag(cellHandle(view.container, 'c1'), 'dragStart', transfer)
    const third = cellRow(view.container, 'c3')
    const lines = () => [...view.container.querySelectorAll('[data-drop-before], [data-drop-after]')]
      .map(node => `${node.getAttribute('data-cell-id')}:${node.getAttribute('data-drop-before') === 'true' ? 'before' : 'after'}`)
    expect(lines()).toHaveLength(0)
    fireDrag(third, 'dragOver', transfer, 260)
    expect(lines()).toEqual(['c3:after'])
    // A pointer crossing to the other half moves the line, because the target changed.
    fireDrag(third, 'dragOver', transfer, 210)
    expect(lines()).toEqual(['c3:before'])
    fireDrag(third, 'drop', transfer)
    expect(lines()).toHaveLength(0)
  })

  it('keeps a cancelled drag from leaving a drop line on screen', () => {
    // Pressing escape, or dragging out of the window, fires dragend on the handle without any
    // drop. The highlight is the surface's, so the handle's dragend is what clears it.
    const view = setup(three())
    stubCellRects(view.container)
    const transfer = fakeTransfer()
    const handle = cellHandle(view.container, 'c1')
    fireDrag(handle, 'dragStart', transfer)
    fireDrag(cellRow(view.container, 'c3'), 'dragOver', transfer, 260)
    expect(view.container.querySelector('[data-drop-after]')).not.toBeNull()
    fireDrag(handle, 'dragEnd', transfer)
    expect(view.container.querySelector('[data-drop-before]')).toBeNull()
    expect(view.container.querySelector('[data-drop-after]')).toBeNull()
  })

  it('leaves a drag the notebook does not own unconsumed', () => {
    // The notebook is a drop *target* for its own cells only. A file dragged in from the OS,
    // or text the reader is moving inside an editor, arrives without our payload type; taking
    // that event (`preventDefault`) would declare it consumed and silently break whatever the
    // real target was about to do with it. Refusing to consume a foreign drop is the whole
    // difference between "reorders on its own drags" and "swallows every drag over it".
    const view = setup(three())
    stubCellRects(view.container)
    // A payload carrying a foreign type, never ours.
    const foreign = { types: ['Files'], getData: () => '', setData: () => {}, dropEffect: '', effectAllowed: '' }
    const row = cellRow(view.container, 'c2')
    const over = fireDrag(row, 'dragOver', foreign as ReturnType<typeof fakeTransfer>, 120)
    expect(over.defaultPrevented).toBe(false)
    expect(view.container.querySelector('[data-drop-before], [data-drop-after]')).toBeNull()
    const dropped = fireDrag(row, 'drop', foreign as ReturnType<typeof fakeTransfer>)
    expect(dropped.defaultPrevented).toBe(false)
    expect(view.onEdit).not.toHaveBeenCalled()
  })

  it('keeps a cell\'s output on that cell after it is dragged', () => {
    // Run state and stored output are both keyed by cell id, so a reorder that kept the ids
    // carries the plot along. The trap this guards: a drag that rebuilt the list without
    // preserving ids would leave c1's output sitting under some other cell — the screen would
    // look reordered but the file would have moved the *result* to the wrong place.
    const view = setup(nb([
      code('c1', 'plot()', { execution_count: 2, outputs: [{ output_type: 'stream', name: 'stdout', text: 'FIGURE-ONE\n' }] }),
      code('c2', 'b'),
      code('c3', 'c'),
    ]))
    stubCellRects(view.container)
    const text = dragTo(view, 'c1', 'c3', 260)
    const written = JSON.parse(text as string) as {
      cells: { id: string; outputs: { text?: unknown }[] }[]
    }
    // c1 now sits last, and the output is still *inside* c1's own record: the file and the
    // screen agree because both key the output to the id, which a reorder never rewrites.
    expect(written.cells.map(cell => cell.id)).toEqual(['c2', 'c3', 'c1'])
    expect(written.cells[2]?.outputs[0]?.['text']).toContain('FIGURE-ONE')
  })

  it('keeps a live run attached to the cell it belongs to after a drag', () => {
    // The ticket's "运行中/排队的格" in its real state, not just output saved in the file:
    // run state lives in the session keyed by cell id, and a reorder never rewrites ids, so a
    // cell mid-run keeps its `[*]` prompt and its running badge through the drag. The bug this
    // pins: a gesture that rebuilt a cell instead of moving it would orphan the live run — the
    // output would land on a cell the reader no longer sees as running.
    const view = setup(three())
    stubCellRects(view.container)
    frame(view.runtime, 1, { type: 'cell_started', msgId: 'm1', cellId: 'c1', code: 'a', executionCount: 4 })
    expect(view.getByText(labels.running)).toBeTruthy()
    const text = dragTo(view, 'c1', 'c3', 260)
    // The file moved c1 by its id, and the session still shows the run on that same cell.
    expect(text !== null && cellIds(text)).toEqual(['c2', 'c3', 'c1'])
    const row = cellRow(view.container, 'c1')
    expect(row.textContent).toContain(labels.running)
    expect(row.textContent).toContain('[*]')
  })

  it('refuses to start a drag or accept a drop while an external change is unresolved', () => {
    // Reordering is an edit, and every other edit is refused while the file disagrees with
    // what is on screen: dragging then would write a stale order over someone else's change.
    const view = setup(three(), { editable: false })
    stubCellRects(view.container)
    // The handle strip is always there, but it does not invite a grab: `draggable` is the
    // attribute that says whether this strip will move the cell right now, and a file that
    // cannot accept edits says no in the attribute rather than only inside the handler.
    expect(cellHandle(view.container, 'c1').getAttribute('draggable')).not.toBe('true')
    const first = cellRow(view.container, 'c1')
    const transfer = fakeTransfer()
    // Even a hand-forced drag over the row is refused: no highlight, no write.
    fireDrag(first, 'dragOver', transfer, 20)
    expect(first.getAttribute('data-drop-before')).toBeNull()
    fireDrag(first, 'drop', transfer)
    expect(view.onEdit).not.toHaveBeenCalled()
  })

  it('still offers the keyboard up and down moves', () => {
    // Dragging is a supplement. The arrows stay because they are reachable without a pointer,
    // and they are how a reordering gets undone one step at a time.
    const view = setup(three())
    const down = view.getAllByLabelText(labels.moveDown) as HTMLButtonElement[]
    expect(down).toHaveLength(3)
    expect(down[0]?.disabled).toBe(false)
    expect(down[2]?.disabled).toBe(true)
  })
})

describe('notebook outline panel', () => {
  it('lists the markdown headings in a panel that opens only when asked', () => {
    // Off by default: the panel spends horizontal room the reader did not ask for. This
    // mirrors the Markdown outline, which is a per-tab choice stored on the tab.
    const off = setup(nb([code('c1', 'a = 1')]))
    expect(off.queryByRole('navigation', { name: labels.outline })).toBeNull()
    // On: the rows use the same heading extractor the Markdown preview uses, so `# Setup`
    // reads identically in both views of one document. A code cell's source is not a heading
    // and stays out of the table of contents.
    const on = setup(nb([
      { cell_type: 'markdown', id: 'm1', source: '# Setup', metadata: {} },
      code('c1', 'df = load()'),
    ]), { outlineVisible: true })
    const nav = on.getByRole('navigation', { name: labels.outline })
    expect(nav.textContent).toContain('Setup')
    expect(nav.textContent).not.toContain('df = load()')
  })

  it('scrolls the cell an outline row names, not the row at that position', () => {
    let scrolled: Element | null = null
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function (this: Element) { scrolled = this }
    // `m1` carries two headings on purpose. The outline then holds three rows over two
    // cells, so an implementation that took "the cell at that outline position" would walk
    // off the end of the cell list rather than reaching `m2` — and a fixture where the two
    // orders agreed would let that mistake pass.
    const view = setup(nb([
      { cell_type: 'markdown', id: 'm1', source: '# First\n## Also first', metadata: {} },
      { cell_type: 'markdown', id: 'm2', source: '# Second', metadata: {} },
    ]), { outlineVisible: true })
    const nav = view.getByRole('navigation', { name: labels.outline })
    const row = Array.from(nav.querySelectorAll('button')).find(button => button.textContent === 'Second')!
    expect(Array.from(nav.querySelectorAll('button')).indexOf(row)).toBe(2)
    try {
      fireEvent.click(row)
    } finally {
      Element.prototype.scrollIntoView = original
    }
    // The row carries a cell id, not an ordinal, because the only thing stable across
    // insert / delete / move is the id — a heading index would jump the reader to whatever
    // now happens to sit at that position.
    expect(scrolled).not.toBeNull()
    expect(scrolled!.getAttribute('data-cell-id')).toBe('m2')
  })
})


