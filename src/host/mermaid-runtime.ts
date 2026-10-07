/** Serve the built Mermaid runtime bundle with cheap ETag revalidation. */

import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * A short content revision for the runtime bundle: its size and mtime, hashed.
 *
 * Used as an ETag so a rebuild that changes the bytes busts the browser cache,
 * while an unchanged bundle keeps a cheap 304 across reloads instead of
 * re-downloading a multi-megabyte library. Stat-ing costs nothing next to
 * reading the bundle; an absent bundle (not yet built) reports `unbuilt`, and
 * serving then answers 404.
 * @param path - absolute on-disk path of the built runtime bundle.
 * @returns a short revision token, or `unbuilt` when the file is missing.
 */
export async function mermaidRuntimeRevision(path: string): Promise<string> {
  try {
    const info = await stat(path)
    return createHash('sha1').update(`${info.size}-${Math.floor(info.mtimeMs)}`).digest('hex').slice(0, 16)
  } catch {
    return 'unbuilt'
  }
}

/**
 * Answer one GET/HEAD for the Mermaid runtime bundle.
 *
 * The bundle is public, open-source library code carrying no workspace data, so
 * this route is intentionally not behind the workbench's origin fence (matching
 * the shipped document preview's own runtime route). A matching `If-None-Match`
 * yields 304; a changed bundle is served fresh; a missing one answers 404 so the
 * client shows a clear "runtime unavailable" state rather than a blank pane.
 * @param req - the incoming request.
 * @param res - the response this handler owns end to end.
 * @param path - absolute on-disk path of the built runtime bundle.
 */
export async function serveMermaidRuntime(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Cache-Control': 'no-store' })
    res.end()
    return
  }
  const etag = `"${await mermaidRuntimeRevision(path)}"`
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { 'ETag': etag, 'Cache-Control': 'no-cache' })
    res.end()
    return
  }
  try {
    const body = await readFile(path)
    // No Content-Length: the WebServer may gzip socket-backed responses, and a
    // chunked body stays correct whatever transform the server applies.
    res.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
      'ETag': etag,
      'X-Content-Type-Options': 'nosniff',
    })
    if (req.method === 'HEAD') res.end()
    else res.end(body)
  } catch {
    res.writeHead(404, { 'Cache-Control': 'no-store' })
    res.end()
  }
}
