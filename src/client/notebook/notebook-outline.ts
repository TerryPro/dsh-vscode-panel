import { extractMarkdownOutline } from '../markdown/markdown-outline.ts'
import type { NotebookDocument } from './notebook-document.ts'

/**
 * One row of the notebook's outline: what to show, and which cell to jump to.
 *
 * `cellId`, not an index into a rendered heading list, which is what the Markdown
 * preview's outline uses. A notebook's headings live in different cells than the ones the
 * preview flattens, and the only thing stable across insert, delete and move is the cell
 * id (see the note on ids in `notebook-document.ts`), so that is what a row carries.
 */
export interface NotebookOutlineEntry {
  /** Position in the outline, used as the React key. */
  index: number
  /** Heading depth, for indentation: 1 for `#` through 6 for `######`. */
  level: number
  /** Display text, stripped of inline Markdown by the shared extractor. */
  text: string
  /** The cell this row jumps to. */
  cellId: string
}

/**
 * The notebook's structure as a flat list: the Markdown headings, in document order.
 *
 * Only Markdown cells contribute rows. A code or raw cell is source, not prose: its first
 * line is a statement (`df = load("x.csv")`, `make deploy`), and putting those in a table of
 * contents mixes two kinds of entry the reader is scanning for different reasons — headings
 * on one side, whatever happened to sit at the top of a cell on the other. Cells stay
 * navigable through the cell list and folding, which is the surface built for them.
 *
 * Heading extraction is delegated to the function the Markdown preview uses, so the fenced
 * code and setext rules cannot drift between two views of one file.
 */
export function buildNotebookOutline(document: NotebookDocument): NotebookOutlineEntry[] {
  const entries: NotebookOutlineEntry[] = []
  for (const cell of document.cells) {
    if (cell.kind !== 'markdown') continue
    for (const heading of extractMarkdownOutline(cell.source)) {
      entries.push({ index: entries.length, level: heading.level, text: heading.text, cellId: cell.id })
    }
  }
  return entries
}
