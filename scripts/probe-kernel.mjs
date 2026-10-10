#!/usr/bin/env node
/**
 * Drives the compiled host bundle's kernel API over real HTTP with a real kernel.
 *
 * The plugin's own process cannot be restarted from inside a running DSH host, so
 * this harness mounts the built routes into a stand-in context and talks to them the
 * way the browser would: same-origin `fetch`, a real `EventSource`, and an actual
 * `ipykernel` child process. Routing, the origin fence, token authorization, sequence
 * replay, output translation, interruption, and process cleanup are therefore all
 * exercised as shipped code.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { serveHostBundle } from './probe-host-server.mjs'
import { openEventStream } from './probe-sse.mjs'
import {
  scenarioFailure, scenarioInterrupt, scenarioIntrospection, scenarioRich, scenarioState,
} from './probe-scenarios.mjs'
import {
  scenarioPoll, scenarioRestart, scenarioStream, scenarioTeardown, scenarioTwoNotebooks,
} from './probe-transport.mjs'

const execFileAsync = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const bundlePath = path.join(here, '..', 'lib', 'index.js')

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  [${detail}]`}`)
}

/** Python processes that are running now, to tell a leftover kernel from an unrelated one. */
async function pythonPids() {
  if (process.platform !== 'win32') {
    const { stdout } = await execFileAsync('pgrep', ['-f', 'ipykernel_launcher']).catch(() => ({ stdout: '' }))
    return stdout.split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
  }
  const { stdout } = await execFileAsync('wmic', [
    'process', 'where', 'name=\'python.exe\'', 'get', 'ProcessId', '/format:csv',
  ]).catch(() => ({ stdout: '' }))
  return stdout.split(/\r?\n/u)
    .map(line => line.split(',').pop()?.trim())
    .filter(entry => entry !== undefined && /^\d+$/u.test(entry ?? ''))
}

function notebookBody() {
  return {
    cells: [
      { cell_type: 'markdown', id: 'md1', source: '# Probe', metadata: {} },
      { cell_type: 'code', id: 'c1', source: ['x = 41'], outputs: [], execution_count: null, metadata: {} },
      { cell_type: 'code', id: 'c2', source: ['print("from c2")', 'x * 2'], outputs: [], execution_count: null, metadata: {} },
      { cell_type: 'code', id: 'c3', source: ['raise RuntimeError("probe failure")'], outputs: [], execution_count: null, metadata: {} },
      { cell_type: 'code', id: 'c4', source: ['import time'], outputs: [], execution_count: null, metadata: {} },
      { cell_type: 'code', id: 'c5', source: ['pass'], outputs: [], execution_count: null, metadata: {} },
      { cell_type: 'code', id: 'c6', source: ['pass'], outputs: [], execution_count: null, metadata: {} },
      { cell_type: 'code', id: 'c7', source: ['pass'], outputs: [], execution_count: null, metadata: {} },
      { cell_type: 'code', id: 'c8', source: ['pass'], outputs: [], execution_count: null, metadata: {} },
      { cell_type: 'code', id: 'x1', source: ['pass'], outputs: [], execution_count: null, metadata: {} },
    ],
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python' },
    },
    nbformat: 4,
    nbformat_minor: 5,
  }
}

const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'dsh-notebook-probe-'))
await writeFile(path.join(workspaceRoot, 'probe.ipynb'), `${JSON.stringify(notebookBody(), null, 1)}\n`, 'utf8')
await writeFile(path.join(workspaceRoot, 'probe-b.ipynb'), `${JSON.stringify(notebookBody(), null, 1)}\n`, 'utf8')

const host = await serveHostBundle(pathToFileURL(bundlePath).href, workspaceRoot)
const base = host.base
const STREAM = '/dsh-workbench-layout/kernel/stream'
const PREFIX = '/dsh-workbench-layout/kernel'
console.log(`host routes at ${base} (${host.routeCount()} registered)`)

function makeClient(handle, notebookPath, streamSince = 1) {
  const client = {
    handle,
    notebookPath,
    base,
    async post(pathname, body) {
      const response = await fetch(`${base}${PREFIX}${pathname}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify(body),
      })
      return { status: response.status, value: await response.json().catch(() => null) }
    },
    async poll(since) {
      const query = new URLSearchParams({
        kernelId: client.handle.kernelId, token: client.handle.token,
        workspaceId: client.handle.workspaceId, since: String(since),
      })
      const response = await fetch(`${base}${PREFIX}/poll?${query.toString()}`, { headers: { origin: base } })
      return { status: response.status, value: await response.json().catch(() => null) }
    },
    reopenStream(since) {
      const query = new URLSearchParams({
        kernelId: client.handle.kernelId, token: client.handle.token, since: String(since),
      })
      // Node has no global EventSource; this reads the same wire format the browser's
      // does, so the Host's real SSE handler is still what is under test.
      return openEventStream(`${base}${STREAM}?${query.toString()}`)
    },
  }
  client.stream = client.reopenStream(streamSince)
  return client
}

const pidsBefore = new Set(await pythonPids())

// --- discovery, then start ------------------------------------------------------
const discover = await (await fetch(`${base}/dsh-workbench-layout/kernel/discover`, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: base },
  body: JSON.stringify({ workspaceId: 'ws-1' }),
})).json()
check('discover lists a usable kernel', discover.usable === true,
  (discover.kernels ?? []).map(kernel => `${kernel.name}=${kernel.available}`).join(','))
check('discover reports the resolved interpreter',
  (discover.kernels ?? []).some(kernel => typeof kernel.interpreterPath === 'string'))
check('discover reports no absolute path in the message field', !JSON.stringify(discover).includes(workspaceRoot))

const started = await fetch(`${base}/dsh-workbench-layout/kernel/start`, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: base },
  body: JSON.stringify({ workspaceId: 'ws-1', path: 'probe.ipynb' }),
})
const startValue = await started.json().catch(() => null)
check('start returned a kernel', started.status === 200 && typeof startValue?.kernelId === 'string',
  JSON.stringify(startValue).slice(0, 160))
if (typeof startValue?.kernelId !== 'string') {
  console.log('\ncannot continue: the kernel did not start')
  await host.close()
  process.exit(1)
}

const handle = { workspaceId: 'ws-1', kernelId: startValue.kernelId, token: startValue.token }
const client = makeClient(handle, 'probe.ipynb')
check('start names the kernel language', startValue.language === 'python', startValue.language)

// The fence has to hold for the kernel prefix exactly as it does for files.
const crossSite = await fetch(`${base}/dsh-workbench-layout/kernel/discover`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' },
  body: JSON.stringify({ workspaceId: 'ws-1' }),
})
check('a cross-site kernel request is rejected', crossSite.status === 403, String(crossSite.status))
const noToken = await client.post('/execute', { workspaceId: 'ws-1', kernelId: handle.kernelId, code: 'x' })
check('a missing token is refused', noToken.status === 400, String(noToken.value?.error?.code))
const badToken = await client.post('/execute', { ...handle, token: 'guessed', code: 'x' })
check('a wrong token is refused', badToken.status === 403, String(badToken.value?.error?.code))
const otherSpace = await client.post('/execute', { ...handle, workspaceId: 'ws-9', code: 'x' })
check('another workspace cannot claim the kernel', otherSpace.status === 403, String(otherSpace.value?.error?.code))
const unknown = await client.post('/execute', { ...handle, kernelId: 'nope', code: 'x' })
check('an unknown kernel id is a 404', unknown.status === 404, String(unknown.value?.error?.code))
const getOnPost = await fetch(`${base}/dsh-workbench-layout/kernel/execute`, { headers: { origin: base } })
check('a GET on a POST-only kernel route is refused', getOnPost.status === 405, String(getOnPost.status))

// The kernel announces itself on the stream before anything runs.
await new Promise(resolve => setTimeout(resolve, 1_200))
check('the info frame arrived', client.stream.state.frames.some(frame => frame.type === 'info'))
const info = client.stream.state.frames.find(frame => frame.type === 'info')
check('kernel_info reported ipykernel', typeof info?.info?.implementation === 'string' && info.info.implementation.length > 0,
  `${info?.info?.implementation}@${info?.info?.implementationVersion}`)

await scenarioStream(client, check)
await scenarioState(client, check)
await scenarioFailure(client, check)
await scenarioRich(client, check)
await scenarioInterrupt(client, check)
await scenarioIntrospection(client, check)
await scenarioPoll(client, check)

// Two notebooks, two namespaces.
const secondStart = await client.post('/start', { workspaceId: 'ws-1', path: 'probe-b.ipynb' })
if (typeof secondStart.value?.kernelId === 'string') {
  const second = makeClient(
    { workspaceId: 'ws-1', kernelId: secondStart.value.kernelId, token: secondStart.value.token },
    'probe-b.ipynb', 1,
  )
  await scenarioTwoNotebooks(client, check, async () => second)
  second.stream.close()
} else {
  check('a second notebook could start its own kernel', false, String(secondStart.status))
}

await scenarioRestart(client, check)
await scenarioTeardown(client, check, host.close, pythonPids, pidsBefore)

// The file the notebook tab would save: outputs must have been written by the view,
// so here the raw file is asserted to still be valid notebook JSON.
const after = JSON.parse(await fsp.readFile(path.join(workspaceRoot, 'probe.ipynb'), 'utf8'))
check('the notebook file is still valid nbformat json', after.nbformat === 4 && Array.isArray(after.cells))

const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
await fsp.rm(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined)
process.exit(failed.length === 0 ? 0 : 1)
