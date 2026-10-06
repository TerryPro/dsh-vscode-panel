// @vitest-environment jsdom

import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodeEditor } from '../src/client/editor/CodeEditor.tsx'

afterEach(() => { cleanup() })

describe('CodeEditor 语法高亮', () => {
  it('依据文件路径加载语言并为源码着色', async () => {
    const view = render(
      <CodeEditor
        value={'const greeting = "hi" // note'}
        onChange={() => {}}
        ariaLabel="src/a.ts"
        path="src/a.ts"
      />,
    )
    const content = view.container.querySelector('.cm-content')
    // 语言扩展生效：内容节点标记出解析器名称。
    expect(content?.getAttribute('data-language')).toBe('typescript')
    // CodeMirror 在调度帧内着色，等待 token span 出现。
    await waitFor(() => {
      const tokens = view.container.querySelectorAll('.cm-line span')
      expect(tokens.length).toBeGreaterThanOrEqual(5)
    })
  })

  it('未知扩展名的文件不加载语言，仅保留纯文本', () => {
    const view = render(
      <CodeEditor
        value={'const greeting = "hi"'}
        onChange={() => {}}
        ariaLabel="LICENSE"
        path="LICENSE"
      />,
    )
    expect(view.container.querySelector('.cm-content')?.getAttribute('data-language')).toBeNull()
  })

  it('用 SVG 人字 chevron 渲染折叠图标，而非文本字符', async () => {
    const view = render(
      <CodeEditor
        value={'function outer() {\n  const a = 1\n  return a\n}\n'}
        onChange={() => {}}
        ariaLabel="src/a.ts"
        path="src/a.ts"
      />,
    )
    // 可折叠行解析后才会挂上折叠 marker，等待 SVG chevron 出现。
    await waitFor(() => {
      const marker = view.container.querySelector('.cm-foldGutter .cm-gutterElement span[data-fold-open]')
      expect(marker).not.toBeNull()
    })
    const svg = view.container.querySelector('.cm-foldGutter svg')
    expect(svg).not.toBeNull()
    expect(svg?.querySelector('path')).not.toBeNull()
    // 不再使用旧的文本字形。
    expect(view.container.querySelector('.cm-foldGutter')?.textContent).not.toContain('›')
  })

  it('挂载时上报初始光标位置', () => {
    const onCursorChange = vi.fn()
    render(
      <CodeEditor
        value={'const a = 1'}
        onChange={() => {}}
        ariaLabel="src/a.ts"
        path="src/a.ts"
        onCursorChange={onCursorChange}
      />,
    )
    expect(onCursorChange).toHaveBeenCalledWith({ line: 1, column: 1, selectedChars: 0, selectedLines: 0 })
  })

  it('最终结果模式（inlineDiff=false）不显示任何 Git 装饰', () => {
    const view = render(
      <CodeEditor
        value={'a\nb\nc\nnew line'}
        onChange={() => {}}
        ariaLabel="src/a.ts"
        path="src/a.ts"
        gitOriginal={'a\nb\nc'}
        inlineDiff={false}
      />,
    )
    expect(view.container.querySelector('.cm-gitChangeGutter')).toBeNull()
  })

  it('inlineDiff 模式改用内联差异视图，不再渲染行内变更标记', () => {
    const view = render(
      <CodeEditor
        value={'a\nb\nc\nnew line'}
        onChange={() => {}}
        ariaLabel="src/a.ts"
        path="src/a.ts"
        gitOriginal={'a\nb\nc'}
        inlineDiff={true}
      />,
    )
    // 切换到 unifiedMergeView：我们的 gitChangeGutter 不再存在。
    expect(view.container.querySelector('.cm-gitChangeGutter')).toBeNull()
  })
})
