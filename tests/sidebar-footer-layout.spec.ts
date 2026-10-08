// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  createSidebarFooterLayout,
  SIDEBAR_SETTINGS_TRIGGER_ATTRIBUTE,
} from '../src/client/layout/sidebar-footer-layout.ts'

afterEach(() => { document.body.innerHTML = '' })

describe('侧栏底部原生堆叠布局', () => {
  it('只标记 Settings 触发器，不把底部席位重排到同一行', () => {
    const { settings, settingsTrigger } = sidebarFooterFixture()
    const logger = { info: vi.fn() }
    const layout = createSidebarFooterLayout(logger)

    expect(settingsTrigger.hasAttribute(SIDEBAR_SETTINGS_TRIGGER_ATTRIBUTE)).toBe(true)
    expect(settings.hasAttribute(SIDEBAR_SETTINGS_TRIGGER_ATTRIBUTE)).toBe(false)
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('stacked order'))

    // The foot must keep DSH's native column order: no side-by-side grid or
    // same-row override may return to the global stylesheet.
    const stylesheet = readFileSync(resolve(process.cwd(), 'src/client/styles/global.module.css'), 'utf8')
    expect(stylesheet).not.toMatch(/sidebar-foot[^{]*\][^{]*\{[^}]*grid-template-columns/u)
    expect(stylesheet).not.toMatch(/grid-row:\s*1/u)
    // The dock still hides the duplicated gear while keeping it clickable.
    expect(stylesheet).toContain('[data-dsh-workbench-activity-dock] [data-dsh-workbench-sidebar-settings-trigger]')
    expect(stylesheet).toMatch(/display:\s*none/u)

    layout.dispose()
    expect(settingsTrigger.hasAttribute(SIDEBAR_SETTINGS_TRIGGER_ATTRIBUTE)).toBe(false)
  })

  it('忽略 Settings 面板内的弹层按钮，只标记触发行的启动器', () => {
    const { settingsSeat } = sidebarFooterFixture()
    // An open Settings panel mounts later inside the seat and carries its own
    // dialog-popup buttons; they must never be tagged as the launcher.
    const panel = document.createElement('div')
    const panelDialogButton = document.createElement('button')
    panelDialogButton.setAttribute('aria-haspopup', 'dialog')
    panel.appendChild(panelDialogButton)
    settingsSeat.appendChild(panel)

    const layout = createSidebarFooterLayout({ info: vi.fn() })
    const tagged = document.querySelectorAll(`[${SIDEBAR_SETTINGS_TRIGGER_ATTRIBUTE}]`)
    expect(tagged).toHaveLength(1)
    expect(tagged[0].parentElement?.parentElement).toBe(settingsSeat)
    layout.dispose()
  })

  it('在官方底部结构替换后释放旧标记并接管新节点', async () => {
    const first = sidebarFooterFixture()
    const layout = createSidebarFooterLayout({ info: vi.fn() })
    const second = sidebarFooterFixture()
    first.settings.remove()

    await vi.waitFor(() => {
      expect(second.settingsTrigger.hasAttribute(SIDEBAR_SETTINGS_TRIGGER_ATTRIBUTE)).toBe(true)
    })
    expect(first.settingsTrigger.isConnected).toBe(false)
    layout.dispose()
  })
})

function sidebarFooterFixture() {
  const foot = document.createElement('div')
  const actions = document.createElement('div')
  const actionSeat = document.createElement('div')
  actionSeat.dataset.slot = 'sidebar.footer.action'
  const quotaWidget = document.createElement('button')
  quotaWidget.textContent = '100 / 100'
  actionSeat.appendChild(quotaWidget)
  actions.appendChild(actionSeat)
  const settings = document.createElement('div')
  const settingsSeat = document.createElement('div')
  settingsSeat.dataset.slot = 'sidebar.settings'
  // The official settings registrant wraps its launcher in a trigger row and
  // renders the settings panel after it, so the launcher is not a direct child
  // of the seat and is not the seat's last button either.
  const triggerRow = document.createElement('div')
  const settingsTrigger = document.createElement('button')
  settingsTrigger.setAttribute('aria-haspopup', 'dialog')
  triggerRow.appendChild(settingsTrigger)
  const panelClose = document.createElement('button')
  settingsSeat.append(triggerRow, panelClose)
  settings.appendChild(settingsSeat)
  // Native order: the action seat stacks above the settings seat.
  foot.append(actions, settings)
  document.body.appendChild(foot)
  return { foot, actions, settings, settingsSeat, settingsTrigger }
}
