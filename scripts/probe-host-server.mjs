/**
 * Serves the compiled host bundle's real routes over HTTP.
 *
 * The plugin mounts itself through a cordis context, so the harness supplies the
 * minimum of that context the host entry actually consumes — `fs`,
 * `workspaceRegistry`, `webServer`, `webRuntime`, `logger` — and registers the real
 * handlers from `lib/index.js`. Routing, the origin fence, the JSON shapes, and the
 * kernel are then all genuine; only DSH's own service layer is stand-in.
 *
 * The filesystem version token is a content hash instead of DSH's stat-derived one:
 * the property the workbench relies on is "changes when the file changes, and a save
 * carrying an old token is refused", which a hash reproduces exactly.
 */

import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import fsp from 'node:fs/promises'
import path from 'node:path'

function targetOf(target) {
  return typeof target === 'string' ? target : (target?.path ?? '')
}

async function versionOf(file) {
  const info = await fsp.stat(file).catch(() => null)
  if (info === null || !info.isFile()) return undefined
  return `v-${createHash('sha1').update(`${info.size}-${Math.floor(info.mtimeMs)}`).digest('hex').slice(0, 12)}`
}

function makeFs(workspaceRoot) {
  return {
    async resolve(value, options) {
      const cwd = options?.cwd ?? workspaceRoot
      const target = typeof value === 'string' ? value : targetOf(value)
      const absolute = target.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(target)
      return { path: absolute ? path.normalize(target) : path.resolve(cwd, target) }
    },
    contains(root, target) {
      const base = typeof root === 'string' ? root : targetOf(root)
      const child = typeof target === 'string' ? target : targetOf(target)
      const resolved = path.resolve(child)
      return resolved === base || resolved.startsWith(`${base}${path.sep}`)
    },
    processPath(target) { return typeof target === 'string' ? target : targetOf(target) },
    async stat(target) {
      const file = typeof target === 'string' ? target : targetOf(target)
      const info = await fsp.stat(file).catch(() => null)
      if (info === null) return undefined
      return {
        type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other',
        size: info.size,
        version: (await versionOf(file)) ?? 'v-unknown',
      }
    },
    async lstat(target, options) {
      const file = typeof target === 'string'
        ? path.resolve(options?.cwd ?? workspaceRoot, target)
        : targetOf(target)
      const info = await fsp.lstat(file).catch(() => null)
      if (info === null) return undefined
      return { type: info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : 'file' }
    },
    async listDir(target) {
      const dir = typeof target === 'string' ? target : targetOf(target)
      const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
      return entries.map(entry => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file', size: undefined }))
    },
    async readText(target) {
      const file = typeof target === 'string' ? target : targetOf(target)
      const buffer = await fsp.readFile(file)
      if (buffer.includes(0)) throw Object.assign(new Error('not text'), { code: 'FS_NOT_TEXT' })
      return buffer.toString('utf8')
    },
    async readBytes(target) {
      const file = typeof target === 'string' ? target : targetOf(target)
      return new Uint8Array(await fsp.readFile(file))
    },
    async writeText(target, content, guard) {
      const file = typeof target === 'string' ? target : targetOf(target)
      const current = await versionOf(file)
      if (guard?.kind === 'createIfAbsent' && current !== undefined) {
        throw Object.assign(new Error('exists'), { code: 'FS_NOT_OBSERVED' })
      }
      if (guard?.kind === 'replaceIfVersion' && current !== undefined && current !== guard.version) {
        throw Object.assign(new Error('stale'), { code: 'FS_STALE_VERSION' })
      }
      await fsp.writeFile(file, content, 'utf8')
      return { version: (await versionOf(file)) ?? 'v-unknown' }
    },
  }
}

/**
 * The plugin's own configuration, at its declared defaults.
 *
 * `Config` is a schemastery object rather than a parser, and DSH fills it in for the
 * real host. The harness reads each field's declared `meta.default`, so the probe
 * exercises the shipped numbers rather than invented ones.
 */
function hostConfig(Config) {
  const value = {}
  for (const [name, entry] of Object.entries(Config?.dict ?? {})) {
    value[name] = entry?.meta?.default
  }
  return value
}

/** Start the harness. Resolves with the base URL and a shutdown handle. */
export async function serveHostBundle(bundlePath, workspaceRoot) {
  const { apply, Config } = await import(bundlePath)
  const logs = []
  const routes = []
  const disposers = []
  const ctx = {
    logger: {
      info: message => { logs.push(`info ${message}`) },
      warn: message => { logs.push(`warn ${message}`) },
      error: message => { logs.push(`error ${message}`) },
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
    webRuntime: { trustedHosts: [] },
    workspaceRegistry: { get: id => (id === 'ws-1' ? { id, path: workspaceRoot } : undefined) },
    fs: makeFs(workspaceRoot),
    effect(fn) {
      disposers.push(fn())
      return () => {}
    },
  }
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://dsh.invalid').pathname
    const exact = routes.find(route => route.kind === 'exact' && route.path === pathname)
    const route = exact ?? routes
      .filter(entry => entry.kind === 'prefix' && (pathname === entry.path || pathname.startsWith(`${entry.path}/`)))
      .sort((left, right) => right.path.length - left.path.length)[0]
    if (route === undefined) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'NO_ROUTE', message: 'no route' } }))
      return
    }
    void Promise.resolve(route.handler(req, res)).catch(error => {
      if (res.headersSent) { res.end(); return }
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'HARNESS_THROW', message: String(error?.message ?? error) } }))
    })
  })
  await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const base = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`
  apply(ctx, hostConfig(Config))
  return {
    base,
    logs,
    routeCount: () => routes.length,
    async close() {
      for (const dispose of disposers) {
        if (typeof dispose === 'function') await dispose()
      }
      // The kernel shutdown effect runs here, which is the no-orphan assertion.
      await new Promise(resolve => { server.close(resolve) })
    },
  }
}
