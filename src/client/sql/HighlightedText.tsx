/**
 * One span of the search query, wrapped in `<mark>` so the matching substring stands out.
 *
 * Done as a single `indexOf` walk rather than a regex with capture groups, so the highlighted
 * output is the original text with marks inserted — and so a regex injection through the
 * search input is impossible. The case-insensitivity is the panel's, not the regex's, so the
 * matched substring is the same length regardless of how the user typed it.
 */
import css from './sql-panel.module.css'

export function HighlightedText({ text, query }: { text: string; query: string }): React.ReactNode {
  const lower = text.toLowerCase()
  const segments: React.ReactNode[] = []
  let cursor = 0
  while (cursor < text.length) {
    const found = lower.indexOf(query, cursor)
    if (found < 0) {
      segments.push(text.slice(cursor))
      break
    }
    if (found > cursor) segments.push(text.slice(cursor, found))
    segments.push(
      <mark key={`${text}-${found}`} className={css.tableNameMark}>
        {text.slice(found, found + query.length)}
      </mark>,
    )
    cursor = found + query.length
  }
  return <>{segments}</>
}
