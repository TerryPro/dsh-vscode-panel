// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModeSwitch } from '../src/client/layout/ModeSwitch.tsx'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  FishLogo: () => <svg data-icon="brand" />,
  IconFolderOpenOutlineMedium: ({ size }: { size: number }) => <svg data-icon="files" width={size} />,
  IconPanelLeftOutlineMedium: ({ size, className }: { size: number; className?: string }) => <svg data-icon="editor" className={className} width={size} />,
  IconQueueOutlineRegular: ({ size }: { size: number }) => <svg data-icon="sessions" width={size} />,
  IconSettingsOutlineMedium: ({ size }: { size: number }) => <svg data-icon="settings" width={size} />,
  Tooltip: ({ children, label }: { children: React.ReactNode; label: string }) => <span data-tooltip-label={label}>{children}</span>,
}))

const workbench = vi.hoisted(() => ({ sidebarMode: 'git', editorExpanded: true, conversationExpanded: true }))
vi.mock('../src/client/use-workbench.ts', () => ({
  useWorkbench: () => workbench,
}))

const setSidebarMode = vi.fn()
const toggleEditor = vi.fn()
const toggleConversation = vi.fn()
const logger = { info: vi.fn() }

const t = (key: string): string => ({
  'mode.sessions': '会话',
  'mode.files': '文件',
  'mode.git': 'Git',
  'mode.terminal': '终端',
  'mode.settings': '设置',
  'mode.bar': '工作台视图',
  'editor.collapse': '收起中栏',
  'editor.expand': '展开中栏',
  'editor.collapseConversation': '收起对话栏',
  'editor.expandConversation': '展开对话栏',
})[key] ?? key

// The slot-owner augmentation for `wide` is not part of this spec's type graph,
// so props are passed through an untyped bag exactly as the shell would supply them.
function renderSwitch(wide: boolean) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const props: any = { wide, controller: { setSidebarMode, toggleEditor, toggleConversation }, logger, t }
  return render(<ModeSwitch {...props} />)
}

describe('工作台活动栏', () => {
  beforeEach(() => {
    setSidebarMode.mockClear()
    toggleEditor.mockClear()
    toggleConversation.mockClear()
    workbench.editorExpanded = true
    workbench.sidebarMode = 'git'
    workbench.conversationExpanded = true
    logger.info.mockClear()
    appFixture()
  })

  it('在任意折叠态都挂载独立常驻的左侧停靠列', () => {
    const { appRoot } = appFixtureElements()
    renderSwitch(true)

    expect(appRoot.hasAttribute('data-dsh-workbench-activity-dock')).toBe(true)
    const dock = appRoot.firstElementChild
    expect(dock).not.toBeNull()
    expect(dock?.querySelector('[role="toolbar"]')).not.toBeNull()
    expect(dock?.querySelectorAll('button')).toHaveLength(7) // 4 views + editor + conversation + settings
    expect(dock?.querySelector('[aria-label="Git"] svg')?.getAttribute('width')).toBe('18')

    // The AppFrame grid reserves the dock width as inline padding so nothing is covered.
    const frame = document.querySelector('[data-shell-overlay]')?.parentElement
    expect(frame).not.toBeNull()
    expect((frame as HTMLElement).style.paddingLeft).toBe('48px')

    // The dock survives the collapsed fold state as well.
    cleanup()
    document.body.innerHTML = ''
    appFixture()
    const { appRoot: collapsedRoot } = appFixtureElements()
    renderSwitch(false)
    expect(collapsedRoot.hasAttribute('data-dsh-workbench-activity-dock')).toBe(true)
    expect(collapsedRoot.firstElementChild?.querySelector('[role="toolbar"]')).not.toBeNull()
  })

  it('展开态点击已选中项经官方 toggle 收起，点击其它项仅切换视图', () => {
    const view = renderSwitch(true)
    const folded = vi.fn()
    officialToggle()?.addEventListener('click', folded)

    fireEvent.click(view.getByRole('button', { name: 'Git' }))
    expect(folded).toHaveBeenCalledOnce()
    expect(setSidebarMode).not.toHaveBeenCalled()

    fireEvent.click(view.getByRole('button', { name: '文件' }))
    expect(setSidebarMode).toHaveBeenCalledWith('files')
    expect(folded).toHaveBeenCalledOnce()
  })

  it('收起态点击任一图标都会切换视图并请求展开侧栏', () => {
    const view = renderSwitch(false)
    const expanded = vi.fn()
    officialToggle()?.addEventListener('click', expanded)

    fireEvent.click(view.getByRole('button', { name: 'Git' }))
    expect(setSidebarMode).toHaveBeenCalledWith('git')
    expect(expanded).toHaveBeenCalledOnce()
  })

  it('底部齿轮打开官方 Settings 而不重复渲染触发器', () => {
    const view = renderSwitch(true)
    const official = document.querySelector('[data-dsh-workbench-sidebar-settings-trigger]')
    expect(official).not.toBeNull()
    const launched = vi.fn()
    official?.addEventListener('click', launched)

    fireEvent.click(view.getByRole('button', { name: '设置' }))
    expect(launched).toHaveBeenCalledOnce()
  })

  it('活动栏底部的对话栏按钮切换右侧对话栏', () => {
    const view = renderSwitch(true)

    const button = view.getByRole('button', { name: '收起对话栏' })
    expect(button.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(button)
    expect(toggleConversation).toHaveBeenCalledOnce()

    // The button stays available even with no document open because the dock is independent of the editor.
    workbench.conversationExpanded = false
    cleanup()
    document.body.innerHTML = ''
    appFixture()
    const collapsedView = renderSwitch(true)
    expect(collapsedView.getByRole('button', { name: '展开对话栏' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('停靠列与按钮遵循固定 48px 列与官方圆形几何', () => {
    const stylesheet = readFileSync(resolve(process.cwd(), 'src/client/Workbench.module.css'), 'utf8')
    const dockRule = stylesheet.match(/\.activityDock\s*\{[^}]+\}/u)?.[0]
    const modeButtonRule = stylesheet.match(/\.modeButton\s*\{[^}]+\}/u)?.[0]

    expect(dockRule).toContain('position: fixed')
    expect(dockRule).toContain('width: 48px')
    expect(modeButtonRule).toContain('width: 36px')
    expect(modeButtonRule).toContain('height: 36px')
    expect(modeButtonRule).toContain('border-radius: 50%')
    expect(stylesheet).toMatch(/\.modeButton\[data-active\]\s*\{[^}]*interactive-bg-active[^}]*button-info-fill/u)
    expect(stylesheet).toMatch(/\[data-dsh-workbench-activity-dock\] \[data-dsh-workbench-sidebar-settings-trigger\]\s*\{[^}]*display: none/u)
  })
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

function officialToggle(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('button[class*="_toggle"]')
}

function appFixtureElements() {
  const appRoot = document.querySelector<HTMLElement>('[data-fixture-app-root]')!
  return { appRoot }
}

function appFixture(): void {
  const appRoot = document.createElement('div')
  appRoot.setAttribute('data-fixture-app-root', '')
  const frame = document.createElement('div')
  const shellOverlay = document.createElement('div')
  shellOverlay.setAttribute('data-shell-overlay', '')
  frame.appendChild(shellOverlay)
  appRoot.appendChild(frame)

  const foot = document.createElement('div')
  const footerActions = document.createElement('div')
  const footerActionSeat = document.createElement('div')
  footerActionSeat.dataset.slot = 'sidebar.footer.action'
  footerActions.appendChild(footerActionSeat)
  const settingsArea = document.createElement('div')
  const settingsSeat = document.createElement('div')
  settingsSeat.dataset.slot = 'sidebar.settings'
  const settingsButton = document.createElement('button')
  settingsButton.setAttribute('aria-haspopup', 'dialog')
  settingsSeat.appendChild(settingsButton)
  settingsArea.appendChild(settingsSeat)
  foot.append(footerActions, settingsArea)
  appRoot.appendChild(foot)

  const toggleButton = document.createElement('button')
  toggleButton.className = 'hHd-Xa_toggle'
  appRoot.appendChild(toggleButton)

  document.body.appendChild(appRoot)
}
