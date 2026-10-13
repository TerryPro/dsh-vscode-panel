/**
 * `.sqlnb` document model: parse, edit, and re-serialize without losing anything.
 *
 * A SQL notebook tab keeps its draft as the *file text*, exactly like the notebook,
 * CSV and JSON viewers do, so saving, dirty tracking, version checks and
 * external-change reconciliation all stay in the shared file-tab machinery. This
 * module is the only place that knows the `.sqlnb` layout.
 *
 * The file holds three things (ADR 0007, which replaced ADR 0003's "source text only"):
 * - the cells: their kind and their text;
 * - the connection record: which database this notebook is about and the tier it was opened
 *   with, so reopening the notebook connects again instead of asking;
 * - each cell's last results, so an answer outlives the tab that produced it.
 *
 * What it still deliberately does NOT store: cell ids. They are derived from cell order (see
 * `sqlCellId`), because a stored random id would dirty every Git diff for a value nothing
 * depends on.
 *
 * Round trips preserve unknown document keys, unknown cell keys, whether `source`
 * was a string or a list of lines, the file's indentation, line endings, BOM and
 * trailing newline — the tree is edited in place, never rebuilt from the render
 * model.
 */

import {
  SQL_ACCESS_DEFAULT,
  SQL_MEMORY_TARGET,
  type SqlAccess,
  type SqlBlobValue,
  type SqlCellKind,
  type SqlColumn,
  type SqlResultBlock,
  type SqlRow,
  type SqlValue,
} from '../../shared/sql-protocol.ts'

/**
 * The document version this build writes.
 *
 * Version 1 is the shape that stored cells and nothing else; version 2 adds the connection record
 * and each cell's last results. Both stay readable *and writable* — a file written yesterday is
 * not a broken file — and a version 1 document is upgraded to this one the moment an edit needs a
 * field only the new shape has.
 */
export const SQLNB_VERSION = 2

/** Versions this build reads. Anything else is shown but never rewritten (ADR 0003). */
const READABLE_VERSIONS: readonly number[] = [1, SQLNB_VERSION]

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
  /**
   * The results this cell last produced, as the file kept them.
   *
   * Empty for a cell that never ran. Results are written back by the runtime when a run settles
   * (ADR 0007), so what is on screen after reopening a notebook is what the file recorded rather
   * than a blank row the reader has to re-run to see.
   */
  blocks: SqlResultBlock[]
  /** The `In[n]` the file recorded for this cell, or null for one that never ran. */
  executionCount: number | null
  /** Wall clock the recorded run took, or null when the file kept none. */
  elapsedMs: number | null
}

/**
 * The connection this notebook is about, as recorded in the file.
 *
 * A *record*, not a live connection: it says which database and which tier, and nothing about
 * whether a handle is currently open. The runtime turns it into a connection on open (ADR 0007);
 * the panel still shows the Host's own answer, which is the only thing that can say what was
 * actually granted.
 */
export interface SqlNotebookConnectionRecord {
  /** Workspace-relative database path, or `:memory:`. */
  path: string
  access: SqlAccess
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
  /**
   * The connection the file records, or null when it records none.
   *
   * Null is the normal state of a version 1 file and of a notebook nobody has connected yet. The
   * surface auto-connects only when this is present (ADR 0007): a file that never named a database
   * must not have one guessed for it.
   */
  connection: SqlNotebookConnectionRecord | null
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

/**
 * Read the file's connection record.
 *
 * Absent or malformed reads as "no record" rather than as an error: the record is an
 * optimisation for reopening a notebook, and a file whose `connection` was hand-edited into
 * nonsense is still a perfectly good notebook whose reader can connect from the picker. Refusing
 * the whole document over it would hide their cells to punish a field they may not have written.
 */
function readConnection(value: unknown): SqlNotebookConnectionRecord | null {
  if (!isRecord(value)) return null
  const path = value['path']
  if (typeof path !== 'string' || path === '') return null
  // Only the two tiers the protocol defines. Anything else falls back to the requirement's
  // default rather than being carried into an open request the Host would refuse.
  const access: SqlAccess = value['access'] === 'writable' ? 'writable' : SQL_ACCESS_DEFAULT
  return { path, access }
}

/** Whether one stored value is a row value this build can render. */
function isStoredValue(value: unknown): value is SqlValue | SqlBlobValue {
  if (value === null) return true
  if (typeof value === 'string' || typeof value === 'number') return true
  return isRecord(value) && typeof value['base64'] === 'string' && typeof value['byteLength'] === 'number'
}

/** One stored column header, or null when the file's shape is not one this build wrote. */
function readStoredColumn(value: unknown): SqlColumn | null {
  if (!isRecord(value)) return null
  const label = value['label']
  if (typeof label !== 'string') return null
  const name = typeof value['name'] === 'string' ? value['name'] : label
  const type = value['type']
  // `type` is omitted rather than set to undefined: `exactOptionalPropertyTypes` treats the two
  // as different, and the render path tests for the key's absence.
  return typeof type === 'string' ? { label, name, type } : { label, name }
}

/**
 * Read one stored result block.
 *
 * A block whose columns or rows are not arrays is dropped rather than guessed at: a half-read
 * block would render a table whose header and rows disagree, which is exactly the kind of
 * plausible-looking wrong answer a viewer must never produce. Dropping it leaves the cell
 * showing fewer blocks, which the reader can see, instead of a table they would have to doubt.
 */
function readStoredBlock(value: unknown): SqlResultBlock | null {
  if (!isRecord(value)) return null
  const rawColumns = value['columns']
  const rawRows = value['rows']
  if (!Array.isArray(rawColumns) || !Array.isArray(rawRows)) return null
  const columns: SqlColumn[] = []
  for (const candidate of rawColumns) {
    const column = readStoredColumn(candidate)
    if (column === null) return null
    columns.push(column)
  }
  const rows: SqlRow[] = []
  for (const candidate of rawRows) {
    if (!Array.isArray(candidate)) return null
    if (!candidate.every(isStoredValue)) return null
    rows.push(candidate)
  }
  const error = value['error']
  const storedError = isRecord(error) && typeof error['code'] === 'string'
    ? { code: error['code'], message: typeof error['message'] === 'string' ? error['message'] : '' }
    : undefined
  const changes = value['changes']
  return {
    columns,
    rows,
    // The caps are re-read as numbers because a hand-edited file may hold anything, and a
    // `rowLimit` of `"many"` would reach the notice text as a literal.
    rowLimit: typeof value['rowLimit'] === 'number' ? value['rowLimit'] : 0,
    truncated: value['truncated'] === true,
    columnsDropped: typeof value['columnsDropped'] === 'number' ? value['columnsDropped'] : 0,
    valuesTruncated: typeof value['valuesTruncated'] === 'number' ? value['valuesTruncated'] : 0,
    ...(storedError === undefined ? {} : { error: storedError }),
    ...(typeof changes === 'number' ? { changes } : {}),
    ...(value['stoppedByDeadline'] === true ? { stoppedByDeadline: true as const } : {}),
  }
}

/** Every result block a cell stored, skipping any this build cannot read. */
function readStoredBlocks(value: unknown): SqlResultBlock[] {
  if (!Array.isArray(value)) return []
  const blocks: SqlResultBlock[] = []
  for (const candidate of value) {
    const block = readStoredBlock(candidate)
    if (block !== null) blocks.push(block)
  }
  return blocks
}

/** A fresh document for a file this build could not read at all. */
function unreadable(format: SqlNotebookFormat, warning: SqlNotebookWarning, version = 0): SqlNotebookDocument {
  // No connection record either: a file this build cannot parse must not have one read out of it to
  // then open a database with.
  return { format, cells: [], version, connection: null, warning, readOnly: true, degradedIndexes: [], blank: false }
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
    return { format, cells: [], version: 0, connection: null, warning: null, readOnly: false, degradedIndexes: [], blank: true }
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
  const versionKnown = READABLE_VERSIONS.includes(version)

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
        blocks: [],
        executionCount: null,
        elapsedMs: null,
      })
      degradedIndexes.push(index)
      return
    }
    const read = readCellKind(candidate['kind'])
    if (read.degraded) degradedIndexes.push(index)
    const count = candidate['execution_count']
    const elapsed = candidate['elapsed_ms']
    cells.push({
      id: sqlCellId(index),
      index,
      kind: read.kind,
      source: joinSqlNotebookText(candidate['source']),
      sourceIsList: Array.isArray(candidate['source']),
      degraded: read.degraded,
      blocks: readStoredBlocks(candidate['results']),
      executionCount: typeof count === 'number' && Number.isInteger(count) && count >= 0 ? count : null,
      elapsedMs: typeof elapsed === 'number' && Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null,
    })
  })

  return {
    format,
    cells,
    version,
    connection: readConnection(value['connection']),
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

/**
 * One stored result block, in the shape the file keeps.
 *
 * `undefined` members are dropped rather than written as `null`: a block with no error and no
 * `changes` must not carry those keys, or every later read has to tell "absent" from "explicitly
 * nothing" for fields that were never there.
 */
function storedBlock(block: SqlResultBlock): Record<string, unknown> {
  return {
    columns: block.columns.map(column => (
      column.type === undefined
        ? { label: column.label, name: column.name }
        : { label: column.label, name: column.name, type: column.type }
    )),
    rows: block.rows as unknown,
    rowLimit: block.rowLimit,
    truncated: block.truncated,
    columnsDropped: block.columnsDropped,
    valuesTruncated: block.valuesTruncated,
    ...(block.error === undefined ? {} : { error: block.error }),
    ...(block.changes === undefined ? {} : { changes: block.changes }),
    ...(block.stoppedByDeadline === true ? { stoppedByDeadline: true } : {}),
  }
}

/**
 * Write one cell's results and prompt number into the tree, or clear them.
 *
 * Both halves go in together, for the same reason the Jupyter notebook writes outputs and
 * `execution_count` as one pair: a file that records a result but no `[n]` is a file whose rows
 * claim to have come from nowhere.
 */
function writeCellResults(
  cell: Record<string, unknown>,
  blocks: readonly SqlResultBlock[],
  executionCount: number | null,
  elapsedMs: number | null,
): void {
  if (blocks.length === 0) {
    delete cell['results']
  } else {
    cell['results'] = blocks.map(storedBlock)
  }
  if (executionCount === null) {
    delete cell['execution_count']
  } else {
    cell['execution_count'] = executionCount
  }
  if (elapsedMs === null) {
    delete cell['elapsed_ms']
  } else {
    cell['elapsed_ms'] = elapsedMs
  }
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
 * A version 1 file is the exception, and a deliberate one: it is a document this build
 * understands completely, so the first edit to it upgrades the version field to this build's.
 * Refusing it would strand every notebook written before ADR 0007.
 *
 * A blank file is the other exception: the tree creates an empty file, so the first cell has to
 * turn zero bytes into a valid document instead of refusing the user their very first action.
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
  const version = typeof tree['version'] === 'number' ? tree['version'] : 0
  if (!READABLE_VERSIONS.includes(version)) {
    throw new SqlNotebookEditError('SQLNB_UNSUPPORTED_VERSION', '这份笔记的格式版本比当前工作台更新，不能改写它。')
  }
  if (!Array.isArray(tree['cells'])) {
    throw new SqlNotebookEditError('SQLNB_MISSING_CELLS', '这份笔记缺少单元格列表，请用原始视图修正后再保存。')
  }
  // Only raised, never lowered: a file this build read as version 1 becomes version 2 on its next
  // write, which is what lets a first run record its result.
  tree['version'] = Math.max(version, SQLNB_VERSION)
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
 *
 * `connection` is written when the entry that created the notebook already knew which database it
 * is about (ADR 0007): a notebook made beside `orders.db` records that, so reopening it connects
 * again instead of landing on "not connected" for a database the reader already chose.
 */
export function createSqlNotebookSkeleton(connection?: SqlNotebookConnectionRecord): string {
  return serializeSqlNotebook(
    {
      version: SQLNB_VERSION,
      ...(connection === undefined ? {} : { connection: { path: connection.path, access: connection.access } }),
      cells: [sqlCellNode('sql')],
    },
    SKELETON_FORMAT,
  )
}

/**
 * The notebook a database file gets when the user double-clicks it.
 *
 * Seeded with a query that actually reads something: an empty first cell is the one
 * start that teaches a reader nothing about the file they just opened. The table name
 * is quoted with the doubling SQLite requires, because a name containing a quote is a
 * real thing schemas contain and a broken first query would look like our bug.
 *
 * The connection record is what makes the seeded query meaningful on the next open: without it the
 * first cell would be a `SELECT` against nothing.
 */
export function createSqlNotebookForDatabase(tableName: string | undefined, database?: string): string {
  const first = tableName === undefined
    ? "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    : `SELECT * FROM "${tableName.replace(/"/gu, '""')}" LIMIT 100`
  return serializeSqlNotebook(
    {
      version: SQLNB_VERSION,
      ...(database === undefined ? {} : { connection: { path: database, access: SQL_ACCESS_DEFAULT } }),
      cells: [sqlCellNode('sql'), sqlCellNode('sql', first)],
    },
    SKELETON_FORMAT,
  )
}

/**
 * An edit the view can ask for. Every one is applied to the tree, not the model.
 *
 * Five of these are the reader's own gestures; the last three are the runtime recording what a run
 * produced (ADR 0007). They are the same union on purpose — one write path, one refusal rule — so a
 * notebook this build will not rewrite refuses to record a result for exactly the reason it refuses
 * a typed edit.
 */
export type SqlNotebookEdit =
  | { type: 'source'; index: number; source: string }
  | { type: 'kind'; index: number; kind: SqlCellKind }
  | { type: 'insertAfter'; index: number; kind: SqlCellKind }
  | { type: 'remove'; index: number }
  | { type: 'move'; from: number; to: number }
  /** One cell's results, prompt number and timing, as a settled run left them. */
  | { type: 'results'; index: number; blocks: readonly SqlResultBlock[]; executionCount: number | null; elapsedMs: number | null }
  /** Every cell's results, dropped at once. */
  | { type: 'clearResults' }
  /** The database this notebook is about, or null to stop recording one. */
  | { type: 'connection'; connection: SqlNotebookConnectionRecord | null }

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
        // A kind change can make a stored result meaningless — a SQL cell's table under a text
        // cell describes a query the cell no longer holds — so the results go with it rather than
        // being shown against text that did not produce them.
        if (edit.kind !== 'sql') delete cell['results']
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
      case 'results': {
        const cell = cells[edit.index]
        if (cell === undefined) return
        writeCellResults(cell, edit.blocks, edit.executionCount, edit.elapsedMs)
        return
      }
      case 'clearResults': {
        // Every cell, because "clear all outputs" is one gesture over the whole notebook: leaving
        // the blocks of a cell the reader cannot see on screen would make the command look partial
        // the next time they scroll to it.
        for (const cell of cells) writeCellResults(cell, [], null, null)
        return
      }
      case 'connection': {
        if (edit.connection === null) {
          delete value['connection']
          return
        }
        value['connection'] = { path: edit.connection.path, access: edit.connection.access }
        return
      }
    }
  })
}

/**
 * Append one SQL cell holding `source`, and return the new file text.
 *
 * Two edits rather than one, because the edit union inserts an empty cell and a cell's text is set
 * by index. Both go through the same write-back path the surface uses, so a notebook this build
 * cannot rewrite refuses here for exactly the reason it refuses there — the caller keeps the
 * reader's bytes and says why instead of re-serializing what happened to parse.
 */
export function appendSqlCell(text: string, source: string): string {
  const cells = parseSqlNotebook(text).cells
  const withCell = applySqlNotebookEdit(text, { type: 'insertAfter', index: cells.length - 1, kind: 'sql' })
  return applySqlNotebookEdit(withCell, { type: 'source', index: cells.length, source })
}

/**
 * Record a settled run's results in the file text, and say whether anything changed.
 *
 * "Changed" is not a convenience: the runtime writes back after every run, and a file whose bytes
 * did not move must not be marked dirty or written to disk. The comparison is on the serialized
 * text rather than on the blocks, because the text is what the tab holds and what a save would
 * write — a block that round-trips to the same bytes is the same file.
 */
export function writeSqlCellResults(
  text: string,
  index: number,
  blocks: readonly SqlResultBlock[],
  executionCount: number | null,
  elapsedMs: number | null,
): string | null {
  try {
    const next = applySqlNotebookEdit(text, { type: 'results', index, blocks, executionCount, elapsedMs })
    return next === text ? null : next
  } catch (error: unknown) {
    // A refusal here is the "never auto-repair" rule doing its job (a file this build must not
    // rewrite). The run already happened and its answer is on screen; failing to record it is not
    // a reason to lose the reader's bytes, so the caller keeps the draft it had.
    if (error instanceof SqlNotebookEditError) return null
    throw error
  }
}

/** Record which database this notebook is about, or null to stop recording one. */
export function writeSqlNotebookConnection(text: string, connection: SqlNotebookConnectionRecord | null): string | null {
  try {
    const next = applySqlNotebookEdit(text, { type: 'connection', connection })
    return next === text ? null : next
  } catch (error: unknown) {
    if (error instanceof SqlNotebookEditError) return null
    throw error
  }
}
