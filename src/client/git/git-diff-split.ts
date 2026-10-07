/** Persisted left/right split ratio for the side-by-side Git diff panes. */

/** localStorage key holding the split diff's left-pane width fraction. */
const STORAGE_KEY = 'dsh-workbench:diff-split-ratio'

/** Neither pane may collapse past these bounds while dragging the divider. */
export const DIFF_SPLIT_MIN = 0.2
export const DIFF_SPLIT_MAX = 0.8

/** Clamp a raw width fraction into the usable band, defaulting to half. */
export function clampDiffSplitRatio(value: number): number {
  if (!Number.isFinite(value)) return 0.5
  return Math.min(DIFF_SPLIT_MAX, Math.max(DIFF_SPLIT_MIN, value))
}

/** Read the remembered split ratio, or 0.5 when unset, unparsable, or storage is blocked. */
export function readDiffSplitRatio(): number {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY)
    return raw === null ? 0.5 : clampDiffSplitRatio(Number.parseFloat(raw))
  } catch {
    return 0.5
  }
}

/** Remember the split ratio; a blocked or full storage just drops the preference. */
export function saveDiffSplitRatio(ratio: number): void {
  try {
    localStorage?.setItem(STORAGE_KEY, String(clampDiffSplitRatio(ratio)))
  } catch {
    /* the ratio simply will not be remembered */
  }
}
