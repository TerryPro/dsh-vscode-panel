/**
 * `.sqlnb` document model: parse, edit, and re-serialize without losing anything.
 *
 * A SQL notebook tab keeps its draft as the *file text*, exactly like the notebook,
 * CSV and JSON viewers do, so saving, dirty tracking, version checks and
 * external-change reconciliation all stay in the shared file-tab machinery. This
 * module is the only place that knows the `.sqlnb` layout.
 *
 * What the format deliberately does NOT store (ADR 0003):
 * - results. Running a cell never changes the file, so it never marks it dirty.
 * - cell ids. They are derived from cell order (see `sqlCellId`), because a stored
 *   random id would dirty every Git diff for a value nothing depends on.
 * - which database the notebook points at. A connection is session state; writing
 *   the path in would make the file point at a database that may have moved.
 *
 * Round trips preserve unknown document keys, unknown cell keys, whether `source`
 * was a string or a list of lines, the file's indentation, line endings, BOM and
 * trailing newline — the tree is edited in place, never rebuilt from the render
 * model.
 */

import type { SqlCellKind } from '../../shared/sql-protocol.ts'

/** The document version this build writes and understands. */
export const SQLNB_VERSION = 1

export const SQL_NOTEBOOK_EXTENSIONS = ['sqlnb'] as const

/** Whether this workspace path is a SQL notebook. */
export function isSqlNotebookPath(path: string | undefined): boolean {
  if (path === undefined) return false
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1).toLowerCase()
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return false
  return (SQL_NOTEBOOK_EXTENSIONS as readonly string[]).includes(name.slice(dot + 1))
}

/**
 * A cell kind this view can render.
 *
 * `raw` is not a kind users choose — it is what an unrecognized kind becomes, so a
 * future version's cell type still reaches the screen as text instead of vanishing.
 */
export type SqlNotebookCellKind = 'sql' | 'markdown' | 'raw'

export interface SqlNotebookCellModel {
  /** Derived from cell order, never stored. See the file header. */
  id: string
  index: number
  kind: SqlNotebookCellKind
  source: string
  /**
   * True when the file asked for a kind this build does not know.
   *
   * Shown as text and not editable: quietly re-typing an unknown cell as `sql` would
   * run content the author never meant to run.
   */
  degraded: boolean
  /** True when `source` was stored as a list, so an edit writes it back that way. */
  sourceIsList: boolean
}

export interface SqlNotebookFormat {
  /** Exact indent string the file uses, so re-serializing does not reflow it. */
  indent: string
  newline: '\n' | '\r\n'
  trailingNewline: boolean
  bom: boolean
}

export type SqlNotebookWarning = 'invalid-json' | 'not-an-object' | 'missing-cells' | 'unsupported-version'

export interface SqlNotebookDocument {
  format: SqlNotebookFormat
  cells: SqlNotebookCellModel[]
  version: number
  /** Why the file is not fully understood, or null when it parsed cleanly. */
  warning: SqlNotebookWarning | null
  /**
   * True when nothing may be written back to this file.
   *
   * A version this build does not understand is the case that matters: rewriting it
   * would silently discard fields only the newer format knows about, so the panel
   * shows the text and points at the raw view rather than guessing.
   */
  readOnly: boolean
  /** Which cell indexes could not be understood, so the panel can name them. */
  degradedIndexes: number[]
  /** True for the zero-byte file the tree creates, which is not a broken document. */
  blank: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Join the file's `string | string[]` source form into text. */
export function joinSqlNotebookText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(entry => (typeof entry === 'string' ? entry : String(entry))).join('')
  if (value === undefined || value === null) return ''
  return String(value)
}

/** Split text the way a list-form `source` stores it: lines that keep their newline. */
export function splitSqlNotebookLines(text: string): string[] {
  if (text === '') return []
  return text.split(/(?<=\n)/u)
}

/**
 * The BOM as a computed code point. A literal U+FEFF in source is invisible and
 * disappears silently in editors, diffs and copy-paste, so it is never written that
 * way here.
 */
const BOM = String.fromCharCode(0xFEFF)

function stripByteOrderMark(text: string): string {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text
}

function detectFormat(text: string): SqlNotebookFormat {
  const bom = text.charCodeAt(0) === 0xFEFF
  const body = bom ? text.slice(1) : text
  const newline: '\n' | '\r\n' = body.includes('\r\n') ? '\r\n' : '\n'
  const indented = /\n([ \t]+)"/u.exec(body)
  const trailing = /\r?\n$/u.test(body)
  return { indent: indented?.[1] ?? '  ', newline, trailingNewline: trailing, bom }
}

/**
 * The only id rule, shared by the render model and every caller that holds a cell.
 *
 * Ids exist so the view can keep pointing at "the cell that is running" while the text around it
 * changes, and they are derived from position so the file carries no field that would dirty every
 * diff. The cost is the other side of the same coin: a structural edit *renames* the rows it
 * shifts, so anything keyed by one of these ids — a run, a fold, a rendered Markdown cell — has to
 * follow that rename or it slides onto its neighbour. `rowAfterEdit` below is the one derivation of
 * that rename, and every holder of per-row state goes through it.
 */
export function sqlCellId(index: number): string {
  return `sqlnb-${index}`
}

/** The row a cell id names, or null for an id this derivation never produces. */
export function cellIndexFromId(id: string): number | null {
  if (!id.startsWith('sqlnb-')) return null
  const rest = id.slice('sqlnb-'.length)
  const index = Number(rest)
  return Number.isInteger(index) && index >= 0 && String(index) === rest ? index : null
}

/**
 * Where a row lands after one `move`, whose `to` is the position the cell *ends up* at.
 *
 * Same splice the document performs: lift the row out, then insert at `to`. Positions above the
 * lifted row keep their number, positions below lose one, and everything at or after the insertion
 * point gains one back.
 */
export function indexAfterMove(index: number, from: number, to: number): number {
  if (index === from) return to
  const shifted = index > from ? index - 1 : index
  return shifted >= to ? shifted + 1 : shifted
}

/**
 * How one edit renames the rows it did not touch, and whether it removed the row asked about.
 *
 * An edit rewrites the file's text and nothing else, so every row number after the edit point moves
 * by exactly one; a removal also ends a row. `null` means the row is gone and whatever was keyed by
 * it goes with it — keeping it would hand a result to whichever neighbour inherited the number.
 */
export function rowAfterEdit(edit: SqlNotebookEdit, index: number): number | null {
  switch (edit.type) {
    case 'insertAfter':
      return index > edit.index ? index + 1 : index
    case 'remove':
      return index === edit.index ? null : index > edit.index ? index - 1 : index
    case 'move':
      return indexAfterMove(index, edit.from, edit.to)
    default:
      return index
  }
}

function readCellKind(value: unknown): { kind: SqlNotebookCellKind; degraded: boolean } {
  if (value === 'sql' || value === 'markdown') return { kind: value, degraded: false }
  // Anything else — missing, misspelled, or a kind only a newer version defines —
  // becomes read-only text rather than `sql`.
  return { kind: 'raw', degraded: true }
}

/** A fresh document for a file this build could not read at all. */
function unreadable(format: SqlNotebookFormat, warning: SqlNotebookWarning, version = 0): SqlNotebookDocument {
  return { format, cells: [], version, warning, readOnly: true, degradedIndexes: [], blank: false }
}

/**
 * Read `.sqlnb` text into a render model.
 *
 * Never throws: text that is not JSON, is not an object, has no `cells`, or carries a
 * version this build does not know still yields a document with a `warning` and
 * `readOnly` set, so the panel can say which one and let the raw view fix it.
 *
 * The zero-byte file the tree creates is *not* a broken document: it reads as `blank`
 * with no cells and stays writable, because creating the file first and adding the
 * first cell afterwards is how the file tree already works for notebooks.
 */
export function parseSqlNotebook(text: string): SqlNotebookDocument {
  const format = detectFormat(text)
  if (stripByteOrderMark(text).trim() === '') {
    return { format, cells: [], version: 0, warning: null, readOnly: false, degradedIndexes: [], blank: true }
  }
  let value: unknown
  try {
    value = JSON.parse(stripByteOrderMark(text))
  } catch {
    return unreadable(format, 'invalid-json')
  }
  if (!isRecord(value)) return unreadable(format, 'not-an-object')

  const version = typeof value['version'] === 'number' ? value['version'] : 0
  const rawCells = Array.isArray(value['cells']) ? value['cells'] : null
  if (rawCells === null) return unreadable(format, 'missing-cells', version)

  // An unknown version is still shown cell by cell when its shape happens to be one we
  // can read: hiding content the user asked to look at is worse than showing it read-
  // only. Nothing is ever written back over it.
  const versionKnown = version === SQLNB_VERSION

  const cells: SqlNotebookCellModel[] = []
  const degradedIndexes: number[] = []
  rawCells.forEach((candidate, index) => {
    if (!isRecord(candidate)) {
      // A cell that is not an object is shown as its own JSON text, because dropping it
      // would mean the next unrelated edit deletes it from disk.
      cells.push({
        id: sqlCellId(index),
        index,
        kind: 'raw',
        source: JSON.stringify(candidate) ?? String(candidate),
        degraded: true,
        sourceIsList: false,
      })
      degradedIndexes.push(index)
      return
    }
    const read = readCellKind(candidate['kind'])
    if (read.degraded) degradedIndexes.push(index)
    cells.push({
      id: sqlCellId(index),
      index,
      kind: read.kind,
      source: joinSqlNotebookText(candidate['source']),
      sourceIsList: Array.isArray(candidate['source']),
      degraded: read.degraded,
    })
  })

  return {
    format,
    cells,
    version,
    warning: versionKnown ? null : 'unsupported-version',
    readOnly: !versionKnown,
    degradedIndexes,
    blank: false,
  }
}

/** Serialize a document tree back to file text, in the file's own style. */
export function serializeSqlNotebook(value: Record<string, unknown>, format: SqlNotebookFormat): string {
  const body = JSON.stringify(value, null, format.indent)
  const unified = format.newline === '\n' ? body : body.replace(/\n/gu, format.newline)
  return `${format.bom ? BOM : ''}${unified}${format.trailingNewline ? format.newline : ''}`
}

/** The document tree a file must hold for this build to write it. */
function treeFor(value: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(value['cells'])) value['cells'] = []
  return value
}

/** A caller was refused a write because the file is not one this build may rewrite. */
export class SqlNotebookEditError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'SqlNotebookEditError'
  }
}

/**
 * Read the tree, apply one edit to it, and return the new file text.
 *
 * This is the single way the SQL notebook view writes a file, and it is where the
 * "never auto-repair" rule lives (ADR 0003): a broken or newer-than-us file raises
 * `SqlNotebookEditError` rather than being rewritten into whatever shape this build
 * happens to understand. Every caller is a click handler that must refuse the edit
 * and keep the user's bytes.
 *
 * A blank file is the one exception, and a deliberate one: the tree creates an empty
 * file, so the first cell has to turn zero bytes into a valid document instead of
 * refusing the user their very first action.
 */
export function editSqlNotebook(
  text: string,
  apply: (value: Record<string, unknown>) => void,
): string {
  const format = detectFormat(text)
  const stripped = stripByteOrderMark(text).trim()
  if (stripped === '') {
    const skeleton: Record<string, unknown> = { version: SQLNB_VERSION, cells: [] }
    apply(skeleton)
    return serializeSqlNotebook(skeleton, { indent: '  ', newline: '\n', trailingNewline: true, bom: false })
  }
  let value: unknown
  try {
    value = JSON.parse(stripped)
  } catch {
    throw new SqlNotebookEditError('SQLNB_INVALID_JSON', '笔记文件不是有效的 JSON，请用原始视图修正后再保存。')
  }
  if (!isRecord(value)) {
    throw new SqlNotebookEditError('SQLNB_INVALID_JSON', '笔记文件不是一个 JSON 对象，请用原始视图修正后再保存。')
  }
  const tree = value as Record<string, unknown>
  if (tree['version'] !== SQLNB_VERSION) {
    throw new SqlNotebookEditError('SQLNB_UNSUPPORTED_VERSION', '这份笔记的格式版本比当前工作台更新，不能改写它。')
  }
  if (!Array.isArray(tree['cells'])) {
    throw new SqlNotebookEditError('SQLNB_MISSING_CELLS', '这份笔记缺少单元格列表，请用原始视图修正后再保存。')
  }
  apply(treeFor(tree))
  return serializeSqlNotebook(tree, format)
}

/** One cell as it appears in the tree. */
export function sqlCellNode(kind: SqlCellKind, source = ''): Record<string, unknown> {
  return { kind, source }
}

const SKELETON_FORMAT: SqlNotebookFormat = { indent: '  ', newline: '\n', trailingNewline: true, bom: false }

/**
 * The content a brand-new notebook is created with: one version and one empty SQL
 * cell. That is enough to be a valid document immediately, and the empty cell is what
 * the view shows instead of a bare editor with nothing to run.
 */
export function createSqlNotebookSkeleton(): string {
  return serializeSqlNotebook({ version: SQLNB_VERSION, cells: [sqlCellNode('sql')] }, SKELETON_FORMAT)
}

/**
 * The notebook a database file gets when the user double-clicks it.
 *
 * Seeded with a query that actually reads something: an empty first cell is the one
 * start that teaches a reader nothing about the file they just opened. The table name
 * is quoted with the doubling SQLite requires, because a name containing a quote is a
 * real thing schemas contain and a broken first query would look like our bug.
 */
export function createSqlNotebookForDatabase(tableName: string | undefined): string {
  const first = tableName === undefined
    ? "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    : `SELECT * FROM "${tableName.replace(/"/gu, '""')}" LIMIT 100`
  return serializeSqlNotebook(
    { version: SQLNB_VERSION, cells: [sqlCellNode('sql'), sqlCellNode('sql', first)] },
    SKELETON_FORMAT,
  )
}

/** An edit the view can ask for. Every one is applied to the tree, not the model. */
export type SqlNotebookEdit =
  | { type: 'source'; index: number; source: string }
  | { type: 'kind'; index: number; kind: SqlCellKind }
  | { type: 'insertAfter'; index: number; kind: SqlCellKind }
  | { type: 'remove'; index: number }
  | { type: 'move'; from: number; to: number }

/**
 * Apply one structural or content edit.
 *
 * Cells are located by index because the ids the view holds are the same index-derived
 * ids this produces — one derivation, so a move cannot strand a running cell's result.
 */
export function applySqlNotebookEdit(text: string, edit: SqlNotebookEdit): string {
  return editSqlNotebook(text, (value) => {
    const cells = value['cells'] as Record<string, unknown>[]
    switch (edit.type) {
      case 'source': {
        const cell = cells[edit.index]
        if (cell === undefined) return
        // Written back in whichever shape the file used, so editing one cell does not
        // reflow every line of the document.
        cell['source'] = Array.isArray(cell['source'])
          ? splitSqlNotebookLines(edit.source)
          : edit.source
        return
      }
      case 'kind': {
        const cell = cells[edit.index]
        if (cell === undefined) return
        cell['kind'] = edit.kind
        return
      }
      case 'insertAfter': {
        cells.splice(edit.index + 1, 0, sqlCellNode(edit.kind))
        return
      }
      case 'remove': {
        cells.splice(edit.index, 1)
        return
      }
      case 'move': {
        const [moved] = cells.splice(edit.from, 1)
        if (moved === undefined) return
        cells.splice(Math.max(0, Math.min(edit.to, cells.length)), 0, moved)
        return
      }
    }
  })
}
