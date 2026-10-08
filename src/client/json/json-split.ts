/** Persisted canvas preferences for the JSON view: the split ratio and the grid. */

/** localStorage key holding the JSON split's editor-pane width fraction. */
const STORAGE_KEY = 'dsh-workbench:json-split-ratio'

/** localStorage key holding whether the canvas draws its background grid. */
const GRID_KEY = 'dsh-workbench:json-grid'

/** Neither the editor nor the canvas may collapse past these bounds while dragging. */
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

/** Read the remembered grid choice; a canvas with no memory still draws the grid. */
export function readJsonGrid(): boolean {
  try {
    return (typeof localStorage === 'undefined' ? null : localStorage.getItem(GRID_KEY)) !== '0'
  } catch {
    return true
  }
}

/** Remember whether the canvas draws its grid; a blocked storage just drops it. */
export function saveJsonGrid(visible: boolean): void {
  try {
    localStorage?.setItem(GRID_KEY, visible ? '1' : '0')
  } catch {
    /* the choice simply will not be remembered */
  }
}
