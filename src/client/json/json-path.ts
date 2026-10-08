/** Client-side recognition of the JSON-family files the workbench draws as a value graph. */

import { basename } from '../../shared/path-name.ts'

/**
 * File extensions the workbench offers a structured graph for. `json5` is left
 * out on purpose: its unquoted keys, single-quoted strings and multi-line
 * values cost a far larger scanner than the JSONC one the view needs, so those
 * files stay in the source view while the highlighting map keeps covering them.
 */
export const JSON_VIEW_EXTENSIONS = ['json', 'jsonc'] as const

/** True when a workspace-relative (or absolute) path points at a graph-viewable JSON file. */
export function isJsonPath(path: string | undefined): boolean {
  if (path === undefined) return false
  const name = basename(path).toLowerCase()
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return false
  return (JSON_VIEW_EXTENSIONS as readonly string[]).includes(name.slice(dot + 1))
}
