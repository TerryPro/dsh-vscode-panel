/**
 * ANSI text to safe inline markup for kernel output.
 *
 * Jupyter tracebacks and `rich` / `colorama` output arrive as ANSI escape text,
 * which is why an ipykernel traceback looks correct in a terminal and shows raw
 * control-code noise in a plain `pre`. Rather than pull in an ANSI renderer, this
 * translates the small SGR subset kernels actually emit into `span` elements and
 * escapes everything else. The result is HTML the output view renders directly, so
 * the escaping here is a security boundary, not a convenience.
 */

/** SGR foreground codes mapped to the terminal 16 palette. */
const FOREGROUND: Record<number, string> = {
  30: 'var(--dsh-ansi-black, #4e4e4e)',
  31: 'var(--dsh-ansi-red, #c23b22)',
  32: 'var(--dsh-ansi-green, #3f9b0b)',
  33: 'var(--dsh-ansi-yellow, #b98a00)',
  34: 'var(--dsh-ansi-blue, #3a6ea8)',
  35: 'var(--dsh-ansi-magenta, #a150a1)',
  36: 'var(--dsh-ansi-cyan, #2f8a8a)',
  37: 'var(--dsh-ansi-white, #cccccc)',
  90: 'var(--dsh-ansi-bright-black, #6f6f6f)',
  91: 'var(--dsh-ansi-bright-red, #e2563c)',
  92: 'var(--dsh-ansi-bright-green, #64c229)',
  93: 'var(--dsh-ansi-bright-yellow, #e0c400)',
  94: 'var(--dsh-ansi-bright-blue, #6fa8dc)',
  95: 'var(--dsh-ansi-bright-magenta, #d070d0)',
  96: 'var(--dsh-ansi-bright-cyan, #56c2c2)',
  97: 'var(--dsh-ansi-bright-white, #ffffff)',
}

const BACKGROUND: Record<number, string> = {
  40: 'var(--dsh-ansi-bg-black, #000000)',
  41: 'var(--dsh-ansi-bg-red, #7a1f12)',
  42: 'var(--dsh-ansi-bg-green, #1f5c05)',
  43: 'var(--dsh-ansi-bg-yellow, #6b4f00)',
  44: 'var(--dsh-ansi-bg-blue, #12365c)',
  45: 'var(--dsh-ansi-bg-magenta, #5c1f5c)',
  46: 'var(--dsh-ansi-bg-cyan, #0f4d4d)',
  47: 'var(--dsh-ansi-bg-white, #b0b0b0)',
}

const BASE16: readonly string[] = [
  '#000000', '#800000', '#008000', '#808000', '#000080', '#800080', '#008080', '#c0c0c0',
  '#808080', '#ff0000', '#00ff00', '#ffff00', '#0000ff', '#ff00ff', '#00ffff', '#ffffff',
]

/**
 * The shell's own default pair, used when reverse video is set with no explicit
 * colour. Reverse video swaps them: the text takes the shell's background and the block
 * takes its text colour, which inverts cleanly in either theme.
 *
 * These are the shell's foreground and background rather than the ANSI `black`/`white`
 * slots, because a fixed grey vanishes against one of the two base colours — which is
 * what made a bare `ESC[7m` header unreadable in the light theme.
 */
const DEFAULT_FOREGROUND = 'var(--dsw-alias-bg-base, #ffffff)'
const DEFAULT_BACKGROUND = 'var(--dsw-alias-label-primary, #1f2329)'

export interface AnsiStyleState {
  color: string | null
  background: string | null
  bold: boolean
  faint: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  inverse: boolean
}

function emptyStyle(): AnsiStyleState {
  return {
    color: null,
    background: null,
    bold: false,
    faint: false,
    italic: false,
    underline: false,
    strike: false,
    inverse: false,
  }
}

export function escapeHtmlText(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.trunc(value)))
}

/** Map a 256-palette index to a colour, for the extended `38;5;n` form. */
export function ansi256Color(index: number): string {
  const value = clampByte(index)
  if (value < 16) return BASE16[value] ?? '#000000'
  const levels = [0, 95, 135, 175, 215, 255] as const
  if (value < 232) {
    const offset = value - 16
    return `rgb(${levels[Math.floor(offset / 36) % 6] ?? 0},${levels[Math.floor(offset / 6) % 6] ?? 0},${levels[offset % 6] ?? 0})`
  }
  const gray = 8 + (value - 232) * 10
  return `rgb(${gray},${gray},${gray})`
}

/** Apply one SGR parameter list to the running style state. */
function applySgr(style: AnsiStyleState, parameters: readonly number[]): AnsiStyleState {
  if (parameters.length === 0 || parameters.includes(0)) return emptyStyle()
  const next: AnsiStyleState = { ...style }
  for (let index = 0; index < parameters.length; index += 1) {
    const code = parameters[index] ?? 0
    if (code === 1) next.bold = true
    else if (code === 3) next.italic = true
    else if (code === 4) next.underline = true
    else if (code === 7) next.inverse = true
    else if (code === 9) next.strike = true
    else if (code === 2) next.faint = true
    else if (code === 22) { next.bold = false; next.faint = false }
    else if (code === 23) next.italic = false
    else if (code === 24) next.underline = false
    else if (code === 27) next.inverse = false
    else if (code === 29) next.strike = false
    else if (code === 39) next.color = null
    else if (code === 49) next.background = null
    else if (code === 38 || code === 48) {
      const mode = parameters[index + 1]
      if (mode === 5) {
        const color = ansi256Color(parameters[index + 2] ?? 0)
        if (code === 38) next.color = color
        else next.background = color
        index += 2
      } else if (mode === 2) {
        const color = `rgb(${clampByte(parameters[index + 2] ?? 0)},${clampByte(parameters[index + 3] ?? 0)},${clampByte(parameters[index + 4] ?? 0)})`
        if (code === 38) next.color = color
        else next.background = color
        index += 4
      }
    } else if (FOREGROUND[code] !== undefined) next.color = FOREGROUND[code] ?? null
    else if (BACKGROUND[code] !== undefined) next.background = BACKGROUND[code] ?? null
  }
  return next
}

function styleAttributes(style: AnsiStyleState): string {
  const declarations: string[] = []
  // Reverse video swaps the two colours. With no explicit foreground the swap still
  // has to produce a background, or a progress bar that writes ESC[7;42m would show
  // plain text where the terminal shows a highlighted block.
  const color = style.inverse ? (style.background ?? DEFAULT_FOREGROUND) : style.color
  const background = style.inverse ? (style.color ?? DEFAULT_BACKGROUND) : style.background
  if (color !== null) declarations.push(`color:${color}`)
  if (background !== null) declarations.push(`background:${background}`)
  if (style.bold) declarations.push('font-weight:700')
  if (style.faint) declarations.push('opacity:.55')
  if (style.italic) declarations.push('font-style:italic')
  const decoration = [style.underline ? 'underline' : '', style.strike ? 'line-through' : '']
    .filter(Boolean)
    .join(' ')
  if (decoration !== '') declarations.push(`text-decoration:${decoration}`)
  return declarations.length === 0 ? '' : ` style="${declarations.join(';')}"`
}

function styleSpan(text: string, style: AnsiStyleState): string {
  const escaped = escapeHtmlText(text)
  const attributes = styleAttributes(style)
  return attributes === '' ? escaped : `<span${attributes}>${escaped}</span>`
}

/**
 * CSI sequences: SGR (`m`) becomes markup, any other is consumed so a cursor or
 * erase sequence cannot corrupt the render. OSC hyperlinks and lone escapes are
 * dropped rather than rendered, because kernel text is not an authoring surface.
 */
const ESCAPE_PATTERN = new RegExp([
  '\\u001B\\[[0-9;?]*m',
  '\\u001B\\[[0-9;?]*[A-Za-z@`]',
  '\\u001B\\][^\\u0007\\u001B]*(?:\\u0007|\\u001B\\\\)',
  '\\u001B[@-Z\\\\-_]',
].join('|'), 'gu')

/**
 * A truncated escape at the very end of a chunk: an incomplete CSI parameter run, or
 * an unterminated OSC string. Stream frames split anywhere, so a sequence can
 * straddle two renders; the fragment is dropped rather than shown, because its
 * meaning is unknowable without the bytes that follow.
 */
const TRAILING_ESCAPE = new RegExp([
  '\\u001B\\[[0-9;?]*$',
  '\\u001B\\][^\\u0007\\u001B]*$',
  '\\u001B$',
].join('|'), 'u')

/** Convert ANSI-styled kernel text to escaped, styled HTML. */
export function ansiToHtml(value: string): string {
  let html = ''
  let style = emptyStyle()
  let cursor = 0
  ESCAPE_PATTERN.lastIndex = 0
  for (let match = ESCAPE_PATTERN.exec(value); match !== null; match = ESCAPE_PATTERN.exec(value)) {
    const text = value.slice(cursor, match.index)
    if (text !== '') html += styleSpan(text, style)
    cursor = match.index + match[0].length
    if (match[0].endsWith('m')) {
      const parameters = match[0]
        .slice(2, -1)
        .split(';')
        .map(entry => (entry === '' ? 0 : Number.parseInt(entry, 10)))
        .filter(entry => Number.isFinite(entry))
      style = applySgr(style, parameters)
    }
  }
  // Anything left is plain text plus, possibly, one escape cut in half by the frame
  // boundary: render the text, drop the fragment.
  const tail = value.slice(cursor)
  if (tail !== '') html += styleSpan(tail.replace(TRAILING_ESCAPE, ''), style)
  return html
}

/** Plain text for search, copy, and the collapsed one-line preview. */
export function stripAnsiSequences(value: string): string {
  return value.replace(ESCAPE_PATTERN, '').replace(TRAILING_ESCAPE, '')
}

/** Whether kernel text carries any escape at all, so plain paths skip a pass. */
export function containsAnsiSequences(value: string): boolean {
  ESCAPE_PATTERN.lastIndex = 0
  const found = ESCAPE_PATTERN.test(value)
  ESCAPE_PATTERN.lastIndex = 0
  return found
}
