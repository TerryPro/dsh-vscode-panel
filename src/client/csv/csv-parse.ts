/**
 * A self-contained RFC-4180 flavoured parser for delimited table files (CSV/TSV).
 *
 * Kept dependency-free on purpose: the workbench bundle stays lean, the grammar
 * is small enough to own outright, and every behaviour below is unit-tested. The
 * parser is lenient where real exports demand it — it auto-detects the delimiter,
 * understands quoted fields with embedded delimiters/newlines/escaped quotes,
 * tolerates ragged rows by padding to a fixed width, and skips blank lines.
 */

/** How many data rows the table view renders before truncating to protect the UI. */
export const CSV_RENDER_MAX_ROWS = 5000

/** Candidate field separators probed by {@link detectDelimiter}, in tie-break order. */
const DELIMITER_CANDIDATES = [',', '\t', ';', '|'] as const

/** Sort direction applied to one visible column. */
export type SortDirection = 'asc' | 'desc'

/** A parsed table: fixed-width columns plus the rows, capped for rendering. */
export interface CsvDocument {
  readonly delimiter: string
  /** Header names taken from the first record, padded to the widest column count. */
  readonly columns: readonly string[]
  /** Data rows (everything after the header), each normalized to `columns.length`. */
  readonly rows: readonly (readonly string[])[]
  /** Total data rows parsed before the render cap. */
  readonly totalRows: number
  /** Whether {@link rows} was cut short by the render cap. */
  readonly truncated: boolean
}

export interface ParseCsvOptions {
  /** Force a delimiter instead of auto-detecting one (e.g. always tab for `.tsv`). */
  delimiter?: string | undefined
  /** Override the render cap; defaults to {@link CSV_RENDER_MAX_ROWS}. */
  maxRows?: number | undefined
}

/** Strip a leading UTF-8 byte-order mark, which Excel-prefixed CSVs often carry. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * Guess the field separator from the first physical line.
 *
 * Quoted segments are masked out so a delimiter inside a cell does not skew the
 * count. The candidate appearing most often wins; ties fall back to the earlier
 * entry, and a line with no candidate at all defaults to a comma.
 */
export function detectDelimiter(text: string): string {
  const firstLine = stripBom(text).split(/\r?\n/u)[0] ?? ''
  const unquoted = firstLine.replace(/"(?:[^"\r\n]|"")*"/gu, '')
  let best: string = ','
  let bestCount = 0
  for (const candidate of DELIMITER_CANDIDATES) {
    const count = unquoted.split(candidate).length - 1
    if (count > bestCount) {
      bestCount = count
      best = candidate
    }
  }
  return best
}

/**
 * Split text into raw records honoring quotes, escaped quotes and CR/LF/CRLF
 * endings. Blank lines (a lone empty field) are dropped so stray trailing or
 * middle newlines never become phantom rows or a phantom header.
 */
function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let touched = false
  const endField = (): void => { row.push(field); field = ''; touched = false }
  const endRow = (): void => { endField(); rows.push(row); row = [] }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ }
        else inQuotes = false
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') {
      // A quote only opens a quoted field when the field is still untouched;
      // anywhere else it is a literal character within the value.
      if (field === '' && !touched) { inQuotes = true; touched = true }
      else field += ch
      continue
    }
    if (ch === delimiter) { endField(); continue }
    if (ch === '\r') {
      if (text[i + 1] === '\n') i++
      endRow()
      continue
    }
    if (ch === '\n') { endRow(); continue }
    field += ch
    touched = true
  }
  // Flush the final record only when it carries content, so a trailing newline
  // terminates the last row instead of inventing an empty one.
  if (field !== '' || row.length > 0 || touched) endRow()

  return rows.filter(record => !(record.length === 1 && record[0]!.trim().length === 0))
}

/** Extend a short record with empty cells so every row shares one column width. */
function padToWidth(row: string[], width: number): string[] {
  if (row.length === width) return row
  const padded = row.slice()
  while (padded.length < width) padded.push('')
  return padded
}

/** Parse a delimited document into normalized, render-capped columns and rows. */
export function parseCsv(text: string, options: ParseCsvOptions = {}): CsvDocument {
  const clean = stripBom(text)
  const delimiter = options.delimiter ?? detectDelimiter(clean)
  const maxRows = options.maxRows ?? CSV_RENDER_MAX_ROWS
  const records = parseDelimited(clean, delimiter)
  if (records.length === 0) {
    return { delimiter, columns: [], rows: [], totalRows: 0, truncated: false }
  }
  const [headerRow = [], ...dataRows] = records
  const width = dataRows.reduce((max, row) => Math.max(max, row.length), headerRow.length)
  const columns = padToWidth(headerRow, width)
  const truncated = dataRows.length > maxRows
  const visible = truncated ? dataRows.slice(0, maxRows) : dataRows
  const rows = visible.map(row => padToWidth(row, width))
  return { delimiter, columns, rows, totalRows: dataRows.length, truncated }
}

/** Parse a trimmed cell as a finite number, or return undefined for non-numbers. */
function numericValue(cell: string): number | undefined {
  const trimmed = cell.trim()
  if (trimmed.length === 0 || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/u.test(trimmed)) {
    return undefined
  }
  const value = Number(trimmed)
  return Number.isFinite(value) ? value : undefined
}

/** Public numeric-cell parser shared with the editing/summary layer. */
export function parseNumericCell(cell: string): number | undefined {
  return numericValue(cell)
}

/**
 * Order two cell values: numerically when both parse as numbers, otherwise with a
 * natural (digit-aware, case-insensitive) string comparison.
 */
export function compareCsvValues(a: string, b: string): number {
  const left = numericValue(a)
  const right = numericValue(b)
  if (left !== undefined && right !== undefined) return left - right
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

/** Return a stable copy of `rows` ordered by one column; a negative index is a no-op. */
export function sortCsvRows(
  rows: readonly (readonly string[])[],
  columnIndex: number,
  direction: SortDirection,
): (readonly string[])[] {
  if (columnIndex < 0) return rows.map(row => row)
  const factor = direction === 'asc' ? 1 : -1
  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const cmp = compareCsvValues(left.row[columnIndex] ?? '', right.row[columnIndex] ?? '')
      return cmp !== 0 ? cmp * factor : left.index - right.index
    })
    .map(entry => entry.row)
}

/**
 * Keep rows whose any cell contains the query (case-insensitive, trimmed).
 * A blank query returns the input untouched so the common path allocates nothing.
 */
export function filterCsvRows(
  rows: readonly (readonly string[])[],
  query: string,
): readonly (readonly string[])[] {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return rows
  return rows.filter(row => row.some(cell => cell.toLowerCase().includes(needle)))
}

/**
 * Whether a column should read as numeric (right-aligned): it has at least one
 * value and every non-empty value in the rendered rows parses as a number.
 */
export function columnIsNumeric(rows: readonly (readonly string[])[], columnIndex: number): boolean {
  let seen = false
  for (const row of rows) {
    const cell = row[columnIndex] ?? ''
    const trimmed = cell.trim()
    if (trimmed.length === 0) continue
    if (numericValue(cell) === undefined) return false
    seen = true
  }
  return seen
}

/** Formatting traits of the original text that a table edit must preserve on write-back. */
export interface CsvFormat {
  /** Line separator used by the file: CRLF, a lone CR, or LF. */
  readonly eol: string
  /** Whether the original ended with a trailing newline. */
  readonly trailingNewline: boolean
  /** Whether the original began with a UTF-8 byte-order mark. */
  readonly bom: boolean
}

/**
 * Detect the original file's line ending, trailing newline and BOM so editing a
 * cell can regenerate text that keeps these traits and minimizes the resulting
 * diff. LF is the fallback when the text has no line breaks at all.
 */
export function detectCsvFormat(text: string): CsvFormat {
  const bom = text.charCodeAt(0) === 0xfeff
  const body = bom ? text.slice(1) : text
  const eol = body.includes('\r\n') ? '\r\n' : body.includes('\r') ? '\r' : '\n'
  return { eol, trailingNewline: body.endsWith('\n') || body.endsWith('\r'), bom }
}

/** Quote a cell only when it would otherwise break the format (RFC-4180 minimal quoting). */
function needsQuote(cell: string, delimiter: string): boolean {
  return cell.includes(delimiter) || cell.includes('"') || cell.includes('\n') || cell.includes('\r')
}

function escapeCell(cell: string, delimiter: string): string {
  const value = cell ?? ''
  return needsQuote(value, delimiter) ? `"${value.replace(/"/gu, '""')}"` : value
}

/**
 * Regenerate delimited text from a table, restoring the original delimiter, line
 * ending, trailing newline and BOM. Values are re-quoted only when required, so
 * editing one cell leaves the rest of the file byte-for-byte stable in the common
 * well-formed case (see the round-trip tests).
 */
export function serializeCsv(
  columns: readonly string[],
  rows: readonly (readonly string[])[],
  delimiter: string,
  format: CsvFormat,
): string {
  const lines = [columns, ...rows].map(row => row.map(cell => escapeCell(cell, delimiter)).join(delimiter))
  let text = lines.join(format.eol)
  if (format.trailingNewline) text += format.eol
  return format.bom ? `\uFEFF${text}` : text
}
