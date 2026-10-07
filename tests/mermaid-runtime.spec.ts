import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mermaidRuntimeRevision, serveMermaidRuntime } from '../src/host/mermaid-runtime.ts'

let dir: string
let bundle: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsw-mermaid-'))
  bundle = join(dir, 'mermaid-runtime.js')
  await writeFile(bundle, 'export default { render() {} }\n', 'utf8')
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

interface FakeResponse {
  statusCode: number
  headers: Record<string, string | number>
  body: Buffer | undefined
  ended: boolean
}

function makeRes(): FakeResponse {
  const res: FakeResponse = { statusCode: 0, headers: {}, body: undefined, ended: false }
  Object.assign(res, {
    writeHead(status: number, headers?: Record<string, string | number>) {
      res.statusCode = status
      if (headers !== undefined) Object.assign(res.headers, headers)
      return res
    },
    end(chunk?: Buffer) {
      res.body = chunk
      res.ended = true
      return res
    },
  })
  return res
}

function makeReq(method: string, headers: Record<string, string> = {}): IncomingMessage {
  return { method, headers } as unknown as IncomingMessage
}

function asServerResponse(res: FakeResponse): ServerResponse {
  return res as unknown as ServerResponse
}

describe('mermaidRuntimeRevision', () => {
  it('hashes an existing bundle and reports unbuilt for a missing one', async () => {
    const revision = await mermaidRuntimeRevision(bundle)
    expect(revision).toMatch(/^[0-9a-f]{16}$/u)
    expect(await mermaidRuntimeRevision(bundle)).toBe(revision)
    expect(await mermaidRuntimeRevision(join(dir, 'nope.js'))).toBe('unbuilt')
  })
})

describe('serveMermaidRuntime', () => {
  it('serves the bundle as JavaScript with an ETag on GET', async () => {
    const res = makeRes()
    await serveMermaidRuntime(makeReq('GET'), asServerResponse(res), bundle)
    expect(res.statusCode).toBe(200)
    expect(res.headers['Content-Type']).toBe('text/javascript; charset=utf-8')
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff')
    expect(String(res.headers.ETag)).toMatch(/^"[0-9a-f]{16}"$/u)
    expect(res.body?.toString('utf8')).toContain('export default')
  })

  it('answers 304 without a body when the ETag still matches', async () => {
    const etag = `"${await mermaidRuntimeRevision(bundle)}"`
    const res = makeRes()
    await serveMermaidRuntime(makeReq('GET', { 'if-none-match': etag }), asServerResponse(res), bundle)
    expect(res.statusCode).toBe(304)
    expect(res.body).toBeUndefined()
  })

  it('omits the body for HEAD but still sends the headers', async () => {
    const res = makeRes()
    await serveMermaidRuntime(makeReq('HEAD'), asServerResponse(res), bundle)
    expect(res.statusCode).toBe(200)
    expect(res.body).toBeUndefined()
    expect(res.headers.ETag).toBeDefined()
  })

  it('answers 404 for a bundle that is not built', async () => {
    const res = makeRes()
    await serveMermaidRuntime(makeReq('GET'), asServerResponse(res), join(dir, 'missing.js'))
    expect(res.statusCode).toBe(404)
    expect(res.ended).toBe(true)
  })

  it('rejects a non-GET/HEAD method with 405', async () => {
    const res = makeRes()
    await serveMermaidRuntime(makeReq('POST'), asServerResponse(res), bundle)
    expect(res.statusCode).toBe(405)
  })
})
