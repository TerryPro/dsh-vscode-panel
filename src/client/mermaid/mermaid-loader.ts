/**
 * Lazy bridge to the host-served Mermaid runtime.
 *
 * The library is imported once per page through a dynamic `import()` of the URL
 * the Host serves (`MERMAID_RUNTIME_PATH`), then initialized with a theme and
 * reused across every open diagram tab. The URL is computed at runtime (from
 * `document.baseURI`) so the bundler cannot statically resolve it into the
 * eagerly-loaded client bundle — the import stays native and lazy.
 *
 * Failure policy: every path rejects with an `Error` (never a bare value) so the
 * preview component can show in-panel copy; a failed load resets the memo so a
 * later open can retry (for example once the runtime finishes building).
 */

import { MERMAID_RUNTIME_PATH } from '../../shared/contracts.ts'
import { resolveMermaidTheme, type MermaidTheme } from './mermaid-render.ts'

/** The configuration shape this preview initializes Mermaid with. */
export interface MermaidConfig {
  startOnLoad: boolean
  securityLevel: 'strict' | 'loose' | 'antiscript' | 'sandbox'
  suppressErrorRendering: boolean
  theme: string
  fontFamily: string
}

/** The subset of the Mermaid API this preview depends on. */
export interface MermaidRuntime {
  initialize(config: MermaidConfig): void
  render(id: string, code: string): Promise<{ svg: string } | string>
}

/** The namespace shape a bundled ESM Mermaid module can present. */
type MermaidModule = { default?: MermaidRuntime; mermaid?: MermaidRuntime }

let runtime: MermaidRuntime | null = null
let loadPromise: Promise<MermaidRuntime> | null = null
let activeTheme: MermaidTheme | '' = ''
let renderSequence = 0

/**
 * Resolve the served runtime to an absolute URL at runtime. Reading the base
 * from the live document (rather than a constant) keeps the value opaque to the
 * bundler, which preserves the dynamic `import()` in the built client.
 */
function runtimeUrl(): string {
  const base = typeof document !== 'undefined' && document.baseURI !== '' ? document.baseURI : 'http://localhost/'
  return new URL(MERMAID_RUNTIME_PATH, base).href
}

/** Whether the shell is currently in its dark theme, so Mermaid can match it. */
export function shellIsDark(): boolean {
  return typeof document !== 'undefined' && document.body?.hasAttribute('data-ds-dark-theme') === true
}

/**
 * Initialize (or re-tune) the loaded runtime for a theme. Idempotent per theme:
 * an unchanged theme is a no-op, so redrawing on every keystroke never re-inits.
 * Inline `%%{init}%%` directives and YAML front-matter still override per diagram.
 */
export function configureMermaid(theme: MermaidTheme): void {
  if (runtime === null || theme === activeTheme) return
  activeTheme = theme
  runtime.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme,
    fontFamily: 'inherit',
  })
}

/** Import + initialize the served bundle once; concurrent callers share one promise. */
export function loadMermaidRuntime(theme: MermaidTheme): Promise<MermaidRuntime> {
  if (runtime !== null) {
    configureMermaid(theme)
    return Promise.resolve(runtime)
  }
  if (loadPromise === null) loadPromise = importOnce(theme)
  return loadPromise
}

function importOnce(theme: MermaidTheme): Promise<MermaidRuntime> {
  return import(/* @vite-ignore */ runtimeUrl())
    .then((imported: MermaidModule) => {
      const candidate = imported?.default ?? imported?.mermaid
      if (candidate === undefined) throw new Error('the Mermaid runtime exports no library')
      runtime = candidate
      activeTheme = ''
      configureMermaid(theme)
      return candidate
    })
    .catch((error: unknown) => {
      loadPromise = null
      throw error instanceof Error ? error : new Error(String(error))
    })
}

/**
 * Render one diagram to SVG markup for a theme, loading the runtime first.
 * @param dark - whether the shell is in dark mode, resolved to a Mermaid theme.
 * @param code - the Mermaid source text.
 * @returns the rendered SVG markup; rejects with an `Error` on a parse failure.
 */
export async function renderMermaidDiagram(dark: boolean, code: string): Promise<string> {
  const theme = resolveMermaidTheme(dark)
  const loaded = await loadMermaidRuntime(theme)
  renderSequence += 1
  const id = `dsw-mermaid-${renderSequence.toString(36)}`
  try {
    const result = await loaded.render(id, code)
    return typeof result === 'string' ? result : result.svg
  } catch (error: unknown) {
    // A parse failure can leave a temporary node behind even with
    // suppressErrorRendering; drop it so repeated edits never stack stray DOM.
    if (typeof document !== 'undefined') document.getElementById(id)?.remove()
    throw error instanceof Error ? error : new Error(String(error))
  }
}
