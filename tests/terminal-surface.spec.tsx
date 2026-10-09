// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { zh } from '../src/client/core/locales.ts'
import type { WorkbenchTerminalTab } from '../src/client/model/controller.ts'
import { TerminalSurface } from '../src/client/terminal/TerminalSurface.tsx'
import { EDITOR_TRANSITION_END_EVENT, EDITOR_TRANSITION_START_EVENT } from '../src/client/layout/editor-layout-contract.ts'

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
        active
        controller={controllerFake(view) as never}
        t={translate}
      />,
    )
    expect(view.resize).toHaveBeenCalledWith(120, 50)
  })

  it('终端从 connecting 变为可写后重新适配并回传尺寸', () => {
    const view = makeView({ phase: 'connecting', writable: false })
    render(
      <TerminalSurface
        tab={terminalTab(7)}
        active
        controller={controllerFake(view) as never}
        t={translate}
      />,
    )
    // Not writable yet: the emulator must not adopt a size or notify the model.
    expect(view.resize).not.toHaveBeenCalled()
    // Connecting -> running with no host resize: fit has to be retried here.
    act(() => { view.set({ phase: 'connected', writable: true }) })
    expect(view.resize).toHaveBeenCalledWith(120, 50)
  })

  it('快照网格大于可见窗格时按容器尺寸回适，避免底部行被裁切', () => {
    const view = makeView({
      render: {
        revision: 1,
        frame: { type: 'snapshot', info: { cols: 80, rows: 24, state: 'running' }, screen: 'dir output' },
      },
    })
    render(
      <TerminalSurface
        tab={terminalTab(8)}
        active
        controller={controllerFake(view) as never}
        t={translate}
      />,
    )
    const terminal = terminalHarness.instances[0]!
    // The snapshot first applies the server's 24-row grid, then the reconcile
    // re-fits to the container, so the last resize is the fitted one (not 80x24).
    expect(terminal.resize).toHaveBeenCalledWith(80, 24)
    expect(terminal.resize).toHaveBeenLastCalledWith(120, 50)
  })

  it('尚未绑定会话时显示等待提示且不挂载视图', () => {
    const controller = {
      terminalView: vi.fn(() => undefined),
      terminalBinding: vi.fn(() => 'noSession' as const),
      setTerminalStatus: vi.fn(),
      setTerminalShell: vi.fn(),
      setTerminalTitle: vi.fn(),
      setTerminalRuntime: vi.fn(),
      recordTerminalOwner: vi.fn(),
      reopenTerminalHere: vi.fn(),
    }
    const rendered = render(
      <TerminalSurface
        tab={terminalTab(3)}
        active
        controller={controller as never}
        t={translate}
      />,
    )
    expect(rendered.getByText(zh['terminal.noSession'])).toBeTruthy()
    // Nothing to attach to, so the model is never resolved for a view.
    expect(controller.terminalView).not.toHaveBeenCalled()
  })

  it('原终端已消失时用重新打开替换无效的重试', () => {
    const view = makeView({ phase: 'failed', writable: false, issue: 'missingTerminal', info: undefined })
    const controller = controllerFake(view)
    const rendered = render(
      <TerminalSurface
        tab={terminalTab(15)}
        active
        controller={controller as never}
        t={translate}
      />,
    )
    expect(rendered.getByText(zh['terminal.missingTerminal'])).toBeTruthy()
    fireEvent.click(rendered.getByRole('button', { name: zh['terminal.reopen'] }))
    // Retrying the same view re-reads the stale content binding and fails again,
    // so recovery must take a new identity instead.
    expect(controller.reopenTerminalHere).toHaveBeenCalledWith('terminal:15')
    expect(view.refresh).not.toHaveBeenCalled()
  })

  it('会话终端数量达上限时说明原因但不提供无效重试', () => {
    const view = makeView({ phase: 'failed', writable: false, issue: 'terminalLimit', info: undefined })
    const rendered = render(
      <TerminalSurface
        tab={terminalTab(16)}
        active
        controller={controllerFake(view) as never}
        t={translate}
      />,
    )
    expect(rendered.getByText(zh['terminal.limitReached'])).toBeTruthy()
    expect(rendered.queryByRole('button')).toBeNull()
  })

  it('为失败的终端提供原位重试入口', () => {
    const view = makeView({ phase: 'failed', writable: false, info: undefined })
    const rendered = render(
      <TerminalSurface
        tab={terminalTab(4)}
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
        active
        controller={controllerFake(view) as never}
        t={translate}
      />,
    )
    fireEvent.click(rendered.getByRole('button', { name: zh['terminal.control'] }))
    expect(view.connect).toHaveBeenCalled()
  })

  it('宿主网格与模拟器一致时不重复回传服务端尺寸', () => {
    const view = makeView()
    render(
      <TerminalSurface tab={terminalTab(9)} active controller={controllerFake(view) as never} t={translate} />,
    )
    const before = view.resize.mock.calls.length
    expect(before).toBeGreaterThanOrEqual(1)
    // The mock emulator is fixed at 80x24; proposing the same grid must hit the
    // idempotency guard and skip re-notifying the server.
    terminalHarness.fitInstances[0]!.proposeDimensions.mockReturnValue({ cols: 80, rows: 24 })
    FakeResizeObserver.instances[0]!.trigger()
    expect(view.resize.mock.calls.length).toBe(before)
  })

  it('按服务端 maxRows/maxCols 上限截断容器尺寸', () => {
    const view = makeView() // environment.maxCols = 500, maxRows = 200
    render(
      <TerminalSurface tab={terminalTab(12)} active controller={controllerFake(view) as never} t={translate} />,
    )
    terminalHarness.fitInstances[0]!.proposeDimensions.mockReturnValue({ cols: 600, rows: 500 })
    FakeResizeObserver.instances[0]!.trigger()
    expect(view.resize).toHaveBeenLastCalledWith(500, 200)
  })

  it('容器高度为零或行数不足时不回传尺寸', () => {
    const view = makeView()
    render(
      <TerminalSurface tab={terminalTab(13)} active controller={controllerFake(view) as never} t={translate} />,
    )
    const before = view.resize.mock.calls.length
    terminalHarness.fitInstances[0]!.proposeDimensions.mockReturnValue({ cols: 120, rows: 0 })
    FakeResizeObserver.instances[0]!.trigger()
    expect(view.resize.mock.calls.length).toBe(before)

    terminalHarness.fitInstances[0]!.proposeDimensions.mockReturnValue({ cols: 120, rows: 40 })
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(0)
    FakeResizeObserver.instances[0]!.trigger()
    expect(view.resize.mock.calls.length).toBe(before)
  })

  it('编辑器轨道过渡期间挂起 fit，过渡结束后补算尺寸', () => {
    const view = makeView({ phase: 'connecting', writable: false })
    render(
      <TerminalSurface tab={terminalTab(10)} active controller={controllerFake(view) as never} t={translate} />,
    )
    document.body.dispatchEvent(new Event(EDITOR_TRANSITION_START_EVENT, { bubbles: true }))
    // Terminal becomes ready mid-transition: fit is deferred, not applied.
    act(() => { view.set({ phase: 'connected', writable: true }) })
    expect(view.resize).not.toHaveBeenCalled()
    // Transition ends: the pending fit runs and reports the fitted grid.
    document.body.dispatchEvent(new Event(EDITOR_TRANSITION_END_EVENT, { bubbles: true }))
    expect(view.resize).toHaveBeenCalledWith(120, 50)
  })

  it('宿主主题令牌变化时重算 xterm 主题', async () => {
    const view = makeView()
    render(
      <TerminalSurface tab={terminalTab(11)} active controller={controllerFake(view) as never} t={translate} />,
    )
    const terminal = terminalHarness.instances[0]!
    expect(terminal.options.theme).toBeUndefined()
    await act(async () => {
      document.body.setAttribute('data-ds-dark-theme', 'true')
      await new Promise(resolve => { setTimeout(resolve, 0) })
    })
    expect(terminal.options.theme).toBeDefined()
    document.body.removeAttribute('data-ds-dark-theme')
  })
})

interface FakeView {
  id: string
  state: { getSnapshot: () => Record<string, unknown>; subscribe: (listener: () => void) => () => void }
  set: (patch: Record<string, unknown>) => void
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
    set: (patch) => {
      state = { ...state, ...patch }
      for (const listener of [...listeners]) listener()
    },
    mount: vi.fn(() => vi.fn()),
    write: vi.fn(),
    resize: vi.fn(),
    acknowledge: vi.fn(),
    rename: vi.fn(() => Promise.resolve()),
    refresh: vi.fn(() => Promise.resolve()),
    connect: vi.fn(),
    close: vi.fn(() => Promise.resolve()),
    dispose: vi.fn(() => Promise.resolve()),
  }
}

function controllerFake(view: FakeView) {
  return {
    terminalView: vi.fn(() => view),
    terminalBinding: vi.fn(() => 'ready' as const),
    setTerminalStatus: vi.fn(),
    setTerminalShell: vi.fn(),
    setTerminalTitle: vi.fn(),
    setTerminalRuntime: vi.fn(),
    recordTerminalOwner: vi.fn(),
    reopenTerminalHere: vi.fn(),
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
