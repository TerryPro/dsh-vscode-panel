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
  /** Heading depth, for indentation: 1 for `#`, and for a cell named by its own text. */
  level: number
  /** Display text, stripped of inline Markdown by the shared extractor. */
  text: string
  /** The cell this row jumps to. */
  cellId: string
}

/**
 * The notebook's structure as a flat list: every Markdown heading, plus every cell that
 * is not Markdown.
 *
 * A non-Markdown cell gets a row of its own because a notebook is read as a sequence of
 * steps, not as prose with attachments: on a long notebook the question is usually "which
 * cell computes that?", which a headings-only outline cannot answer. Its first line with
 * content names it, since that line is the step and its whole source would be a paragraph
 * the panel cannot show. Raw cells are included on the same terms as code cells — leaving
 * them out would make the panel a map with holes in it.
 *
 * Heading extraction is delegated to the function the Markdown preview uses, so the fenced
 * code and setext rules cannot drift between two views of one file.
 */
export function buildNotebookOutline(document: NotebookDocument): NotebookOutlineEntry[] {
  const entries: NotebookOutlineEntry[] = []
  for (const cell of document.cells) {
    if (cell.kind === 'markdown') {
      for (const heading of extractMarkdownOutline(cell.source)) {
        entries.push({ index: entries.length, level: heading.level, text: heading.text, cellId: cell.id })
      }
      continue
    }
    const label = firstMeaningfulLine(cell.source)
    if (label === null) continue
    entries.push({ index: entries.length, level: 1, text: label, cellId: cell.id })
  }
  return entries
}

/**
 * The line that names a cell, or `null` when it holds nothing to name.
 *
 * Leading blank lines are the shape a worked-on notebook actually accumulates — clearing a
 * cell leaves its newline behind — so the first *content* line is what a reader would call
 * the cell, not the first line of the file.
 */
function firstMeaningfulLine(source: string): string | null {
  for (const line of source.split('\n')) {
    const text = line.trim()
    if (text !== '') return text
  }
  return null
}
