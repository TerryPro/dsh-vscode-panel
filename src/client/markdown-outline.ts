/** Headings extracted from a Markdown source, in document order. */

export interface MarkdownOutlineEntry {
  /** Heading depth, 1 for `#`/setext `===` through 6 for `######`. */
  level: number
  /** Heading text with inline Markdown stripped, ready for display. */
  text: string
  /** Zero-based ordinal among all headings; matches the rendered heading's DOM order. */
  index: number
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/u
const ATX_RE = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/u
const SETEXT_RE = /^ {0,3}(=+|-+)\s*$/u

/**
 * Collect ATX (`# …`) and setext (`===` / `---`) headings from a Markdown source,
 * skipping anything inside a fenced code block. Pure over text so it can be
 * unit-tested without a DOM; the `index` of each entry lines up with the order
 * the rendered preview uses for its `h1`–`h6` elements.
 */
export function extractMarkdownOutline(source: string): MarkdownOutlineEntry[] {
  const lines = source.replace(/\r\n?/gu, '\n').split('\n')
  const entries: MarkdownOutlineEntry[] = []
  let fenceMarkerState: string | null = null
  let fenceChar = ''
  // Last non-blank, non-heading line, kept as a setext heading candidate.
  let paragraph = ''

  for (const line of lines) {
    const fence = FENCE_RE.exec(line)
    const fenceMarker = fence?.[1]
    if (fence !== null && fenceMarker !== undefined) {
      if (fenceMarkerState === null) {
        fenceMarkerState = fenceMarker
        fenceChar = fenceMarker[0] ?? ''
      } else if ((fenceMarker[0] ?? '') === fenceChar && fenceMarker.length >= fenceMarkerState.length) {
        fenceMarkerState = null
      }
      paragraph = ''
      continue
    }
    if (fenceMarkerState !== null) {
      paragraph = ''
      continue
    }

    const atx = ATX_RE.exec(line)
    if (atx !== null) {
      const hashes = atx[1] ?? ''
      const text = cleanHeadingText(atx[2] ?? '')
      if (text !== '') entries.push({ level: hashes.length, text, index: entries.length })
      paragraph = ''
      continue
    }

    const setext = SETEXT_RE.exec(line)
    const setextMarker = setext?.[1]
    if (setext !== null && setextMarker !== undefined && paragraph !== '') {
      const text = cleanHeadingText(paragraph)
      if (text !== '') {
        entries.push({ level: setextMarker[0] === '=' ? 1 : 2, text, index: entries.length })
      }
      paragraph = ''
      continue
    }

    paragraph = line.trim() === '' ? '' : line.trim()
  }

  return entries
}

/** Reduce a raw heading line to display text by dropping inline Markdown. */
function cleanHeadingText(raw: string): string {
  let text = raw
  text = text.replace(/!?\[([^\]]*)\]\([^)]*\)/gu, '$1')
  text = text.replace(/!?\[([^\]]*)\]\[[^\]]*\]/gu, '$1')
  text = text.replace(/`([^`]*)`/gu, '$1')
  text = text.replace(/\*\*|__|~~|[*_`]/gu, '')
  return text.trim()
}
