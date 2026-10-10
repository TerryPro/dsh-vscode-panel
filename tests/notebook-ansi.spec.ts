import { describe, expect, it } from 'vitest'
import {
  ansi256Color,
  ansiToHtml,
  containsAnsiSequences,
  escapeHtmlText,
  stripAnsiSequences,
} from '../src/client/notebook/ansi-text.ts'

const ESC = String.fromCharCode(27)
const SGR = (codes: string) => `${ESC}[${codes}m`

describe('ansi kernel text', () => {
  it('escapes markup before wrapping it, so kernel output cannot inject elements', () => {
    expect(escapeHtmlText('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(ansiToHtml('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;')
    expect(ansiToHtml('a & b')).toBe('a &amp; b')
  })

  it('renders the SGR colours an ipykernel traceback really uses', () => {
    const line = `${SGR('31')}ZeroDivisionError${SGR('39')} boom`
    const html = ansiToHtml(line)
    expect(html).toContain('<span style="color:')
    expect(html).toContain('ZeroDivisionError')
    // The reset after the red run means "boom" carries no colour of its own.
    expect(html.endsWith('> boom</span>')).toBe(false)
    expect(stripAnsiSequences(line)).toBe('ZeroDivisionError boom')
  })

  it('maps the 16-colour and 256-colour forms to CSS', () => {
    expect(ansiToHtml(`${SGR('1;31')}bold red${SGR('0')}`)).toContain('font-weight:700')
    expect(ansiToHtml(`${SGR('4')}underlined${SGR('0')}`)).toContain('text-decoration:underline')
    expect(ansiToHtml(`${SGR('38;5;196')}x${SGR('0')}`)).toContain('rgb(255,0,0)')
    expect(ansiToHtml(`${SGR('38;2;10;20;30')}x${SGR('0')}`)).toContain('rgb(10,20,30)')
    expect(ansi256Color(9)).toBe('#ff0000')
    expect(ansi256Color(232)).toBe('rgb(8,8,8)')
    expect(ansi256Color(255)).toBe('rgb(238,238,238)')
    // Out-of-range indices are clamped rather than producing a bogus colour.
    expect(ansi256Color(-5)).toBe(ansi256Color(0))
    expect(ansi256Color(9999)).toBe(ansi256Color(255))
  })

  it('consumes non-SGR control sequences without rendering them', () => {
    // Cursor movement and clears come from progress bars that write terminal codes.
    expect(ansiToHtml(`${ESC}[2Kclean`)).toBe('clean')
    expect(ansiToHtml(`${ESC}[1;1Hclean`)).toBe('clean')
    expect(stripAnsiSequences(`${ESC}]8;;https://example.com${ESC}\\link${ESC}]8;;${ESC}\\`)).toBe('link')
  })

  it('closes a style that is still open when the text ends', () => {
    const html = ansiToHtml(`${SGR('31')}never reset`)
    expect(html).toBe('<span style="color:var(--dsh-ansi-red, #c23b22)">never reset</span>')
  })

  it('passes text with no escapes through untouched', () => {
    expect(ansiToHtml('plain text')).toBe('plain text')
    expect(containsAnsiSequences('plain')).toBe(false)
    expect(containsAnsiSequences(`${SGR('31')}x`)).toBe(true)
  })

  it('survives a truncated escape at the end of a chunk', () => {
    // Stream frames split anywhere, so a partial escape must not leak into the HTML.
    expect(containsAnsiSequences(ESC)).toBe(false)
    expect(stripAnsiSequences(`${SGR('31')}a${ESC}[`)).toBe('a')
  })

  it('does not treat an inverse style as a colour swap that loses the background', () => {
    const html = ansiToHtml(`${SGR('7;42')}selected${SGR('0')}`)
    expect(html).toContain('background:')
    expect(html).toContain('color:')
  })
})
