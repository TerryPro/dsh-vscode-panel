/**
 * Live Mermaid diagram preview: renders the source to SVG through the lazily
 * imported runtime, debounced and fenced so only the newest render wins.
 *
 * This is a presentational leaf — it owns no file state. The workbench editor
 * passes the open file's draft as `source`; editing, saving, dirty tracking and
 * external-change reconciliation all stay with the shared file-tab machinery.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import {
  clampZoom,
  createRenderGuard,
  extractErrorLine,
  fitScale,
  MERMAID_MAX_SOURCE_CHARS,
  MERMAID_RENDER_DEBOUNCE_MS,
  resolveMermaidTheme,
  svgNaturalSize,
} from './mermaid-render.ts'
import { loadMermaidRuntime, renderMermaidDiagram, shellIsDark } from './mermaid-loader.ts'
import css from './mermaid.module.css'

/** User-facing copy the preview needs, resolved by the caller from the locale. */
export interface MermaidPreviewLabels {
  /** Shown while the runtime bundle is being imported for the first time. */
  loading: string
  /** Shown when the runtime bundle cannot be loaded (e.g. not built). */
  missing: string
  /** Title shown when a diagram fails to parse or render. */
  renderError: string
  /** Shown for an empty source with nothing to draw. */
  empty: string
  /** Prefix for the offending source line in a render error title. */
  line: string
  zoomIn: string
  zoomOut: string
  zoomFit: string
  zoomReset: string
  /** Label for the toggle that lets the reader drag the diagram to pan it. */
  pan: string
}

export interface MermaidPreviewProps {
  /** The Mermaid source text; re-rendered (debounced) whenever it changes. */
  source: string
  labels: MermaidPreviewLabels
  /** True when shown beside the source editor in split mode; draws a divider. */
  split?: boolean
  /** Inline style merged on the root, used to size the pane in a split row. */
  style?: CSSProperties
}

type RuntimeStatus = 'loading' | 'ready' | 'missing'

export function MermaidPreview({ source, labels, split = false, style }: MermaidPreviewProps) {
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus>('loading')
  const [svg, setSvg] = useState('')
  const [error, setError] = useState('')
  const [rendering, setRendering] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [themeNonce, setThemeNonce] = useState(0)
  const [panEnabled, setPanEnabled] = useState(false)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [panDragging, setPanDragging] = useState(false)

  const scrollRef = useRef<HTMLDivElement>(null)
  const svgHostRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const didFitRef = useRef(false)
  const zoomRef = useRef(1)
  zoomRef.current = zoom
  const panDragRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null)
  const guard = useMemo(createRenderGuard, [])

  // Load the shared runtime once; the status gates rendering and drives the
  // "runtime unavailable" copy when the bundle cannot be imported.
  useEffect(() => {
    let alive = true
    loadMermaidRuntime(resolveMermaidTheme(shellIsDark()))
      .then(() => { if (alive) setRuntimeStatus('ready') })
      .catch(() => { if (alive) setRuntimeStatus('missing') })
    return () => { alive = false }
  }, [])

  // Re-tune and redraw when the shell flips light/dark. The theme can move via an
  // attribute, a class, or inline token overrides on either <html> or <body>, so
  // watch all three signals on both nodes (the terminal re-reads tokens on style).
  useEffect(() => {
    if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return undefined
    const observer = new MutationObserver(() => { setThemeNonce(value => value + 1) })
    const watch: MutationObserverInit = { attributes: true, attributeFilter: ['data-ds-dark-theme', 'class', 'style'] }
    observer.observe(document.documentElement, watch)
    observer.observe(document.body, watch)
    return () => { observer.disconnect() }
  }, [])

  // Debounced render of the current source; the newest render wins over any in flight.
  useEffect(() => {
    if (runtimeStatus !== 'ready') return undefined
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    if (source.trim() === '') {
      guard.begin()
      setSvg('')
      setError('')
      setRendering(false)
      return undefined
    }
    setRendering(true)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      const token = guard.begin()
      if (source.length > MERMAID_MAX_SOURCE_CHARS) {
        setSvg('')
        setError(`source exceeds ${MERMAID_MAX_SOURCE_CHARS} characters`)
        setRendering(false)
        return
      }
      renderMermaidDiagram(shellIsDark(), source)
        .then((result) => {
          if (!guard.isCurrent(token)) return
          setSvg(result)
          setError('')
          setRendering(false)
        })
        .catch((caught: unknown) => {
          if (!guard.isCurrent(token)) return
          setSvg('')
          setError(caught instanceof Error ? caught.message : String(caught))
          setRendering(false)
        })
    }, MERMAID_RENDER_DEBOUNCE_MS)
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [source, runtimeStatus, themeNonce, guard])

  const fitToView = useCallback((): void => {
    setPan({ x: 0, y: 0 })
    const scroll = scrollRef.current
    const element = svgHostRef.current?.querySelector('svg') ?? null
    if (scroll === null || element === null) {
      setZoom(1)
      return
    }
    // Measure the real rendered size (undoing the current zoom) rather than
    // trusting the viewBox, so a residual inline max-width cannot make fit lie.
    const rect = element.getBoundingClientRect()
    const current = zoomRef.current || 1
    let naturalWidth = rect.width / current
    let naturalHeight = rect.height / current
    if (!(naturalWidth > 0) || !(naturalHeight > 0)) {
      const natural = svgNaturalSize(element.getAttribute('viewBox'), element.getAttribute('width'), element.getAttribute('height'))
      naturalWidth = natural.width
      naturalHeight = natural.height
    }
    setZoom(fitScale(scroll.clientWidth, scroll.clientHeight, naturalWidth, naturalHeight, 32))
  }, [])

  // Fit the whole diagram once, the first time it renders for this file.
  useEffect(() => {
    if (svg !== '' && error === '' && !didFitRef.current) {
      didFitRef.current = true
      fitToView()
    }
  }, [svg, error, fitToView])

  // Ctrl/⌘ + wheel zooms the canvas; non-passive so it can cancel page scroll.
  useEffect(() => {
    const scroll = scrollRef.current
    if (scroll === null) return undefined
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      setZoom(value => clampZoom(value + (event.deltaY < 0 ? 0.25 : -0.25)))
    }
    scroll.addEventListener('wheel', onWheel, { passive: false })
    return () => { scroll.removeEventListener('wheel', onWheel) }
  }, [runtimeStatus])

  const hasSvg = svg !== '' && error === '' && runtimeStatus === 'ready'
  const errorLine = error === '' ? null : extractErrorLine(error)

  const togglePan = (): void => {
    const next = !panEnabled
    setPanEnabled(next)
    if (!next) setPan({ x: 0, y: 0 })
  }
  const onPanPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!panEnabled || event.button !== 0) return
    panDragRef.current = { x: event.clientX, y: event.clientY, px: pan.x, py: pan.y }
    event.currentTarget.setPointerCapture?.(event.pointerId)
    setPanDragging(true)
  }
  const onPanPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = panDragRef.current
    if (drag === null) return
    setPan({ x: drag.px + (event.clientX - drag.x), y: drag.py + (event.clientY - drag.y) })
  }
  const onPanPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (panDragRef.current === null) return
    panDragRef.current = null
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    setPanDragging(false)
  }

  return (
    <div className={split ? `${css.mermaidPreview} ${css.mermaidPreviewSplit}` : css.mermaidPreview} data-mermaid-preview="" style={style}>
      <div
        ref={scrollRef}
        className={panEnabled ? `${css.mermaidScroll} ${css.mermaidScrollPan}` : css.mermaidScroll}
        data-dragging={panDragging ? 'true' : undefined}
        onDoubleClick={() => { if (hasSvg) fitToView() }}
        onPointerDown={onPanPointerDown}
        onPointerMove={onPanPointerMove}
        onPointerUp={onPanPointerUp}
        onPointerCancel={onPanPointerUp}
      >
        <div className={css.mermaidStage} style={panEnabled ? { transform: `translate(${pan.x}px, ${pan.y}px)` } : undefined}>
          {runtimeStatus === 'missing'
            ? <p className={css.mermaidMessage} role="alert">{labels.missing}</p>
            : error !== ''
              ? (
                <div className={css.mermaidError} role="alert">
                  <div className={css.mermaidErrorTitle}>
                    {errorLine === null ? labels.renderError : `${labels.renderError} · ${labels.line} ${errorLine}`}
                  </div>
                  <pre className={css.mermaidErrorBody}>{error}</pre>
                </div>
              )
              : hasSvg
                ? <div ref={svgHostRef} className={css.mermaidSvg} style={{ zoom }} dangerouslySetInnerHTML={{ __html: svg }} />
                : <p className={css.mermaidMessage}>{runtimeStatus === 'loading' ? labels.loading : labels.empty}</p>}
        </div>
      </div>
      {rendering && <div className={css.mermaidBusy} aria-hidden="true"><span className={css.mermaidSpinner} /></div>}
      {hasSvg && (
        <div className={css.mermaidZoomBar}>
          <button type="button" className={css.mermaidZoomButton} title={labels.pan} aria-label={labels.pan} aria-pressed={panEnabled} onClick={togglePan}><IconMove16 /></button>
          <button type="button" className={css.mermaidZoomButton} title={labels.zoomOut} aria-label={labels.zoomOut} onClick={() => { setZoom(value => clampZoom(value - 0.25)) }}>−</button>
          <button type="button" className={css.mermaidZoomPercent} title={labels.zoomReset} aria-label={labels.zoomReset} onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }) }}>{`${Math.round(zoom * 100)}%`}</button>
          <button type="button" className={css.mermaidZoomButton} title={labels.zoomFit} aria-label={labels.zoomFit} onClick={fitToView}>⤢</button>
          <button type="button" className={css.mermaidZoomButton} title={labels.zoomIn} aria-label={labels.zoomIn} onClick={() => { setZoom(value => clampZoom(value + 0.25)) }}>+</button>
        </div>
      )}
    </div>
  )
}

/** A four-way move glyph marking the drag-to-pan toggle. */
function IconMove16() {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2.5v11M2.5 8h11M8 2.5 6.2 4.3M8 2.5l1.8 1.8M8 13.5l-1.8-1.8M8 13.5l1.8-1.8M2.5 8l1.8-1.8M2.5 8l1.8 1.8M13.5 8l-1.8-1.8M13.5 8l-1.8 1.8" />
    </svg>
  )
}
