/**
 * `.ipynb` document model: parse, edit, and re-serialize without losing anything.
 *
 * A notebook tab keeps its draft as the *file text*, exactly like the CSV and JSON
 * viewers do, so saving, dirty tracking, version checks, and external-change
 * reconciliation all stay in the shared file-tab machinery. This module is the only
 * place that knows the notebook JSON layout: it reads text into a render model,
 * applies one structural or content edit to the underlying JSON tree, and writes
 * text back out preserving the file's own conventions.
 *
 * What a round trip preserves:
 * - unknown document keys, cell keys, and cell metadata (the tree is edited in
 *   place, never rebuilt from the render model);
 * - whether `source` was stored as a string or as a list of lines;
 * - the file's indentation, line-ending style, byte-order mark, and trailing newline.
 */

import type { NotebookMimeBundle, NotebookOutputItem } from '../../shared/notebook-protocol.ts'

export const NBFORMAT_MINIMUM = 4
const MAX_STRUCTURED_NOTEBOOK_BYTES = 8 * 1024 * 1024

/** Cell kinds `.ipynb` defines; anything else is read as raw. */
export type NotebookCellKind = 'code' | 'markdown' | 'raw'

export interface NotebookCellModel {
  /** nbformat 4.5 cell id; synthesized for older notebooks that have none. */
  id: string
  index: number
  kind: NotebookCellKind
  source: string
  /** True when `source` is stored as a list of lines, so edits write it back that way. */
  sourceIsList: boolean
  executionCount: number | null
  outputs: NotebookOutputItem[]
  metadata: NotebookMimeBundle
}

export interface NotebookFormat {
  /** Exact indent string the file uses, so re-serializing does not reflow it. */
  indent: string
  newline: '\n' | '\r\n'
  trailingNewline: boolean
  /** True when the file begins with a UTF-8 byte order mark. */
  bom: boolean
}

export interface NotebookDocument {
  format: NotebookFormat
  cells: NotebookCellModel[]
  /** Document-level language metadata, used to label and highlight cells. */
  language: string
  /**
   * The kernel the file asks for, from `metadata.kernelspec.name`, or `''` when the
   * document does not name one. Auto-connect prefers it so a notebook saved against
   * `ir` opens on R rather than on whatever the workspace happens to list first.
   */
  kernelspecName: string
  nbformat: number
  nbformatMinor: number
  /** Why the text is not a usable notebook; the view still shows what it found. */
  warning: NotebookParseWarning | null
  /** True when the document is too large to edit structurally; use Source. */
  oversized: boolean
}

export type NotebookParseWarning = 'invalid-json' | 'missing-cells' | 'unsupported-format'

const DEFAULT_FORMAT: NotebookFormat = { indent: ' ', newline: '\n', trailingNewline: true, bom: false }

/** An edit that produced nothing because the notebook no longer matched. */
export class NotebookEditError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'NotebookEditError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Join Jupyter's `string | string[]` source/output representation into text. */
export function joinNotebookText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(entry => (typeof entry === 'string' ? entry : String(entry))).join('')
  if (value === undefined || value === null) return ''
  return String(value)
}

/** Split text the way `.ipynb` stores a source list: lines that keep their newline. */
export function splitNotebookLines(text: string): string[] {
  if (text === '') return []
  return text.split(/(?<=\n)/u)
}

function detectFormat(text: string): NotebookFormat {
  const bom = text.charCodeAt(0) === 0xFEFF
  const body = bom ? text.slice(1) : text
  const newline: '\n' | '\r\n' = body.includes('\r\n') ? '\r\n' : '\n'
  const indented = /\n([ \t]+)"/u.exec(body)
  const trailing = /\r?\n$/u.test(body)
  return { indent: indented?.[1] ?? ' ', newline, trailingNewline: trailing, bom }
}

function readMetadata(value: unknown): NotebookMimeBundle {
  return isRecord(value) ? value as NotebookMimeBundle : {}
}

function readCellKind(value: unknown): NotebookCellKind {
  return value === 'code' || value === 'markdown' || value === 'raw' ? value : 'raw'
}

/** Read the `.ipynb` output objects of one cell into render items. */
function readOutputs(value: unknown): NotebookOutputItem[] {
  if (!Array.isArray(value)) return []
  const outputs: NotebookOutputItem[] = []
  for (const entry of value) {
    const item = notebookOutputFromRecord(entry)
    if (item !== null) outputs.push(item)
  }
  return outputs
}

/**
 * Convert one `.ipynb` output object, or one live kernel output payload, into a
 * render item. Returns `null` for an output this workbench does not display, so
 * callers drop it rather than fabricate an empty row.
 */
export function notebookOutputFromRecord(entry: unknown): NotebookOutputItem | null {
  if (!isRecord(entry)) return null
  switch (entry['output_type']) {
    case 'stream':
      return {
        kind: 'stream',
        name: entry['name'] === 'stderr' ? 'stderr' : 'stdout',
        text: joinNotebookText(entry['text']),
      }
    case 'execute_result':
      return {
        kind: 'execute_result',
        executionCount: typeof entry['execution_count'] === 'number' ? entry['execution_count'] : 0,
        data: readMetadata(entry['data']),
        metadata: readMetadata(entry['metadata']),
      }
    case 'display_data':
      return { kind: 'display_data', data: readMetadata(entry['data']), metadata: readMetadata(entry['metadata']) }
    case 'update_display_data':
      return {
        kind: 'update_display_data',
        data: readMetadata(entry['data']),
        metadata: readMetadata(entry['metadata']),
      }
    case 'error':
      return {
        kind: 'error',
        ename: typeof entry['ename'] === 'string' ? entry['ename'] : 'Error',
        evalue: typeof entry['evalue'] === 'string' ? entry['evalue'] : '',
        traceback: Array.isArray(entry['traceback'])
          ? entry['traceback'].map(line => (typeof line === 'string' ? line : String(line)))
          : [],
      }
    default:
      return null
  }
}

/** Write one output back to its `.ipynb` object form. */
export function notebookOutputToRecord(item: NotebookOutputItem): Record<string, unknown> {
  switch (item.kind) {
    case 'stream':
      return { output_type: 'stream', name: item.name, text: splitNotebookLines(item.text) }
    case 'execute_result':
      return {
        output_type: 'execute_result',
        execution_count: item.executionCount,
        data: item.data,
        metadata: item.metadata,
      }
    case 'display_data':
    case 'update_display_data':
      return { output_type: item.kind, data: item.data, metadata: item.metadata }
    case 'error':
      return { output_type: 'error', ename: item.ename, evalue: item.evalue, traceback: item.traceback }
  }
}

/**
 * Read notebook text into a render model.
 *
 * Never throws: text that is not JSON, has no `cells`, or uses an unsupported
 * major version still yields a document carrying a `warning`, so the notebook view
 * can show what it found and offer Source for the fix.
 */
export function parseNotebook(text: string): NotebookDocument {
  const format = detectFormat(text)
  const oversized = new TextEncoder().encode(text).byteLength > MAX_STRUCTURED_NOTEBOOK_BYTES
  const blank: NotebookDocument = {
    format,
    cells: [],
    language: 'python',
    kernelspecName: '',
    nbformat: NBFORMAT_MINIMUM,
    nbformatMinor: 5,
    warning: null,
    oversized,
  }
  let value: unknown
  try {
    value = JSON.parse(stripByteOrderMark(text))
  } catch {
    return { ...blank, warning: 'invalid-json' }
  }
  if (!isRecord(value)) return { ...blank, warning: 'invalid-json' }
  const rawCells = Array.isArray(value['cells']) ? value['cells'] : null
  const nbformat = typeof value['nbformat'] === 'number' ? value['nbformat'] : NBFORMAT_MINIMUM
  if (rawCells === null) return { ...blank, nbformat, warning: 'missing-cells' }
  const cells: NotebookCellModel[] = []
  rawCells.forEach((candidate, index) => {
    if (!isRecord(candidate)) return
    const kind = readCellKind(candidate['cell_type'])
    cells.push({
      id: typeof candidate['id'] === 'string' && candidate['id'] !== '' ? candidate['id'] : `dsh-cell-${index}`,
      index,
      kind,
      source: joinNotebookText(candidate['source']),
      sourceIsList: Array.isArray(candidate['source']),
      executionCount: kind === 'code' && typeof candidate['execution_count'] === 'number'
        ? candidate['execution_count']
        : null,
      outputs: kind === 'code' ? readOutputs(candidate['outputs']) : [],
      metadata: readMetadata(candidate['metadata']),
    })
  })
  const metadata = isRecord(value['metadata']) ? value['metadata'] : {}
  const languageInfo = isRecord(metadata['language_info']) ? metadata['language_info'] : undefined
  const language = typeof languageInfo?.['name'] === 'string' ? languageInfo['name'] : 'python'
  const kernelspec = isRecord(metadata['kernelspec']) ? metadata['kernelspec'] : undefined
  const kernelspecName = typeof kernelspec?.['name'] === 'string' ? kernelspec['name'] : ''
  return {
    format,
    cells,
    language,
    kernelspecName,
    nbformat,
    nbformatMinor: typeof value['nbformat_minor'] === 'number' ? value['nbformat_minor'] : 0,
    warning: nbformat < NBFORMAT_MINIMUM ? 'unsupported-format' : null,
    oversized,
  }
}

function stripByteOrderMark(text: string): string {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text
}

/** Serialize a notebook tree back to file text in the file's own style. */
export function serializeNotebook(value: Record<string, unknown>, format: NotebookFormat): string {
  const body = JSON.stringify(value, null, format.indent)
  const unified = format.newline === '\n' ? body : body.replace(/\n/gu, format.newline)
  return `${format.bom ? '\uFEFF' : ''}${unified}${format.trailingNewline ? format.newline : ''}`
}

/**
 * Read the document tree, apply one edit to it, and return the new file text.
 *
 * Every notebook change funnels through here so the view has exactly one way to
 * write a file: parse the current draft, mutate the plain JSON tree in place, and
 * re-serialize with the detected format. A file that is not readable JSON raises
 * `NotebookEditError` rather than a raw `SyntaxError`, because every caller is a
 * click handler that has to refuse the edit rather than crash the panel.
 */
export function editNotebook(text: string, apply: (value: Record<string, unknown>, format: NotebookFormat) => void): string {
  const format = detectFormat(text)
  let value: unknown
  try {
    value = JSON.parse(stripByteOrderMark(text))
  } catch {
    throw new NotebookEditError('INVALID_NOTEBOOK', 'notebook is not valid JSON')
  }
  if (!isRecord(value)) throw new NotebookEditError('INVALID_NOTEBOOK', 'notebook is not a JSON object')
  apply(value, format)
  return serializeNotebook(value, format)
}

/**
 * The skeleton a blank notebook file becomes when its first cell is added.
 *
 * Creating a notebook from the file tree writes an empty file, so the cell surface
 * is looking at zero bytes. A skeleton carrying nbformat metadata is what makes the
 * first `+ code cell` produce a file Jupyter can open, rather than a bare array
 * parsed out of nothing.
 */
export function createNotebookSkeleton(kind: NotebookCellKind, language = 'python'): string {
  const value = {
    cells: [emptyCell(kind)],
    metadata: {
      kernelspec: { display_name: 'Python 3', language, name: language === 'python' ? 'python3' : language },
      language_info: { name: language },
    },
    nbformat: 4,
    nbformat_minor: 5,
  }
  return `${JSON.stringify(value, null, 1)}\n`
}

/** Whether a draft is an empty file that a first cell can turn into a real notebook. */
export function notebookIsBlank(text: string): boolean {
  return text.trim() === ''
}

function requireCells(value: Record<string, unknown>): Record<string, unknown>[] {
  const cells = value['cells']
  if (!Array.isArray(cells)) throw new NotebookEditError('INVALID_NOTEBOOK', 'notebook has no cells')
  return cells as Record<string, unknown>[]
}

function cellIndexOf(cells: readonly Record<string, unknown>[], cellId: string): number {
  return cells.findIndex(candidate => isRecord(candidate) && candidate['id'] === cellId)
}

function requireCell(value: Record<string, unknown>, cellId: string): {
  cells: Record<string, unknown>[]
  index: number
  cell: Record<string, unknown>
} {
  const cells = requireCells(value)
  const index = cellIndexOf(cells, cellId)
  const cell = index < 0 ? undefined : cells[index]
  if (cell === undefined || !isRecord(cell)) {
    throw new NotebookEditError('CELL_NOT_FOUND', `cell ${JSON.stringify(cellId)} is no longer in the notebook`)
  }
  return { cells, index, cell }
}

/** Generate the id a new cell gets, and one for notebooks older than nbformat 4.5. */
export function createCellId(): string {
  const random = Math.random().toString(36).slice(2, 8)
  return `dsh-${random}${Date.now().toString(36).slice(-4)}`
}

/** A blank cell object in the shape its kind requires. */
export function emptyCell(kind: NotebookCellKind, id = createCellId()): Record<string, unknown> {
  if (kind === 'code') {
    return { cell_type: 'code', execution_count: null, id, metadata: {}, outputs: [], source: [] }
  }
  return { cell_type: kind, id, metadata: {}, source: [] }
}

/** Write `source` back in whatever shape the cell already used. */
function writeCellSource(cell: Record<string, unknown>, source: string): void {
  cell['source'] = typeof cell['source'] === 'string' ? source : splitNotebookLines(source)
}

/** One structural or content change the notebook view can request. */
export type NotebookMutation =
  | { op: 'set-source'; cellId: string; source: string }
  | { op: 'set-kind'; cellId: string; kind: NotebookCellKind }
  | { op: 'insert'; cellId: string | null; before: boolean; kind: NotebookCellKind }
  | { op: 'delete'; cellId: string }
  | { op: 'move'; cellId: string; direction: -1 | 1 }
  | { op: 'split'; cellId: string; offset: number }
  | { op: 'merge-down'; cellId: string }
  | { op: 'set-outputs'; cellId: string; outputs: NotebookOutputItem[] }
  | { op: 'append-output'; cellId: string; item: NotebookOutputItem }
  | { op: 'clear-outputs'; cellId: string }
  | { op: 'clear-all-outputs' }
  | { op: 'set-execution-count'; cellId: string; executionCount: number | null }

/** Apply one mutation to notebook text and return the new text. */
export function applyNotebookMutation(text: string, mutation: NotebookMutation): string {
  return editNotebook(text, (value) => {
    switch (mutation.op) {
      case 'set-source': {
        const { cell } = requireCell(value, mutation.cellId)
        writeCellSource(cell, mutation.source)
        return
      }
      case 'set-kind': {
        const { cell } = requireCell(value, mutation.cellId)
        if (mutation.kind === 'code') {
          cell['cell_type'] = 'code'
          if (!Array.isArray(cell['outputs'])) cell['outputs'] = []
          if (!('execution_count' in cell)) cell['execution_count'] = null
        } else {
          cell['cell_type'] = mutation.kind
          delete cell['outputs']
          delete cell['execution_count']
        }
        return
      }
      case 'insert': {
        const cells = requireCells(value)
        const cell = emptyCell(mutation.kind)
        if (mutation.cellId === null) {
          cells.push(cell)
          return
        }
        const index = cellIndexOf(cells, mutation.cellId)
        if (index < 0) throw new NotebookEditError('CELL_NOT_FOUND', 'the notebook changed; try again')
        cells.splice(mutation.before ? index : index + 1, 0, cell)
        return
      }
      case 'delete': {
        const cells = requireCells(value)
        const index = cellIndexOf(cells, mutation.cellId)
        if (index >= 0) cells.splice(index, 1)
        return
      }
      case 'move': {
        const cells = requireCells(value)
        const from = cellIndexOf(cells, mutation.cellId)
        const to = from + mutation.direction
        if (from < 0 || to < 0 || to >= cells.length) return
        const cell = cells[from]
        if (cell === undefined) return
        cells.splice(from, 1)
        cells.splice(to, 0, cell)
        return
      }
      case 'split': {
        const { cells, index, cell } = requireCell(value, mutation.cellId)
        const source = joinNotebookText(cell['source'])
        const offset = Math.max(0, Math.min(mutation.offset, source.length))
        const clone = structuredClone(cell)
        if (typeof cell['source'] === 'string') {
          cell['source'] = source.slice(0, offset)
          clone['source'] = source.slice(offset)
        } else {
          cell['source'] = splitNotebookLines(source.slice(0, offset))
          clone['source'] = splitNotebookLines(source.slice(offset))
        }
        clone['id'] = createCellId()
        if (clone['cell_type'] === 'code') {
          clone['outputs'] = []
          clone['execution_count'] = null
        }
        cells.splice(index + 1, 0, clone)
        return
      }
      case 'merge-down': {
        const { cells, index, cell } = requireCell(value, mutation.cellId)
        const next = cells[index + 1]
        if (next === undefined || !isRecord(next)) return
        const merged = `${joinNotebookText(cell['source'])}\n${joinNotebookText(next['source'])}`
        writeCellSource(cell, merged)
        if (cell['cell_type'] === 'code') {
          const own = Array.isArray(cell['outputs']) ? cell['outputs'] : []
          const below = Array.isArray(next['outputs']) ? next['outputs'] : []
          cell['outputs'] = [...own, ...below]
        }
        cells.splice(index + 1, 1)
        return
      }
      case 'set-outputs': {
        const { cell } = requireCell(value, mutation.cellId)
        cell['outputs'] = mutation.outputs.map(notebookOutputToRecord)
        return
      }
      case 'append-output': {
        const { cell } = requireCell(value, mutation.cellId)
        const outputs = Array.isArray(cell['outputs']) ? cell['outputs'] : []
        outputs.push(notebookOutputToRecord(mutation.item))
        cell['outputs'] = outputs
        return
      }
      case 'clear-outputs': {
        const { cell } = requireCell(value, mutation.cellId)
        cell['outputs'] = []
        cell['execution_count'] = null
        return
      }
      case 'clear-all-outputs': {
        for (const cell of requireCells(value)) {
          if (!isRecord(cell) || cell['cell_type'] !== 'code') continue
          cell['outputs'] = []
          cell['execution_count'] = null
        }
        return
      }
      case 'set-execution-count': {
        const { cell } = requireCell(value, mutation.cellId)
        cell['execution_count'] = mutation.executionCount
        return
      }
    }
  })
}

/**
 * Language a cell should highlight as.
 *
 * `.ipynb` records the kernel language in document metadata; a cell may override it
 * through `metadata.jupyter.source` (Jupyter's own cell-language tag) or a plain
 * `metadata.language`. Otherwise the document language is what the kernel runs.
 */
export function notebookCellLanguage(document: NotebookDocument, cell: NotebookCellModel): string {
  const declared = cell.metadata['language']
  if (typeof declared === 'string' && declared !== '') return declared
  const jupyter = isRecord(cell.metadata['jupyter']) ? cell.metadata['jupyter'] : undefined
  const source = typeof jupyter?.['source'] === 'string' ? jupyter['source'] : undefined
  if (source !== undefined && source !== '') return source
  return document.language
}

/** Text lines of a cell, for line-numbered rendering and split offsets. */
export function notebookCellLines(source: string): string[] {
  return source.split('\n')
}

/** Cell ids present in the document, in order — the run-all sequence. */
export function notebookCellIds(document: NotebookDocument, kinds: readonly NotebookCellKind[] = ['code']): string[] {
  return document.cells.filter(cell => kinds.includes(cell.kind)).map(cell => cell.id)
}
