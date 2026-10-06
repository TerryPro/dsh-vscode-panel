import type { MarkdownOutlineEntry } from './markdown-outline.ts'
import css from './markdown.module.css'

export interface MarkdownOutlineLabels {
  /** Accessible name and panel heading, e.g. “大纲”. */
  title: string
  /** Shown when the document has no headings. */
  empty: string
}

interface MarkdownOutlineProps {
  entries: MarkdownOutlineEntry[]
  labels: MarkdownOutlineLabels
  /** Receives the clicked entry's `index`, used to locate the rendered heading. */
  onSelect: (index: number) => void
}

/** Right-hand table-of-contents panel for a Markdown preview. */
export function MarkdownOutline({ entries, labels, onSelect }: MarkdownOutlineProps) {
  return (
    <nav className={css.markdownOutline} aria-label={labels.title}>
      <div className={css.markdownOutlineTitle}>{labels.title}</div>
      {entries.length === 0
        ? <div className={css.markdownOutlineEmpty}>{labels.empty}</div>
        : (
          <ul className={css.markdownOutlineList}>
            {entries.map(entry => (
              <li key={entry.index}>
                <button
                  type="button"
                  className={css.markdownOutlineItem}
                  data-level={entry.level}
                  style={{ paddingLeft: `${(entry.level - 1) * 12 + 10}px` }}
                  title={entry.text}
                  onClick={() => { onSelect(entry.index) }}
                >
                  {entry.text}
                </button>
              </li>
            ))}
          </ul>
        )}
    </nav>
  )
}
