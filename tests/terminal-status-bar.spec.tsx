// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { zh } from '../src/client/core/locales.ts'
import type { WorkbenchTerminalTab } from '../src/client/model/controller.ts'
import { TerminalStatusBar } from '../src/client/terminal/TerminalStatusBar.tsx'

const t = (key: string, params?: Record<string, string>): string => {
  const value = (zh as Record<string, string>)[key] ?? key
  return params === undefined ? value : value.replace(/\{(\w+)\}/gu, (_, name: string) => params[name] ?? '')
}

function tab(overrides: Partial<WorkbenchTerminalTab> = {}): WorkbenchTerminalTab {
  return {
    id: 'terminal:1',
    kind: 'terminal',
    sequence: 1,
    contentId: 'wbterm:workspace-1:terminal:1',
    status: 'running',
    ...overrides,
  }
}

describe('终端状态条', () => {
  afterEach(cleanup)

  it('把宿主报告的事实按相位、Shell、尺寸、启动目录依次呈现', () => {
    const { container } = render(
      <TerminalStatusBar
        tab={tab({
          shellName: 'pwsh.exe',
          runtime: { cwd: 'F:\\repo', cols: 120, rows: 40, exitCode: null },
        })}
        binding="ready"
        t={t as never}
      />,
    )
    const items = Array.from(container.querySelectorAll('[role="contentinfo"] > span')).map(node => node.textContent)
    expect(items).toContain('pwsh')
    expect(items).toContain('120×40')
    expect(items).toContain('F:\\repo')
    expect(items).toContain(zh['terminal.running'])
  })

  it('未分配进程时只报相位，不编造 Shell、尺寸或目录', () => {
    const { container } = render(<TerminalStatusBar tab={tab({ status: 'connecting' })} binding="ready" t={t as never} />)
    const text = container.textContent ?? ''
    expect(text).toContain(zh['terminal.connecting'])
    expect(text).not.toContain('×')
  })

  it('没有会话可寻址时标记为未分配而非某个运行相位', () => {
    const { container } = render(<TerminalStatusBar tab={tab()} binding="noSession" t={t as never} />)
    expect(container.textContent).toContain(zh['terminal.unclaimed'])
    expect(container.textContent).not.toContain(zh['terminal.running'])
    expect(container.querySelector('[data-status="unclaimed"]')).not.toBeNull()
  })

  it('退出码靠右显示并区分失败与正常结束', () => {
    const { container } = render(
      <TerminalStatusBar
        tab={tab({ status: 'exited', runtime: { cwd: '', cols: 80, rows: 24, exitCode: 1 } })}
        binding="ready"
        t={t as never}
      />,
    )
    const exit = container.querySelector('[class*="terminalStatusBarExit"]')
    expect(exit?.textContent).toBe(t('terminal.statusExit', { code: '1' }))
    expect(exit?.getAttribute('data-status')).toBe('exited')
  })

  it('只有启动目录允许被裁切，其余事实保持完整可读', () => {
    const { container } = render(
      <TerminalStatusBar
        tab={tab({ shellName: 'cmd.exe', runtime: { cwd: 'F:\\a\\very\\long\\path', cols: 80, rows: 24, exitCode: null } })}
        binding="ready"
        t={t as never}
      />,
    )
    const shrinking = container.querySelectorAll('[data-shrink="true"]')
    expect(shrinking).toHaveLength(1)
    expect(shrinking[0]?.textContent).toBe('F:\\a\\very\\long\\path')
  })
})
