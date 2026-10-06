// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { zh } from '../src/client/locales.ts'
import type { WorkbenchTerminalTab } from '../src/client/controller.ts'
import { TerminalSurface } from '../src/client/terminal/TerminalSurface.tsx'

const terminalHarness = vi.hoisted(() => ({
  instances: [] as Array<{
    write: ReturnType<typeof vi.fn>
    resize: ReturnType<typeof vi.fn>
    reset: ReturnType<typeof vi.fn>
    focus: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
    emitData(data: string): void
  }>,
  fitInstances: [] as Array<{ proposeDimensions: ReturnType<typeof vi.fn> }>,
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    readonly cols = 80
    readonly rows = 24
    readonly options: Record<string, unknown> = {}
    readonly write = vi.fn((_data: string, callback?: () => void) => { callback?.() })
    readonly resize = vi.fn()
    readonly reset = vi.fn()
    readonly focus = vi.fn()
    readonly dispose = vi.fn()
    private dataListener: ((data: string) => void) | undefined
    constructor() { terminalHarness.instances.push(this) }
    loadAddon() {}
    open() {}
    onData(listener: (data: string) => void) {
      this.dataListener = listener
      return { dispose: vi.fn() }
    }
    onResize() { return { dispose: vi.fn() } }
    emitData(data: string) { this.dataListener?.(data) }
  },
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    readonly proposeDimensions = vi.fn(() => ({ cols: 120, rows: 50 }))
    constructor() { terminalHarness.fitInstances.push(this) }
  },
}))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ children, size: _size, variant: _variant, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { size?: string; variant?: string }) => <button {...props}>{children}</button>,
}))

beforeEach(() => {
  terminalHarness.instances.length = 0
  terminalHarness.fitInstances.length = 0
  FakeResizeObserver.instances.length = 0
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('中栏终端画布', () => {
  it('挂载官方 TerminalView，转发输入并回写服务端帧', () => {
    const view = makeView({ render: { revision: 3, frame: { type: 'output', sequence: 3, data: '\u001b[32mok\u001b[0m' } } })
    const controller = controllerFake(view)
    const rendered = render(
      <TerminalSurface
        tab={terminalTab(1)}
        sessionId="session-1"
        active
        controller={controller as never}
        t={translate}
      />,
    )

    expect(view.mount).toHaveBeenCalled()
    const terminal = terminalHarness.instances[0]!
    expect(terminal.write).toHaveBeenCalledWith('\u001b[32mok\u001b[0m', expect.any(Function))
    expect(view.acknowledge).toHaveBeenCalledWith(3)
    act(() => { terminal.emitData('pwd\r') })
    expect(view.write).toHaveBeenCalledWith('pwd\r')
    // The connected+running phase is mirrored onto the tab for the rail/tab dots.
    expect(controller.setTerminalStatus).toHaveBeenCalledWith('terminal:1', 'running')
    rendered.unmount()
    expect(terminal.dispose).toHaveBeenCalled()
  })

  it('在展开且可写时把适配后的尺寸回传给官方模型', () => {
    const view = makeView()
    render(
      <TerminalSurface
        tab={terminalTab(2)}
        sessionId="session-1"
        active
        controller={controllerFake(view) as never}
        t={translate}
      />,
    )
    expect(view.resize).toHaveBeenCalledWith(120, 50)
  })

  it('尚未绑定会话时显示等待提示且不挂载视图', () => {
    const controller = { terminalView: vi.fn(() => undefined), setTerminalStatus: vi.fn() }
    const rendered = render(
      <TerminalSurface
        tab={terminalTab(3)}
        sessionId={undefined}
        active
        controller={controller as never}
        t={translate}
      />,
    )
    expect(rendered.getByText(zh['terminal.noSession'])).toBeTruthy()
  })

  it('为失败的终端提供原位重试入口', () => {
    const view = makeView({ phase: 'failed', writable: false, info: undefined })
    const rendered = render(
      <TerminalSurface
        tab={terminalTab(4)}
        sessionId="session-1"
        active
        controller={controllerFake(view) as never}
        t={translate}
      />,
    )
    fireEvent.click(rendered.getByRole('button', { name: zh['terminal.retry'] }))
    expect(view.refresh).toHaveBeenCalled()
  })

  it('为断开的终端提供重连入口', () => {
    const view = makeView({ phase: 'disconnected', writable: false })
    const rendered = render(
      <TerminalSurface
        tab={terminalTab(5)}
        sessionId="session-1"
        active
        controller={controllerFake(view) as never}
        t={translate}
      />,
    )
    fireEvent.click(rendered.getByRole('button', { name: zh['terminal.restart'] }))
    expect(view.connect).toHaveBeenCalled()
  })

  it('只读终端提供获取控制权的入口', () => {
    const view = makeView({ writable: false })
    const rendered = render(
      <TerminalSurface
        tab={terminalTab(6)}
        sessionId="session-1"
        active
        controller={controllerFake(view) as never}
        t={translate}
      />,
    )
    fireEvent.click(rendered.getByRole('button', { name: zh['terminal.control'] }))
    expect(view.connect).toHaveBeenCalled()
  })
})

interface FakeView {
  id: string
  state: { getSnapshot: () => Record<string, unknown>; subscribe: (listener: () => void) => () => void }
  mount: ReturnType<typeof vi.fn>
  write: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
  acknowledge: ReturnType<typeof vi.fn>
  refresh: ReturnType<typeof vi.fn>
  connect: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
}

function makeView(patch: Record<string, unknown> = {}): FakeView {
  const listeners = new Set<() => void>()
  let state: Record<string, unknown> = {
    phase: 'connected',
    writable: true,
    environment: { cwd: '/', maxInputBytes: 65536, maxCols: 500, maxRows: 200, scrollback: 1000 },
    info: { id: 'term', title: 'zsh', shell: { path: '/zsh', args: [], name: 'zsh' }, cwd: '/', cols: 80, rows: 24, state: 'running', exitCode: null },
    ...patch,
  }
  return {
    id: 'term',
    state: {
      getSnapshot: () => state,
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    },
    mount: vi.fn(() => vi.fn()),
    write: vi.fn(),
    resize: vi.fn(),
    acknowledge: vi.fn(),
    refresh: vi.fn(() => Promise.resolve()),
    connect: vi.fn(),
    close: vi.fn(() => Promise.resolve()),
    dispose: vi.fn(() => Promise.resolve()),
  }
}

function controllerFake(view: FakeView) {
  return {
    terminalView: vi.fn(() => view),
    setTerminalStatus: vi.fn(),
  }
}

function terminalTab(sequence: number): WorkbenchTerminalTab {
  return { id: `terminal:${sequence}`, kind: 'terminal', sequence, contentId: `wbterm:workspace-1:terminal:${sequence}`, status: 'connecting' }
}

function translate(key: keyof typeof zh, values?: Record<string, string>): string {
  const template = zh[key]
  if (values === undefined) return template
  return Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, value), template)
}

class FakeResizeObserver {
  static readonly instances: FakeResizeObserver[] = []
  readonly observe = vi.fn()
  readonly disconnect = vi.fn()
  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this)
  }
  trigger(): void {
    this.callback([], this as unknown as ResizeObserver)
  }
}
