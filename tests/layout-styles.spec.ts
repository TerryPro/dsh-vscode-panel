// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import {
  ASSISTANT_ACTIONS_ATTRIBUTE,
  ASSISTANT_METRICS_ATTRIBUTE,
  ASSISTANT_METRICS_WRAP_ATTRIBUTE,
  CONVERSATION_NARROW_ATTRIBUTE,
  CONVERSATION_ROOT_ATTRIBUTE,
} from '../src/client/layout/conversation-layout.ts'
import {
  EDITOR_RELEASE_ATTRIBUTE,
  EDITOR_TRANSITION_ATTRIBUTE,
  TRANSITION_EDITOR_WIDTH,
} from '../src/client/editor/editor-track-transition.ts'
import {
  DETAILS_TRACK_ATTRIBUTE,
  DETAILS_TRACK_NATIVE_HANDLE_ATTRIBUTE,
  DETAILS_TRACK_SIDEBAR_WIDTH,
  DETAILS_TRACK_WIDTH,
  SIDEBAR_TRACK_HANDLE_ATTRIBUTE,
  readNativeSidebarWidth,
  resolveDetailsTrackMaximum,
  resolveDetailsTrackWidth,
  resolveResponsiveDetailsDefault,
} from '../src/client/layout/details-track-layout.ts'
import { EDITOR_COLLAPSED_ATTRIBUTE, installWorkbenchLayout } from '../src/client/layout/layout-styles.ts'
import {
  EDITOR_HOST_ATTRIBUTE,
  GLOBAL_PANEL_ATTRIBUTE,
} from '../src/client/layout/global-panel-layout.ts'
import { CONVERSATION_COLLAPSED_ATTRIBUTE } from '../src/client/layout/editor-layout-contract.ts'

afterEach(() => {
  document.head.innerHTML = ''
  document.body.innerHTML = ''
})

describe('workbench layout presentation', () => {
  it('uses a responsive default and preserves the AppFrame center concession', () => {
    expect(resolveResponsiveDetailsDefault(1280)).toBe(420)
    expect(resolveResponsiveDetailsDefault(1920)).toBe(614)
    expect(resolveResponsiveDetailsDefault(2560)).toBe(720)
    expect(resolveDetailsTrackMaximum(1920, 280)).toBe(1000)
    expect(resolveDetailsTrackWidth(1920, 280, 900)).toBe(900)
    expect(resolveDetailsTrackWidth(1400, 280, 900)).toBe(480)
    expect(resolveDetailsTrackWidth(1200, 280, 420)).toBe(0)
  })

  it('reads AppFrame sidebar geometry from its inline grid before fallback CSS', () => {
    const frame = document.createElement('div')
    const sidebar = document.createElement('div')
    frame.style.gridTemplateColumns = '56px minmax(0, 1fr) 0px'
    vi.spyOn(sidebar, 'getBoundingClientRect').mockReturnValue(rect(280))

    expect(readNativeSidebarWidth(frame, sidebar)).toBe(56)
  })

  it('treats a parsed zero sidebar track as collapsed instead of falling back', () => {
    const frame = document.createElement('div')
    const sidebar = document.createElement('div')
    frame.style.gridTemplateColumns = '0px minmax(0, 1fr) 360px'
    vi.spyOn(sidebar, 'getBoundingClientRect').mockReturnValue(rect(280))

    expect(readNativeSidebarWidth(frame, sidebar)).toBe(0)
  })

  it('keeps the native active-Session divider while widening its workbench track', () => {
    const { frame, detailsHandle } = appFrameFixture('active', 312)
    document.body.appendChild(frame)
    let dispose: (() => void) | undefined
    const ctx = contextWithDispose(value => { dispose = value })
    const visibility = editorVisibility()

    installWorkbenchLayout(ctx, visibility, fileController(), panelSelection())
    expect(frame.hasAttribute('data-dsh-workbench-frame')).toBe(true)
    expect(frame.querySelector(`[${CONVERSATION_ROOT_ATTRIBUTE}]`)).not.toBeNull()
    expect(frame.style.gridTemplateColumns).toBe('312px minmax(0, 1fr) 360px')
    expect(frame.hasAttribute('data-dsh-workbench-fallback-details')).toBe(false)
    expect(frame.hasAttribute(DETAILS_TRACK_ATTRIBUTE)).toBe(true)
    expect(frame.style.getPropertyValue(DETAILS_TRACK_SIDEBAR_WIDTH)).toBe('312px')
    expect(frame.style.getPropertyValue(DETAILS_TRACK_WIDTH)).toBe('448px')
    expect(detailsHandle?.hasAttribute(DETAILS_TRACK_NATIVE_HANDLE_ATTRIBUTE)).toBe(true)
    const style = document.head.querySelector<HTMLStyleElement>('[data-dsh-workbench-layout]')
    expect(style).not.toBeNull()
    expect(style?.textContent).toContain(':not([data-rightbar-collapsed])')
    expect(style?.textContent).toContain("[data-rightbar-col]::after")
    expect(style?.textContent).toContain('border-top: 1px solid var(--dsw-alias-border-l1)')
    expect(style?.textContent).toContain(`> :nth-child(3) {`)
    expect(style?.textContent).toContain('border-left: 1px solid var(--dsw-alias-border-l1) !important')
    expect(style?.textContent).toContain(`[${SIDEBAR_TRACK_HANDLE_ATTRIBUTE}]`)
    expect(style?.textContent).toContain(`> :nth-child(1) [class*="_root"]`)
    expect(style?.textContent).toContain('width: 100% !important')
    expect(style?.textContent).toContain('data-dsh-workbench-conversation-narrow')
    expect(style?.textContent).toContain("[role='status']:has(> code) > code")
    expect(style?.textContent).toContain(`[${ASSISTANT_ACTIONS_ATTRIBUTE}]`)
    expect(style?.textContent).toContain('flex-wrap: wrap')
    expect(style?.textContent).toContain(`[${ASSISTANT_METRICS_ATTRIBUTE}]`)
    expect(style?.textContent).toContain('overflow-wrap: anywhere')
    expect(style?.textContent).toContain('[data-input-scroll] + div')
    expect(style?.textContent).toContain("[data-slot='conversation.input.model']")
    expect(style?.textContent).toContain('[data-composer-seat]')
    expect(style?.textContent).toContain("[data-slot='conversation.input.model'] > div {\n  flex: 0 1 auto;")
    expect(style?.textContent).toContain("button[aria-haspopup='menu'] {\n  width: auto;")
    expect(style?.textContent).toContain('padding-inline: 8px')
    expect(style?.textContent).toContain(`:not([${EDITOR_COLLAPSED_ATTRIBUTE}]):not([data-rightbar-collapsed]):not([data-rightbar-fullscreen]) > :nth-child(2) [${CONVERSATION_ROOT_ATTRIBUTE}]`)
    expect(style?.textContent).toContain(`:not([${EDITOR_COLLAPSED_ATTRIBUTE}])[data-dsh-workbench-fallback-details] > :nth-child(2) [${CONVERSATION_ROOT_ATTRIBUTE}]`)
    expect(style?.textContent).toContain(`[${EDITOR_TRANSITION_ATTRIBUTE}] > :nth-child(2) [${CONVERSATION_ROOT_ATTRIBUTE}]`)
    expect(style?.textContent).toContain(`@property ${TRANSITION_EDITOR_WIDTH}`)
    expect(style?.textContent).toContain(`${TRANSITION_EDITOR_WIDTH} var(--ds-transition-duration-slow) var(--ds-ease-in-out)`)
    expect(style?.textContent).toContain(`[${EDITOR_RELEASE_ATTRIBUTE}] {
  transition: none !important;`)
    expect(style?.textContent).not.toContain('> :nth-child(2) [data-phase]')
    expect(style?.textContent).not.toContain('[data-composer-card]')
    expect(style?.textContent).not.toContain('--dsw-alias-bg-base: var(--dsw-specific-sidebar-fill)')
    expect(style?.textContent).toContain(EDITOR_COLLAPSED_ATTRIBUTE)
    expect(style?.textContent).toContain('> span[aria-hidden]:last-child')
    expect(style?.textContent).toContain("button[aria-haspopup='menu'] > svg:last-child")
    expect(style?.textContent).toContain('data-dsh-workbench-floating-model-menu')
    expect(style?.textContent).toContain('position: fixed !important')
    expect(style?.textContent).not.toContain('flex-direction: column')
    // The collapsed-editor seam: the conversation returns to AppFrame's centre
    // track, whose native left edge is absent on Windows and a 0.5px hairline
    // elsewhere, with a 16px rounded corner. It must match the workbench seam.
    expect(style?.textContent).toContain(
      `[${EDITOR_COLLAPSED_ATTRIBUTE}]:not([data-sidebar-collapsed]) > :nth-child(2) {
  border-left: 1px solid var(--dsw-alias-border-l1);
  border-radius: 0;
}`,
    )

    visibility.setExpanded(false)
    expect(frame.hasAttribute(EDITOR_COLLAPSED_ATTRIBUTE)).toBe(true)
    visibility.setExpanded(true)
    expect(frame.hasAttribute(EDITOR_COLLAPSED_ATTRIBUTE)).toBe(false)

    dispose?.()
    expect(frame.hasAttribute('data-dsh-workbench-frame')).toBe(false)
    expect(frame.style.gridTemplateColumns).toBe('312px minmax(0, 1fr) 360px')
    expect(frame.style.getPropertyValue(DETAILS_TRACK_WIDTH)).toBe('')
    expect(detailsHandle?.hasAttribute(DETAILS_TRACK_NATIVE_HANDLE_ATTRIBUTE)).toBe(false)
    expect(document.head.querySelector('[data-dsh-workbench-layout]')).toBeNull()
  })

  it('gives overflowing assistant metrics a wrapping line below the native action icons', () => {
    const { frame, conversation } = appFrameFixture('active', 312)
    const tail = document.createElement('div')
    tail.dataset.turnTail = 'turn-1'
    tail.dataset.timeHoverRoot = ''
    const actions = document.createElement('div')
    actions.appendChild(document.createElement('button'))
    const metrics = document.createElement('span')
    metrics.textContent = '8月22日 23:39 · 用时 2秒 · 首 token 2.1秒 · 250 tok/s'
    actions.appendChild(metrics)
    tail.appendChild(actions)
    conversation.appendChild(tail)
    document.body.appendChild(frame)
    let dispose: (() => void) | undefined

    try {
      installWorkbenchLayout(contextWithDispose(value => { dispose = value }), editorVisibility(), fileController(), panelSelection())
      actions.setAttribute(ASSISTANT_METRICS_WRAP_ATTRIBUTE, '')

      expect(actions.hasAttribute(ASSISTANT_ACTIONS_ATTRIBUTE)).toBe(true)
      expect(metrics.hasAttribute(ASSISTANT_METRICS_ATTRIBUTE)).toBe(true)
      expect(getComputedStyle(actions).flexWrap).toBe('wrap')
      expect(getComputedStyle(actions).height).toBe('auto')
      expect(getComputedStyle(metrics).whiteSpace).toBe('normal')
      expect(getComputedStyle(metrics).flexBasis).toBe('100%')
    } finally {
      dispose?.()
    }
  })

  it('opens a draggable workbench track for the blank-Session Hero and releases it when active', async () => {
    const { frame, conversation } = appFrameFixture('hero')
    document.body.appendChild(frame)
    let dispose: (() => void) | undefined
    const ctx = contextWithDispose(value => { dispose = value })
    const visibility = editorVisibility()

    installWorkbenchLayout(ctx, visibility, fileController(), panelSelection())
    expect(frame.hasAttribute('data-dsh-workbench-fallback-details')).toBe(true)
    expect(frame.style.getPropertyValue(DETAILS_TRACK_SIDEBAR_WIDTH)).toBe('280px')
    expect(frame.style.getPropertyValue(DETAILS_TRACK_WIDTH)).toBe('448px')
    expect(frame.querySelector('[data-dsh-workbench-fallback-handle]')).not.toBeNull()
    expect(ctx.logger.info).toHaveBeenCalledWith(expect.stringContaining('activated blank-Session'))

    visibility.setExpanded(false)
    expect(frame.hasAttribute(EDITOR_COLLAPSED_ATTRIBUTE)).toBe(true)
    expect(frame.hasAttribute('data-dsh-workbench-fallback-details')).toBe(false)
    expect(frame.querySelector<HTMLElement>('[data-dsh-workbench-fallback-handle]')?.hidden).toBe(true)

    visibility.setExpanded(true)
    expect(frame.hasAttribute(EDITOR_COLLAPSED_ATTRIBUTE)).toBe(false)
    expect(frame.hasAttribute('data-dsh-workbench-fallback-details')).toBe(true)

    conversation.dataset.phase = 'active'
    frame.removeAttribute('data-rightbar-collapsed')
    await vi.waitFor(() => {
      expect(frame.hasAttribute('data-dsh-workbench-fallback-details')).toBe(false)
    })
    expect(ctx.logger.info).toHaveBeenCalledWith(expect.stringContaining('released responsive conversation track'))

    dispose?.()
    expect(frame.querySelector('[data-dsh-workbench-fallback-handle]')).toBeNull()
  })

  it('mirrors sidebar collapse, expansion and drag widths during a blank Session', async () => {
    const { frame } = appFrameFixture('hero')
    document.body.appendChild(frame)
    let dispose: (() => void) | undefined
    const ctx = contextWithDispose(value => { dispose = value })

    installWorkbenchLayout(ctx, editorVisibility(), fileController(), panelSelection())
    expect(frame.style.getPropertyValue(DETAILS_TRACK_SIDEBAR_WIDTH)).toBe('280px')

    frame.style.gridTemplateColumns = '56px minmax(0, 1fr) 0px'
    frame.toggleAttribute('data-sidebar-collapsed', true)
    await vi.waitFor(() => {
      expect(frame.style.getPropertyValue(DETAILS_TRACK_SIDEBAR_WIDTH)).toBe('56px')
    })
    expect(frame.style.getPropertyValue(DETAILS_TRACK_WIDTH)).toBe('448px')

    frame.style.gridTemplateColumns = '344px minmax(0, 1fr) 0px'
    frame.removeAttribute('data-sidebar-collapsed')
    await vi.waitFor(() => {
      expect(frame.style.getPropertyValue(DETAILS_TRACK_SIDEBAR_WIDTH)).toBe('344px')
    })
    expect(frame.style.getPropertyValue(DETAILS_TRACK_WIDTH)).toBe('416px')
    expect(ctx.logger.info).toHaveBeenCalledWith(expect.stringContaining('collapsed sidebar at 56px'))
    expect(ctx.logger.info).toHaveBeenCalledWith(expect.stringContaining('expanded sidebar at 344px'))

    dispose?.()
  })

  it('marks the frame when the conversation column is collapsed', () => {
    const { frame } = appFrameFixture('active', 312)
    document.body.appendChild(frame)
    let dispose: (() => void) | undefined
    const ctx = contextWithDispose(value => { dispose = value })
    const visibility = editorVisibility()

    installWorkbenchLayout(ctx, visibility, fileController(), panelSelection())
    expect(frame.hasAttribute(CONVERSATION_COLLAPSED_ATTRIBUTE)).toBe(false)

    visibility.setConversationExpanded(false)
    expect(frame.hasAttribute(CONVERSATION_COLLAPSED_ATTRIBUTE)).toBe(true)

    visibility.setConversationExpanded(true)
    expect(frame.hasAttribute(CONVERSATION_COLLAPSED_ATTRIBUTE)).toBe(false)

    dispose?.()
    expect(frame.hasAttribute(CONVERSATION_COLLAPSED_ATTRIBUTE)).toBe(false)
  })

  it('drags the plugin sidebar handle to resize the left panel', () => {
    const { frame } = appFrameFixture('active', 280, 1400)
    document.body.appendChild(frame)
    let dispose: (() => void) | undefined
    const ctx = contextWithDispose(value => { dispose = value })

    installWorkbenchLayout(ctx, editorVisibility(), fileController(), panelSelection())
    const handle = frame.querySelector(`[${SIDEBAR_TRACK_HANDLE_ATTRIBUTE}]`)
    expect(handle).not.toBeNull()
    expect(frame.style.getPropertyValue(DETAILS_TRACK_SIDEBAR_WIDTH)).toBe('280px')

    dispatchPointer(handle as HTMLElement, 'pointerdown', 280)
    dispatchPointer(handle as HTMLElement, 'pointermove', 360)
    dispatchPointer(handle as HTMLElement, 'pointerup', 360)
    expect(frame.style.getPropertyValue(DETAILS_TRACK_SIDEBAR_WIDTH)).toBe('360px')
    expect(ctx.logger.info).toHaveBeenCalledWith(expect.stringContaining('resized sidebar to 360px'))

    dispose?.()
    expect(frame.querySelector(`[${SIDEBAR_TRACK_HANDLE_ATTRIBUTE}]`)).toBeNull()
  })

  it('drags the native divider past the former 520px ceiling on a large screen', () => {
    const { frame, detailsHandle } = appFrameFixture('active', 280, 1920)
    document.body.appendChild(frame)
    let dispose: (() => void) | undefined
    const ctx = contextWithDispose(value => { dispose = value })

    installWorkbenchLayout(ctx, editorVisibility(), fileController(), panelSelection())
    expect(frame.style.getPropertyValue(DETAILS_TRACK_WIDTH)).toBe('614px')
    expect(detailsHandle).not.toBeNull()

    dispatchPointer(detailsHandle!, 'pointerdown', 1200)
    dispatchPointer(detailsHandle!, 'pointerup', 900)

    expect(frame.style.getPropertyValue(DETAILS_TRACK_WIDTH)).toBe('914px')
    expect(detailsHandle?.getAttribute('aria-valuemax')).toBe('1000')
    expect(detailsHandle?.getAttribute('aria-valuenow')).toBe('914')
    expect(ctx.logger.info).toHaveBeenCalledWith(expect.stringContaining('resized conversation track to 914px'))

    dispose?.()
  })

  it('holds the middle editor open while a global main panel replaces the conversation', () => {
    const { frame, sessionHost } = appFrameFixture('active', 312)
    document.body.appendChild(frame)
    let dispose: (() => void) | undefined
    const ctx = contextWithDispose(value => { dispose = value })
    const panels = panelSelection()

    installWorkbenchLayout(ctx, editorVisibility(), fileController(), panels)
    expect(frame.hasAttribute(GLOBAL_PANEL_ATTRIBUTE)).toBe(false)
    expect(sessionHost.hasAttribute(EDITOR_HOST_ATTRIBUTE)).toBe(true)

    // DSH hides every Session subtree once a global panel owns the center slot.
    panels.select('plugins')
    expect(frame.hasAttribute(GLOBAL_PANEL_ATTRIBUTE)).toBe(true)
    sessionHost.hidden = true
    expect(sessionHost.hasAttribute(EDITOR_HOST_ATTRIBUTE)).toBe(true)

    const style = document.head.querySelector<HTMLStyleElement>('[data-dsh-workbench-layout]')
    expect(style?.textContent).toContain(`[${GLOBAL_PANEL_ATTRIBUTE}]:not([${EDITOR_COLLAPSED_ATTRIBUTE}]) > :nth-child(3) [${EDITOR_HOST_ATTRIBUTE}]`)
    expect(style?.textContent).toContain('display: contents !important')

    // Returning to the conversation keeps the claim through the frame where DSH
    // has released the panel but not yet un-hidden the subtree, so the editor
    // never blinks; the CSS stops applying with the marker gone.
    panels.select(null)
    expect(frame.hasAttribute(GLOBAL_PANEL_ATTRIBUTE)).toBe(false)
    expect(sessionHost.hasAttribute(EDITOR_HOST_ATTRIBUTE)).toBe(true)
    sessionHost.hidden = false
    expect(sessionHost.hasAttribute(EDITOR_HOST_ATTRIBUTE)).toBe(true)

    dispose?.()
    expect(sessionHost.hasAttribute(EDITOR_HOST_ATTRIBUTE)).toBe(false)
    expect(frame.hasAttribute(GLOBAL_PANEL_ATTRIBUTE)).toBe(false)
  })

  it('re-claims a Session subtree re-created while the global panel is open', async () => {
    const first = appFrameFixture('active', 312)
    document.body.appendChild(first.frame)
    let dispose: (() => void) | undefined
    const panels = panelSelection()
    installWorkbenchLayout(
      contextWithDispose(value => { dispose = value }),
      editorVisibility(),
      fileController(),
      panels,
    )
    expect(first.sessionHost.hasAttribute(EDITOR_HOST_ATTRIBUTE)).toBe(true)

    panels.select('plugins')
    first.sessionHost.hidden = true

    // The controller replaces the subtree underneath the open panel: the new host
    // mounts hidden, so the claim must move to it instead of stranding the column.
    const replacement = document.createElement('div')
    replacement.dataset.sidebarRightSession = 'session-2'
    replacement.hidden = true
    first.sessionHost.replaceWith(replacement)

    await vi.waitFor(() => {
      expect(replacement.hasAttribute(EDITOR_HOST_ATTRIBUTE)).toBe(true)
    })
    expect(first.sessionHost.hasAttribute(EDITOR_HOST_ATTRIBUTE)).toBe(false)

    panels.select(null)
    replacement.hidden = false
    expect(replacement.hasAttribute(EDITOR_HOST_ATTRIBUTE)).toBe(true)

    dispose?.()
    expect(replacement.hasAttribute(EDITOR_HOST_ATTRIBUTE)).toBe(false)
    expect(first.frame.hasAttribute(GLOBAL_PANEL_ATTRIBUTE)).toBe(false)
  })

  it('claims the Session subtree even when it mounts hidden under an open panel', () => {
    const { frame, sessionHost } = appFrameFixture('active', 312)
    sessionHost.hidden = true
    document.body.appendChild(frame)
    let dispose: (() => void) | undefined

    installWorkbenchLayout(
      contextWithDispose(value => { dispose = value }),
      editorVisibility(),
      fileController(),
      panelSelection('plugins'),
    )
    expect(frame.hasAttribute(GLOBAL_PANEL_ATTRIBUTE)).toBe(true)
    expect(sessionHost.hasAttribute(EDITOR_HOST_ATTRIBUTE)).toBe(true)

    dispose?.()
  })
})

function appFrameFixture(phase: 'hero' | 'active', sidebarWidth = 280, frameWidth = 1400) {
  const frame = document.createElement('div')
  frame.style.gridTemplateColumns = `${sidebarWidth}px minmax(0, 1fr) ${phase === 'active' ? 360 : 0}px`
  frame.toggleAttribute('data-rightbar-collapsed', phase !== 'active')
  const sidebar = document.createElement('div')
  const conversationColumn = document.createElement('div')
  const conversationSlot = document.createElement('div')
  conversationSlot.dataset.slot = 'conversation.session'
  const conversation = document.createElement('div')
  conversation.dataset.phase = phase
  const conversationScroll = document.createElement('div')
  conversationScroll.dataset.conversationScroll = ''
  const textarea = document.createElement('textarea')
  textarea.dataset.phase = 'inert'
  conversationScroll.appendChild(textarea)
  conversation.appendChild(conversationScroll)
  conversationSlot.appendChild(conversation)
  conversationColumn.appendChild(conversationSlot)
  const details = document.createElement('div')
  details.dataset.rightbarCol = ''
  const sessionHost = document.createElement('div')
  sessionHost.dataset.sidebarRightSession = 'session-1'
  const dockPanel = document.createElement('div')
  dockPanel.dataset.sidebarRightPanel = 'push'
  const editor = document.createElement('section')
  editor.dataset.dshWorkbenchEditor = ''
  sessionHost.append(dockPanel, editor)
  details.appendChild(sessionHost)
  const overlay = document.createElement('div')
  overlay.dataset.shellOverlay = ''
  const detailsHandle = phase === 'active' ? document.createElement('div') : null
  if (detailsHandle !== null) detailsHandle.dataset.side = 'rightbar'
  frame.append(sidebar, conversationColumn, details, overlay)
  if (detailsHandle !== null) frame.appendChild(detailsHandle)
  vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue(rect(frameWidth))
  vi.spyOn(sidebar, 'getBoundingClientRect').mockReturnValue(rect(sidebarWidth))
  expect(conversationColumn.querySelector(":scope > [data-slot='conversation.session'] > [data-phase]")).toBe(conversation)
  expect(conversationColumn.querySelector(':scope > textarea[data-phase]')).toBeNull()
  return { frame, conversation, detailsHandle, details, sessionHost, dockPanel, editor }
}

function dispatchPointer(target: HTMLElement, type: string, clientX: number): void {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientX })
  Object.defineProperty(event, 'pointerId', { value: 1 })
  target.dispatchEvent(event)
}

function contextWithDispose(onDispose: (dispose: () => void) => void): ClientContext {
  return {
    effect: vi.fn((setup: () => () => void) => { onDispose(setup()) }),
    logger: { info: vi.fn() },
  } as unknown as ClientContext
}

function editorVisibility(initial = true) {
  let editorExpanded = initial
  let conversationExpanded = true
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => ({ editorExpanded, conversationExpanded }),
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    setExpanded: (next: boolean) => {
      editorExpanded = next
      listeners.forEach(listener => { listener() })
    },
    setConversationExpanded: (next: boolean) => {
      conversationExpanded = next
      listeners.forEach(listener => { listener() })
    },
  }
}

function panelSelection(initial: string | null = null) {
  let activePanelId = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => ({ activePanelId }),
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    select: (next: string | null) => {
      activePanelId = next
      listeners.forEach(listener => { listener() })
    },
  }
}

function fileController() {
  return {
    store: { getSnapshot: () => ({ workspaceId: 'workspace-1' }) },
    openConversationFile: vi.fn(() => Promise.resolve()),
  }
}

function rect(width: number): DOMRect {
  return { width, height: 800, x: 0, y: 0, top: 0, right: width, bottom: 800, left: 0, toJSON: () => ({}) }
}
