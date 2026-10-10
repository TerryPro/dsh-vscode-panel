/**
 * A minimal SSE reader for the probe.
 *
 * Node has no global `EventSource`, and installing one for a script would be a
 * dependency the shipped code does not use. This reads the same wire format the
 * browser does — `event:`/`data:` pairs separated by a blank line — over a streaming
 * `fetch` body, so the probe still exercises the Host's real SSE handler: its
 * headers, its snapshot-then-replay order, and its live push.
 */

export function openEventStream(url, { onEvent } = {}) {
  const controller = new AbortController()
  const state = { frames: [], snapshots: [], ends: [], open: false, errors: 0 }
  let closed = false

  const dispatch = (name, data) => {
    let value
    try {
      value = JSON.parse(data)
    } catch {
      return
    }
    if (name === 'frame') state.frames.push(value)
    else if (name === 'snapshot') state.snapshots.push(value)
    else if (name === 'end') state.ends.push(value)
    onEvent?.(name, value)
  }

  const run = async () => {
    try {
      const response = await fetch(url, { signal: controller.signal, headers: { accept: 'text/event-stream' } })
      if (!response.ok || response.body === null) {
        state.errors += 1
        return
      }
      state.open = true
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        buffer += decoder.decode(value, { stream: true })
        for (;;) {
          // An SSE event ends at a blank line; a comment (`: ping`) is skipped.
          const boundary = buffer.indexOf('\n\n')
          if (boundary < 0) break
          const block = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          let name = 'message'
          const dataLines = []
          for (const line of block.split('\n')) {
            if (line.startsWith(':')) continue
            if (line.startsWith('event:')) name = line.slice(6).trim()
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
          }
          if (dataLines.length > 0) dispatch(name, dataLines.join('\n'))
        }
      }
    } catch (error) {
      if (!closed) state.errors += 1
      void error
    }
  }

  void run()
  return {
    state,
    close() {
      closed = true
      controller.abort()
    },
    ofType: type => state.frames.filter(frame => frame.type === type),
    forCell: (cellId, type) => state.frames.filter(frame => (
      frame.cellId === cellId && (type === undefined || frame.type === type)
    )),
    lastSequence: () => state.frames.at(-1)?.sequence ?? 0,
    /** Resolves once the browser-side equivalent of `open` has happened. */
    async waitForOpen(timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        if (state.open) return true
        if (Date.now() > deadline) return false
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    },
  }
}
