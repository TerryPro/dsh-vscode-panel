/**
 * Read-only structured tree for a JSON/JSONC document.
 *
 * The tree is a *view*: the file tab's draft stays the single source of truth, so
 * values are still edited in the source view (or in the left half of the split),
 * exactly like IntelliJ's tree/text toggle. Rows come from the pure
 * `flattenVisibleJson` model: each level draws an indent guide, a folded container
 * previews what it holds, and every opened container gets its own closing brace
 * row, so both membership and extent are visible without expanding anything.
 * Folding is remembered per file, and a row can reveal its own text in the editor
 * when one is on screen. Parsing follows the live
 * draft, so a half-typed document still shows a tree with the problem visible
 * instead of refusing to render.
 */

import { useCallback, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { EditorView } from '@codemirror/view'
import { IconChevronDownOutlineRegular, IconChevronRightOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { copyTextToClipboard } from '../core/clipboard.ts'
import { readJsonCollapsed, saveJsonCollapsed } from './json-collapse.ts'
import { isJsonTreeRenderable, jsonPathKey, parseJsonDocument, type JsonNode } from './json-parse.ts'
import {
  allContainerKeys,
  collapsedPreview,
  flattenVisibleJson,
  isContainer,
  JSON_DEFAULT_EXPAND_DEPTH,
  JSON_LONG_STRING,
  shortenJsonValue,
  walk,
  type JsonRow,
} from './json-tree-view.ts'
import css from './json.module.css'

/** User-facing copy the tree needs, resolved by the caller from the locale. */
export interface JsonTreeLabels {
  /** Accessible name of the tree itself, e.g. “JSON 树”. */
  tree: string
  empty: string
  /** Note shown when the draft has syntax problems. */
  invalid: string
  /** Short label standing in for a value the grammar could not read. */
  invalidValue: string
  tooLarge: string
  truncated: (count: number) => ReactNode
  /** Size note for the whole document, e.g. “1,024 个节点”. */
  nodes: (count: number) => ReactNode
  search: string
  noMatches: string
  matches: (count: number) => ReactNode
  expandAll: string
  collapseAll: string
  depth: (value: number) => ReactNode
  copyValue: string
  copyPath: string
  copied: string
  copyFailed: string
  items: (count: number) => ReactNode
  keys: (count: number) => ReactNode
  showMore: (count: number) => ReactNode
  expandString: string
}

export interface JsonTreeProps {
  source: string
  /** Workspace path used to key persisted folding state. */
  path: string
  labels: JsonTreeLabels
  /** Editor to reveal a clicked row's text in; without one the rows only select. */
  view?: EditorView | null | undefined
  split?: boolean
  style?: CSSProperties
}

/** A flattened row that carries a parsed node, i.e. anything but a cursor or a closer. */
type NodeRow = Extract<JsonRow, { kind: 'node' }>

/** Rows the reader can move focus through; a closer is only punctuation. */
type NavRow = Exclude<JsonRow, { kind: 'close' }>

/** What the panel draws: a focusable row, or a container's non-interactive closer. */
type Visual =
  | { readonly kind: 'row'; readonly row: NavRow; readonly slot: number }
  | { readonly kind: 'closer'; readonly row: Extract<JsonRow, { kind: 'close' }> }

/** Expand-depth presets the toolbar button cycles through. */
const DEPTH_PRESETS = [1, 2, 3, 4] as const

export function JsonTree({ source, path, labels, view = null, split = false, style }: JsonTreeProps) {
  const renderable = useMemo(() => isJsonTreeRenderable(source), [source])
  const parsed = useMemo(() => (renderable ? parseJsonDocument(source) : null), [renderable, source])
  const root = parsed?.root ?? null
  const [depth, setDepth] = useState<number>(JSON_DEFAULT_EXPAND_DEPTH)
  const [folded, setFolded] = useState<Set<string> | null>(() => readJsonCollapsed(path))
  const [search, setSearch] = useState('')
  const [revealed, setRevealed] = useState<ReadonlyMap<string, number>>(() => new Map())
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [openStrings, setOpenStrings] = useState<ReadonlySet<string>>(() => new Set())
  const [focusIndex, setFocusIndex] = useState(0)
  const [note, setNote] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const rowRefs = useRef<(HTMLDivElement | null)[]>([])
  const presetCollapsed = useMemo(() => allContainerKeys(root, depth), [root, depth])
  const collapsed = folded ?? presetCollapsed
  const flat = useMemo(() => flattenVisibleJson(root, { collapsed, search, revealed }), [root, collapsed, search, revealed])
  // Closers are structure, not content: they carry no focus or keyboard slot.
  const navRows = useMemo(() => flat.rows.filter((row): row is NavRow => row.kind !== 'close'), [flat])
  const visuals = useMemo(() => {
    const list: Visual[] = []
    let slot = 0
    for (const row of flat.rows) {
      if (row.kind === 'close') list.push({ kind: 'closer', row })
      else list.push({ kind: 'row', row, slot: slot++ })
    }
    return list
  }, [flat])
  const indexByKey = useMemo(() => {
    const index = new Map<string, number>()
    // Duplicate keys in one object share a path; the last row wins the lookup.
    navRows.forEach((row, position) => { if (row.kind === 'node') index.set(row.key, position) })
    return index
  }, [navRows])
  const nodesByKey = useMemo(() => {
    const nodes = new Map<string, JsonNode>()
    if (root !== null) for (const node of walk(root)) nodes.set(jsonPathKey(node.path), node)
    return nodes
  }, [root])
  const selectedRow = navRows.find((row): row is NodeRow => row.kind === 'node' && row.key === selectedKey)
  const selectedNode = selectedRow?.node ?? null

  /** Record a folding change; the preset stays unless the picker is used again. */
  const applyCollapsed = useCallback((next: Set<string>): void => {
    setFolded(next)
    saveJsonCollapsed(path, next)
  }, [path])

  const revealInEditor = useCallback((node: JsonNode): void => {
    if (view === null) return
    view.dispatch({
      selection: { anchor: node.start, head: node.end },
      effects: EditorView.scrollIntoView(node.start, { y: 'center' }),
      userEvent: 'select',
    })
  }, [view])

  /** One handler for click and Enter: select, then act on whatever the row is. */
  const activateRow = useCallback((row: NavRow, index: number): void => {
    setFocusIndex(index)
    rowRefs.current[index]?.focus()
    if (row.kind === 'more') {
      setRevealed(current => {
        const next = new Map(current)
        next.set(row.parentKey, (next.get(row.parentKey) ?? 0) + 1)
        return next
      })
      return
    }
    setSelectedKey(row.key)
    const node = row.node
    if (isContainer(node)) {
      const next = new Set(collapsed)
      if (next.has(row.key)) next.delete(row.key)
      else next.add(row.key)
      applyCollapsed(next)
      return
    }
    if (valueText(node).length > JSON_LONG_STRING) {
      setOpenStrings(current => {
        const next = new Set(current)
        next.add(row.key)
        return next
      })
    }
    revealInEditor(node)
  }, [applyCollapsed, collapsed, revealInEditor])

  const copySelection = useCallback(async (kind: 'value' | 'path'): Promise<void> => {
    if (selectedNode === null) return
    const text = kind === 'path' ? jsonPathKey(selectedNode.path) : valueText(selectedNode)
    try {
      await copyTextToClipboard(text)
      setNote({ kind: 'ok', text: labels.copied })
    } catch {
      setNote({ kind: 'error', text: labels.copyFailed })
    }
  }, [labels.copied, labels.copyFailed, selectedNode])

  const cycleDepth = useCallback((): void => {
    const position = DEPTH_PRESETS.indexOf(depth as (typeof DEPTH_PRESETS)[number])
    const next = DEPTH_PRESETS[(position + 1) % DEPTH_PRESETS.length] ?? JSON_DEFAULT_EXPAND_DEPTH
    setDepth(next)
    applyCollapsed(allContainerKeys(root, next))
  }, [applyCollapsed, depth, root])

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const rows = navRows
    if (rows.length === 0) return
    // Follow the real focus when a row raised the event, else the roving index.
    const focused = Number((event.target as HTMLElement).dataset.rowIndex)
    const index = Math.min(Math.max(Number.isNaN(focused) ? focusIndex : focused, 0), rows.length - 1)
    const move = (target: number): void => {
      const clamped = Math.min(Math.max(target, 0), rows.length - 1)
      setFocusIndex(clamped)
      rowRefs.current[clamped]?.focus()
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      move(index + 1)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      move(index - 1)
      return
    }
    if (event.key === 'Home') {
      event.preventDefault()
      move(0)
      return
    }
    if (event.key === 'End') {
      event.preventDefault()
      move(rows.length - 1)
      return
    }
    if (event.key === 'Enter') {
      const row = rows[index]
      if (row !== undefined) {
        event.preventDefault()
        activateRow(row, index)
      }
      return
    }
    const row = rows[index]
    if (row === undefined || row.kind !== 'node' || !isContainer(row.node)) return
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      if (row.collapsed) activateRow(row, index)
      else move(index + 1)
      return
    }
    if (event.key !== 'ArrowLeft') return
    event.preventDefault()
    if (!row.collapsed) {
      activateRow(row, index)
      return
    }
    const parentIndex = indexByKey.get(jsonPathKey(row.node.path.slice(0, -1)))
    if (parentIndex !== undefined) move(parentIndex)
  }

  const containerSummary = (node: JsonNode): ReactNode => {
    return node.kind === 'array' ? labels.items(node.children.length) : labels.keys(node.children.length)
  }

  const valueOf = (node: JsonNode): ReactNode => {
    const text = node.display === '' && node.kind === 'unknown' ? labels.invalidValue : valueText(node)
    const expandable = node.error === undefined && text.length > JSON_LONG_STRING
    const open = openStrings.has(jsonPathKey(node.path))
    return (
      <span className={valueClass(node)} title={expandable && !open ? labels.expandString : undefined}>
        {expandable && !open ? shortenJsonValue(text) : text}
        {expandable && !open && <span className={css.jsonValueToggle}> ▾</span>}
      </span>
    )
  }

  /** One indent rule per nesting level, so the hierarchy reads without counting spaces. */
  const guides = (depth: number): ReactNode[] =>
    Array.from({ length: depth }, (_, level) => <span key={level} className={css.jsonGuide} data-guide="1" aria-hidden="true" />)

  /** Point at a container by lighting the guides of everything it contains. */
  const litSubtree = (element: HTMLDivElement | null, on: boolean): void => {
    const litClass = css.jsonRowLit
    if (element === null || litClass === undefined) return
    const depth = Number(element.dataset.depth)
    if (Number.isNaN(depth)) return
    element.classList.toggle(litClass, on)
    for (let sibling = element.nextElementSibling; sibling !== null; sibling = sibling.nextElementSibling) {
      const row = sibling as HTMLElement
      if (Number(row.dataset.depth) <= depth) break
      row.classList.toggle(litClass, on)
    }
  }

  /** A container row's braces: `{ … }` with a preview when folded, `{` when open. */
  const containerHead = (node: JsonNode, folded: boolean, selected: boolean): ReactNode => {
    const opener = node.kind === 'object' ? '{' : '['
    const closer = node.kind === 'object' ? '}' : ']'
    const open = node.children.length > 0
    const pairClass = `${css.jsonPunctuation} ${selected ? css.jsonPunctActive : ''}`
    if (!folded) return <span className={pairClass}>{open ? opener : `${opener}${closer}`}</span>
    const preview = collapsedPreview(node)
    return (
      <>
        <span className={css.jsonPunctuation}>{opener}</span>
        {preview.text !== '' && <span className={css.jsonPreview}>{preview.text}</span>}
        {preview.hidden > 0 && <span className={css.jsonPreview}>{` +${preview.hidden}`}</span>}
        <span className={css.jsonPunctuation}>{closer}</span>
        {open && <span className={css.jsonBadge}>{containerSummary(node)}</span>}
      </>
    )
  }

  if (!renderable) {
    return (
      <section className={treeClass(split)} style={style} aria-label={labels.tree}>
        <p className={css.jsonNote}>{labels.tooLarge}</p>
      </section>
    )
  }

  const filtering = search.trim() !== ''
  return (
    <section className={treeClass(split)} style={style} aria-label={labels.tree}>
      <div className={css.jsonToolbar}>
        <input
          className={css.jsonSearch}
          type="search"
          aria-label={labels.search}
          placeholder={labels.search}
          value={search}
          onChange={event => { setSearch(event.target.value) }}
        />
        <button type="button" className={css.jsonAction} onClick={cycleDepth}>{labels.depth(depth)}</button>
        <button type="button" className={css.jsonAction} onClick={() => { applyCollapsed(new Set()) }}>{labels.expandAll}</button>
        <button type="button" className={css.jsonAction} onClick={() => { applyCollapsed(allContainerKeys(root, 1)) }}>{labels.collapseAll}</button>
        <button type="button" className={css.jsonAction} disabled={selectedNode === null} onClick={() => { void copySelection('value') }}>{labels.copyValue}</button>
        <button type="button" className={css.jsonAction} disabled={selectedNode === null} onClick={() => { void copySelection('path') }}>{labels.copyPath}</button>
        <span className={css.jsonCount}>{filtering ? labels.matches(flat.matches) : labels.nodes(parsed?.totalNodes ?? 0)}</span>
      </div>
      {(parsed?.errors.length ?? 0) > 0 && <p className={`${css.jsonNote} ${css.jsonNoteError}`}>{labels.invalid}</p>}
      {parsed !== null && parsed.truncated && <p className={css.jsonNote}>{labels.truncated(parsed.totalNodes)}</p>}
      {note !== null && <p className={note.kind === 'error' ? `${css.jsonNote} ${css.jsonNoteError}` : css.jsonNote}>{note.text}</p>}
      {navRows.length === 0
        ? <p className={css.jsonEmpty}>{filtering ? labels.noMatches : labels.empty}</p>
        : (
          <div className={css.jsonScroll} role="tree" aria-label={labels.tree} onKeyDown={onKeyDown}>
            {visuals.map(entry => {
              if (entry.kind === 'closer') {
                const closer = entry.row
                const paired = selectedKey === closer.owner
                return (
                  <div key={closer.key} className={css.jsonRow} data-depth={closer.depth} data-closer={closer.owner} aria-hidden="true">
                    {guides(closer.depth)}
                    <span className={css.jsonExpander} />
                    <span className={`${css.jsonPunctuation} ${paired ? css.jsonPunctActive : ''}`}>
                      {nodesByKey.get(closer.owner)?.kind === 'array' ? ']' : '}'}
                    </span>
                  </div>
                )
              }
              const row = entry.row
              const slot = entry.slot
              if (row.kind === 'more') {
                return (
                  <div key={row.key} ref={element => { rowRefs.current[slot] = element }} className={`${css.jsonRow} ${css.jsonMore}`} data-depth={row.depth} data-row-index={slot}>
                    {guides(row.depth)}
                    <button type="button" className={css.jsonAction} onClick={() => { activateRow(row, slot) }}>{labels.showMore(row.hidden)}</button>
                  </div>
                )
              }
              const node = row.node
              const container = isContainer(node)
              const segment = node.keyText === undefined ? node.path[node.path.length - 1] : undefined
              const labelled = node.keyText !== undefined || typeof segment === 'number'
              return (
                <div
                  key={row.key}
                  ref={element => { rowRefs.current[slot] = element }}
                  className={`${css.jsonRow} ${selectedKey === row.key ? css.jsonRowSelected : ''}`}
                  role="treeitem"
                  aria-level={node.depth + 1}
                  aria-expanded={container ? !row.collapsed : undefined}
                  aria-selected={selectedKey === row.key}
                  tabIndex={slot === focusIndex ? 0 : -1}
                  data-row-index={slot}
                  data-depth={row.depth}
                  data-kind={node.kind}
                  title={node.error === undefined ? undefined : labels.invalidValue}
                  onClick={() => { activateRow(row, slot) }}
                  onFocus={() => { setFocusIndex(slot) }}
                  onMouseEnter={container ? (event: ReactMouseEvent<HTMLDivElement>) => { litSubtree(event.currentTarget, true) } : undefined}
                  onMouseLeave={container ? (event: ReactMouseEvent<HTMLDivElement>) => { litSubtree(event.currentTarget, false) } : undefined}
                >
                  {guides(row.depth)}
                  <span className={css.jsonExpander} aria-hidden="true">
                    {container ? (row.collapsed ? <IconChevronRightOutlineRegular size={14} /> : <IconChevronDownOutlineRegular size={14} />) : null}
                  </span>
                  {node.keyText !== undefined && <span className={css.jsonKey}>{JSON.stringify(node.keyText)}</span>}
                  {typeof segment === 'number' && <span className={css.jsonIndex}>{segment}</span>}
                  {labelled && <span className={css.jsonPunctuation}>:</span>}
                  {container ? containerHead(node, row.collapsed, selectedKey === row.key) : valueOf(node)}
                </div>
              )
            })}
          </div>
        )}
    </section>
  )
}

/** The decoded value for strings, the source text for everything else. */
function valueText(node: JsonNode): string {
  return node.kind === 'string' ? JSON.stringify(node.display) : node.display
}

function valueClass(node: JsonNode): string {
  if (node.kind === 'string') return css.jsonString ?? ''
  if (node.kind === 'number') return css.jsonNumber ?? ''
  if (node.kind === 'boolean' || node.kind === 'null') return css.jsonAtom ?? ''
  if (node.kind === 'unknown') return css.jsonInvalid ?? ''
  return css.jsonPunctuation ?? ''
}

function treeClass(split: boolean): string {
  return split ? `${css.jsonTree} ${css.jsonTreeSplit}` : css.jsonTree ?? ''
}
