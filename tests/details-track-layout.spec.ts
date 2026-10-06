// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDetailsTrackLayout,
  DETAILS_TRACK_ATTRIBUTE,
  DETAILS_TRACK_FALLBACK_ATTRIBUTE,
  DETAILS_TRACK_HANDLE_ATTRIBUTE,
  DETAILS_TRACK_SIDEBAR_WIDTH,
  DETAILS_TRACK_WIDTH,
  SIDEBAR_TRACK_HANDLE_ATTRIBUTE,
} from '../src/client/layout/details-track-layout.ts'

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

interface TrackFixture {
  frame: HTMLElement
  sidebar: HTMLElement
  phase: HTMLElement
}

function trackFixture(phase: string): TrackFixture {
  const frame = document.createElement('div')
  const sidebar = document.createElement('div')
  const conversation = document.createElement('div')
  const phaseNode = document.createElement('div')
  phaseNode.dataset.phase = phase
  conversation.appendChild(phaseNode)
  const details = document.createElement('div')
  details.appendChild(document.createElement('span'))
  frame.append(sidebar, conversation, details)
  document.body.appendChild(frame)
  vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue(rect(1600))
  vi.spyOn(sidebar, 'getBoundingClientRect').mockReturnValue(rect(300))
  return { frame, sidebar, phase: phaseNode }
}

/** The handles are created by the layout itself, so look them up afterwards. */
function handles(frame: HTMLElement): { sidebarHandle: HTMLElement; fallbackHandle: HTMLElement } {
  return {
    sidebarHandle: frame.querySelector(`[${SIDEBAR_TRACK_HANDLE_ATTRIBUTE}]`) as HTMLElement,
    fallbackHandle: frame.querySelector(`[${DETAILS_TRACK_HANDLE_ATTRIBUTE}]`) as HTMLElement,
  }
}

function rect(width: number): DOMRect {
  return new DOMRect(0, 0, width, 900)
}

function pointer(target: HTMLElement, type: string, clientX: number): void {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX }))
}

describe('右侧会话轨道与侧栏把手的模式选择', () => {
  it('空会话也接管轨道并保留侧栏拖拽把手', () => {
    const { frame } = trackFixture('hero')
    const layout = createDetailsTrackLayout(frame, { info: vi.fn() })
    const { sidebarHandle, fallbackHandle } = handles(frame)

    expect(frame.hasAttribute(DETAILS_TRACK_ATTRIBUTE)).toBe(true)
    expect(frame.hasAttribute(DETAILS_TRACK_FALLBACK_ATTRIBUTE)).toBe(true)
    expect(sidebarHandle.hidden).toBe(false)
    expect(fallbackHandle.hidden).toBe(false)
    expect(frame.style.getPropertyValue(DETAILS_TRACK_SIDEBAR_WIDTH)).toBe('300px')
    expect(frame.style.getPropertyValue(DETAILS_TRACK_WIDTH)).toBe('512px')

    layout.dispose()
    expect(frame.hasAttribute(DETAILS_TRACK_ATTRIBUTE)).toBe(false)
    expect(sidebarHandle.hidden).toBe(true)
  })

  it('有对话的会话接管原生分隔线且不再挂载后备把手', () => {
    const { frame } = trackFixture('active')
    const layout = createDetailsTrackLayout(frame, { info: vi.fn() })
    const { sidebarHandle, fallbackHandle } = handles(frame)

    expect(frame.hasAttribute(DETAILS_TRACK_ATTRIBUTE)).toBe(true)
    expect(frame.hasAttribute(DETAILS_TRACK_FALLBACK_ATTRIBUTE)).toBe(false)
    expect(sidebarHandle.hidden).toBe(false)
    expect(fallbackHandle.hidden).toBe(true)

    layout.dispose()
  })

  it('右栏全屏时完全交还给原生 AppFrame', () => {
    const { frame } = trackFixture('hero')
    frame.setAttribute('data-rightbar-fullscreen', '')
    const layout = createDetailsTrackLayout(frame, { info: vi.fn() })
    const { sidebarHandle, fallbackHandle } = handles(frame)

    expect(frame.hasAttribute(DETAILS_TRACK_ATTRIBUTE)).toBe(false)
    expect(frame.hasAttribute(DETAILS_TRACK_FALLBACK_ATTRIBUTE)).toBe(false)
    expect(sidebarHandle.hidden).toBe(true)
    expect(fallbackHandle.hidden).toBe(true)
    expect(frame.style.getPropertyValue(DETAILS_TRACK_SIDEBAR_WIDTH)).toBe('')

    layout.dispose()
  })

  it('空会话下拖拽侧栏把手会更新侧栏宽度变量', () => {
    const { frame } = trackFixture('settling')
    const layout = createDetailsTrackLayout(frame, { info: vi.fn() })
    const { sidebarHandle } = handles(frame)
    expect(frame.style.getPropertyValue(DETAILS_TRACK_SIDEBAR_WIDTH)).toBe('300px')

    pointer(sidebarHandle, 'pointerdown', 300)
    pointer(sidebarHandle, 'pointerup', 340)
    expect(frame.style.getPropertyValue(DETAILS_TRACK_SIDEBAR_WIDTH)).toBe('340px')

    layout.dispose()
  })
})
