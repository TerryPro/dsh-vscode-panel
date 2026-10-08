/**
 * Pure view model for the JSON tree: which nodes are on screen, in what order,
 * and which of them are folded away.
 *
 * Keeping this apart from the component is what makes the tree testable without
 * a DOM — the same split the CSV grid uses between `csv-parse` and `CsvTable`.
 * Rows carry the collapsed-path keys the panel persists, so folding state
 * survives editing: it is keyed by document path rather than by source offset,
 * which drifts on every keystroke.
 */

import { jsonPathKey, type JsonNode } from './json-parse.ts'

/** How many elements of one array are listed before a “show more” row. */
export const JSON_ARRAY_PAGE = 200

/** Container levels left open the first time a document is shown. */
export const JSON_DEFAULT_EXPAND_DEPTH = 3

/** Strings longer than this are folded behind a click so a row stays one line. */
export const JSON_LONG_STRING = 200

/** One line of the tree: a node, a “show more” cursor, or a container's closer. */
export type JsonRow =
  | {
    readonly kind: 'node'
    readonly key: string
    readonly node: JsonNode
    /** Nesting level, mirroring {@link JsonNode.depth} for the row's indent. */
    readonly depth: number
    /** Whether this container's children are currently hidden. */
    readonly collapsed: boolean
  }
  | {
    readonly kind: 'more'
    readonly key: string
    /** Path key of the array whose remaining elements this row reveals. */
    readonly parentKey: string
    /** Indent one level under that array. */
    readonly depth: number
    readonly hidden: number
  }
  | {
    readonly kind: 'close'
    readonly key: string
    /** Path key of the container this brace or bracket closes. */
    readonly owner: string
    /** Same level as that container's opening row. */
    readonly depth: number
  }

export interface FlattenJsonOptions {
  /** Path keys of containers whose children are hidden. */
  collapsed?: ReadonlySet<string>
  /** Case-insensitive substring filter over keys and scalar values. */
  search?: string
  /** Extra array pages revealed so far, per array path key. */
  revealed?: ReadonlyMap<string, number>
  /** Override the array page size; defaults to {@link JSON_ARRAY_PAGE}. */
  arrayPage?: number
}

export interface JsonFlatView {
  readonly rows: readonly JsonRow[]
  /** Nodes matching the search, counted before filtering. */
  readonly matches: number
}

/** Every container's path key at or below `minDepth`, for folding presets. */
export function allContainerKeys(root: JsonNode | null, minDepth = JSON_DEFAULT_EXPAND_DEPTH): Set<string> {
  const keys = new Set<string>()
  if (root === null) return keys
  for (const node of walk(root)) {
    if (isContainer(node) && node.depth >= minDepth) keys.add(jsonPathKey(node.path))
  }
  return keys
}

/** Flatten the tree into rows, honouring folding, array paging and the filter. */
export function flattenVisibleJson(root: JsonNode | null, options: FlattenJsonOptions = {}): JsonFlatView {
  if (root === null) return { rows: [], matches: 0 }
  const collapsed = options.collapsed ?? EMPTY_KEYS
  const revealed = options.revealed
  const arrayPage = options.arrayPage ?? JSON_ARRAY_PAGE
  const query = (options.search ?? '').trim().toLowerCase()
  const keep = query === '' ? null : matchingKeys(root, query)
  const rows: JsonRow[] = []
  const visit = (node: JsonNode): void => {
    const key = jsonPathKey(node.path)
    if (keep !== null && !keep.keys.has(key)) return
    // A filter expands on its own terms: matching branches are shown open.
    const folded = keep === null && isContainer(node) && collapsed.has(key)
    rows.push({ kind: 'node', key, node, depth: node.depth, collapsed: folded })
    if (!isContainer(node) || folded) return
    const children = node.children
    const limit = node.kind === 'array' ? arrayPage * (1 + (revealed?.get(key) ?? 0)) : children.length
    const shown = Math.min(children.length, limit)
    for (const child of children.slice(0, shown)) visit(child)
    if (shown < children.length) rows.push({ kind: 'more', key: `${key}.more`, parentKey: key, depth: node.depth + 1, hidden: children.length - shown })
    // A closer gives the container a visible end; an empty one keeps `{}` inline.
    if (shown > 0) rows.push({ kind: 'close', key: `${key}.close`, owner: key, depth: node.depth })
  }
  visit(root)
  return { rows, matches: keep === null ? 0 : keep.matches }
}

/**
 * The path keys worth rendering for a search: every hit plus each of its
 * ancestors, so a match never appears detached from the structure that holds it.
 */
function matchingKeys(root: JsonNode, query: string): { keys: Set<string>; matches: number } {
  const keys = new Set<string>()
  let matches = 0
  for (const node of walk(root)) {
    if (!nodeMatchesQuery(node, query)) continue
    matches += 1
    for (let length = 0; length <= node.path.length; length += 1) keys.add(jsonPathKey(node.path.slice(0, length)))
  }
  return { keys, matches }
}

function nodeMatchesQuery(node: JsonNode, query: string): boolean {
  if (node.keyText !== undefined && node.keyText.toLowerCase().includes(query)) return true
  return !isContainer(node) && node.display.toLowerCase().includes(query)
}

/** Depth-first, source-order iteration over a parsed subtree. */
export function* walk(node: JsonNode): Generator<JsonNode> {
  yield node
  for (const child of node.children) yield* walk(child)
}

export function isContainer(node: JsonNode): boolean {
  return node.kind === 'object' || node.kind === 'array'
}

/** Long values are truncated for display; the whole text stays one click away. */
export function shortenJsonValue(text: string, limit = JSON_LONG_STRING): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}…`
}

/** How many members a folded container previews, and how wide one may run. */
export const JSON_PREVIEW_MEMBERS = 2
export const JSON_PREVIEW_VALUE = 24

export interface JsonPreview {
  /** The previewed members, formatted as `"key": "value"` pairs. */
  readonly text: string
  /** Members the preview left out. */
  readonly hidden: number
}

/** `"key"` for an object member, `[3]` for an array element. */
export function memberLabel(node: JsonNode): string {
  if (node.keyText !== undefined) return JSON.stringify(node.keyText)
  const last = node.path[node.path.length - 1]
  return typeof last === 'number' ? `[${last}]` : '$'
}

/**
 * What a folded container holds, so the reader need not open it to know — the
 * collapsed preview Chrome DevTools shows. Deliberately plain text: the row stays
 * scannable and the size badge beside it carries the count.
 */
export function collapsedPreview(
  node: JsonNode,
  members = JSON_PREVIEW_MEMBERS,
  valueLimit = JSON_PREVIEW_VALUE,
): JsonPreview {
  const shown = node.children.slice(0, members)
  const text = shown.map(child => `${memberLabel(child)}: ${previewValue(child, valueLimit)}`).join(', ')
  return { text, hidden: Math.max(0, node.children.length - shown.length) }
}

function previewValue(node: JsonNode, valueLimit: number): string {
  if (node.kind === 'object') return '{…}'
  if (node.kind === 'array') return '[…]'
  if (node.kind === 'unknown') return '…'
  return shortenJsonValue(node.kind === 'string' ? JSON.stringify(node.display) : node.display, valueLimit)
}

const EMPTY_KEYS: ReadonlySet<string> = new Set<string>()
