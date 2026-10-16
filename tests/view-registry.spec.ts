import { describe, expect, it, vi } from 'vitest'
import type { WorkbenchFileTab } from '../src/client/model/controller.ts'
import { fileViewOf, resolveFileView } from '../src/client/editor/view-registry.ts'

// 注册表连带着各视图的正文与工具条，它们会导入 UI primitives；这里只测分派，不渲染，
// 所以照其它界面 spec 的做法把这个包架掉。
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({}))

/** 一份文件的判定只看两件事：路径，以及宿主说它是不是 Markdown。 */
function claim(path: string, markdown = false): { view: string; mode: string; editor: boolean } {
  const { view, mode } = resolveFileView({ path, markdown })
  return { view: view.name, mode: mode.name, editor: mode.editor }
}

describe('文件视图注册表', () => {
  it('按声明顺序认领：每种格式归自己的视图，认不出的落到兜底', () => {
    expect(claim('diagram.mmd').view).toBe('mermaid')
    expect(claim('diagram.mermaid').view).toBe('mermaid')
    expect(claim('index.html').view).toBe('html')
    expect(claim('data.csv').view).toBe('csv')
    expect(claim('data.tsv').view).toBe('csv')
    expect(claim('cfg.json').view).toBe('structured')
    expect(claim('cfg.yaml').view).toBe('structured')
  })

  it('两种单元文档各归各的视图，不合成一类', () => {
    expect(claim('nb.ipynb').view).toBe('notebook')
    expect(claim('query.sqlnb').view).toBe('sqlNotebook')
  })

  it('Markdown 由宿主标记认领，不看扩展名', () => {
    expect(claim('README.md', true).view).toBe('markdown')
    // 同一个扩展名，宿主说不像 Markdown 就不是它。
    expect(claim('README.md').view).toBe('plainText')
    expect(claim('notes.txt', true).view).toBe('markdown')
  })

  it('兜底视图接住其它一切', () => {
    expect(claim('src/a.ts').view).toBe('plainText')
    expect(claim('notes.txt').view).toBe('plainText')
    expect(claim('a').view).toBe('plainText')
  })

  it('每个视图开在自己的默认模式上', () => {
    expect(claim('README.md', true).mode).toBe('preview')
    expect(claim('index.html').mode).toBe('preview')
    expect(claim('diagram.mmd').mode).toBe('split')
    expect(claim('data.csv').mode).toBe('table')
    expect(claim('cfg.json').mode).toBe('graph')
    expect(claim('nb.ipynb').mode).toBe('notebook')
    expect(claim('query.sqlnb').mode).toBe('notebook')
    expect(claim('src/a.ts').mode).toBe('source')
  })

  it('存下来的模式不在该视图的集合里就退回默认', () => {
    const stored = (path: string, mode: string): string => resolveFileView({ path, markdown: false, mode }).mode.name
    expect(stored('data.csv', 'split')).toBe('split')
    expect(stored('data.csv', 'preview')).toBe('table')
    expect(stored('src/a.ts', 'split')).toBe('source')
    expect(stored('diagram.mmd', 'notebook')).toBe('split')
  })

  it('正文里有没有那块纯文本编辑器，由模式自己说', () => {
    const editor = (path: string, mode?: string, markdown = false): boolean =>
      resolveFileView({ path, markdown, ...(mode === undefined ? {} : { mode }) }).mode.editor
    expect(editor('README.md', 'preview', true)).toBe(false)
    expect(editor('README.md', 'split', true)).toBe(true)
    expect(editor('README.md', 'source', true)).toBe(true)
    expect(editor('index.html')).toBe(false)
    expect(editor('index.html', 'interactive')).toBe(false)
    expect(editor('index.html', 'source')).toBe(true)
    expect(editor('data.csv', 'table')).toBe(false)
    expect(editor('cfg.json', 'graph')).toBe(false)
    expect(editor('nb.ipynb', 'notebook')).toBe(false)
    expect(editor('nb.ipynb', 'source')).toBe(true)
    expect(editor('query.sqlnb', 'notebook')).toBe(false)
    expect(editor('src/a.ts')).toBe(true)
  })

  it('视图跟着文件走：文件换了类型就换认领者', () => {
    // 同一个路径，宿主改说它是 Markdown 之后，认领者就从兜底换成 Markdown 视图。
    expect(resolveFileView({ path: 'a.txt', markdown: false }).view.name).toBe('plainText')
    expect(resolveFileView({ path: 'a.txt', markdown: true }).view.name).toBe('markdown')
    // 记下的模式不属于新认领者时就退回它的默认。
    expect(resolveFileView({ path: 'cfg.json', markdown: false, mode: 'table' }).mode.name).toBe('graph')
  })

  it('一个文件 tab 解析出的视图与模式', () => {
    expect(fileViewOf(fileTab('diagram.mmd', false, 'preview'))).toMatchObject({
      view: { name: 'mermaid' },
      mode: { name: 'preview', editor: false },
    })
    expect(fileViewOf(fileTab('src/a.ts', false)).mode.name).toBe('source')
    expect(fileViewOf(fileTab('README.md', true, 'split')).mode.name).toBe('split')
  })
})

/** The open file tab a resolution reads: path, whether the Host called it Markdown, and the chosen mode. */
function fileTab(path: string, markdown: boolean, mode?: string): WorkbenchFileTab {
  return {
    id: `file:${path}`,
    kind: 'file',
    path,
    file: { path, content: '', version: '1', size: 0, markdown },
    image: null,
    draft: '',
    dirty: false,
    ...(mode === undefined ? {} : { mode }),
    wrap: true,
    inlineDiff: false,
    loading: false,
    saving: false,
    externalChange: null,
    error: null,
  }
}
