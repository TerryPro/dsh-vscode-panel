/**
 * Pure Mermaid preview helpers: theme resolution, render fencing, source
 * inspection, and the zoom maths. Nothing here touches the DOM or imports the
 * Mermaid library, so every rule is unit-assertable in a plain Node process.
 */

/** The Mermaid themes this preview initializes the runtime with. */
export type MermaidTheme = 'default' | 'dark' | 'forest' | 'neutral' | 'base'

/** Debounce between the last keystroke and a re-render, in milliseconds. */
export const MERMAID_RENDER_DEBOUNCE_MS = 300

/** A guard so a runaway paste does not lock the browser in one render pass. */
export const MERMAID_MAX_SOURCE_CHARS = 100_000

/** Resolve the Mermaid theme that matches the shell's current appearance. */
export function resolveMermaidTheme(dark: boolean): MermaidTheme {
  return dark ? 'dark' : 'default'
}

/**
 * A monotonic token source that makes only the newest render win. Two renders
 * can be in flight (a slow diagram overtaken by a keystroke); each claims a
 * token and drops its result once a newer token exists.
 */
export interface RenderGuard {
  begin(): number
  isCurrent(token: number): boolean
}

export function createRenderGuard(): RenderGuard {
  let current = 0
  return {
    begin() {
      current += 1
      return current
    },
    isCurrent(token) {
      return token === current
    },
  }
}

/**
 * Detect a diagram's declared type from its first content line, skipping blank
 * lines, `%%` comments/directives and a leading `---` YAML front-matter block.
 * @param code - the Mermaid source.
 * @returns the type keyword (e.g. `flowchart`), or `''` when none is recognised.
 */
export function diagramTypeOf(code: string): string {
  const lines = String(code ?? '').split('\n')
  const trimmedAt = (index: number): string => lines[index]?.trim() ?? ''
  let index = 0
  while (index < lines.length && (trimmedAt(index) === '' || trimmedAt(index).startsWith('%%'))) index += 1
  if (index < lines.length && trimmedAt(index) === '---') {
    index += 1
    while (index < lines.length && trimmedAt(index) !== '---') index += 1
    index += 1
  }
  for (; index < lines.length; index += 1) {
    const line = trimmedAt(index)
    if (line === '' || line.startsWith('%%')) continue
    const match = line.match(
      /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|requirementDiagram|erDiagram|journey|gantt|pie|quadrantChart|xyChart|sankey|mindmap|timeline|packet|architecture|gitGraph)\b/u,
    )
    return match?.[1] ?? ''
  }
  return ''
}

/**
 * Pull a line number out of a Mermaid parse error, when it names one, so the
 * preview can point the reader at the offending source line.
 * @param message - the render error text.
 * @returns the 1-based line number, or `null` when the message carries none.
 */
export function extractErrorLine(message: string): number | null {
  const text = String(message ?? '')
  const match = text.match(/line\s+(\d+)/iu) ?? text.match(/\bL(\d+)\b/u)
  const value = match?.[1]
  return value === undefined ? null : Number(value)
}

/** Clamp a zoom factor to the usable band, rounded to two decimals. */
export function clampZoom(zoom: number): number {
  if (typeof zoom !== 'number' || !Number.isFinite(zoom)) return 1
  return Math.min(6, Math.max(0.25, Math.round(zoom * 100) / 100))
}

/**
 * A rendered SVG's intrinsic size from its `viewBox` (preferred) or its
 * width/height attributes — the numbers a fit-to-view needs, read before any
 * CSS scaling. Missing or garbage values fall back to 0 (→ no fit).
 * @returns the natural `{ width, height }`.
 */
export function svgNaturalSize(viewBox: string | null, width: string | null, height: string | null): { width: number; height: number } {
  const parts = String(viewBox ?? '').trim().split(/[\s,]+/u).map(Number)
  if (parts.length === 4 && parts.every(Number.isFinite) && (parts[2] ?? 0) > 0 && (parts[3] ?? 0) > 0) {
    return { width: parts[2] ?? 0, height: parts[3] ?? 0 }
  }
  const parsedWidth = Number.parseFloat(width ?? '') || 0
  const parsedHeight = Number.parseFloat(height ?? '') || 0
  return { width: parsedWidth, height: parsedHeight }
}

/**
 * The zoom that fits the whole diagram inside the available box (minus padding)
 * without overflowing EITHER dimension: the smaller of the width and height
 * ratios (contain). The binding dimension ends up exactly full; the other may
 * leave margin, but nothing spills past the pane, so a fitted diagram needs no
 * scrolling. Clamped to the usable band; falls back to 1 when either extent is
 * unmeasurable.
 * @returns a clamped zoom factor.
 */
export function fitScale(availableWidth: number, availableHeight: number, naturalWidth: number, naturalHeight: number, padding: number): number {
  const width = availableWidth - padding
  const height = availableHeight - padding
  if (!(naturalWidth > 0) || !(naturalHeight > 0) || width <= 0 || height <= 0) return 1
  return clampZoom(Math.min(width / naturalWidth, height / naturalHeight))
}
