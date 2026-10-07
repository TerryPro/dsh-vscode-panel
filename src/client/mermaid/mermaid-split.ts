/** Persisted split ratio between the Mermaid source editor and its live preview. */

/** localStorage key holding the mermaid split's editor-pane width fraction. */
const STORAGE_KEY = 'dsh-workbench:mermaid-split-ratio'

/** Neither the editor nor the preview may collapse past these bounds while dragging. */
export const MERMAID_SPLIT_MIN = 0.2
export const MERMAID_SPLIT_MAX = 0.8

/** Clamp a raw width fraction into the usable band, defaulting to half. */
export function clampMermaidSplitRatio(value: number): number {
  if (!Number.isFinite(value)) return 0.5
  return Math.min(MERMAID_SPLIT_MAX, Math.max(MERMAID_SPLIT_MIN, value))
}

/** Read the remembered mermaid split ratio, or 0.5 when unset/unparsable/blocked. */
export function readMermaidSplitRatio(): number {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY)
    return raw === null ? 0.5 : clampMermaidSplitRatio(Number.parseFloat(raw))
  } catch {
    return 0.5
  }
}

/** Remember the mermaid split ratio; a blocked or full storage just drops it. */
export function saveMermaidSplitRatio(ratio: number): void {
  try {
    localStorage?.setItem(STORAGE_KEY, String(clampMermaidSplitRatio(ratio)))
  } catch {
    /* the ratio simply will not be remembered */
  }
}
