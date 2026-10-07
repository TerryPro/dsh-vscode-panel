/** Client-side recognition of Mermaid diagram source files. */

import { basename } from '../../shared/path-name.ts'

/**
 * File extensions the workbench renders as a Mermaid diagram. Kept in the
 * mermaid feature folder because only the browser half needs it: unlike the
 * Markdown flag, the Host reads these as ordinary text and never branches on
 * the suffix, so there is no shared contract to keep in sync.
 */
export const MERMAID_EXTENSIONS = ['mmd', 'mermaid'] as const

/** True when a workspace-relative (or absolute) path points at a Mermaid source file. */
export function isMermaidPath(path: string | undefined): boolean {
  if (path === undefined) return false
  const name = basename(path).toLowerCase()
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return false
  return (MERMAID_EXTENSIONS as readonly string[]).includes(name.slice(dot + 1))
}
