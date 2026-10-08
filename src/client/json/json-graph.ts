/**
 * Graph model and layered layout for the JSON canvas view.
 *
 * The grammar follows JSON Crack: one card per object, one `key: value` row per
 * member, a card for every array so it can be collapsed as a unit, and a labelled
 * edge from a member row to the card it points at. Layout is computed here rather
 * than in the DOM so it is deterministic and testable: cards are measured from
 * their text with a fixed monospace advance, each nesting level becomes a column,
 * and a parent is centred against the span its children gathered.
 *
 * Folding is keyed by document path (`$.a[0]`) and persisted per file, so the
 * canvas reopens the way the reader left it.
 */

import { jsonPathKey, type JsonNode, type JsonNodeKind } from './json-parse.ts'

/** Row height inside a card, in CSS pixels. */
export const GRAPH_ROW_HEIGHT = 28

/** Card padding and width band. */
export const GRAPH_CARD_PADDING_X = 12
export const GRAPH_CARD_MIN_WIDTH = 90
export const GRAPH_CARD_MAX_WIDTH = 340

/** Advance of one 13px monospace character; keeps layout independent of the DOM. */
export const GRAPH_CHAR_WIDTH = 8

/** Space between columns and between sibling cards. */
export const GRAPH_GAP_X = 90
export const GRAPH_GAP_Y = 18

/** Canvas margin, and the width a row's fold control reserves. */
export const GRAPH_MARGIN = 32
export const GRAPH_TOGGLE_WIDTH = 20

/** Elements listed per array before a “show more” row, and how much of a value is shown. */
export const GRAPH_PAGE_SIZE = 20
export const GRAPH_VALUE_MAX_CHARS = 48

/** Container levels left open the first time a document is shown. */
export const GRAPH_DEFAULT_EXPAND_DEPTH = 3

/** Zoom band the canvas clamps to. */
export const GRAPH_SCALE_MIN = 0.25
export const GRAPH_SCALE_MAX = 2.5

export interface GraphRow {
  /** Member name for an object row; `null` where the value stands alone. */
  readonly key: string | null
  /** Text drawn after the key: a value, or a `{n}` / `[n]` count for a container. */
  readonly text: string
  /** Untruncated value text, so a row can be copied without the ellipsis. */
  readonly display: string
  readonly kind: JsonNodeKind
  /** Path key of the value this row shows; used for selection and folding. */
  readonly pathKey: string
  /** Card this row links to, when the value is a non-empty container. */
  readonly childId: string | null
  /** Whether the row offers a fold control, and its current state. */
  readonly collapsible: boolean
  readonly collapsed: boolean
  /** Source span of the value, so a row can be revealed in the editor. */
  readonly start: number
  readonly end: number
  /** Set on the array “show more” row: the card it belongs to, and what it hides. */
  readonly moreFor: string | null
  readonly hidden: number
}

export interface GraphCard {
  /** Card identity: the path key of the node it renders. */
  readonly id: string
  readonly rows: readonly GraphRow[]
  readonly depth: number
  readonly width: number
  readonly height: number
  readonly x: number
  readonly y: number
  /** True when the card offers a “show more” row for a long array. */
  readonly hasMore: boolean
}

export interface GraphEdge {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly label: string | null
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
}

export interface GraphLayout {
  readonly cards: readonly GraphCard[]
  readonly edges: readonly GraphEdge[]
  /** Extent of the drawn content, for fitting the viewport. */
  readonly width: number
  readonly height: number
}

export interface GraphLayoutOptions {
  /** Path keys of values folded away; their cards are not drawn. */
  collapsed?: ReadonlySet<string>
  /** Extra array pages revealed so far, per array path key. */
  revealed?: ReadonlyMap<string, number>
}

interface CardDraft {
  id: string
  depth: number
  rows: GraphRow[]
  children: CardDraft[]
  width: number
  height: number
  x: number
  y: number
  hasMore: boolean
}

/** Every container's path key at or below `minDepth`, for the folding presets. */
export function allContainerKeys(root: JsonNode | null, minDepth = GRAPH_DEFAULT_EXPAND_DEPTH): Set<string> {
  const keys = new Set<string>()
  const visit = (node: JsonNode): void => {
    if ((node.kind === 'object' || node.kind === 'array') && node.depth >= minDepth) keys.add(jsonPathKey(node.path))
    for (const child of node.children) visit(child)
  }
  if (root !== null) visit(root)
  return keys
}

/** Build the cards and edges for a parsed document, laid out left to right. */
export function buildGraphLayout(root: JsonNode | null, options: GraphLayoutOptions = {}): GraphLayout {
  if (root === null) return { cards: [], edges: [], width: 0, height: 0 }
  const collapsed = options.collapsed ?? EMPTY_KEYS
  const rootDraft = cardFor(root, 0, collapsed, options.revealed)
  const columns: number[] = []
  const measure = (draft: CardDraft): void => {
    columns[draft.depth] = Math.max(columns[draft.depth] ?? 0, draft.width)
    for (const child of draft.children) measure(child)
  }
  measure(rootDraft)
  const columnX = columnsToOffsets(columns)
  let cursor = 0
  const place = (draft: CardDraft): void => {
    draft.x = columnX[draft.depth] ?? GRAPH_MARGIN
    if (draft.children.length === 0) {
      draft.y = cursor
      cursor += draft.height + GRAPH_GAP_Y
      return
    }
    const start = cursor
    for (const child of draft.children) place(child)
    const span = cursor - GRAPH_GAP_Y - start
    // Centre the card against what it heads; the column flow carries on below.
    draft.y = start + Math.max(0, (span - draft.height) / 2)
    cursor = Math.max(cursor, draft.y + draft.height + GRAPH_GAP_Y)
  }
  place(rootDraft)
  const cards: GraphCard[] = []
  const edges: GraphEdge[] = []
  const collect = (draft: CardDraft): void => {
    cards.push({
      id: draft.id,
      rows: draft.rows,
      depth: draft.depth,
      width: draft.width,
      height: draft.height,
      x: draft.x,
      y: draft.y,
      hasMore: draft.hasMore,
    })
    for (const child of draft.children) {
      const rowIndex = draft.rows.findIndex(row => row.childId === child.id)
      edges.push({
        id: `${draft.id}->${child.id}`,
        from: draft.id,
        to: child.id,
        label: rowIndex === -1 ? null : draft.rows[rowIndex]?.key ?? null,
        x1: draft.x + draft.width,
        y1: draft.y + rowIndex * GRAPH_ROW_HEIGHT + GRAPH_ROW_HEIGHT / 2,
        x2: child.x,
        y2: child.y + child.height / 2,
      })
      collect(child)
    }
  }
  collect(rootDraft)
  const last = columns.length - 1
  return {
    cards,
    edges,
    width: (columnX[last] ?? GRAPH_MARGIN) + (columns[last] ?? 0) + GRAPH_MARGIN,
    height: Math.max(cursor, rootDraft.height) + GRAPH_MARGIN,
  }
}

/** Cards whose own name, a row key or a row value matches the query. */
export function matchingCardIds(layout: GraphLayout, query: string): string[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return []
  const ids: string[] = []
  for (const card of layout.cards) {
    const own = cardName(card.id).toLowerCase()
    const hit = own.includes(needle) || card.rows.some(row =>
      (row.key !== null && row.key.toLowerCase().includes(needle))
      || row.text.toLowerCase().includes(needle))
    if (hit) ids.push(card.id)
  }
  return ids
}

/** The last path segment of a card, which is the name a reader would search for. */
function cardName(id: string): string {
  return /\.([^.[\]]+)$/.exec(id)?.[1] ?? ''
}

/** Transform that centres and fits a layout inside a viewport. */
export function fitTransform(
  layout: GraphLayout,
  viewport: { width: number; height: number },
  padding = 24,
  maxScale = 1,
): { x: number; y: number; scale: number } {
  if (viewport.width <= 0 || viewport.height <= 0 || layout.width <= 0) {
    return { x: padding, y: padding, scale: 1 }
  }
  const scale = clampGraphScale(Math.min(
    (viewport.width - padding * 2) / layout.width,
    (viewport.height - padding * 2) / layout.height,
    maxScale,
  ))
  return {
    x: (viewport.width - layout.width * scale) / 2,
    y: (viewport.height - layout.height * scale) / 2,
    scale,
  }
}

/** Keep zoom inside the usable band; non-finite input falls back to 100%. */
export function clampGraphScale(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(GRAPH_SCALE_MAX, Math.max(GRAPH_SCALE_MIN, value))
}

/** Zoom around a viewport point so the document under the cursor stays put. */
export function zoomAround(
  view: { x: number; y: number; scale: number },
  point: { x: number; y: number },
  nextScale: number,
): { x: number; y: number; scale: number } {
  const scale = clampGraphScale(nextScale)
  const ratio = scale / view.scale
  return { scale, x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio }
}

function cardFor(
  node: JsonNode,
  depth: number,
  collapsed: ReadonlySet<string>,
  revealed: ReadonlyMap<string, number> | undefined,
): CardDraft {
  const id = jsonPathKey(node.path)
  const rows: GraphRow[] = []
  const children: CardDraft[] = []
  if (node.kind === 'object' || node.kind === 'array') {
    const limit = node.kind === 'array'
      ? GRAPH_PAGE_SIZE * (1 + (revealed?.get(id) ?? 0))
      : node.children.length
    const shown = Math.min(node.children.length, limit)
    for (let index = 0; index < shown; index += 1) {
      const child = node.children[index]
      if (child === undefined) continue
      const childId = isBranch(child) ? jsonPathKey(child.path) : null
      const folded = childId !== null && collapsed.has(childId)
      rows.push({
        key: child.keyText ?? `[${child.path[child.path.length - 1] ?? index}]`,
        text: rowText(child),
        display: child.display,
        kind: child.kind,
        pathKey: jsonPathKey(child.path),
        childId,
        collapsible: childId !== null,
        collapsed: folded === true,
        start: child.start,
        end: child.end,
        moreFor: null,
        hidden: 0,
      })
      if (childId !== null && !folded) children.push(cardFor(child, depth + 1, collapsed, revealed))
    }
    if (shown < node.children.length) {
      rows.push({
        key: null,
        text: `+${node.children.length - shown}`,
        display: '',
        kind: 'unknown',
        pathKey: `${id}.more`,
        childId: null,
        collapsible: false,
        collapsed: false,
        start: node.start,
        end: node.end,
        moreFor: id,
        hidden: node.children.length - shown,
      })
    }
  }
  if (rows.length === 0) {
    rows.push({
      key: null,
      text: node.kind === 'object' ? '{}' : node.kind === 'array' ? '[]' : rowText(node),
      display: node.display,
      kind: node.kind,
      pathKey: id,
      childId: null,
      collapsible: false,
      collapsed: false,
      start: node.start,
      end: node.end,
      moreFor: null,
      hidden: 0,
    })
  }
  return {
    id,
    depth,
    rows,
    children,
    width: cardWidth(rows),
    height: rows.length * GRAPH_ROW_HEIGHT + 2,
    x: 0,
    y: 0,
    hasMore: rows.some(row => row.pathKey === `${id}.more`),
  }
}

/** The value text a row shows: a scalar verbatim, a container as a count. */
function rowText(node: JsonNode): string {
  if (node.kind === 'object') return `{${node.children.length}}`
  if (node.kind === 'array') return `[${node.children.length}]`
  if (node.kind === 'unknown') return node.display === '' ? '⚠' : shorten(node.display)
  if (node.kind === 'string') return shorten(JSON.stringify(node.display))
  return node.display
}

function isBranch(node: JsonNode): boolean {
  return (node.kind === 'object' || node.kind === 'array') && node.children.length > 0
}

function shorten(text: string): string {
  if (text.length <= GRAPH_VALUE_MAX_CHARS) return text
  return `${text.slice(0, GRAPH_VALUE_MAX_CHARS)}…`
}

function cardWidth(rows: readonly GraphRow[]): number {
  let longest = 0
  for (const row of rows) {
    const label = row.key === null ? row.text : `${row.key}: ${row.text}`
    const toggle = row.collapsible ? GRAPH_TOGGLE_WIDTH : 0
    longest = Math.max(longest, label.length * GRAPH_CHAR_WIDTH + toggle)
  }
  return Math.min(GRAPH_CARD_MAX_WIDTH, Math.max(GRAPH_CARD_MIN_WIDTH, longest + GRAPH_CARD_PADDING_X * 2))
}

/** Left edge of each depth column, from the widest card in every earlier column. */
function columnsToOffsets(columns: readonly number[]): number[] {
  const offsets: number[] = []
  let x = GRAPH_MARGIN
  for (const width of columns) {
    offsets.push(x)
    x += width + GRAPH_GAP_X
  }
  return offsets
}

const EMPTY_KEYS: ReadonlySet<string> = new Set<string>()
