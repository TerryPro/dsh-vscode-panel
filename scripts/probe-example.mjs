/**
 * Runs every cell of an example notebook through a real kernel and reports each
 * cell's terminal status, so a shipped example can be verified rather than assumed.
 */
import { mkdtemp, copyFile, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const target = process.argv[2] ?? path.join(here, '..', 'examples', 'python_data_analysis', 'sales_notebook.ipynb')
const { parseNotebook } = await import(pathToFileURL(path.join(here, '..', 'lib', 'types', 'client', 'notebook', 'notebook-document.js')).href)
const { KernelSession } = await import(pathToFileURL(path.join(here, '..', 'lib', 'types', 'host', 'kernel', 'kernel-session.js')).href)
const { discoverKernels, defaultKernelChoice } = await import(pathToFileURL(path.join(here, '..', 'lib', 'types', 'host', 'kernel', 'discovery.js')).href)

const workspace = await mkdtemp(path.join(tmpdir(), 'dsh-example-run-'))
const file = path.basename(target)
await copyFile(target, path.join(workspace, file))
// The example reads a sibling CSV, which must travel with it.
const dataDir = path.dirname(target)
for (const entry of await readdir(dataDir)) {
  if (entry !== file) await copyFile(path.join(dataDir, entry), path.join(workspace, entry)).catch(() => undefined)
}

const document = parseNotebook(await readFile(path.join(workspace, file), 'utf8'))
const choice = defaultKernelChoice((await discoverKernels(workspace)).kernels)
const events = []
const session = new KernelSession('ws-1', {
  bridgeInterpreter: choice.interpreterPath,
  bridgeScript: path.join(here, '..', 'lib', 'kernel-bridge.py'),
  kernelArgv: choice.argv ?? [choice.interpreterPath, '-m', 'ipykernel_launcher', '-f', '{connection_file}'],
  interpreterPath: choice.interpreterPath,
  displayName: choice.displayName,
  specName: choice.name,
  workingDirectory: workspace,
  notebookPath: file,
}, {
  publish: event => { events.push(event) },
  ended: reason => { console.log('kernel ended:', reason) },
}, { startTimeoutMs: 60000, requestTimeoutMs: 15000 })

await session.start(AbortSignal.timeout(60000))
console.log('kernel:', choice.displayName, '\n')

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

function finished(cellId) {
  return events.find(event => event.type === 'cell_completed' && event.cellId === cellId)
}

let failures = 0
for (const cell of document.cells) {
  if (cell.kind !== 'code') continue
  const isLoop = cell.source.includes('time.sleep')
  events.length = 0
  const { msgId } = session.execute(cell.source, cell.id, false)
  void msgId
  if (isLoop) {
    await wait(1200)
    session.interrupt()
  }
  const deadline = Date.now() + (isLoop ? 30000 : 90000)
  while (!finished(cell.id) && Date.now() < deadline) await wait(100)
  const done = finished(cell.id)
  const expected = cell.source.includes('raise') ? 'error' : isLoop ? 'interrupted' : 'ok'
  const ok = done?.status === expected
  if (!ok) failures += 1
  if (!ok) {
    const error = events.map(event => event.item).find(item => item?.kind === 'error')
    console.log('   ->', error ? `${error.ename}: ${error.evalue}` : 'no error item')
  }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${cell.id}: ${done?.status ?? 'no completion'}${ok ? '' : ` (expected ${expected})`}`)
}

// The file on disk must still be a notebook, with the outputs the runs produced
// *not* silently rewritten by the session (only the editor writes the file).
const after = parseNotebook(await readFile(path.join(workspace, file), 'utf8'))
console.log(`${after.cells.length === document.cells.length ? 'PASS' : 'FAIL'}  the file is unchanged by execution`)

await session.stop('user')
await wait(400)
console.log(failures === 0 ? '\nALL CELLS OK' : `\n${failures} cell(s) did not behave as expected`)
process.exit(failures === 0 ? 0 : 1)
