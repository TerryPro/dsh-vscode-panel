/**
 * Choosing what a kernel output actually renders as.
 *
 * A mime bundle carries the same object in several forms — `pandas` sends
 * `text/html` plus a `text/plain` fallback, matplotlib sends `image/png` plus a
 * long repr — and which one a reader wants depends on both the bundle and what this
 * workbench can draw. This module owns that decision once, so the output view and
 * its tests read the same vocabulary: pick the richest form that renders, keep the
 * fallback available for the copy path, and never show an empty cell.
 */

import type { NotebookMimeBundle, NotebookOutputItem } from '../../shared/notebook-protocol.ts'
import { stripAnsiSequences } from './ansi-text.ts'

/** Forms this workbench can draw, richest first. */
const PREFERRED = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'text/html',
  'text/latex',
  'application/json',
  'text/markdown',
] as const

export type NotebookRenderKind = 'image' | 'html' | 'latex' | 'json' | 'markdown' | 'text' | 'none'

export interface NotebookRenderChoice {
  kind: NotebookRenderKind
  /** The mime type selected, so the view can label an explicit override. */
  mime: string
  /** Raw bundle value for that mime. */
  value: string | unknown
  /** Mime types the bundle offered, for the "show as" switch. */
  alternatives: string[]
}

/** Mime types that carry a raster or vector image the browser can draw. */
export function isImageMime(mime: string): boolean {
  return mime === 'image/svg+xml' || mime.startsWith('image/')
}

/** `image/*` values arrive base64-encoded per the Jupyter protocol. */
export function imageDataUrl(mime: string, value: string): string {
  return mime === 'image/svg+xml' ? `data:${mime};utf8,${value}` : `data:${mime};base64,${value}`
}

function textValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(entry => (typeof entry === 'string' ? entry : String(entry))).join('')
  return undefined
}

/**
 * Pick the form to render for one mime bundle.
 *
 * `text/plain` is deliberately last and only used when nothing else is present: a
 * kernel almost always includes it, and preferring it would turn every data frame
 * into its console repr.
 * @param data - the bundle's `data` field.
 * @param prefer - an explicit mime the reader asked for, used when the bundle has it.
 * @returns the chosen form, or `none` when the bundle carries nothing renderable.
 */
export function chooseNotebookRender(
  data: NotebookMimeBundle,
  prefer?: string,
): NotebookRenderChoice {
  const keys = Object.keys(data)
  const alternatives = keys.filter(key => key !== 'application/vnd.jupyter.widget-view+json')
  if (prefer !== undefined && data[prefer] !== undefined) {
    return { kind: kindForMime(prefer), mime: prefer, value: data[prefer] ?? '', alternatives }
  }
  for (const mime of PREFERRED) {
    const value = data[mime]
    if (value === undefined) continue
    if (mime === 'text/html' && (textValue(value) ?? '').trim() === '') continue
    const kind = kindForMime(mime)
    if (kind === 'none') continue
    return { kind, mime, value: value ?? '', alternatives }
  }
  const plain = data['text/plain']
  if (plain !== undefined) {
    return { kind: 'text', mime: 'text/plain', value: plain ?? '', alternatives }
  }
  return { kind: 'none', mime: '', value: '', alternatives }
}

function kindForMime(mime: string): NotebookRenderKind {
  if (isImageMime(mime)) return 'image'
  if (mime === 'text/html') return 'html'
  if (mime === 'text/latex') return 'latex'
  if (mime === 'application/json') return 'json'
  if (mime === 'text/markdown') return 'markdown'
  if (mime === 'text/plain') return 'text'
  return 'none'
}

/**
 * Plain text for the copy path.
 *
 * Copying an output should give the reader what they would have seen in a terminal,
 * so ANSI codes are stripped from every text form and a rendered image contributes
 * nothing at all.
 */
export function notebookOutputText(item: NotebookOutputItem): string {
  switch (item.kind) {
    case 'stream':
      return stripAnsiSequences(item.text)
    case 'error':
      return stripAnsiSequences([item.ename, item.evalue, ...item.traceback].filter(Boolean).join('\n'))
    case 'execute_result':
    case 'display_data':
    case 'update_display_data': {
      const text = chooseNotebookRender(item.data)
      if (text.kind === 'image') return ''
      return stripAnsiSequences(textValue(text.value) ?? '')
    }
  }
}

/** Whether an output carries anything a reader can see. */
export function notebookOutputIsVisible(item: NotebookOutputItem): boolean {
  switch (item.kind) {
    case 'stream':
      return item.text.trim() !== ''
    case 'error':
      return true
    default:
      return chooseNotebookRender(item.data).kind !== 'none'
  }
}

/**
 * Collapse consecutive stream items of the same name.
 *
 * A `print` in a loop arrives as one frame per call; showing hundreds of near-empty
 * rows is noise, and a writer that merged them reads like the terminal did.
 */
export function collapseNotebookStreams(items: readonly NotebookOutputItem[]): NotebookOutputItem[] {
  const merged: NotebookOutputItem[] = []
  for (const item of items) {
    const previous = merged.at(-1)
    if (previous !== undefined && previous.kind === 'stream' && item.kind === 'stream' && previous.name === item.name) {
      merged[merged.length - 1] = { ...previous, text: previous.text + item.text }
      continue
    }
    merged.push(item)
  }
  return merged
}

/** Whether the bundle is a widget view the workbench cannot render, and says so. */
export function notebookWidgetNotice(data: NotebookMimeBundle): string | null {
  const widget = data['application/vnd.jupyter.widget-view+json']
  if (widget === undefined) return null
  const modelId = typeof widget === 'object' && widget !== null && typeof (widget as Record<string, unknown>)['model_id'] === 'string'
    ? (widget as Record<string, string>)['model_id']
    : ''
  const fallback = textValue(data['text/plain']) ?? ''
  if (fallback.trim() !== '' && chooseNotebookRender({ 'text/plain': fallback }).kind === 'text') {
    // `ipywidgets` ships a text fallback; showing it is more useful than a notice.
    return null
  }
  return modelId === ''
    ? 'jupyter widget output cannot be displayed here'
    : 'jupyter widget output cannot be displayed here'
}

/** The scheme Jupyter writes for a cell-carried figure: `![alt](attachment:name.png)`. */
const ATTACHMENT_PREFIX = 'attachment:'

/**
 * Resolve one Markdown `attachment:` reference to a data URL, or nothing at all.
 *
 * A figure dragged into a Markdown cell is stored in two halves: the source keeps
 * `![alt](attachment:plot.png)` and the cell's `attachments` map keeps the bytes. The shared
 * Markdown renderer can only draw the first half, so this hands it the second — the same
 * mime-ranked choice an output bundle gets, which keeps one set of rules for "what can this
 * workbench draw" across kernel output and authored images alike.
 *
 * Returning `undefined` is the documented way to decline: the renderer then falls back to the
 * image's alt text, which names the figure the reader can no longer see. That is the right
 * outcome for a destination this cell does not carry, and for a form it cannot draw (a PDF
 * attachment, say) — worse would be an invented or broken thumbnail.
 */
export function notebookAttachmentUrl(
  attachments: NotebookMimeBundle,
  destination: string,
): string | undefined {
  if (!destination.startsWith(ATTACHMENT_PREFIX)) return undefined
  const bundle = attachments[destination.slice(ATTACHMENT_PREFIX.length)]
  if (typeof bundle !== 'object' || bundle === null || Array.isArray(bundle)) return undefined
  const choice = chooseNotebookRender(bundle as NotebookMimeBundle)
  // An attachment is drawn or it is not: html or latex would mean injecting executable
  // markup from a file into the page, which is the boundary kernel output already respects.
  return choice.kind === 'image' ? imageDataUrl(choice.mime, String(choice.value)) : undefined
}
