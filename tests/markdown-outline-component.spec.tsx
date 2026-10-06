// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownOutline } from '../src/client/markdown/MarkdownOutline.tsx'
import type { MarkdownOutlineEntry } from '../src/client/markdown/markdown-outline.ts'

afterEach(() => { cleanup() })

describe('MarkdownOutline 面板', () => {
  it('无标题时显示空态且不渲染任何按钮', () => {
    const view = render(
      <MarkdownOutline entries={[]} labels={{ title: '大纲', empty: '暂无标题' }} onSelect={vi.fn()} />,
    )
    expect(view.getByRole('navigation', { name: '大纲' })).toBeTruthy()
    expect(view.getByText('暂无标题')).toBeTruthy()
    expect(view.queryAllByRole('button')).toHaveLength(0)
  })

  it('按层级渲染条目并把被点条目的 index 回传 onSelect', () => {
    const entries: MarkdownOutlineEntry[] = [
      { level: 1, text: 'Title', index: 0 },
      { level: 2, text: 'Section', index: 1 },
    ]
    const onSelect = vi.fn()
    const view = render(
      <MarkdownOutline entries={entries} labels={{ title: '大纲', empty: '暂无标题' }} onSelect={onSelect} />,
    )
    const section = view.getByRole('button', { name: 'Section' })
    expect(section.getAttribute('data-level')).toBe('2')
    fireEvent.click(section)
    expect(onSelect).toHaveBeenCalledWith(1)
  })
})
