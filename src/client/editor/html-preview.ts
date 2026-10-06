/** Client-side HTML preview helpers: path recognition, sandboxed documents and resource packing. */

import { basename } from '../../shared/path-name.ts'

/** File extensions the workbench offers an HTML preview for. */
export const HTML_PREVIEW_EXTENSIONS = ['html', 'htm', 'xhtml'] as const

/** True when a workspace-relative (or absolute) path points at an HTML document. */
export function isHtmlPath(path: string | undefined): boolean {
  if (path === undefined) return false
  const name = basename(path).toLowerCase()
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return false
  return (HTML_PREVIEW_EXTENSIONS as readonly string[]).includes(name.slice(dot + 1))
}

/**
 * A restrictive policy for the static HTML preview. Scripts, forms, navigation
 * and network requests are all denied; only inline styles and inline (data/blob)
 * images, fonts and media are allowed, matching the sandboxed iframe it runs in.
 */
export const HTML_PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data:',
  "connect-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ')

/**
 * Build the document shown inside the static preview iframe.
 *
 * A strict CSP and an explicit UTF-8 declaration are prepended to the source's
 * own head so the browser cannot load any sub-resource or run any script before
 * the document is parsed. The iframe's empty `sandbox` attribute is the primary
 * guard; this policy is defense-in-depth against resource loads and referrer leaks.
 * @param html - the raw HTML source text of the opened file.
 * @returns a complete HTML document string safe to feed to an iframe's `srcDoc`.
 */
export function buildHtmlPreviewDocument(html: string): string {
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  const policy = parsed.createElement('meta')
  policy.setAttribute('http-equiv', 'Content-Security-Policy')
  policy.setAttribute('content', HTML_PREVIEW_CSP)
  const charset = parsed.createElement('meta')
  charset.setAttribute('charset', 'utf-8')
  const head = parsed.head ?? parsed.documentElement.appendChild(parsed.createElement('head'))
  head.prepend(charset)
  head.prepend(policy)
  return `<!doctype html>${parsed.documentElement.outerHTML}`
}

/** One statically declared local classic script or stylesheet, already read as text. */
export interface HtmlAsset {
  readonly kind: 'script' | 'stylesheet'
  /** The original HTML attribute value, never a workspace absolute path. */
  readonly reference: string
  readonly text: string
}

/** Complete HTML and its finite set of packed local dependencies. */
export interface HtmlBundle {
  readonly html: string
  readonly assets: readonly HtmlAsset[]
}

/**
 * Read one packed dependency as text; the caller resolves it against the source file.
 * @param reference - HTML-decoded relative URL, including any query or fragment.
 * @param signal - cancellation of the current packing operation.
 * @returns the dependency's text; permission and read failures reject.
 */
export type ReadHtmlRelative = (reference: string, signal: AbortSignal) => Promise<string>

const MAX_ASSET_CHARS = 4 * 1024 * 1024
const MAX_TOTAL_CHARS = 32 * 1024 * 1024
const MAX_ASSETS = 64
const BASE64_CHUNK_BYTES = 0x8000
const SCRIPT_TYPES = ['', 'text/javascript', 'application/javascript']

/** Whether a reference can be resolved relative to the source file, never the parent app URL. */
function isRelativeReference(reference: string): boolean {
  return reference.length > 0
    && !/^(?:[a-z][a-z\d+.-]*:|[/\\#?])/iu.test(reference)
    && !reference.includes('\0')
}

/**
 * Collect finite static dependencies without executing or mounting document elements.
 *
 * Only direct classic `.js` scripts and `.css` stylesheet links with relative
 * references are packed; a `base[href]` leaves all URL resolution to the browser and
 * disables packing, while modules, CSS `url()/@import`, and dynamic URLs are skipped.
 * @param html - complete HTML source text.
 * @param readRelative - source-file-scoped read, never exposed to the iframe.
 * @param signal - stops reads and prevents publication after cancellation.
 * @returns complete HTML and its finite static asset set; limit and read failures reject.
 */
export async function packHtml(
  html: string,
  readRelative: ReadHtmlRelative,
  signal: AbortSignal,
): Promise<HtmlBundle> {
  signal.throwIfAborted()
  let total = html.length
  if (total > MAX_TOTAL_CHARS) throw new Error('HTML package exceeds its total size limit')
  const template = document.createElement('template')
  template.innerHTML = html
  const assets: HtmlAsset[] = []
  if (template.content.querySelector('base[href]') !== null) return { html, assets }

  const seen = new Set<string>()
  for (const element of Array.from(template.content.querySelectorAll('script[src],link[href]'))) {
    const script = element.localName === 'script'
    const type = element.getAttribute('type')?.trim().toLowerCase() ?? ''
    if (script && !SCRIPT_TYPES.includes(type)) continue
    if (!script && !(element.getAttribute('rel') ?? '').toLowerCase().split(/\s+/u).includes('stylesheet')) continue
    // The selector guarantees the corresponding URL attribute is present.
    const reference = element.getAttribute(script ? 'src' : 'href') as string
    const suffix = reference.search(/[?#]/u)
    const path = suffix === -1 ? reference : reference.slice(0, suffix)
    if (!isRelativeReference(reference) || !(script ? /\.js$/iu : /\.css$/iu).test(path)) continue
    const kind = script ? 'script' : 'stylesheet'
    const key = `${kind}:${reference}`
    if (seen.has(key)) continue
    if (assets.length >= MAX_ASSETS) throw new Error('HTML package exceeds its asset count limit')
    signal.throwIfAborted()
    const text = await readRelative(reference, signal)
    signal.throwIfAborted()
    if (text.length > MAX_ASSET_CHARS) throw new Error('HTML asset exceeds its size limit')
    total += text.length
    if (total > MAX_TOTAL_CHARS) throw new Error('HTML package exceeds its total size limit')
    assets.push({ kind, reference, text })
    seen.add(key)
  }
  return { html, assets }
}

/**
 * Build the outer document for an interactive preview.
 *
 * Its resource Blob URLs are created inside the sandbox, because that opaque
 * origin cannot load URLs created by the parent page. The packed payload is
 * carried base64-encoded so HTML, script, or quote content can never break out
 * of the bootstrap `<script>`; the embedded bootstrap then rewrites each relative
 * reference to a freshly minted blob URL and writes the finished document.
 * @param bundle - complete HTML text and its packed static dependencies.
 * @returns bootstrap HTML whose inline script materializes the previewed document.
 */
export function createInteractiveHtmlDocument(bundle: HtmlBundle): string {
  const payload = encodeBase64Utf8(JSON.stringify({
    html: bundle.html,
    assets: bundle.assets.map(asset => ({ kind: asset.kind, reference: asset.reference, text: asset.text })),
  }))
  return `<!doctype html><meta charset="utf-8"><script>(()=>{
const bytes=data=>Uint8Array.from(atob(data),character=>character.charCodeAt(0));
const bundle=JSON.parse(new TextDecoder('utf-8').decode(bytes("${payload}")));
let html=bundle.html;
if(bundle.assets.length){
  const parsed=new DOMParser().parseFromString(html,'text/html');
  for(const asset of bundle.assets){
    const script=asset.kind==='script';
    const url=URL.createObjectURL(new Blob([asset.text],{type:script?'application/javascript':'text/css'}));
    const attribute=script?'src':'href';
    for(const element of parsed.querySelectorAll(script?'script[src]':'link[rel~="stylesheet" i][href]')){
      if(element.getAttribute(attribute)===asset.reference)element.setAttribute(attribute,url);
    }
  }
  html='<!doctype html>'+parsed.documentElement.outerHTML;
}
document.open();document.write(html);document.close();
})()</script>`
}

/**
 * Resolve an HTML relative reference against the source file's workspace path.
 * Only `.` and `..` segments are collapsed; the backend path policy still rejects
 * any result that escapes the workspace root, so this stays best-effort client-side.
 * @param basePath - workspace path of the HTML file being previewed.
 * @param reference - a relative URL from the HTML, optionally with query or fragment.
 * @returns a normalized workspace-relative path.
 */
export function resolveRelativePath(basePath: string, reference: string): string {
  const clean = reference.split(/[?#]/u)[0]
  const normalized = basePath.replace(/\\/gu, '/')
  const dir = normalized.slice(0, normalized.lastIndexOf('/') + 1)
  return collapseSegments(`${dir}${clean}`)
}

function collapseSegments(path: string): string {
  const out: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else out.push('..')
      continue
    }
    out.push(segment)
  }
  return out.join('/')
}

function encodeBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text)
  const chunks: string[] = []
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_BYTES)))
  }
  return btoa(chunks.join(''))
}

