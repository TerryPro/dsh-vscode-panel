/** Client-side recognition of the YAML files the workbench draws as a value graph. */

import { basename } from '../../shared/path-name.ts'

/**
 * File extensions the workbench offers the structured graph for in YAML. The
 * graph itself is format-agnostic; only the parser and the decorations
 * (anchors, block scalars, multiple documents) differ.
 */
export const YAML_VIEW_EXTENSIONS = ['yaml', 'yml'] as const

/** True when a workspace-relative (or absolute) path points at a graph-viewable YAML file. */
export function isYamlPath(path: string | undefined): boolean {
  if (path === undefined) return false
  const name = basename(path).toLowerCase()
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return false
  return (YAML_VIEW_EXTENSIONS as readonly string[]).includes(name.slice(dot + 1))
}
