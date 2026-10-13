import { extractMarkdownOutline } from '../markdown/markdown-outline.ts'
import type { SqlNotebookDocument } from './sql-notebook-document.ts'

/**
 * One row of a SQL notebook's outline: what to show, and which cell to jump to.
 *
 * `cellId`, not an index into a rendered heading list. `MarkdownOutline` takes the row's `index`
 * and hands it back on a click, so this list keeps its own ordinals and resolves them to the cell
 * the reader actually meant — the only thing stable across an insert, a delete or a move.
 */
export interface SqlNotebookOutlineEntry {
  /** Position in the outline, used as the React key and as what a click returns. */
  index: number
  /** Heading depth, for indentation: 1 for `#` through 6 for `######`. */
  level: number
  /** Display text, stripped of inline Markdown by the shared extractor. */
  text: string
  /** The cell this row jumps to. */
  cellId: string
}

/**
 * A SQL notebook's structure as a flat list: the Markdown cells' headings, in document order.
 *
 * Only text cells contribute rows, which is the ticket's rule ("大纲只收 markdown 格标题") and the
 * same one the Jupyter outline applies. A SQL cell is a statement, not prose: its first line is
 * `SELECT …`, and a table of contents mixing the two is a list the reader cannot scan for either.
 *
 * Written apart from the notebook's builder rather than shared with it, because the two formats
 * share only the one rule: the cell models are different types and this format derives ids from
 * position. Heading extraction is *not* duplicated — it is the same function the Markdown preview
 * and the notebook outline use, so fenced code and setext rules cannot drift between views.
 */
export function buildSqlNotebookOutline(document: SqlNotebookDocument): SqlNotebookOutlineEntry[] {
  const entries: SqlNotebookOutlineEntry[] = []
  for (const cell of document.cells) {
    if (cell.kind !== 'markdown') continue
    for (const heading of extractMarkdownOutline(cell.source)) {
      entries.push({ index: entries.length, level: heading.level, text: heading.text, cellId: cell.id })
    }
  }
  return entries
}
