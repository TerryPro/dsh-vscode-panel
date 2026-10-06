/** HTML preview rendered in a sandboxed iframe, static or interactive, without parent access. */
import { useEffect, useMemo, useState } from 'react'
import {
  buildHtmlPreviewDocument,
  createInteractiveHtmlDocument,
  packHtml,
} from './html-preview.ts'
import type { ReadHtmlRelative } from './html-preview.ts'
import css from './editor.module.css'

export interface HtmlPreviewProps {
  /** Raw HTML source text; re-rendered whenever it changes. */
  html: string
  /** Accessible title describing the preview frame. */
  title: string
  /** Status text shown while an interactive document is being packed. */
  loadingText?: string
  /** Status text shown when an interactive document cannot be produced. */
  failedText?: string
  /** Run the document's own scripts inside the sandbox; defaults to the static frame. */
  interactive?: boolean
  /** Source-file-scoped dependency reader; required only for the interactive frame. */
  readResource?: ReadHtmlRelative | undefined
}

/**
 * Show complete HTML as a document.
 *
 * The static frame uses an empty `sandbox` attribute, giving it an opaque origin and
 * denying scripts, forms, top-level navigation and same-origin access. The interactive
 * frame adds `allow-scripts` so the document's own scripts run, but still cannot reach
 * the surrounding workbench; its local dependencies are packed under the source file's
 * authority and served from blob URLs minted inside the sandbox.
 * @param props - the HTML source, frame labels, and interactive packing inputs.
 * @returns an isolated document iframe, or a loading/failure status for interactive mode.
 */
export function HtmlPreview({
  html, title, loadingText = 'Loading…', failedText = 'Preview failed', interactive = false, readResource,
}: HtmlPreviewProps) {
  if (!interactive || readResource === undefined) return <StaticHtmlFrame html={html} title={title} />
  return (
    <InteractiveHtmlFrame
      key={html}
      html={html}
      title={title}
      loadingText={loadingText}
      failedText={failedText}
      readResource={readResource}
    />
  )
}

function StaticHtmlFrame({ html, title }: Pick<HtmlPreviewProps, 'html' | 'title'>) {
  const srcDoc = useMemo(() => buildHtmlPreviewDocument(html), [html])
  return (
    <iframe
      className={css.htmlFrame}
      title={title}
      srcDoc={srcDoc}
      sandbox=""
      referrerPolicy="no-referrer"
      data-html-preview
    />
  )
}

/** One mounted document owns its root Blob; replacing the source also replaces the browsing context. */
function InteractiveHtmlFrame({
  html, title, loadingText, failedText, readResource,
}: {
  html: string
  title: string
  loadingText: string
  failedText: string
  readResource: ReadHtmlRelative
}) {
  const [frame, setFrame] = useState<{ url: string | null }>()
  useEffect(() => {
    const controller = new AbortController()
    let url: string | undefined
    void (async () => {
      try {
        const bundle = await packHtml(html, readResource, controller.signal)
        controller.signal.throwIfAborted()
        const document = createInteractiveHtmlDocument(bundle)
        url = URL.createObjectURL(new Blob([document], { type: 'text/html' }))
        if (!controller.signal.aborted) setFrame({ url })
      } catch {
        if (!controller.signal.aborted) setFrame({ url: null })
      }
    })()
    return () => {
      controller.abort()
      if (url !== undefined) URL.revokeObjectURL(url)
    }
  }, [html, readResource])

  if (frame === undefined) return <p className={css.htmlStatus}>{loadingText}</p>
  if (frame.url === null) return <p className={css.htmlStatus} role="alert">{failedText}</p>
  return (
    <iframe
      key={frame.url}
      className={css.htmlFrame}
      title={title}
      src={frame.url}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      data-html-preview
    />
  )
}
