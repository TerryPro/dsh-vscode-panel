// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { installNativeRightbarEntry } from '../src/client/layout/native-rightbar-entry.ts'

/**
 * The bug this covers is the one a reader feels rather than sees: DSH's expand
 * button is on screen the whole time the workbench holds the right-column seat,
 * and pressing it painted nothing because no occupant was left to draw the panel.
 * The entry is only real if the yield runs **before** the official handler, so the
 * tests assert ordering against a bubble-phase listener standing in for React's
 * delegated `onClick`.
 */

afterEach(() => { document.body.innerHTML = '' })

describe('原生右侧栏展开按钮的让位入口', () => {
  it('在官方处理器展开面板之前先收起中栏并释放席位', () => {
    const order: string[] = []
    const button = expandButton()
    button.addEventListener('click', () => { order.push('official-expand') })
    const controller = controllerFake(true, () => { order.push('yield-seat') })

    installNativeRightbarEntry(controller, { info: vi.fn() })
    button.click()

    // Capture-on-document strictly precedes the bubble handler, which is where
    // React's delegated onClick lives; any other order writes the expansion into a
    // surface with no occupant and the click is lost again.
    expect(order).toEqual(['yield-seat', 'official-expand'])
    expect(controller.store.getSnapshot().editorExpanded).toBe(false)
  })

  it('中栏已收起时不重复收起，把按钮完全交还 DSH', () => {
    const controller = controllerFake(false)
    const entry = installNativeRightbarEntry(controller, { info: vi.fn() })

    expandButton().click()
    expect(controller.toggleEditor).not.toHaveBeenCalled()

    // A second press must behave identically: the seat already belongs to DSH.
    expandButton().click()
    expect(controller.toggleEditor).not.toHaveBeenCalled()
    entry()
  })

  it('不接管其它按钮、鼠标其它键，或卸载后的点击', () => {
    const controller = controllerFake(true)
    const logger = { info: vi.fn() }
    const entry = installNativeRightbarEntry(controller, logger)

    const ordinary = document.createElement('button')
    ordinary.dataset.dockkitControl = 'close-tab'
    document.body.appendChild(ordinary)
    ordinary.click()
    expect(controller.toggleEditor).not.toHaveBeenCalled()

    const rightButton = expandButton()
    rightButton.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 2 }))
    expect(controller.toggleEditor).not.toHaveBeenCalled()

    entry()
    expandButton().click()
    expect(controller.toggleEditor).not.toHaveBeenCalled()
    expect(logger.info).not.toHaveBeenCalled()
  })

  // The press may land on the icon inside the button, and the official control
  // nests one; matching only the button itself would miss every real click.
  it('接管落在按钮内部图标上的点击', () => {
    const controller = controllerFake(true)
    const button = expandButton()
    const icon = document.createElement('span')
    button.appendChild(icon)
    installNativeRightbarEntry(controller, { info: vi.fn() })

    icon.click()

    expect(controller.toggleEditor).toHaveBeenCalledOnce()
  })
})

function expandButton(): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.dataset.sidebarRightExpand = 'true'
  document.body.appendChild(button)
  return button
}

function controllerFake(editorExpanded: boolean, onToggle?: () => void) {
  const state = { editorExpanded }
  return {
    store: { getSnapshot: () => state },
    toggleEditor: vi.fn(() => {
      state.editorExpanded = false
      onToggle?.()
    }),
  }
}
