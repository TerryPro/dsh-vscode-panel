/**
 * Graph view of a JSON/JSONC document: a canvas of value cards wired by labelled
 * edges, in the grammar JSON Crack made popular — one card per object or array,
 * one `key: value` row per member, a `+` / `−` control where a row points at
 * another card.
 *
 * It answers the question a list cannot: which value owns which, and where a
 * branch leads. Positions come from `buildGraphLayout` (pure, deterministic), so
 * the canvas only draws and transforms. Dragging pans, the wheel zooms around the
 * cursor, and the toolbar fits or rescales the whole document. Folding is stored
 * per file by document path, and a row still reveals its own text in the editor
 * when one is on screen.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  WheelEvent as ReactWheelEvent,
} from 'react'
import { EditorView } from '@codemirror/view'
import { copyTextToClipboard } from '../core/clipboard.ts'
import { readJsonCollapsed, saveJsonCollapsed } from './json-collapse.ts'
import { readJsonGrid, saveJsonGrid } from './json-split.ts'
import {
  buildGraphLayout,
  fitTransform,
  GRAPH_DETAIL_MAX_CHARS,
  GRAPH_MARGIN,
  GRAPH_ROW_HEIGHT,
  graphValueText,
  matchingCardIds,
  zoomAround,
  type GraphCard,
  type GraphEdge,
  type GraphRow,
} from './json-graph.ts'
import { isJsonViewRenderable, parseJsonDocument, type JsonNodeKind } from './json-parse.ts'
import { allContainerKeys, GRAPH_DEFAULT_EXPAND_DEPTH } from './json-graph.ts'
import css from './json.module.css'
import {
  IconCollapseAll16,
  IconCopyPath16,
  IconCopyValue16,
  IconExpandAll16,
  IconGrid16,
  IconMove16,
} from './JsonIcons.tsx'

/** User-facing copy the canvas needs, resolved by the caller from the locale. */
export interface JsonGraphLabels {
  /** Accessible name of the canvas, e.g. “JSON 结构图”. */
  graph: string
  empty: string
  invalid: string
  tooLarge: string
  truncated: (count: number) => ReactNode
  /** Shown instead of a canvas too large to read as a graph. */
  large: string
  search: string
  noMatches: string
  matches: (count: number) => ReactNode
  nextMatch: string
  /** Labels for the two buttons that open or close every branch at once. */
  expandAll: string
  collapseAll: string
  fit: string
  zoomIn: string
  zoomOut: string
  zoomReset: string
  copyValue: string
  copyPath: string
  copied: string
  copyFailed: string
  expandNode: string
  collapseNode: string
  showMore: (count: number) => ReactNode
  /** Heading of the panel that spells out the selected row in full. */
  selectedValue: string
  /** Shown when a value is too long for the panel to spell out entirely. */
  valueTruncated: (shown: number, total: number) => ReactNode
  /** Label for the toggle that lets a drag pan the canvas. */
  pan: string
  /** Label for the toggle that draws the canvas background grid. */
  grid: string
}

export interface JsonGraphProps {
  source: string
  /** Workspace path used to key persisted folding state. */
  path: string
  labels: JsonGraphLabels
  /** Editor to reveal a clicked row's text in; without one the rows only select. */
  view?: EditorView | null | undefined
  split?: boolean
  style?: CSSProperties
}

/** Cards drawn before the canvas gives up on readability. */
const GRAPH_MAX_CARDS = 500

/** Zoom factor per button press; the wheel steps finer than that. */
const ZOOM_STEP = 1.25
const WHEEL_STEP = 1.1

/** Pixels a press must travel before it is treated as a pan rather than a click. */
const PAN_THRESHOLD = 4

export function JsonGraph({ source, path, labels, view = null, split = false, style }: JsonGraphProps) {
  const renderable = useMemo(() => isJsonViewRenderable(source), [source])
  const parsed = useMemo(() => (renderable ? parseJsonDocument(source) : null), [renderable, source])
  const root = parsed?.root ?? null
  const presetCollapsed = useMemo(() => allContainerKeys(root, GRAPH_DEFAULT_EXPAND_DEPTH), [root])
  const [folded, setFolded] = useState<Set<string> | null>(() => readJsonCollapsed(path))
  const [revealed, setRevealed] = useState<ReadonlyMap<string, number>>(() => new Map())
  const [query, setQuery] = useState('')
  const [matchIndex, setMatchIndex] = useState(0)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [note, setNote] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [canvas, setCanvas] = useState({ x: GRAPH_MARGIN, y: GRAPH_MARGIN, scale: 1 })
  const [dragging, setDragging] = useState(false)
  const [panEnabled, setPanEnabled] = useState(true)
  const [grid, setGrid] = useState(readJsonGrid)
  const viewportRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{
    pointerX: number
    pointerY: number
    originX: number
    originY: number
    pointerId: number
    panning: boolean
  } | null>(null)
  const fittedRef = useRef(false)
  const collapsed = folded ?? presetCollapsed
  const layout = useMemo(() => buildGraphLayout(root, { collapsed, revealed }), [root, collapsed, revealed])
  const matches = useMemo(() => matchingCardIds(layout, query), [layout, query])
  const matchSet = useMemo(() => new Set(matches), [matches])
  const rowsByKey = useMemo(() => {
    const index = new Map<string, { row: GraphRow; card: GraphCard }>()
    for (const card of layout.cards) {
      for (const row of card.rows) if (!index.has(row.pathKey)) index.set(row.pathKey, { row, card })
    }
    return index
  }, [layout])
  const selected = selectedKey === null ? null : rowsByKey.get(selectedKey) ?? null
  const detail = useMemo(() => {
    if (selected === null) return null
    const full = graphValueText(selected.row, source)
    return {
      text: full.slice(0, GRAPH_DETAIL_MAX_CHARS),
      total: full.length,
      hidden: Math.max(0, full.length - GRAPH_DETAIL_MAX_CHARS),
    }
  }, [selected, source])
  const tooMany = layout.cards.length > GRAPH_MAX_CARDS

  const viewportSize = useCallback(() => {
    const rect = viewportRef.current?.getBoundingClientRect()
    return { width: rect?.width ?? 0, height: rect?.height ?? 0 }
  }, [])

  const fit = useCallback((): void => {
    setCanvas(fitTransform(layout, viewportSize()))
  }, [layout, viewportSize])

  const centerOn = useCallback((card: GraphCard): void => {
    const size = viewportSize()
    setCanvas(current => ({
      scale: current.scale,
      x: size.width / 2 - (card.x + card.width / 2) * current.scale,
      y: size.height / 2 - (card.y + card.height / 2) * current.scale,
    }))
  }, [viewportSize])

  // Fit once per opened document; re-parsing while typing must not move the view.
  useEffect(() => {
    if (fittedRef.current || layout.cards.length === 0) return
    fittedRef.current = true
    fit()
  }, [fit, layout.cards.length])

  const zoomFrom = useCallback((factor: number): void => {
    const size = viewportSize()
    setCanvas(current => zoomAround(current, { x: size.width / 2, y: size.height / 2 }, current.scale * factor))
  }, [viewportSize])

  const toggleGrid = useCallback((): void => {
    setGrid(current => {
      saveJsonGrid(!current)
      return !current
    })
  }, [])

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>): void => {
    const rect = viewportRef.current?.getBoundingClientRect()
    const point = { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) }
    setCanvas(current => zoomAround(current, point, current.scale * (event.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP)))
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || !panEnabled) return
    // Arm the gesture without capturing yet: capturing on pointerdown redirects the
    // derived `click` to the viewport, which would kill the fold control and the row
    // selection under the cursor. Capture happens once the press proves it is a drag.
    dragRef.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      originX: canvas.x,
      originY: canvas.y,
      pointerId: event.pointerId,
      panning: false,
    }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (drag === null) return
    const dx = event.clientX - drag.pointerX
    const dy = event.clientY - drag.pointerY
    if (!drag.panning) {
      if (Math.abs(dx) < PAN_THRESHOLD && Math.abs(dy) < PAN_THRESHOLD) return
      drag.panning = true
      setDragging(true)
      event.currentTarget.setPointerCapture?.(drag.pointerId)
    }
    setCanvas(current => ({ ...current, x: drag.originX + dx, y: drag.originY + dy }))
  }

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    dragRef.current = null
    if (drag === null) return
    if (drag.panning) event.currentTarget.releasePointerCapture?.(drag.pointerId)
    setDragging(false)
  }

  /** Record a folding change, so the canvas reopens the way the reader left it. */
  const applyCollapsed = useCallback((next: Set<string>): void => {
    setFolded(next)
    saveJsonCollapsed(path, next)
  }, [path])

  const toggleRow = useCallback((row: GraphRow): void => {
    if (row.childId === null) return
    const next = new Set(collapsed)
    if (next.has(row.childId)) next.delete(row.childId)
    else next.add(row.childId)
    applyCollapsed(next)
  }, [applyCollapsed, collapsed])

  const revealMore = useCallback((cardId: string): void => {
    setRevealed(current => {
      const next = new Map(current)
      next.set(cardId, (next.get(cardId) ?? 0) + 1)
      return next
    })
  }, [])

  const revealInEditor = useCallback((row: GraphRow): void => {
    if (view === null) return
    view.dispatch({
      selection: { anchor: row.start, head: row.end },
      effects: EditorView.scrollIntoView(row.start, { y: 'center' }),
      userEvent: 'select',
    })
  }, [view])

  const activateRow = useCallback((row: GraphRow): void => {
    setSelectedKey(row.pathKey)
    revealInEditor(row)
  }, [revealInEditor])

  const stepMatch = useCallback((delta: number): void => {
    if (matches.length === 0) return
    const next = (matchIndex + delta + matches.length) % matches.length
    setMatchIndex(next)
    const target = matches[next]
    const card = layout.cards.find(candidate => candidate.id === target)
    if (card !== undefined) centerOn(card)
  }, [centerOn, layout.cards, matchIndex, matches])

  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    stepMatch(event.shiftKey ? -1 : 1)
  }

  const copy = useCallback(async (kind: 'value' | 'path'): Promise<void> => {
    if (selected === null) return
    const row = selected.row
    const text = kind === 'path' ? row.pathKey : graphValueText(row, source)
    try {
      await copyTextToClipboard(text)
      setNote({ kind: 'ok', text: labels.copied })
    } catch {
      setNote({ kind: 'error', text: labels.copyFailed })
    }
  }, [labels.copied, labels.copyFailed, selected, source])

  const surfaceClass = split ? `${css.graph} ${css.graphSplit}` : css.graph ?? ''
  const filtering = query.trim() !== ''
  if (!renderable) {
    return (
      <section className={surfaceClass} style={style} aria-label={labels.graph}>
        <p className={css.jsonNote}>{labels.tooLarge}</p>
      </section>
    )
  }

  return (
    <section className={surfaceClass} style={style} aria-label={labels.graph}>
      <div className={css.jsonToolbar}>
        <input
          className={css.jsonSearch}
          type="search"
          aria-label={labels.search}
          placeholder={labels.search}
          value={query}
          onChange={event => { setQuery(event.target.value); setMatchIndex(0) }}
          onKeyDown={onSearchKeyDown}
        />
        <button type="button" className={css.jsonAction} disabled={matches.length === 0} aria-label={labels.nextMatch} title={labels.nextMatch} onClick={() => { stepMatch(1) }}>↵</button>
        <button type="button" className={css.jsonIconButton} aria-label={labels.expandAll} title={labels.expandAll} onClick={() => { applyCollapsed(new Set()) }}><IconExpandAll16 /></button>
        <button type="button" className={css.jsonIconButton} aria-label={labels.collapseAll} title={labels.collapseAll} onClick={() => { applyCollapsed(allContainerKeys(root, 1)) }}><IconCollapseAll16 /></button>
        <button type="button" className={css.jsonIconButton} disabled={selected === null} aria-label={labels.copyValue} title={labels.copyValue} onClick={() => { void copy('value') }}><IconCopyValue16 /></button>
        <button type="button" className={css.jsonIconButton} disabled={selected === null} aria-label={labels.copyPath} title={labels.copyPath} onClick={() => { void copy('path') }}><IconCopyPath16 /></button>
        {filtering && <span className={css.jsonCount}>{matches.length === 0 ? labels.noMatches : labels.matches(matches.length)}</span>}
      </div>
      {(parsed?.errors.length ?? 0) > 0 && <p className={`${css.jsonNote} ${css.jsonNoteError}`}>{labels.invalid}</p>}
      {parsed !== null && parsed.truncated && <p className={css.jsonNote}>{labels.truncated(parsed.totalNodes)}</p>}
      {note !== null && <p className={note.kind === 'error' ? `${css.jsonNote} ${css.jsonNoteError}` : css.jsonNote}>{note.text}</p>}
      {layout.cards.length === 0
        ? <p className={css.jsonEmpty}>{labels.empty}</p>
        : tooMany
          ? <p className={css.jsonEmpty}>{labels.large}</p>
          : (
            <div
              ref={viewportRef}
              className={`${css.graphViewport} ${grid ? css.graphViewportGrid : ''} ${panEnabled ? css.graphViewportPan : ''}`}
              data-viewport="1"
              data-dragging={dragging ? '1' : undefined}
              onWheel={onWheel}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            >
              <div
                className={css.graphCanvas}
                data-canvas="1"
                style={{
                  transform: `translate(${canvas.x}px, ${canvas.y}px) scale(${canvas.scale})`,
                  width: layout.width,
                  height: layout.height,
                }}
              >
                <svg className={css.graphEdges} width={layout.width} height={layout.height} aria-hidden="true">
                  {layout.edges.map(edge => (
                    <path
                      key={edge.id}
                      d={edgePath(edge)}
                      className={edgeTouches(edge, selected?.card.id) ? `${css.graphEdge} ${css.graphEdgeLit}` : css.graphEdge}
                    />
                  ))}
                </svg>
                {layout.cards.map(card => (
                  <div
                    key={card.id}
                    className={`${css.graphCard} ${matchSet.has(card.id) ? css.graphCardMatch : ''}`}
                    style={{ left: card.x, top: card.y, width: card.width }}
                    data-card={card.id}
                  >
                    {card.rows.map(row => row.moreFor === null ? renderRow(row, selectedKey, labels, source, activateRow, toggleRow) : (
                      <div key={row.pathKey} className={css.graphRow}>
                        <span className={css.graphSpacer} aria-hidden="true" />
                        <button type="button" className={css.graphMore} onClick={() => { revealMore(card.id) }}>{labels.showMore(row.hidden)}</button>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
              {/* The bar floats over the canvas but never starts a pan. */}
              <div className={css.jsonZoomBar} role="group" aria-label={labels.graph} onPointerDown={event => { event.stopPropagation() }}>
                <button type="button" className={css.jsonZoomButton} aria-pressed={grid} title={labels.grid} aria-label={labels.grid} onClick={toggleGrid}><IconGrid16 /></button>
                <button type="button" className={css.jsonZoomButton} aria-pressed={panEnabled} title={labels.pan} aria-label={labels.pan} onClick={() => { setPanEnabled(value => !value) }}><IconMove16 /></button>
                <button type="button" className={css.jsonZoomButton} aria-label={labels.zoomOut} title={labels.zoomOut} onClick={() => { zoomFrom(1 / ZOOM_STEP) }}>−</button>
                <button type="button" className={css.jsonZoomPercent} aria-label={labels.zoomReset} title={labels.zoomReset} onClick={() => { setCanvas(current => ({ ...current, scale: 1 })) }}>{`${Math.round(canvas.scale * 100)}%`}</button>
                <button type="button" className={css.jsonZoomButton} aria-label={labels.fit} title={labels.fit} onClick={fit}>⤢</button>
                <button type="button" className={css.jsonZoomButton} aria-label={labels.zoomIn} title={labels.zoomIn} onClick={() => { zoomFrom(ZOOM_STEP) }}>+</button>
              </div>
            </div>
          )}
      {/* A card row clips its own text; the panel below spells out what was chosen. */}
      {selected !== null && detail !== null && (
        <div className={css.jsonInspector}>
          <div className={css.jsonInspectorHead}>
            <span className={css.jsonInspectorTitle}>{labels.selectedValue}</span>
            <code className={css.jsonInspectorPath}>{selected.row.pathKey}</code>
          </div>
          <pre className={css.jsonInspectorValue}>{detail.text}</pre>
          {detail.hidden > 0 && <p className={css.jsonInspectorNote}>{labels.valueTruncated(GRAPH_DETAIL_MAX_CHARS, detail.total)}</p>}
        </div>
      )}
    </section>
  )
}

/** One member row: fold control, key, and the value or the container's count. */
function renderRow(
  row: GraphRow,
  selectedKey: string | null,
  labels: JsonGraphLabels,
  source: string,
  activate: (row: GraphRow) => void,
  toggle: (row: GraphRow) => void,
): ReactNode {
  const full = graphValueText(row, source)
  return (
    <div
      className={`${css.graphRow} ${selectedKey === row.pathKey ? css.graphRowSelected : ''}`}
      data-row={row.pathKey}
      data-kind={row.kind}
      title={full}
      onClick={() => { activate(row) }}
    >
      {row.collapsible
        ? (
          <button
            type="button"
            className={css.graphToggle}
            aria-label={row.collapsed ? labels.expandNode : labels.collapseNode}
            aria-expanded={!row.collapsed}
            onClick={event => { event.stopPropagation(); toggle(row) }}
          >
            {row.collapsed ? '+' : '−'}
          </button>
        )
        : <span className={css.graphSpacer} aria-hidden="true" />}
      {row.key !== null && <span className={css.graphKey}>{row.key}</span>}
      {row.key !== null && <span className={css.graphCount}>:</span>}
      <span className={`${css.graphValue} ${valueClass(row.kind)}`}>{row.text}</span>
    </div>
  )
}

function valueClass(kind: JsonNodeKind): string {
  if (kind === 'string') return css.jsonString ?? ''
  if (kind === 'number') return css.jsonNumber ?? ''
  if (kind === 'boolean' || kind === 'null') return css.jsonAtom ?? ''
  if (kind === 'unknown') return css.jsonInvalid ?? ''
  return css.graphCount ?? ''
}

/** Cubic wire from a member row to the card it points at. */
function edgePath(edge: GraphEdge): string {
  const bend = Math.max(GRAPH_ROW_HEIGHT, (edge.x2 - edge.x1) / 2)
  return `M ${edge.x1} ${edge.y1} C ${edge.x1 + bend} ${edge.y1}, ${edge.x2 - bend} ${edge.y2}, ${edge.x2} ${edge.y2}`
}

function edgeTouches(edge: GraphEdge, cardId: string | undefined | null): boolean {
  return cardId != null && (edge.from === cardId || edge.to === cardId)
}
