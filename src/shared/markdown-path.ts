/** Single source of truth for which workspace paths are treated as Markdown. */

import { basename } from './path-name.ts'

/**
 * File extensions recognized as Markdown across the Host and browser halves.
 * Kept here so the workspace backend's `markdown` flag and the client editor's
 * grammar resolution can never drift apart.
 */
export const MARKDOWN_EXTENSIONS = ['md', 'markdown', 'mdown', 'mkd', 'mdx'] as const

/** True when a workspace-relative (or absolute) path points at a Markdown file. */
export function isMarkdownPath(path: string | undefined): boolean {
  if (path === undefined) return false
  const name = basename(path).toLowerCase()
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return false
  return (MARKDOWN_EXTENSIONS as readonly string[]).includes(name.slice(dot + 1))
}
