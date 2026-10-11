import { describe, expect, it } from 'vitest'
import {
  chooseNotebookRender,
  collapseNotebookStreams,
  imageDataUrl,
  isImageMime,
  notebookAttachmentUrl,
  notebookOutputIsVisible,
  notebookOutputText,
  notebookWidgetNotice,
} from '../src/client/notebook/notebook-output.ts'
import type { NotebookOutputItem } from '../src/shared/notebook-protocol.ts'

const ESC = String.fromCharCode(27)
const red = `${ESC}[31m`

describe('mime bundle selection', () => {
  it('prefers the richest renderable form over the text/plain fallback', () => {
    // A `pandas` frame ships HTML plus a repr; showing the repr would turn every
    // table in a notebook into console text.
    const frame = { 'text/html': '<table><tr><td>1</td></tr></table>', 'text/plain': '   a\n0  1' }
    const choice = chooseNotebookRender(frame)
    expect(choice.kind).toBe('html')
    expect(choice.mime).toBe('text/html')
  })

  it('ranks an image above html, the way a plot should render', () => {
    const choice = chooseNotebookRender({
      'text/html': '<div>figure</div>',
      'image/png': 'iVBORw0',
      'text/plain': '<Figure size 640x480>',
    })
    expect(choice.kind).toBe('image')
    expect(choice.mime).toBe('image/png')
  })

  it('honours an explicit preference when the bundle carries it', () => {
    const bundle = { 'text/html': '<p>x</p>', 'text/plain': 'x' }
    expect(chooseNotebookRender(bundle, 'text/plain').mime).toBe('text/plain')
    // A preference the bundle does not carry falls back to the normal ranking.
    expect(chooseNotebookRender(bundle, 'image/png').mime).toBe('text/html')
  })

  it('falls back to text only when nothing richer is present', () => {
    expect(chooseNotebookRender({ 'text/plain': '42' })).toMatchObject({ kind: 'text', mime: 'text/plain' })
    expect(chooseNotebookRender({ 'application/json': { a: 1 } })).toMatchObject({ kind: 'json' })
    expect(chooseNotebookRender({ 'text/markdown': '# h' })).toMatchObject({ kind: 'markdown' })
    expect(chooseNotebookRender({ 'text/latex': '$x^2$' })).toMatchObject({ kind: 'latex' })
  })

  it('reports nothing renderable for an empty or widget-only bundle', () => {
    expect(chooseNotebookRender({}).kind).toBe('none')
    expect(chooseNotebookRender({ 'text/html': '   ' }).kind).toBe('none')
    expect(chooseNotebookRender({ 'application/vnd.jupyter.widget-view+json': { model_id: 'x' } }).kind).toBe('none')
  })

  it('lists the alternatives a reader could switch to', () => {
    const choice = chooseNotebookRender({ 'text/html': '<p>x</p>', 'text/plain': 'x' })
    expect(choice.alternatives.sort()).toEqual(['text/html', 'text/plain'])
  })

  it('builds data URLs the way each image form needs', () => {
    expect(imageDataUrl('image/png', 'AA==')).toBe('data:image/png;base64,AA==')
    // SVG is a document, not bytes: Jupyter sends it as text, so base64 would break it.
    expect(imageDataUrl('image/svg+xml', '<svg/>')).toBe('data:image/svg+xml;utf8,<svg/>')
    expect(isImageMime('image/svg+xml')).toBe(true)
    expect(isImageMime('text/html')).toBe(false)
  })

  it('announces an ipywidgets output it cannot draw, and stays quiet when a fallback exists', () => {
    expect(notebookWidgetNotice({ 'application/vnd.jupyter.widget-view+json': { model_id: 'abc' } }))
      .toMatch(/cannot be displayed/u)
    // `ipywidgets` writes a text repr alongside the view id; showing that beats a notice.
    expect(notebookWidgetNotice({
      'application/vnd.jupyter.widget-view+json': { model_id: 'abc' },
      'text/plain': 'IntProgress(value=0)',
    })).toBeNull()
    expect(notebookWidgetNotice({ 'text/plain': 'x' })).toBeNull()
  })
})

describe('output plain text and visibility', () => {
  it('strips ANSI from every text form so copy yields terminal-like text', () => {
    expect(notebookOutputText({ kind: 'stream', name: 'stdout', text: `${red}boom${ESC}[0m` })).toBe('boom')
    expect(notebookOutputText({ kind: 'error', ename: 'ValueError', evalue: 'bad', traceback: [`${red}frame`] }))
      .toBe('ValueError\nbad\nframe')
  })

  it('contributes nothing for an image, which has no text to copy', () => {
    expect(notebookOutputText({ kind: 'display_data', data: { 'image/png': 'AA' }, metadata: {} })).toBe('')
    expect(notebookOutputText({ kind: 'execute_result', executionCount: 1, data: { 'text/plain': '7' }, metadata: {} }))
      .toBe('7')
  })

  it('collapses consecutive stream chunks of one name', () => {
    const items: NotebookOutputItem[] = [
      { kind: 'stream', name: 'stdout', text: 'a' },
      { kind: 'stream', name: 'stdout', text: 'b' },
      { kind: 'stream', name: 'stderr', text: 'c' },
      { kind: 'stream', name: 'stdout', text: 'd' },
    ]
    expect(collapseNotebookStreams(items)).toEqual([
      { kind: 'stream', name: 'stdout', text: 'ab' },
      { kind: 'stream', name: 'stderr', text: 'c' },
      { kind: 'stream', name: 'stdout', text: 'd' },
    ])
  })

  it('calls an empty stream invisible and a blank display invisible too', () => {
    expect(notebookOutputIsVisible({ kind: 'stream', name: 'stdout', text: '  \n ' })).toBe(false)
    expect(notebookOutputIsVisible({ kind: 'stream', name: 'stdout', text: 'x' })).toBe(true)
    expect(notebookOutputIsVisible({ kind: 'error', ename: 'E', evalue: '', traceback: [] })).toBe(true)
    expect(notebookOutputIsVisible({ kind: 'display_data', data: {}, metadata: {} })).toBe(false)
  })
})

describe('markdown attachment references', () => {
  // A reader who drags a figure into a Markdown cell gets `![alt](attachment:plot.png)` in
  // the source and the bytes in the cell's `attachments`. This resolves the reference to a
  // data URL so the shared Markdown renderer can draw it, using the same mime vocabulary the
  // kernel-output path already uses.
  it('resolves an attachment reference to a data URL of its richest image form', () => {
    const attachments = { 'plot.png': { 'image/png': 'aGVsbG8=', 'text/plain': 'a figure' } }
    expect(notebookAttachmentUrl(attachments, 'attachment:plot.png')).toBe('data:image/png;base64,aGVsbG8=')
  })

  it('leaves a non-attachment destination for the renderer to treat as a path', () => {
    // Only `attachment:` names a payload the cell carries. An ordinary `![x](a.png)` is the
    // author's own relative path and must not be answered here.
    expect(notebookAttachmentUrl({ 'a.png': { 'image/png': 'zz' } }, 'a.png')).toBeUndefined()
  })

  it('returns nothing for a reference whose name the cell does not carry', () => {
    // A dangling `attachment:gone.png` (the payload was edited out, or the file predates
    // attachments) has to fall through to the renderer's alt text rather than invent an
    // image — the reader should see the name, not a broken thumbnail.
    expect(notebookAttachmentUrl({ 'plot.png': { 'image/png': 'zz' } }, 'attachment:gone.png')).toBeUndefined()
  })

  it('returns nothing for an attachment that carries no renderable image', () => {
    // `pdf` and other unsupported forms have no bytes this view can draw; the alt text is
    // the documented fallback, which is more honest than a blank or a broken image icon.
    const attachments = { 'doc.pdf': { 'application/pdf': 'JVBERg==' } }
    expect(notebookAttachmentUrl(attachments, 'attachment:doc.pdf')).toBeUndefined()
  })

  it('refuses an attachment whose richest form is markup rather than an image', () => {
    // The security line the ticket draws: an attachment reference must never put executable
    // HTML into the page. A bundle that offers `text/html` is exactly what `chooseNotebookRender`
    // would rank as renderable output, so this path has to reject anything that is not an image.
    const attachments = { 'evil': { 'text/html': '<img src=x onerror=alert(1)>' } }
    expect(notebookAttachmentUrl(attachments, 'attachment:evil')).toBeUndefined()
  })

  it('ignores an attachment value that is not a mime bundle', () => {
    // A hand-edited or malformed notebook can put a scalar where the bundle belongs; reading
    // it must not throw inside a click/render path.
    expect(notebookAttachmentUrl({ 'plot.png': 'not-a-bundle' }, 'attachment:plot.png')).toBeUndefined()
  })
})
