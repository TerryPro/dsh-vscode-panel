/**
 * 文件视图注册表：编辑器主体里决定一份文件显示成什么的那唯一一处。
 *
 * 一个视图自己声明五件事：认哪些文件、有哪几个模式可切（含默认）、正文画成什么、
 * 状态条右侧放哪些按钮、状态条左侧那行「这份文件连着什么」。加一种文件类型就是加一个视图。
 *
 * 查找按这里声明的顺序取第一个命中者；兜底视图的判定永远为真，因此固定排在最后。
 */

import type { ComponentType, ReactNode } from 'react'
import type { EditorView } from '@codemirror/view'
import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkbenchController, WorkbenchFileTab } from '../model/controller.ts'
import { plainTextView } from './views/plain-text-view.tsx'
import { markdownView } from './views/markdown-view.tsx'
import { htmlView } from './views/html-view.tsx'
import { mermaidView } from './views/mermaid-view.tsx'
import { csvView } from './views/csv-view.tsx'
import { structuredView } from './views/structured-view.tsx'
import { notebookView } from './views/notebook-view.tsx'
import { sqlNotebookView } from './views/sql-notebook-view.tsx'

/** 判定一份文件归哪个视图时能看到的全部东西：它的路径，以及宿主说它是不是 Markdown。 */
export interface FileViewSubject {
  readonly path: string
  readonly markdown: boolean
}

/** 一个视图声明的一个模式。 */
export interface FileViewMode {
  /** 模式名，存在 tab 上就是它。 */
  readonly name: string
  /** 这个模式下正文里有没有那块纯文本编辑器。 */
  readonly editor: boolean
}

export interface FileViewModes {
  /** 默认模式的模式名；一定在 `available` 里，由 `viewModes` 保证。 */
  readonly default: string
  /** 可切的模式；至少一个，因为每个视图总得有个默认。 */
  readonly available: readonly [FileViewMode, ...FileViewMode[]]
}

/**
 * 声明一个视图的可选模式。
 *
 * `fallback` 的类型就是 `available` 里模式名的并集，所以写一个不在集合里的默认模式过不了编译。
 */
export function viewModes<const T extends readonly [FileViewMode, ...FileViewMode[]]>(
  available: T,
  fallback: T[number]['name'],
): FileViewModes {
  return { default: fallback, available }
}

/** 视图在自己那块界面上要用到的东西。 */
export interface FileViewChromeProps {
  /** 这份文件。 */
  readonly tab: WorkbenchFileTab
  /** 它此刻的模式；注册表已按视图声明的集合校正过。 */
  readonly mode: string
  readonly controller: WorkbenchController
  readonly t: TranslateNS<'workbench'>
}

/** 正文拿到的输入：上面那些，加上各视图在 source 与 split 里共用的那块纯文本编辑器。 */
export interface FileViewBodyProps extends FileViewChromeProps {
  readonly workspaceId: string
  /** 那块纯文本编辑器，由编辑器主体建好后传进来；视图不自己造第二个。 */
  readonly codeEditor: ReactNode
  /** 那块编辑器的 CodeMirror 视图，供预览侧与它同步滚动、对齐。 */
  readonly editorView: EditorView | null
  readonly markdownLabels: MarkdownLabels
}

/** 一个文件视图。 */
export interface FileView {
  /** 视图名，存在 tab 上就是它。 */
  readonly name: string
  readonly matches: (file: FileViewSubject) => boolean
  readonly modes: FileViewModes
  readonly body: ComponentType<FileViewBodyProps>
  /** 状态条右侧那组本视图自己的按钮。 */
  readonly toolbar: ComponentType<FileViewChromeProps>
  /** 状态条左侧那行「这份文件连着什么」；不声明的视图没有这一行。 */
  readonly attachment?: ComponentType<FileViewChromeProps>
}

/** 声明的顺序就是查找的顺序：先声明的先命中，兜底视图排在最后。 */
const FILE_VIEWS: readonly FileView[] = [
  notebookView,
  sqlNotebookView,
  mermaidView,
  htmlView,
  csvView,
  structuredView,
  markdownView,
  plainTextView,
]

/** 认领这份文件的那第一个视图。兜底视图永远命中，所以这里总有一个结果。 */
export function fileViewFor(file: FileViewSubject): FileView {
  return FILE_VIEWS.find(view => view.matches(file)) ?? plainTextView
}

/** 这份文件此刻的模式：存的那个若已不在视图声明的集合里，就退回默认。 */
export function fileViewMode(view: FileView, stored: string | undefined): FileViewMode {
  return view.modes.available.find(mode => mode.name === stored)
    ?? view.modes.available.find(mode => mode.name === view.modes.default)
    ?? view.modes.available[0]
}

/** 一份文件此刻归哪个视图、用哪个模式。 */
export interface ResolvedFileView {
  readonly view: FileView
  readonly mode: FileViewMode
}

/**
 * 解析一份文件此刻的视图与模式。
 *
 * 视图由文件自己决定，tab 上记下的那个不作数：文件被换成别的类型时，认领者必须跟着换。
 */
export function resolveFileView(file: FileViewSubject & { mode?: string }): ResolvedFileView {
  const view = fileViewFor(file)
  return { view, mode: fileViewMode(view, file.mode) }
}

/** 一个文件 tab 此刻的视图与模式。 */
export function fileViewOf(tab: WorkbenchFileTab): ResolvedFileView {
  return resolveFileView({
    path: tab.path,
    markdown: tab.file?.markdown === true,
    ...(tab.mode === undefined ? {} : { mode: tab.mode }),
  })
}
