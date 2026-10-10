/**
 * Kernel HTML output made safe to render.
 *
 * A kernel's `text/html` is intended to be rendered — that is how `pandas` data
 * frames and `plotly` figures reach the screen — but it is produced by code the
 * user or an agent ran, not by the workbench. This sanitizer keeps the tables,
 * spans, inline styles, images, and inline SVG kernels actually generate while
 * removing script, event handlers, framework directive attributes, remote resource
 * loads, and anything that could escape into the parent document.
 *
 * `sanitize-html` would be the obvious dependency and is deliberately not taken:
 * the client half bundles everything except five externals, so a new dependency is
 * bundle weight the whole plugin pays, and the surface kernels produce is small
 * enough to own here. React only accepts `dangerouslySetInnerHTML`, so this
 * function's output is exactly what the view renders — which is why its tests are
 * the security regression net.
 */

/** Elements removed outright together with their content. */
const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
  'link', 'meta', 'base', 'form', 'input', 'button', 'textarea', 'select', 'option',
  'noscript', 'template', 'portal',
])

/** Elements that never carry children, so removing one must not swallow what follows. */
const SELF_CONTAINED = new Set(['embed', 'param', 'source', 'track', 'area', 'base', 'link', 'meta', 'input', 'col', 'br', 'hr', 'img', 'wbr'])

/** Document wrappers unwrapped so a fragment never pretends to be a page. */
const DROP_KEEP_CONTENT = new Set(['html', 'head', 'body'])

/** Attributes allowed by name on any element. */
const GLOBAL_ATTRIBUTES = new Set([
  'title', 'lang', 'dir', 'colspan', 'rowspan', 'headers', 'scope',
  'width', 'height', 'align', 'valign', 'border', 'cellpadding', 'cellspacing',
  // Inline SVG presentation attributes, which carry no URL or handler.
  'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray',
  'stroke-opacity', 'fill-opacity', 'fill-rule', 'opacity', 'transform', 'd', 'points',
  'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'dx', 'dy', 'viewbox',
  'preserveaspectratio', 'text-anchor', 'dominant-baseline', 'font-family', 'font-size',
  'font-weight', 'font-style', 'letter-spacing', 'visibility', 'display', 'offset',
  'stop-color', 'stop-opacity', 'gradientunits', 'gradienttransform', 'spreadmethod',
  'markerwidth', 'markerheight', 'markerunits', 'refx', 'refy', 'orient',
])

/** Attributes that additionally have to pass a URL check. */
const URL_ATTRIBUTES = new Set(['href', 'xlink:href', 'src', 'poster', 'background'])

/** Elements allowed to appear in the output. */
const ALLOWED_ELEMENTS = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'col', 'colgroup', 'dd', 'del',
  'details', 'div', 'dfn', 'dl', 'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4',
  'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'samp',
  'section', 'small', 'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td',
  'tfoot', 'th', 'thead', 'tr', 'u', 'ul', 'var',
  // Kernels emit inline SVG for figures and plots; the structural subset is safe
  // once no script, `use`, or event attribute survives.
  'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text',
  'tspan', 'defs', 'clippath', 'lineargradient', 'radialgradient', 'stop', 'marker',
])

/** Tags that never take a closing tag. */
const VOID_ELEMENTS = new Set(['img', 'br', 'hr', 'wbr', 'area', 'col', 'source', 'track', 'param'])

const MAX_DATA_VALUE_LENGTH = 2048
const MAX_STYLE_LENGTH = 2048

/** `use` is dropped: it can reference an external document. */
const DROP_ALWAYS = new Set(['use', 'symbol', 'script', 'animate', 'animatemotion', 'animatetransform', 'set'])

const DANGEROUS_ATTRIBUTE_PREFIXES = ['v-on:', '@', 'wire:', 'lazy:', 'x-on:', 's-on:', 'hx-on', 'ng-']

function isDangerousAttributeName(name: string): boolean {
  if (/^on[a-z]+$/iu.test(name)) return true
  if (name.startsWith('v-html') || name.startsWith('data-ng-')) return true
  const lower = name.toLowerCase()
  return DANGEROUS_ATTRIBUTE_PREFIXES.some(prefix => lower.startsWith(prefix))
}

/**
 * A URL is allowed only for schemes that cannot execute or leak.
 *
 * `data:` is accepted only for the raster image types kernels emit, because
 * `data:text/html` and `data:image/svg+xml` (which can carry script) are both
 * common XSS vectors.
 */
export function isSafeKernelUrl(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed === '') return false
  // Control characters and embedded newlines are how a filter bypass spells a
  // scheme, so any value carrying one is refused outright.
  if (/[\u0000-\u001f\u007f]/u.test(trimmed)) return false
  if (trimmed.startsWith('#') || trimmed.startsWith('/') || trimmed.startsWith('./') || trimmed.startsWith('../')) {
    return true
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(trimmed)?.[1]?.toLowerCase()
  if (scheme === undefined) return true
  if (scheme === 'http' || scheme === 'https' || scheme === 'mailto' || scheme === 'tel') return true
  if (scheme === 'data') return /^data:image\/(?:png|jpeg|gif|webp)[;,]/iu.test(trimmed)
  return false
}

function isSafeStyle(value: string): string | null {
  const trimmed = value.trim().slice(0, MAX_STYLE_LENGTH)
  if (trimmed === '') return null
  if (/expression\s*\(|url\s*\(|javascript:|@import|behavior\s*:|-moz-binding/iu.test(trimmed)) return null
  return trimmed
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]{1,6});/giu, (whole: string, digits: string) => {
      void whole
      const code = Number.parseInt(digits, 16)
      return code >= 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : whole
    })
    .replace(/&#(\d{1,7});/gu, (whole: string, digits: string) => {
      void whole
      const code = Number.parseInt(digits, 10)
      return code >= 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : whole
    })
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, '\'')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&amp;/gu, '&')
}

function escapeText(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
}

function escapeAttribute(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;')
}

const ATTRIBUTE_PATTERN = /(?:([^"\s/>=]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]*)))?)/gu

interface Attribute {
  name: string
  value: string
}

function parseAttributes(source: string): Attribute[] {
  const attributes: Attribute[] = []
  ATTRIBUTE_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null = ATTRIBUTE_PATTERN.exec(source)
  while (match !== null) {
    const name = match[1]
    if (name !== undefined && name !== '') {
      const value = match[2] ?? match[3] ?? match[4] ?? ''
      attributes.push({ name: name.toLowerCase(), value })
    }
    match = ATTRIBUTE_PATTERN.exec(source)
  }
  return attributes
}

const TAG_PATTERN = /<(\/?)([a-zA-Z][a-zA-Z0-9:._-]*)((?:"[^"]*"|'[^']*'|[^"'<>])*)>/gu

/**
 * Make kernel HTML safe to render inside the workbench document.
 *
 * Unknown tags are dropped (their text is kept) and dangerous ones are dropped
 * with their content, attribute names are matched case-insensitively, and
 * `href`/`src` are scheme-checked, so a kernel printing `<img src=x onerror=...>`
 * or `<a href="javascript:...">` yields inert markup.
 * @param value - raw HTML from a kernel MIME bundle.
 * @returns the safe subset, ready for `dangerouslySetInnerHTML`.
 */
export function sanitizeKernelHtml(value: string): string {
  let html = ''
  let cursor = 0
  // Element name whose content is currently being discarded, if any.
  let droppedTag: string | null = null
  let droppedDepth = 0
  const unwrapped = new Set<string>()

  TAG_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null = TAG_PATTERN.exec(value)
  while (match !== null) {
    const text = value.slice(cursor, match.index)
    if (text !== '' && droppedTag === null) html += escapeText(decodeEntities(text))
    cursor = match.index + match[0].length

    const closing = match[1] === '/'
    const rawName = match[2] ?? ''
    const name = rawName.toLowerCase().replace(/[^a-z0-9:._-]/gu, '')
    const body = match[3] ?? ''
    // The tag pattern keeps the closing `>` inside `body`, so an XHTML-style trailing
    // slash is detected there rather than in a separate capture group.
    const selfClosing = body.trimEnd().endsWith('/')
    // Drop the XHTML-style trailing slash before attribute parsing, or a bare value
    // would swallow it (`src=x/` instead of `src=x`).
    const attributeSource = selfClosing ? body.slice(0, body.lastIndexOf('/')) : body

    if (droppedTag !== null) {
      if (name === droppedTag) {
        if (closing || selfClosing) {
          droppedDepth -= 1
          if (droppedDepth <= 0) droppedTag = null
        } else droppedDepth += 1
      }
      match = TAG_PATTERN.exec(value)
      continue
    }

    if (DROP_WITH_CONTENT.has(name)) {
      // A void-ish dropped tag (`<embed>`, `<input>`, `<meta>`) has no closing tag, so
      // entering drop-depth on it would swallow the rest of the output.
      if (!closing && !selfClosing && !SELF_CONTAINED.has(name)) {
        droppedTag = name
        droppedDepth = 1
      }
      match = TAG_PATTERN.exec(value)
      continue
    }
    if (DROP_ALWAYS.has(name) || DROP_KEEP_CONTENT.has(name)) {
      match = TAG_PATTERN.exec(value)
      continue
    }
    if (closing) {
      if (ALLOWED_ELEMENTS.has(name) && !VOID_ELEMENTS.has(name) && !unwrapped.has(name)) html += `</${name}>`
      if (unwrapped.has(name)) unwrapped.delete(name)
      match = TAG_PATTERN.exec(value)
      continue
    }
    if (!ALLOWED_ELEMENTS.has(name)) {
      // Unknown but harmless element: keep the text, lose the tag.
      match = TAG_PATTERN.exec(value)
      continue
    }

    const rendered: string[] = []
    for (const attribute of parseAttributes(attributeSource)) {
      const attributeName = attribute.name
      const attributeValue = decodeEntities(attribute.value)
      if (isDangerousAttributeName(attributeName)) continue
      if (URL_ATTRIBUTES.has(attributeName)) {
        if (isSafeKernelUrl(attributeValue)) rendered.push(`${attributeName}="${escapeAttribute(attributeValue)}"`)
        continue
      }
      if (attributeName === 'style') {
        const style = isSafeStyle(attributeValue)
        if (style !== null) rendered.push(`style="${escapeAttribute(style)}"`)
        continue
      }
      if (attributeName.startsWith('data-')) {
        if (attributeValue.length <= MAX_DATA_VALUE_LENGTH) {
          rendered.push(`${attributeName}="${escapeAttribute(attributeValue)}"`)
        }
        continue
      }
      if (attributeName === 'id' || attributeName === 'class') {
        rendered.push(`${attributeName}="${escapeAttribute(attributeValue.replace(/["<>]/gu, ''))}"`)
        continue
      }
      if (GLOBAL_ATTRIBUTES.has(attributeName)) {
        rendered.push(`${attributeName}="${escapeAttribute(attributeValue.slice(0, 512))}"`)
      }
    }
    if (name === 'a') rendered.push('target="_blank"', 'rel="noopener noreferrer nofollow"')
    if (VOID_ELEMENTS.has(name) || selfClosing) {
      html += `<${name}${rendered.length === 0 ? '' : ` ${rendered.join(' ')}`}/>`
    } else {
      html += `<${name}${rendered.length === 0 ? '' : ` ${rendered.join(' ')}`}>`
    }
    match = TAG_PATTERN.exec(value)
  }

  const tail = value.slice(cursor)
  if (tail !== '' && droppedTag === null) html += escapeText(decodeEntities(tail))
  return html
}

/** Whether sanitized output has anything visible at all. */
export function hasRenderableHtml(value: string): boolean {
  const sanitized = sanitizeKernelHtml(value)
  return sanitized.replace(/<[^>]*>/gu, '').trim() !== '' || /<(?:img|svg)\b/iu.test(sanitized)
}
