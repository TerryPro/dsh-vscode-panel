// @vitest-environment jsdom

import { describe, expect, it, vi, afterEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import {
  buildHtmlPreviewDocument,
  createInteractiveHtmlDocument,
  HTML_PREVIEW_CSP,
  isHtmlPath,
  packHtml,
  resolveRelativePath,
} from '../src/client/html-preview.ts'
import { HtmlPreview } from '../src/client/HtmlPreview.tsx'

describe('isHtmlPath', () => {
  it('recognizes HTML extensions case-insensitively and from nested paths', () => {
    expect(isHtmlPath('index.html')).toBe(true)
    expect(isHtmlPath('docs/Page.HTM')).toBe(true)
    expect(isHtmlPath('src/app/xhtml/doc.xhtml')).toBe(true)
    expect(isHtmlPath('src\\win\\index.html')).toBe(true)
  })

  it('rejects non-HTML files, extensionless names, and missing paths', () => {
    expect(isHtmlPath('README.md')).toBe(false)
    expect(isHtmlPath('styles.css')).toBe(false)
    expect(isHtmlPath('LICENSE')).toBe(false)
    expect(isHtmlPath('.htmlhintrc')).toBe(false)
    expect(isHtmlPath(undefined)).toBe(false)
  })
})

describe('buildHtmlPreviewDocument', () => {
  it('prepends a restrictive CSP and a charset before the document body', () => {
    const document = buildHtmlPreviewDocument('<h1>Hello</h1>')
    const head = new DOMParser().parseFromString(document, 'text/html').head
    const [first, second] = Array.from(head.children)
    expect(first?.getAttribute('http-equiv')).toBe('Content-Security-Policy')
    expect(first?.getAttribute('content')).toBe(HTML_PREVIEW_CSP)
    expect(second?.getAttribute('charset')).toBe('utf-8')
    expect(document).toContain('<h1>Hello</h1>')
  })

  it('denies scripts, network, forms, and framing while allowing inline styles', () => {
    expect(HTML_PREVIEW_CSP).toContain("script-src 'none'")
    expect(HTML_PREVIEW_CSP).toContain("default-src 'none'")
    expect(HTML_PREVIEW_CSP).toContain("connect-src 'none'")
    expect(HTML_PREVIEW_CSP).toContain("form-action 'none'")
    expect(HTML_PREVIEW_CSP).toContain("frame-src 'none'")
    expect(HTML_PREVIEW_CSP).toContain("style-src 'unsafe-inline'")
  })

  it('preserves an existing document structure while injecting the policy', () => {
    const document = buildHtmlPreviewDocument('<html><head><title>Doc</title></head><body><p>Text</p></body></html>')
    const parsed = new DOMParser().parseFromString(document, 'text/html')
    expect(parsed.querySelector('title')?.textContent).toBe('Doc')
    expect(parsed.querySelector('body p')?.textContent).toBe('Text')
    expect(parsed.head.firstElementChild?.getAttribute('http-equiv')).toBe('Content-Security-Policy')
  })
})

describe('HtmlPreview', () => {
  it('mounts a fully sandboxed, script-free frame carrying the previewed source', () => {
    const view = render(<HtmlPreview html="<h1>Hello</h1>" title="HTML preview" />)
    const frame = view.getByTitle('HTML preview') as HTMLIFrameElement
    expect(frame.tagName.toLowerCase()).toBe('iframe')
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(frame.dataset.htmlPreview).toBeDefined()
    expect(frame.getAttribute('srcdoc')).toContain('Content-Security-Policy')
    expect(frame.getAttribute('srcdoc')).toContain('<h1>Hello</h1>')
  })
})

describe('packHtml', () => {
  it('packs relative classic scripts and stylesheets, skipping modules, external URLs, icons, and duplicates', async () => {
    const readRelative = vi.fn(async (reference: string) => `/* ${reference} */`)
    const bundle = await packHtml(
      '<script src="./app.js"></script>'
      + '<script type="module" src="./mod.js"></script>'
      + '<script src="https://cdn.example/x.js"></script>'
      + '<link rel="stylesheet" href="./base.css?v=1">'
      + '<link rel="icon" href="./favicon.png">'
      + '<script src="./app.js"></script>',
      readRelative,
      new AbortController().signal,
    )
    expect(readRelative.mock.calls.map(call => call[0])).toEqual(['./app.js', './base.css?v=1'])
    expect(bundle.assets).toEqual([
      { kind: 'script', reference: './app.js', text: '/* ./app.js */' },
      { kind: 'stylesheet', reference: './base.css?v=1', text: '/* ./base.css?v=1 */' },
    ])
  })

  it('disables packing when the document declares a base href', async () => {
    const readRelative = vi.fn(async () => 'x')
    const bundle = await packHtml('<base href="/cdn/"><script src="./app.js"></script>', readRelative, new AbortController().signal)
    expect(readRelative).not.toHaveBeenCalled()
    expect(bundle.assets).toEqual([])
  })
})

describe('createInteractiveHtmlDocument', () => {
  it('emits an in-sandbox bootstrap that mints blob URLs and writes the document', () => {
    const doc = createInteractiveHtmlDocument({
      html: '<h1>Hi</h1>',
      assets: [{ kind: 'script', reference: './app.js', text: 'alert(1)' }],
    })
    expect(doc).toContain('atob')
    expect(doc).toContain('URL.createObjectURL')
    expect(doc).toContain('document.write')
    expect(doc).not.toContain('alert(1)')
  })
})

describe('resolveRelativePath', () => {
  it('resolves a reference against the source file directory', () => {
    expect(resolveRelativePath('site/index.html', './js/app.js')).toBe('site/js/app.js')
    expect(resolveRelativePath('site/index.html', 'app.js')).toBe('site/app.js')
    expect(resolveRelativePath('site/pages/index.html', '../css/base.css')).toBe('site/css/base.css')
    expect(resolveRelativePath('index.html', './a.js')).toBe('a.js')
    expect(resolveRelativePath('site/index.html', './app.js?v=1#frag')).toBe('site/app.js')
  })

  it('keeps escaping segments for the backend path policy to reject', () => {
    expect(resolveRelativePath('index.html', '../../x.js')).toBe('../../x.js')
  })
})

describe('HtmlPreview interactive frame', () => {
  const originalCreate = URL.createObjectURL
  const originalRevoke = URL.revokeObjectURL
  afterEach(() => {
    URL.createObjectURL = originalCreate
    URL.revokeObjectURL = originalRevoke
  })

  it('packs dependencies and mounts an allow-scripts frame from a sandbox blob URL', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:preview-frame')
    URL.revokeObjectURL = vi.fn()
    const readResource = vi.fn(async () => 'body{}')
    const view = render(
      <HtmlPreview
        html="<script src='./app.js'></script>"
        title="Interactive HTML"
        loadingText="Packing…"
        failedText="Failed"
        interactive
        readResource={readResource}
      />,
    )
    expect(view.getByText('Packing…')).toBeTruthy()
    const frame = await waitFor(() => view.getByTitle('Interactive HTML') as HTMLIFrameElement)
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame.getAttribute('src')).toBe('blob:preview-frame')
    expect(readResource).toHaveBeenCalledWith('./app.js', expect.any(AbortSignal))
  })

  it('reports a failure status when a dependency cannot be read', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:x')
    URL.revokeObjectURL = vi.fn()
    const readResource = vi.fn(async () => { throw new Error('denied') })
    const view = render(
      <HtmlPreview
        html="<script src='./app.js'></script>"
        title="Broken"
        loadingText="Packing…"
        failedText="Could not preview"
        interactive
        readResource={readResource}
      />,
    )
    const alert = await waitFor(() => view.getByRole('alert'))
    expect(alert.textContent).toBe('Could not preview')
  })
})
