/**
 * YAML reader for the structured graph view.
 *
 * The graph consumes a node tree that carries source spans, and that is exactly
 * what this adapter produces: it maps the `yaml` document model (ISC, no
 * transitive dependencies, and documented to parse as much as it can out of any
 * string rather than throwing) onto the same `JsonNode` shape the JSON reader
 * emits, so cards, wires, folding and the details panel work unchanged.
 *
 * Three YAML ideas have no JSON counterpart and ride along as optional node
 * fields: anchors and aliases (`&a` / `*a` — kept as a badge, never expanded, so
 * the graph stays a tree), explicit tags, and block scalars (`|`, `>`), whose
 * multi-line text reads as one line in a card and in full in the panel. Comments
 * are deliberately left out of the graph; the source view owns them.
 */

import { isAlias, isMap, isScalar, isSeq, parseAllDocuments } from 'yaml'
import {
  jsonPathKey,
  jsonUtf8Length,
  JSON_MAX_DEPTH,
  JSON_RENDER_MAX_NODES,
  type JsonDocument,
  type JsonNode,
  type JsonNodeKind,
  type JsonParseError,
} from '../json/json-parse.ts'

/** Documents whose UTF-8 size exceeds this stay in the source view. */
export const YAML_VIEW_MAX_BYTES = 1024 * 1024

/** True when a YAML document is small enough to parse for the graph without stalling the UI. */
export function isYamlViewRenderable(text: string): boolean {
  return jsonUtf8Length(text) <= YAML_VIEW_MAX_BYTES
}

export interface ParseYamlOptions {
  /** Override the node cap; defaults to {@link JSON_RENDER_MAX_NODES}. */
  maxNodes?: number | undefined
}

/**
 * The slice of the `yaml` node model this adapter reads. Typing it structurally
 * keeps the traversal honest without depending on the library's generic
 * parameters, which widen parsed collections to `unknown`.
 */
interface NodeLike {
  readonly range?: readonly number[] | null
  readonly anchor?: string
  readonly tag?: string
  readonly value?: unknown
  readonly source?: string
  readonly type?: string
  readonly items?: readonly unknown[]
}

interface PairLike {
  readonly key?: NodeLike
  readonly value?: NodeLike | null
}

interface Ctx {
  text: string
  nodes: number
  maxNodes: number
  truncated: boolean
  errors: JsonParseError[]
  /** Anchor name to the path key of the node that defines it. */
  anchors: Map<string, string>
}

/** Parse a YAML file — including a multi-document stream — into a graph-ready tree. */
export function parseYamlDocument(text: string, options: ParseYamlOptions = {}): JsonDocument {
  const ctx: Ctx = {
    text,
    nodes: 0,
    maxNodes: options.maxNodes ?? JSON_RENDER_MAX_NODES,
    truncated: false,
    errors: [],
    anchors: new Map(),
  }
  const documents = parseAllDocuments(text, { prettyErrors: false })
  for (const document of documents) {
    for (const error of document.errors) {
      ctx.errors.push({ offset: error.pos?.[0] ?? 0, code: 'unexpected-value', detail: error.message })
    }
  }
  const bodies = documents.filter(document => document.contents !== null)
  const multi = bodies.length > 1
  const roots: JsonNode[] = []
  bodies.forEach((document, index) => {
    const content = convert(document.contents as unknown, multi ? [index] : [], multi ? 1 : 0, ctx)
    if (content === null) return
    roots.push(multi ? { ...content, keyText: `document ${index + 1}` } : content)
  })
  const root = roots.length === 0 ? null : roots.length === 1 ? (roots[0] as JsonNode) : syntheticRoot(roots)
  return {
    root,
    totalNodes: ctx.nodes,
    truncated: ctx.truncated,
    errors: ctx.errors,
    comments: [],
  }
}

/** A stream of documents reads as one array of values, so the graph keeps a single root. */
function syntheticRoot(roots: readonly JsonNode[]): JsonNode {
  const first = roots[0] as JsonNode
  const last = roots[roots.length - 1] as JsonNode
  return {
    kind: 'array',
    depth: 0,
    path: [],
    start: first.start,
    end: last.end,
    children: roots,
    display: '',
  }
}

function convert(raw: unknown, path: readonly (string | number)[], depth: number, ctx: Ctx): JsonNode | null {
  const node = raw as NodeLike
  const [start, end] = span(node, ctx)
  if (depth > JSON_MAX_DEPTH) {
    ctx.errors.push({ offset: start, code: 'too-deep' })
    return null
  }
  if (ctx.nodes >= ctx.maxNodes) {
    ctx.truncated = true
    return null
  }
  ctx.nodes += 1
  const anchor = isAlias(raw) ? undefined : node.anchor
  if (anchor !== undefined) ctx.anchors.set(anchor, jsonPathKey(path))
  const base = { depth, path, start, end, ...(anchor === undefined ? {} : { anchor }) }

  if (isMap(raw)) {
    const children: JsonNode[] = []
    for (const item of node.items ?? []) {
      const pair = item as PairLike
      const key = pair.key
      const keyText = key === undefined ? '(key)' : keyTextOf(key)
      const childPath = [...path, keyText]
      const value = pair.value === undefined || pair.value === null
        ? emptyValueNode(childPath, depth + 1, ctx, key)
        : convert(pair.value, childPath, depth + 1, ctx)
      if (value === null) continue
      children.push({ ...value, keyText, ...(key?.range ? { keyStart: key.range[0], keyEnd: key.range[1] } : {}) })
    }
    return { ...base, kind: 'object', children, display: '' }
  }

  if (isSeq(raw)) {
    const children: JsonNode[] = []
    ;(node.items ?? []).forEach((item, index) => {
      const child = convert(item, [...path, index], depth + 1, ctx)
      if (child !== null) children.push(child)
    })
    return { ...base, kind: 'array', children, display: '' }
  }

  if (isAlias(raw)) {
    const name = node.source ?? ''
    return {
      ...base,
      kind: 'string',
      children: [],
      display: `*${name}`,
      aliasTarget: ctx.anchors.get(name) ?? name,
    }
  }

  if (isScalar(raw)) {
    const kind = scalarKind(node.value)
    const written = node.source ?? ''
    return {
      ...base,
      kind,
      children: [],
      display: kind === 'string' ? String(node.value ?? '') : written === '' ? nullLiteral(kind) : written,
      ...(node.tag === undefined ? {} : { tag: shortTag(node.tag) }),
      ...(node.type === 'BLOCK_LITERAL' ? { blockStyle: 'literal' as const } : {}),
      ...(node.type === 'BLOCK_FOLDED' ? { blockStyle: 'folded' as const } : {}),
    }
  }

  return { ...base, kind: 'unknown', children: [], display: ctx.text.slice(start, end) }
}

/** A `key:` with nothing after it still reads as a member, so it gets a null leaf. */
function emptyValueNode(path: readonly (string | number)[], depth: number, ctx: Ctx, key: NodeLike | undefined): JsonNode {
  ctx.nodes += 1
  const at = key?.range?.[1] ?? 0
  return { kind: 'null', depth, path, start: at, end: at, children: [], display: 'null' }
}

function span(node: NodeLike, ctx: Ctx): [number, number] {
  const range = node?.range
  if (range === undefined || range === null) return [0, ctx.text.length]
  // A block collection's reported end sits after the line break that closes it;
  // a span that reveals or selects a value should stop at the value itself.
  let end = range[1] ?? range[0] ?? 0
  while (end > (range[0] ?? 0) && (ctx.text[end - 1] === '\n' || ctx.text[end - 1] === '\r')) end -= 1
  return [range[0] ?? 0, end]
}

function keyTextOf(key: NodeLike): string {
  const value = key.value
  if (value === null || value === undefined) return key.source ?? ''
  return typeof value === 'object' ? '(key)' : String(value)
}

function scalarKind(value: unknown): JsonNodeKind {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number' || typeof value === 'bigint') return 'number'
  return 'string'
}

function nullLiteral(kind: JsonNodeKind): string {
  return kind === 'null' ? 'null' : ''
}

/** `tag:yaml.org,2002:str` reads as `!!str`; anything else keeps its own name. */
function shortTag(tag: string): string {
  const core = 'tag:yaml.org,2002:'
  return tag.startsWith(core) ? tag.slice(core.length) : tag
}
