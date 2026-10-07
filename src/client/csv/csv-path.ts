/** Client-side recognition of delimited table files the workbench renders as a grid. */

import { basename } from '../../shared/path-name.ts'

/**
 * File extensions the workbench offers a tabular preview for. Kept in the csv
 * feature folder because only the browser half needs it: like Mermaid, the Host
 * reads these as ordinary text and never branches on the suffix, so there is no
 * shared contract to keep in sync.
 */
export const CSV_PREVIEW_EXTENSIONS = ['csv', 'tsv'] as const

/** True when a workspace-relative (or absolute) path points at a delimited table file. */
export function isCsvPath(path: string | undefined): boolean {
  if (path === undefined) return false
  const name = basename(path).toLowerCase()
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return false
  return (CSV_PREVIEW_EXTENSIONS as readonly string[]).includes(name.slice(dot + 1))
}

/**
 * The authoritative delimiter implied by a table file's extension, or `undefined`
 * for a non-table path (fall back to content sniffing). Keyed by extension so the
 * grid and the source-view highlighting always agree — e.g. a `.tsv` full of
 * commas is still split on tabs, never mis-detected as comma-delimited.
 */
export function delimiterForCsvPath(path: string | undefined): string | undefined {
  if (path === undefined) return undefined
  const name = basename(path).toLowerCase()
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return undefined
  const extension = name.slice(dot + 1)
  if (extension === 'tsv') return '\t'
  if (extension === 'csv') return ','
  return undefined
}
