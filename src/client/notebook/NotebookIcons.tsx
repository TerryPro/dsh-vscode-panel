/** Notebook toolbar and cell icons, following DSH's outlined stroke system. */

interface IconProps {
  size?: number
}

function svgProps(size: number) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.3,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true as const,
  }
}

/** Run this cell: a play triangle, the notebook's primary verb. */
export function IconRunCell16({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M5.5 3.5 11.5 8l-6 4.5z" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** Run all: a play triangle with a leading bar, so it reads as "from the top". */
export function IconRunAll16({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M3 4v8" />
      <path d="M6 4.5 11 8l-5 3.5z" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** Interrupt: a filled square, the universal stop glyph. */
export function IconInterrupt16({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <rect x="4.5" y="4.5" width="7" height="7" rx="1" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** Clear all outputs: a broom over a baseline. */
export function IconClearOutputs16({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M9 3.5 12.5 7" />
      <path d="M8 6.5 10.5 9 6 13.5 2.5 10z" />
      <path d="M11 12.5h3" />
    </svg>
  )
}

/** Add a code cell: a plus, the notebook's own "new cell" mark. */
export function IconAddCode16({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M8 3v10M3 8h10" />
    </svg>
  )
}

/**
 * Add a Markdown cell: a plus beside the Markdown mark itself (an M and a down arrow).
 *
 * The paragraph lines it replaces read as "plain text", which is what the cell is not —
 * Markdown is a markup language the cell renders, and the M↓ glyph is the one readers
 * already recognise from every other Markdown surface.
 */
export function IconAddMarkdown16({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M1 8h5M3.5 5.5v5" />
      <path d="M7.3 11.5v-5l1.8 2.2 1.8-2.2v5" />
      <path d="M13.7 6.5v5m0 0-1-1.3m1 1.3 1-1.3" />
    </svg>
  )
}

/**
 * Save the notebook: the floppy outline the workbench already uses for the verb.
 *
 * A notebook's toolbar otherwise holds only run and cell actions, so the one thing a
 * reader reaches for after a run — writing the outputs they can see back to the file —
 * had no visible control at all.
 */
export function IconSave16({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M3 2.5h8l2.5 2.5v8.5H3z" />
      <path d="M5.5 2.5v4h5v-4" />
      <path d="M5 9.5h6v4.5H5z" />
    </svg>
  )
}

/** Move a cell up. */
export function IconMoveUp16({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7" />
    </svg>
  )
}

/** Move a cell down. */
export function IconMoveDown16({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M8 3.5v9M4.5 9 8 12.5 11.5 9" />
    </svg>
  )
}

/** Delete a cell: the trash outline used across the workbench's row actions. */
export function IconDeleteCell16({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M3 4.5h10" />
      <path d="M6 4.5V3h4v1.5" />
      <path d="M4.5 4.5 5 13h6l.5-8.5" />
    </svg>
  )
}

/** Edit a text cell: a pencil, the same verb the workbench names elsewhere. */
export function IconEditCell16({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M11.4 2.9 13.1 4.6 5.4 12.3l-2.4.7.7-2.4z" />
      <path d="M10.1 4.2 11.8 5.9" />
    </svg>
  )
}

/** Show a text cell rendered: an eye, the preview verb used across the workbench. */
export function IconRenderCell16({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M1.8 8S4 4.3 8 4.3 14.2 8 14.2 8 12 11.7 8 11.7 1.8 8 1.8 8z" />
      <circle cx="8" cy="8" r="1.6" />
    </svg>
  )
}

/** Restart the kernel: a circular arrow. */
export function IconRestartKernel16({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M13 8a5 5 0 1 1-1.6-3.7" />
      <path d="M13 2.5V5h-2.5" />
    </svg>
  )
}

/**
 * Connect: a plug being inserted into a socket. Two flat prongs on the left, a rounded
 * barrel on the right, so a reader recognises it as "this opens a handle" the same way
 * they would on a power strip. Deliberately not a link / chain (the same trap SSH clients
 * fall into, where a "connect" icon reads as "navigate to" instead).
 */
export function IconConnect16({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      {/* Prongs on the left, two short verticals. */}
      <path d="M2.5 5.5v2" />
      <path d="M5 5.5v2" />
      {/* Cable / barrel between the prongs and the plug head. */}
      <path d="M2.5 6.5h2.5v2.5a2 2 0 0 0 2 2h0" />
      {/* Plug head: a rounded body with the lead-in arc showing it about to seat. */}
      <path d="M7 7.5h4.2" />
      <path d="M11.2 6 13.5 8l-2.3 2" />
    </svg>
  )
}

/**
 * Disconnect: the connect plug, with a diagonal stroke through it. The stroke sits on
 * top, not under, so the slashed state reads as the live one when the handle is open
 * and the reader is about to close it. The slash starts on the upper-left and ends on
 * the lower-right — the same convention the workbench's other "off" states use.
 */
export function IconDisconnect16({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M2.5 5.5v2" />
      <path d="M5 5.5v2" />
      <path d="M2.5 6.5h2.5v2.5a2 2 0 0 0 2 2h0" />
      <path d="M7 7.5h4.2" />
      <path d="M11.2 6 13.5 8l-2.3 2" />
      {/* The slash: clearly on top, from upper-left to lower-right corner. */}
      <path d="M2.5 2.5 13.5 13.5" />
    </svg>
  )
}

/** Stop the kernel: a power symbol, distinct from the cell's square stop. */
export function IconStopKernel16({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M8 2.5v5" />
      <path d="M4.8 4.4a4.5 4.5 0 1 0 6.4 0" />
    </svg>
  )
}

/**
 * The cell's overflow menu: three dots, the workbench's "more actions" verb.
 *
 * A cell has seven row buttons already and this ticket adds three more, so the
 * structural edits live behind one control rather than crowding the row.
 */
export function IconCellMenu16({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <circle cx="3.6" cy="8" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="12.4" cy="8" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  )
}

/**
 * Restart & Run All: the restart ring the toolbar already draws, with a play triangle
 * inside it.
 *
 * Deliberately neither glyph the toolbar shows on its own, because the command is neither:
 * pressing it throws away the namespace *and* recomputes every cell, so a reader must not
 * mistake it for one of the two buttons they already know. The arc is copied from
 * `IconRestartKernel16` rather than recomputed, so the ring cannot be drawn off-centre or
 * outside the viewBox.
 */
export function IconRestartRunAll16({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M13 8a5 5 0 1 1-1.6-3.7" />
      <path d="M13 2.5V5h-2.5" />
      <path d="M6.9 6.1 9.9 8l-3 1.9z" fill="currentColor" stroke="none" />
    </svg>
  )
}

/**
 * Fold / unfold a cell: a chevron that points down when the body is showing and right
 * when it is folded away.
 *
 * It sits in the cell header's always-visible strip rather than the action row, because
 * the action row only appears on hover or focus — and a fold control that hides itself
 * when there is nothing on screen to reveal it would trap the reader in a collapsed cell.
 */
export function IconFold16({ size = 14, expanded = true }: IconProps & { expanded?: boolean }) {
  return (
    <svg {...svgProps(size)}>
      {expanded ? <path d="M4.5 6.3 8 9.8l3.5-3.5" /> : <path d="M6.3 4.5 9.8 8l-3.5 3.5" />}
    </svg>
  )
}
