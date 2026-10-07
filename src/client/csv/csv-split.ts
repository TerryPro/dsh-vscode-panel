/** Persisted split ratio between the CSV source editor and its table pane. */

/** localStorage key holding the CSV split's editor-pane width fraction. */
const STORAGE_KEY = 'dsh-workbench:csv-split-ratio'

/** Neither the editor nor the table may collapse past these bounds while dragging. */
export const CSV_SPLIT_MIN = 0.2
export const CSV_SPLIT_MAX = 0.8

/** Clamp a raw width fraction into the usable band, defaulting to half. */
export function clampCsvSplitRatio(value: number): number {
  if (!Number.isFinite(value)) return 0.5
  return Math.min(CSV_SPLIT_MAX, Math.max(CSV_SPLIT_MIN, value))
}

/** Read the remembered CSV split ratio, or 0.5 when unset/unparsable/blocked. */
export function readCsvSplitRatio(): number {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY)
    return raw === null ? 0.5 : clampCsvSplitRatio(Number.parseFloat(raw))
  } catch {
    return 0.5
  }
}

/** Remember the CSV split ratio; a blocked or full storage just drops it. */
export function saveCsvSplitRatio(ratio: number): void {
  try {
    localStorage?.setItem(STORAGE_KEY, String(clampCsvSplitRatio(ratio)))
  } catch {
    /* the ratio simply will not be remembered */
  }
}
