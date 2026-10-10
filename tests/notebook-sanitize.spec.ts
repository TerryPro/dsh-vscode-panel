import { describe, expect, it } from 'vitest'
import {
  hasRenderableHtml,
  isSafeKernelUrl,
  sanitizeKernelHtml,
} from '../src/client/notebook/sanitize-html.ts'

/**
 * Kernel `text/html` is rendered by the notebook output view through
 * `dangerouslySetInnerHTML`, so this file is the boundary that decides whether a cell
 * printing hostile markup can affect the workbench. Every case below is a real
 * vector, not a hypothetical.
 */
describe('kernel html sanitizer', () => {
  it('keeps the markup kernels actually produce', () => {
    const table = '<table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>'
    expect(sanitizeKernelHtml(table)).toBe(table)
    expect(sanitizeKernelHtml('<span style="color:red">x</span>')).toContain('style="color:red"')
    expect(sanitizeKernelHtml('<b>bold</b><i>it</i><code>c</code>')).toBe('<b>bold</b><i>it</i><code>c</code>')
    expect(sanitizeKernelHtml('<img src="data:image/png;base64,AA=="/>')).toContain('<img')
  })

  it('removes script, style, and iframe content entirely', () => {
    expect(sanitizeKernelHtml('<script>alert(1)</script>')).toBe('')
    expect(sanitizeKernelHtml('<SCRIPT SRC=//evil.example/x.js></SCRIPT>after')).toBe('after')
    expect(sanitizeKernelHtml('<style>body{display:none}</style>keep')).toBe('keep')
    expect(sanitizeKernelHtml('<iframe src="https://evil.example"></iframe>x')).toBe('x')
    expect(sanitizeKernelHtml('<object data="x"></object><embed src="y">z')).toBe('z')
    // Content nested inside a dropped element goes with it.
    expect(sanitizeKernelHtml('<script><p>inner</p></script>')).toBe('')
    expect(sanitizeKernelHtml('<form action="/x"><input name="a"/></form>ok')).toBe('ok')
  })

  it('drops every event handler attribute spelling', () => {
    for (const attribute of [
      'onerror=alert(1)',
      'ONLOAD=alert(1)',
      'onmouseover="alert(1)"',
      "onclick='alert(1)'",
      'onerror = alert(1)',
    ]) {
      const html = sanitizeKernelHtml(`<img src=x ${attribute}>`)
      expect(html, attribute).not.toMatch(/on[a-z]+=/iu)
    }
    expect(sanitizeKernelHtml('<div onclick="steal()">t</div>')).toBe('<div>t</div>')
  })

  it('refuses javascript and other executing schemes in links and sources', () => {
    expect(isSafeKernelUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeKernelUrl('JaVaScRiPt:alert(1)')).toBe(false)
    expect(isSafeKernelUrl('vbscript:msgbox(1)')).toBe(false)
    expect(isSafeKernelUrl('data:text/html,<script>alert(1)</script>')).toBe(false)
    // An SVG data URL can carry script, so it is refused even though it is an image.
    expect(isSafeKernelUrl('data:image/svg+xml,<svg onload=alert(1)>')).toBe(false)
    expect(isSafeKernelUrl('data:image/png;base64,AA')).toBe(true)
    expect(isSafeKernelUrl('https://example.com/a.png')).toBe(true)
    expect(isSafeKernelUrl('#anchor')).toBe(true)
    expect(isSafeKernelUrl('./relative.png')).toBe(true)
    expect(isSafeKernelUrl('')).toBe(false)
    const html = sanitizeKernelHtml('<a href="javascript:alert(1)">click</a>')
    expect(html).not.toContain('href')
    expect(html).toContain('click')
  })

  it('never lets a link reach the parent document', () => {
    const html = sanitizeKernelHtml('<a href="https://example.com">x</a>')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer nofollow"')
  })

  it('strips framework directive attributes that behave like handlers', () => {
    expect(sanitizeKernelHtml('<div v-on:click="evil()">t</div>')).toBe('<div>t</div>')
    expect(sanitizeKernelHtml('<div @click="evil()">t</div>')).toBe('<div>t</div>')
    expect(sanitizeKernelHtml('<div v-html="payload">t</div>')).toBe('<div>t</div>')
    expect(sanitizeKernelHtml('<div hx-on::click="evil()">t</div>')).toBe('<div>t</div>')
  })

  it('rejects inline styles that fetch or execute', () => {
    expect(sanitizeKernelHtml('<div style="color:red">x</div>')).toContain('style="color:red"')
    expect(sanitizeKernelHtml('<div style="background:url(javascript:alert(1))">x</div>')).not.toContain('style')
    expect(sanitizeKernelHtml('<div style="behavior:url(#default#time2)">x</div>')).not.toContain('style')
    expect(sanitizeKernelHtml('<div style="width:expression(alert(1))">x</div>')).not.toContain('style')
  })

  it('unwraps unknown elements while keeping their text', () => {
    expect(sanitizeKernelHtml('<marquee>scroll</marquee>')).toBe('scroll')
    expect(sanitizeKernelHtml('<custom-tag>kept</custom-tag>')).toBe('kept')
  })

  it('drops svg use and animate so an inline figure cannot fetch or time-travel', () => {
    const html = sanitizeKernelHtml('<svg><use href="http://evil.example/x.svg#y"></use><animate attributeName="href" values="http://evil.example"/><text>ok</text></svg>')
    expect(html).not.toContain('<use')
    expect(html).not.toContain('<animate')
    expect(html).toContain('ok')
  })

  it('treats a stray angle bracket as text rather than a tag start', () => {
    expect(sanitizeKernelHtml('a < b')).toContain('&lt;')
    expect(sanitizeKernelHtml('x <y')).toBe('x &lt;y')
  })

  it('does not re-decode an escaped payload into live markup', () => {
    // A kernel printing a repr of HTML arrives already escaped; decoding it once is
    // correct, and the result must stay inert.
    const html = sanitizeKernelHtml('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script')
    expect(stripAllTags(html)).not.toContain('script>')
  })

  it('survives malformed and truncated markup without throwing', () => {
    for (const input of [
      '<div', '<div ', '<div <span>x</span>', '<a href="unclosed>y', '<<!-- -->z',
      '<div style="a:b', '><><>', '<img src=">', '<table><tr><td>x',
    ]) {
      expect(() => sanitizeKernelHtml(input)).not.toThrow()
      // Whatever comes out must contain no script element and no handler attribute.
      const out = sanitizeKernelHtml(input)
      expect(out.toLowerCase()).not.toContain('<script')
      expect(out).not.toMatch(/\son[a-z]+\s*=/iu)
    }
  })

  it('keeps data attributes but bounds them', () => {
    expect(sanitizeKernelHtml('<div data-key="v">t</div>')).toContain('data-key="v"')
    const huge = 'a'.repeat(5_000)
    expect(sanitizeKernelHtml(`<div data-key="${huge}">t</div>`)).not.toContain(huge)
  })

  it('reports whether sanitized output has anything visible', () => {
    expect(hasRenderableHtml('<table><tr><td>1</td></tr></table>')).toBe(true)
    expect(hasRenderableHtml('plain')).toBe(true)
    expect(hasRenderableHtml('<script>alert(1)</script>')).toBe(false)
    expect(hasRenderableHtml('   ')).toBe(false)
  })

  it('quotes attribute values so a value cannot close the attribute', () => {
    const html = sanitizeKernelHtml('<div title="a\\"b>c">t</div>')
    expect(html).not.toContain('><')
    expect(html).toContain('t')
  })
})

function stripAllTags(value: string): string {
  return value.replace(/<[^>]*>/gu, '')
}
