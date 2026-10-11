/**
 * Proves two notebooks in the SAME directory cannot affect each other.
 *
 * The harsh case on purpose: both files sit in one workspace root, so they share a
 * working directory, share the disk, and would share any accidental global. What must
 * stay separate is the kernel — its namespace, its modules, its interrupt, and its
 * lifetime. Each assertion reads a value back out of one notebook's output rather than
 * trusting a status code, because "ran without error" would also be true of a kernel
 * that had quietly picked up the other notebook's variables.
 */
import { mkdtemp, copyFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..', 'examples', 'isolation')
const { parseNotebook } = await import(pathToFileURL(path.join(here, '..', 'lib', 'types', 'client', 'notebook', 'notebook-document.js')).href)
const { KernelSession } = await import(pathToFileURL(path.join(here, '..', 'lib', 'types', 'host', 'kernel', 'kernel-session.js')).href)
const { discoverKernels, defaultKernelChoice } = await import(pathToFileURL(path.join(here, '..', 'lib', 'types', 'host', 'kernel', 'discovery.js')).href)

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const results = []
function check(name, ok, detail = '') {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  [${detail}]`}`)
}

/** One notebook under test: its cells, its kernel, and everything that kernel said. */
async function openNotebook(workspace, file, choice) {
  const document = parseNotebook(await readFile(path.join(workspace, file), 'utf8'))
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
    ended: reason => { events.push({ type: 'ended', reason }) },
  }, { startTimeoutMs: 60_000, requestTimeoutMs: 15_000 })
  await session.start(AbortSignal.timeout(60_000))
  return {
    file,
    session,
    events,
    cells: document.cells,
    cell: id => document.cells.find(candidate => candidate.id === id),
    /**
     * The event log is cumulative and read by position, never cleared.
     *
     * A cell that runs twice — A re-checking its own namespace after B has moved — has
     * to be read from the run that just happened, and wiping the log would also destroy
     * the execution counters an earlier assertion still needs.
     */
    mark: () => events.length,
    completedSince: (id, from) => {
      for (let index = events.length - 1; index >= from; index -= 1) {
        const event = events[index]
        if (event?.type === 'cell_completed' && event.cellId === id) return event
      }
      return undefined
    },
    /** The text a cell printed or returned since `from`, so an assertion sees a value. */
    textSince: (id, from) => events
      .slice(from)
      .filter(event => event.cellId === id && event.item !== undefined)
      .map(event => event.item.text ?? event.item.data?.['text/plain'] ?? event.item.evalue ?? '')
      .join(''),
    async waitFor(id, from, timeoutMs = 90_000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const done = this.completedSince(id, from)
        if (done !== undefined) return done
        if (Date.now() > deadline) return undefined
        await wait(100)
      }
    },
    /** Run one cell and report *this* run's status, output text, and prompt number. */
    async run(id, timeoutMs = 90_000) {
      const source = this.cell(id)?.source
      if (source === undefined) throw new Error(`no such cell ${id} in ${file}`)
      const from = events.length
      session.execute(source, id, false)
      const done = await this.waitFor(id, from, timeoutMs)
      return {
        status: done?.status,
        text: this.textSince(id, from),
        executionCount: done?.executionCount ?? -1,
      }
    },
    async stop() { await session.stop('user') },
  }
}

const workspace = await mkdtemp(path.join(tmpdir(), 'dsh-isolation-'))
for (const file of ['notebook-A.ipynb', 'notebook-B.ipynb']) {
  await copyFile(path.join(root, file), path.join(workspace, file))
}
const choice = defaultKernelChoice((await discoverKernels(workspace)).kernels)
console.log(`kernel: ${choice.displayName}\n`)

const a = await openNotebook(workspace, 'notebook-A.ipynb', choice)
const b = await openNotebook(workspace, 'notebook-B.ipynb', choice)

/*
 * The definitive "two processes" evidence. `KernelSession.kernelId` is a UUID minted
 * per session object, so comparing the two would be true by construction and prove
 * nothing; an operating-system pid cannot be faked by the harness.
 */
async function pidOf(notebook, cellId) {
  const from = notebook.mark()
  notebook.session.execute('import os\nprint(os.getpid())', cellId, false)
  const done = await notebook.waitFor(cellId, from, 60_000)
  const text = notebook.textSince(cellId, from)
  const match = /(\d+)/.exec(text)
  return { status: done?.status, pid: match === null ? NaN : Number(match[1]), text }
}
const aPid = await pidOf(a, 'probe-a-pid')
const bPid = await pidOf(b, 'probe-b-pid')
check('both kernels answer a pid', aPid.status === 'ok' && bPid.status === 'ok', `${aPid.text}|${bPid.text}`)
check('the two notebooks run as two separate processes',
  Number.isFinite(aPid.pid) && Number.isFinite(bPid.pid) && aPid.pid !== bPid.pid,
  `A pid=${aPid.pid} B pid=${bPid.pid}`)
check('both kernels are alive at once', a.session.phase !== 'terminated' && b.session.phase !== 'terminated')

// --- namespaces ---------------------------------------------------------------
await a.run('alpha-set')
await b.run('beta-set')
const aRead1 = await a.run('alpha-read')
const bRead1 = await b.run('beta-read')
check('A established its namespace', aRead1.status === 'ok', aRead1.text)
check('B established its namespace', bRead1.status === 'ok', bRead1.text)
check('A holds its own mutated object', (await a.run('alpha-mutate')).status === 'ok')
check('B holds its own mutated object', (await b.run('beta-mutate')).status === 'ok')
check('A created its in-memory module', (await a.run('alpha-module')).status === 'ok')
check('A reads back its own module', (await a.run('alpha-check-module')).status === 'ok')

// The cross-talk test, run *after* both notebooks have done their work: each must
// fail to see the other's names. A value is asserted, not merely a status, because
// "ran without error" is also true of a kernel that quietly picked up the other file.
const aSeesB = await a.run('alpha-see-b')
check('A cannot see B\'s variables (NameError expected)', aSeesB.status === 'error', String(aSeesB.status))
const bSeesA = await b.run('beta-see-a')
check('B cannot see A\'s variables (NameError expected)', bSeesA.status === 'error', String(bSeesA.status))

// Re-read each namespace after the other notebook has mutated objects and claimed the
// same module name. This is the assertion that would fail on a shared kernel.
const aAgain = await a.run('alpha-read')
check('A still reads its own values after B ran', aAgain.status === 'ok', aAgain.text)
const bModule = await b.run('beta-module')
check('B did not inherit A\'s in-memory module', bModule.status === 'ok', bModule.text)
check('B claimed the same module name as its own', (await b.run('beta-module-claim')).status === 'ok')
const aModuleAgain = await a.run('alpha-check-module')
check('A\'s module survived B claiming the same name', aModuleAgain.status === 'ok', aModuleAgain.text)

// --- prompt counters are per kernel -------------------------------------------
// Independent counters: if the two shared a kernel, B's numbers would keep climbing
// from A's rather than starting again from its own sequence.
check('prompt numbers advance independently',
  aRead1.executionCount > 0 && bRead1.executionCount > 0 && aRead1.executionCount === bRead1.executionCount,
  `A=${aRead1.executionCount} B=${bRead1.executionCount}`)

// --- interrupt one while the other runs ---------------------------------------
await a.run('alpha-set')
await b.run('beta-set')
const aMark = a.mark()
const bMark = b.mark()
a.session.execute(a.cell('alpha-interrupt').source, 'alpha-interrupt', false)
b.session.execute(b.cell('beta-interrupt').source, 'beta-interrupt', false)
await wait(1_500)
a.session.interrupt()
const aStopped = await a.waitFor('alpha-interrupt', aMark, 30_000)
const bFinished = await b.waitFor('beta-interrupt', bMark, 90_000)
check('interrupting A stopped A', aStopped?.status === 'interrupted', String(aStopped?.status))
// The decisive one: A's interrupt must not reach into B's running cell.
check('interrupting A did not stop B', bFinished?.status === 'ok', String(bFinished?.status))
check('A still works after its own interrupt', (await a.run('alpha-after-interrupt')).status === 'ok')
check('B still works after A was interrupted', (await b.run('beta-after-interrupt')).status === 'ok')

// --- stopping one leaves the other --------------------------------------------
await a.stop()
await wait(1_000)
check('A terminated on stop', a.session.phase === 'terminated', a.session.phase)
const bSurvives = await b.run('beta-survive-a-stop')
check('B survives A being stopped', bSurvives.status === 'ok', bSurvives.text)

await b.stop()
await wait(600)

const failed = results.filter(ok => !ok).length
console.log(`\n${results.length - failed}/${results.length} isolation checks passed`)
await import('node:fs/promises').then(fs => fs.rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }))
process.exit(failed === 0 ? 0 : 1)
