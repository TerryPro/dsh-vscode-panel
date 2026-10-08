/** Persisted split ratio between the JSON source editor and its tree pane. */

/** localStorage key holding the JSON split's editor-pane width fraction. */
const STORAGE_KEY = 'dsh-workbench:json-split-ratio'

/** Neither the editor nor the tree may collapse past these bounds while dragging. */
export const JSON_SPLIT_MIN = 0.2
export const JSON_SPLIT_MAX = 0.8

/** Clamp a raw width fraction into the usable band, defaulting to half. */
export function clampJsonSplitRatio(value: number): number {
  if (!Number.isFinite(value)) return 0.5
  return Math.min(JSON_SPLIT_MAX, Math.max(JSON_SPLIT_MIN, value))
}

/** Read the remembered JSON split ratio, or 0.5 when unset/unparsable/blocked. */
export function readJsonSplitRatio(): number {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY)
    return raw === null ? 0.5 : clampJsonSplitRatio(Number.parseFloat(raw))
  } catch {
    return 0.5
  }
}

/** Remember the JSON split ratio; a blocked or full storage just drops it. */
export function saveJsonSplitRatio(ratio: number): void {
  try {
    localStorage?.setItem(STORAGE_KEY, String(clampJsonSplitRatio(ratio)))
  } catch {
    /* the ratio simply will not be remembered */
  }
}
