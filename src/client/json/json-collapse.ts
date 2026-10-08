/** Persisted per-file folded branches of the JSON value graph. */

/** localStorage key prefix, suffixed with the workspace path, holding a path-key list. */
const KEY_PREFIX = 'dsh-workbench:json-collapse:'

/**
 * Read the remembered folded branches for one file. `null` means nothing is
 * remembered yet — malformed or blocked storage reports the same, so the tree
 * falls back to its default expand depth rather than to a fully open document.
 */
export function readJsonCollapsed(path: string): Set<string> | null {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY_PREFIX + path)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    const keys = new Set<string>()
    for (const entry of parsed) if (typeof entry === 'string') keys.add(entry)
    return keys
  } catch {
    return null
  }
}

/** Remember which branches a file is folded at; a blocked or full storage just drops them. */
export function saveJsonCollapsed(path: string, collapsed: ReadonlySet<string>): void {
  try {
    localStorage?.setItem(KEY_PREFIX + path, JSON.stringify([...collapsed]))
  } catch {
    /* the folding simply will not be remembered */
  }
}
