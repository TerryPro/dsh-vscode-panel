/** Shared `@codemirror/merge` configuration for the workbench's diff surfaces. */

/** Diff engine budget shared by the read-only diff view and the editor's inline Git overlay. */
export const MERGE_DIFF_CONFIG = { timeout: 800 } as const

/**
 * The merge-view options both surfaces agree on: a gutter, change highlighting,
 * inline character diffs when opted in, no merge controls, and syntax-coloured
 * deletions. Callers add `original` and their own `allowInlineDiffs`/collapse policy.
 */
export const MERGE_BASE_OPTIONS = {
  diffConfig: MERGE_DIFF_CONFIG,
  gutter: true,
  highlightChanges: true,
  mergeControls: false,
  syntaxHighlightDeletions: true,
} as const
