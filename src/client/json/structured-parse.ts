/**
 * The one reader the structured graph calls, whatever the file's syntax.
 *
 * JSON and YAML differ enormously in grammar but agree on what the graph needs:
 * a node tree whose nodes carry the source span they were read from. Both readers
 * produce that shape, so this module only has to pick one and report whether the
 * document is small enough to draw — the view stays syntax-blind.
 */

import { isJsonViewRenderable, parseJsonDocument, type JsonDocument } from './json-parse.ts'
import { isJsonPath } from './json-path.ts'
import { isYamlPath } from '../yaml/yaml-path.ts'
import { isYamlViewRenderable, parseYamlDocument } from '../yaml/yaml-parse.ts'

/** Which syntax a structured file is written in. */
export type StructuredFormat = 'json' | 'yaml'

export interface StructuredParseResult {
  /** `null` when the extension belongs to no structured view. */
  readonly format: StructuredFormat | null
  /** Whether the draft is inside the size budget for this format. */
  readonly renderable: boolean
  /** The parsed tree, or `null` when there is nothing to draw yet. */
  readonly document: JsonDocument | null
}

/** The reader a path needs, or `null` when the file has no structured view. */
export function structuredFormatForPath(path: string | undefined): StructuredFormat | null {
  if (isYamlPath(path)) return 'yaml'
  if (isJsonPath(path)) return 'json'
  return null
}

/** True when a draft is small enough that parsing it cannot stall the UI. */
export function isStructuredViewRenderable(format: StructuredFormat, text: string): boolean {
  return format === 'yaml' ? isYamlViewRenderable(text) : isJsonViewRenderable(text)
}

/** Parse a structured file's draft with the reader its extension calls for. */
export function parseStructuredDocument(path: string, text: string): StructuredParseResult {
  const format = structuredFormatForPath(path)
  if (format === null) return { format: null, renderable: false, document: null }
  if (!isStructuredViewRenderable(format, text)) return { format, renderable: false, document: null }
  return { format, renderable: true, document: format === 'yaml' ? parseYamlDocument(text) : parseJsonDocument(text) }
}
