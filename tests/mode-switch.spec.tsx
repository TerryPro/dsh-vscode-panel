// @vitest-environment jsdom

import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModeSwitch } from '../src/client/shell/ModeSwitch.tsx'
import { PANEL_BACK_SEAT_ATTRIBUTE } from '../src/client/layout/editor-layout-contract.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  FishLogo: () => <svg data-icon="brand" />,
  IconFolderOpenOutlineMedium: ({ size }: { size: number }) => <svg data-icon="files" width={size} />,
  IconPanelLeftOutlineMedium: ({ size, className }: { size: number; className?: string }) => <svg data-icon="editor" className={className} width={size} />,
  IconQueueOutlineRegular: ({ size }: { size: number }) => <svg data-icon="sessions" width={size} />,
  IconSettingsOutlineMedium: ({ size }: { size: number }) => <svg data-icon="settings" width={size} />,
  Tooltip: ({ children, label }: { children: React.ReactNode; label: string }) => <span data-tooltip-label={label}>{children}</span>,
}))

const workbench = vi.hoisted(() => ({ sidebarMode: 'git', editorExpanded: true, conversationExpanded: true }))
vi.mock('../src/client/model/use-workbench.ts', () => ({
  useWorkbench: () => workbench,
}))

const setSidebarMode = vi.fn()
const toggleEditor = vi.fn()
const toggleConversation = vi.fn()
const logger = { info: vi.fn() }

/**
 * The official panel-navigation face the dock drives. `activePanelId` is held in
 * a module-level box so a test can move the shell between the Conversation and a
 * global panel, exactly as `ctx.layout.selectPanel` would.
 */
const panelState = { activePanelId: null as string | null }
const panelListeners = new Set<() => void>()
const selectPanel = vi.fn((panelId: string | null) => {
  panelState.activePanelId = panelId
  for (const listener of panelListeners) listener()
})
const panels = {
  panelInfo: {
    getSnapshot: () => ({ activePanelId: panelState.activePanelId }),
    subscribe: (fn: () => void) => {
      panelListeners.add(fn)
      return () => { panelListeners.delete(fn) }
    },
  },
  selectPanel,
}

const t = (key: string): string => ({
  'mode.sessions': '会话',
  'mode.files': '文件',
  'mode.git': 'Git',
  'mode.terminal': '终端',
  'mode.settings': '设置',
  'mode.backToSession': '返回会话',
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
  const props: any = { wide, controller: { setSidebarMode, toggleEditor, toggleConversation }, logger, panels, t }
  return render(<ModeSwitch {...props} />)
}

describe('工作台活动栏', () => {
  beforeEach(() => {
    setSidebarMode.mockClear()
    toggleEditor.mockClear()
    toggleConversation.mockClear()
    selectPanel.mockClear()
    panelState.activePanelId = null
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
    expect(dock?.querySelectorAll('button')).toHaveLength(7) // 4 views + editor + conversation + settings    expect(dock?.querySelector('[aria-label="Git"] svg')?.getAttribute('width')).toBe('18')

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

  it('全局面板打开时给出返回会话的出口，会话态不显示该按钮', () => {
    const closed = renderSwitch(true)
    // The Conversation owns the center column, so there is nothing to return from.
    expect(closed.queryByRole('button', { name: '返回会话' })).toBeNull()
    closed.unmount()

    panelState.activePanelId = 'plugins'
    const view = renderSwitch(true)
    const back = view.getByRole('button', { name: '返回会话' })
    fireEvent.click(back)
    expect(selectPanel).toHaveBeenCalledWith(null)
    expect(panelState.activePanelId).toBeNull()
  })

  it('插件页自带头部席位时，出口只出现在该席位而不重复出现在停靠列', () => {
    panelState.activePanelId = 'plugins'
    pluginPanelFixture()
    const view = renderSwitch(true)

    const seats = document.querySelectorAll(`[${PANEL_BACK_SEAT_ATTRIBUTE}]`)
    expect(seats).toHaveLength(1)
    const back = within(seats[0] as HTMLElement).getByRole('button', { name: '返回会话' })
    // The dock's own rail must not carry a second copy of the same control.
    const dock = document.querySelector('[data-dsh-workbench-activity-dock]')
    expect(within(dock as HTMLElement).queryByRole('button', { name: '返回会话' })).toBeNull()

    fireEvent.click(back)
    expect(selectPanel).toHaveBeenCalledWith(null)
  })

  it('其它全局面板没有头部席位，出口由停靠列承担', () => {
    panelState.activePanelId = 'qoder-quota'
    const view = renderSwitch(true)
    expect(document.querySelector(`[${PANEL_BACK_SEAT_ATTRIBUTE}]`)).toBeNull()
    const dock = document.querySelector('[data-dsh-workbench-activity-dock]')
    expect(within(dock as HTMLElement).getByRole('button', { name: '返回会话' })).not.toBeNull()
  })

  it('停靠列与按钮遵循固定 48px 列与官方圆形几何', () => {
    const stylesheet = ['src/client/shell/shell.module.css', 'src/client/styles/global.module.css']
      .map((p) => readFileSync(resolve(process.cwd(), p), 'utf8')).join('\n')
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

/** The official Plugins page root with its list-view action row, as the shell renders them. */
function pluginPanelFixture(): void {
  const page = document.createElement('div')
  page.setAttribute('data-plugin-panel', 'true')
  const head = document.createElement('header')
  head.setAttribute('data-window-drag', 'true')
  const toolbar = document.createElement('div')
  toolbar.className = 'fO69Vq_toolbar'
  head.appendChild(toolbar)
  page.appendChild(head)
  document.body.appendChild(page)
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
