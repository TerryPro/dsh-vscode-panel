/** Persisted per-file column widths for the editable CSV grid. */

/** localStorage key prefix, suffixed with the workspace path, holding a width array. */
const KEY_PREFIX = 'dsh-workbench:csv-col-widths:'

/** Columns cannot be dragged narrower or wider than this band (CSS pixels). */
export const CSV_COLUMN_MIN_WIDTH = 60
export const CSV_COLUMN_MAX_WIDTH = 1200

/** Clamp a dragged pixel width into the usable band; non-finite input yields the default. */
export function clampColumnWidth(value: number): number {
  if (!Number.isFinite(value)) return 160
  return Math.min(CSV_COLUMN_MAX_WIDTH, Math.max(CSV_COLUMN_MIN_WIDTH, value))
}

/**
 * Read the remembered widths for one file. Malformed or blocked storage simply
 * yields an empty list, letting every column fall back to auto width.
 */
export function readCsvColumnWidths(path: string): number[] {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY_PREFIX + path)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.map(entry => (typeof entry === 'number' ? clampColumnWidth(entry) : CSV_COLUMN_MIN_WIDTH))
  } catch {
    return []
  }
}

/** Remember a file's column widths; a blocked or full storage just drops them. */
export function saveCsvColumnWidths(path: string, widths: readonly number[]): void {
  try {
    const clamped = widths.map(width => clampColumnWidth(width))
    localStorage?.setItem(KEY_PREFIX + path, JSON.stringify(clamped))
  } catch {
    /* the widths simply will not be remembered */
  }
}
