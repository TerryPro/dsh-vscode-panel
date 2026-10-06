/** Proportional scroll synchronization between a Markdown source and preview pane. */

interface ScrollableBox {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/**
 * Mirror `source`'s scroll position onto `target` by relative offset. Pure over
 * numeric fields so it can be unit-tested without a DOM.
 */
export function syncScrollProportionally(source: ScrollableBox, target: ScrollableBox): void {
  const sourceRange = source.scrollHeight - source.clientHeight
  const targetRange = target.scrollHeight - target.clientHeight
  if (sourceRange <= 0 || targetRange <= 0) return
  const ratio = Math.min(1, Math.max(0, source.scrollTop / sourceRange))
  target.scrollTop = ratio * targetRange
}

/**
 * Bind two panes so scrolling either one drives the other, with a one-frame
 * lock that stops the resulting scroll event from echoing back. Returns an
 * unsubscribe function.
 */
export function attachSplitScrollSync(a: HTMLElement, b: HTMLElement): () => void {
  let locked = false
  const release = (): void => { locked = false }
  const makeHandler = (from: HTMLElement, to: HTMLElement): (() => void) => () => {
    if (locked) return
    locked = true
    syncScrollProportionally(from, to)
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(release)
    else release()
  }
  const handlerA = makeHandler(a, b)
  const handlerB = makeHandler(b, a)
  a.addEventListener('scroll', handlerA)
  b.addEventListener('scroll', handlerB)
  return () => {
    a.removeEventListener('scroll', handlerA)
    b.removeEventListener('scroll', handlerB)
  }
}
