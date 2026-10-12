#!/usr/bin/env node
/**
 * Scenario bundle for the SQL-notebook gate (`npm run test:sql`). Re-executed by
 * probe-sql.mjs under the DSH host runtime (ELECTRON_RUN_AS_NODE=1), so every
 * `node:sqlite` measurement below is taken on the SAME runtime the shipped plugin uses
 * — not on whatever Node is on PATH. That distinction is not pedantry: the design of
 * this feature rests on measured behaviour, and PATH node differs from the host.
 *
 * Two layers, reported apart on purpose:
 *
 *   FACTS — the runtime primitives the design rests on. Must stay green. If one flips
 *           (host Node upgrade, node:sqlite bump), the gate exits 2, because the
 *           feature would then be built on a claim that is no longer true.
 *   GATES — the SQL-notebook surface. EXPECTED RED until the matching milestone lands;
 *           that red is A0's deliverable.
 *
 * Usage:
 *   node scripts/probe-sql.mjs                 full run
 *   node scripts/probe-sql.mjs --only A1       one milestone's gates only (exit 0 when
 *                                              facts green AND those gates green) — this
 *                                              is how each PR proves its own slice.
 *
 * Exit codes: 0 = as required by the selection; 1 = gates still red; 2 = runtime drift.
 */
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { serveHostBundle } from './probe-host-server.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
// pathToFileURL, not a bare absolute path: on Windows the ESM loader rejects
// `import('F:\\...')` as an unknown protocol, which is exactly what broke the first run.
const bundlePath = pathToFileURL(path.join(here, '..', 'lib', 'index.js')).href
// Accept both `--only A1` and `--only=A1`; the first revision documented the space form
// while only parsing the equals form, so a reader following the header silently got a full
// unfiltered run. Anything else that starts with `--` is reported rather than ignored.
function parseOnly(argv) {
  const unknown = []
  let only = undefined
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--only') { only = argv[i + 1]; i += 1; continue }
    if (a.startsWith('--only=')) { only = a.slice('--only='.length); continue }
    if (a.startsWith('--')) unknown.push(a)
  }
  for (const flag of unknown) console.error(`ignoring unknown flag: ${flag}`)
  return only
}

const only = parseOnly(process.argv.slice(2).filter(a => a !== '--host' && !a.startsWith('--host=')))

// A crash here is a defect in the gate itself, and it must not be mistaken for a failing
// assertion: report it distinctly and exit 2 so CI never reads it as "expected red".
process.on('uncaughtException', (error) => {
  console.error('\nGATE CRASHED (this is a defect in the probe, not a failing assertion):')
  console.error(error?.stack ?? error)
  process.exit(2)
})

const facts = []
const gates = []
function fact(name, ok, detail = '') {
  facts.push({ name, ok: Boolean(ok) })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}
function gate(tag, name, ok, detail = '') {
  gates.push({ tag, name, ok: Boolean(ok) })
  if (only !== undefined && only !== tag) return
  console.log(`  ${ok ? 'PASS' : 'RED '}  ${tag}  ${name}${detail ? `  [${detail}]` : ''}`)
}

console.log('SQL-notebook gate — runtime:', process.version,
  process.versions.electron ? `(Electron ${process.versions.electron})` : '(NOT Electron — wrong runtime)')

const sqlite = await import('node:sqlite').catch(() => undefined)
const C = sqlite?.constants ?? {}

// ===============================================================================
// FACTS — measured runtime behaviour
// ===============================================================================
console.log('\n[facts] node:sqlite on the host runtime')
const { DatabaseSync } = sqlite ?? {}
fact('runtime is Electron (the plugin loads inside the host, not PATH node)',
  process.versions.electron !== undefined, process.versions.electron ?? 'no process.versions.electron')
fact('node:sqlite exposes DatabaseSync', typeof DatabaseSync === 'function')

const dir = await mkdtemp(path.join(tmpdir(), 'dsh-sql-gate-'))
const dbFile = path.join(dir, 'fixture.db')
{
  const db = new DatabaseSync(dbFile)
  db.exec("CREATE TABLE t(id INTEGER, a INTEGER, b TEXT); INSERT INTO t VALUES(1,42,'x'),(2,43,'y')")
  db.close()
}

{
  // 1. Reading an out-of-range INTEGER throws instead of truncating, so the host must
  //    open the BigInt door and normalize per value. If this ever stops throwing, the
  //    normalization policy needs re-deriving — hence a fact, not a comment.
  const db = new DatabaseSync(dbFile, { readOnly: true })
  try {
    let threw = false
    try { db.prepare('SELECT 9007199254740993 AS v').get() }
    catch (e) { threw = /too large|OUT_OF_RANGE/u.test(`${e?.code ?? ''} ${e?.message ?? ''}`) }
    fact('out-of-range INTEGER throws on default read (must open readBigInts)', threw)

    const st = db.prepare('SELECT 42 AS small')
    st.setReadBigInts(true)
    fact('readBigInts:true turns even 42 into BigInt (normalize must test each value)',
      typeof st.get().small === 'bigint')

    const blob = db.prepare("SELECT x'0102fa' AS b").get().b
    fact('BLOB arrives as Uint8Array', blob instanceof Uint8Array)
    fact('JSON.stringify(Uint8Array) is silent garbage (must base64 before sendJson)',
      /"0":1/u.test(JSON.stringify({ b: blob })))
  } finally { db.close() }
}
{
  // 2. Object rows lose values under duplicate column names, while columns() keeps every
  //    name and setReturnArrays yields a 1:1 aligned array. The feature therefore ships
  //    array rows (ADR 0005) — and labels, not raw names, are what the user sees.
  const db = new DatabaseSync(dbFile)
  const objRow = db.prepare('SELECT a, a FROM t LIMIT 1').get()
  fact('object row silently collapses duplicate columns',
    Object.keys(objRow).length === 1, JSON.stringify(objRow))
  const names = db.prepare('SELECT a, a FROM t LIMIT 1').columns().map(entry => entry.name)
  fact('columns() reports the true column count and names', names.length === 2 && names[0] === 'a' && names[1] === 'a')
  const arr = db.prepare('SELECT 1 AS x, 2 AS x')
  arr.setReturnArrays(true)
  const row = arr.get()
  fact('setReturnArrays yields one value per column', Array.isArray(row) && row.length === 2 && row[0] === 1 && row[1] === 2, JSON.stringify(row))
  db.close()
}
{
  // 3. The authorizer is the only cross-database fence, and it has two traps: a boolean
  //    return kills every statement, and the action codes share a value range with the
  //    authorization codes. Compare by NAME, forever.
  const db = new DatabaseSync(dbFile, { readOnly: true })
  try {
    db.setAuthorizer(() => /** @type {any} */ (false))
    let broke = false
    try { db.prepare('SELECT 1').get() } catch { broke = true }
    fact('authorizer must return an integer code (boolean breaks all statements)', broke)
  } finally { db.close() }
  fact('authorization codes collide with action codes (never reverse-lookup by value)',
    C.SQLITE_DENY === C.SQLITE_CREATE_INDEX && C.SQLITE_IGNORE === C.SQLITE_CREATE_TABLE,
    `DENY=${C.SQLITE_DENY}/CREATE_INDEX=${C.SQLITE_CREATE_INDEX}`)

  // 4. `readOnly` is NOT the fence for reading other files: ATTACH succeeds on a readonly
  //    connection. Only the authorizer stops it. A future "simplify by dropping the
  //    authorizer" refactor must fail here.
  const probe = new DatabaseSync(dbFile, { readOnly: true })
  const target = path.join(dir, 'attacher.db')
  const seed = new DatabaseSync(target)
  seed.exec('CREATE TABLE z(q); INSERT INTO z VALUES(1)')
  seed.close()
  let attachOnReadonly = true
  try { probe.exec(`ATTACH DATABASE '${target.replace(/'/gu, '')}' AS extra`) } catch { attachOnReadonly = false }
  const sawAttach = attachOnReadonly
  probe.close()
  fact('readOnly alone lets ATTACH reach another file (authorizer is mandatory)', sawAttach)
}
{
  // 5. Read-only keeps the whole scratch workflow alive; `query_only` must never be set
  //    because it destroys the temporary-table half of it.
  const db = new DatabaseSync(dbFile, { readOnly: true })
  const before = await sha256(dbFile)
  db.exec('CREATE TEMP TABLE s(x); INSERT INTO s VALUES (1), (2)')
  const joined = db.prepare('SELECT count(*) AS n FROM s JOIN t').get().n
  db.exec('BEGIN; SAVEPOINT sp; RELEASE sp; COMMIT')
  fact('read-only allows TEMP tables, writes into them, joins to main, and transactions', Number(joined) > 0)
  let mainWrite = false
  try { db.exec("INSERT INTO t VALUES (9, 9, 'z')") } catch { mainWrite = true }
  let vacuum = false
  try { db.exec('VACUUM') } catch { vacuum = true }
  fact('read-only refuses main-table writes and VACUUM', mainWrite && vacuum)
  db.exec('PRAGMA query_only=ON')
  let tempAfterQueryOnly = true
  try { db.exec('CREATE TEMP TABLE q(z)') } catch { tempAfterQueryOnly = false }
  fact('PRAGMA query_only=ON breaks TEMP (must stay denied)', !tempAfterQueryOnly)
  db.close()
  fact('read-only scratch workflow leaves the database file byte-identical', before === await sha256(dbFile))
}
{
  // 6. The sidecar residue the feature accepts and must not promise to clean up.
  const wal = path.join(dir, 'wal.db')
  const w = new DatabaseSync(wal)
  w.exec('PRAGMA journal_mode=WAL; CREATE TABLE w(x); INSERT INTO w VALUES (1)')
  w.close()
  const r = new DatabaseSync(wal, { readOnly: true })
  r.prepare('SELECT * FROM w').all()
  r.close()
  const residue = (await readdir(dir)).filter(name => name.startsWith('wal.db-'))
  fact('read-only WAL query leaves -wal/-shm behind after close (residue is expected)',
    residue.some(name => name.endsWith('-wal')) && residue.some(name => name.endsWith('-shm')), residue.join(' '))
}
{
  // 7. A slow synchronous query blocks the thread; chunked iteration yields to it. The
  //    feature is built on the second shape, so the gate measures both. Failures here are
  //    reported as facts, never thrown: a flipped fact must read as drift, not as a crash.
  const timed = async (body) => {
    // Measure AFTER the body: an object literal `{ ms: Date.now() - start, ticks: await body() }`
    // evaluates ms first, so the synchronous query's duration was never actually observed.
    const startedAt = Date.now()
    let ticks
    try { ticks = await body() }
    catch (error) { return { ms: Date.now() - startedAt, ticks: `threw: ${String(error?.message ?? error)}` } }
    return { ms: Date.now() - startedAt, ticks }
  }
  const sync = await timed(async () => {
    const db = new DatabaseSync(dbFile)
    let ticks = 0
    const timer = setInterval(() => { ticks += 1 }, 20)
    db.prepare('WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v+1 FROM n WHERE v < 3000000) SELECT count(*) AS c FROM n').get()
    clearInterval(timer)
    db.close()
    return ticks
  })
  fact('synchronous query blocks timers outright (main-thread work must be chunked)',
    sync.ticks === 0 && sync.ms > 200, `ticks=${sync.ticks} ${sync.ms}ms`)

  const chunked = await timed(async () => {
    const db = new DatabaseSync(dbFile)
    let ticks = 0
    const timer = setInterval(() => { ticks += 1 }, 20)
    const it = db.prepare('WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v+1 FROM n WHERE v < 300000) SELECT v FROM n').iterate()
    // Yield with a real gap between chunks: a bare await on a 0ms macrotask would not
    // prove the timer can fire, which is the whole point of the shipped execution shape.
    let taken = 0
    for (const value of it) {
      taken += 1
      void value
      await new Promise(resolve => setTimeout(resolve, 25))
      if (taken >= 8) break
    }
    clearInterval(timer)
    const observed = ticks
    db.close()
    if (observed === 0) throw new Error('timer never fired while chunked scanning')
    return observed
  })
  fact('chunked iterate + await lets timers run (the shipped execution shape)',
    typeof chunked.ticks === 'number' && chunked.ticks > 0, `ticks=${chunked.ticks} ${chunked.ms}ms`)
}

// ===============================================================================
// GATES — the SQL-notebook surface (red until each milestone lands)
// ===============================================================================
console.log('\n[gates] SQL-notebook surface')
const wsRoot = await mkdtemp(path.join(tmpdir(), 'dsh-sql-ws-'))
await writeFile(path.join(wsRoot, 'sample.db'), await readFile(dbFile))
await writeFile(path.join(wsRoot, 'second.db'), await readFile(dbFile))
await writeFile(path.join(wsRoot, 'notes.sqlnb'), JSON.stringify({ version: 1, cells: [{ kind: 'sql', source: 'SELECT 1' }] }))

let host = undefined
try { host = await serveHostBundle(bundlePath, wsRoot) } catch (e) { console.error('host bundle failed to mount:', e?.message ?? e) }
const post = async (p, body) => {
  const response = await fetch(`${host.base}/dsh-workbench-layout${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: host.base },
    body: JSON.stringify(body),
  })
  return { status: response.status, json: await response.json().catch(() => ({})) }
}

if (host === undefined) {
  gate('A1', 'host bundle mounts for route probes', false, 'mount failed')
} else {
  const opened = await post('/sqlnotebook/open', { workspaceId: 'ws-1', path: 'sample.db' })
  gate('A1', 'POST /sqlnotebook/open resolves a connection (not 404)', opened.status !== 404, `status=${opened.status} code=${opened.json?.error?.code ?? '-'}`)

  const escaped = await post('/sqlnotebook/open', { workspaceId: 'ws-1', path: '../outside.db' })
  gate('A1', 'open refuses a path outside the workspace', escaped.json?.error?.code === 'WORKSPACE_ESCAPE' || escaped.json?.error?.code === 'INVALID_PATH',
    `code=${escaped.json?.error?.code ?? '-'}`)

  const exec = await post('/sqlnotebook/execute', { workspaceId: 'ws-1', path: 'sample.db', sql: 'SELECT 9007199254740993 AS v, x\'0102\' AS b' })
  const block = exec.json?.blocks?.[0]
  const row = block?.rows?.[0]
  gate('A1', 'execute normalizes big integers to strings and BLOBs to base64',
    Array.isArray(row) && typeof row[0] === 'string' && typeof row[1] === 'string', JSON.stringify(row))

  const dup = await post('/sqlnotebook/execute', { workspaceId: 'ws-1', path: 'sample.db', sql: 'SELECT a, a FROM t' })
  const cols = dup.json?.blocks?.[0]?.columns
  gate('A1', 'duplicate columns yield one entry per column with distinct labels and true names',
    Array.isArray(cols) && cols.length === 2 && cols[0].name === 'a' && cols[1].name === 'a' && cols[0].label !== cols[1].label,
    JSON.stringify(cols))

  const multi = await post('/sqlnotebook/execute', { workspaceId: 'ws-1', path: 'sample.db', sql: 'SELECT 1 AS one; SELECT 2 AS two' })
  gate('A1', 'multi-statement cell returns one result block per statement',
    Array.isArray(multi.json?.blocks) && multi.json.blocks.length === 2, `blocks=${multi.json?.blocks?.length}`)

  // A negative assertion must not be satisfied by an absent endpoint: `error !== undefined`
  // was true while the route returned ENDPOINT_NOT_FOUND, so this gate passed for the wrong
  // reason on the first run. Require the route to be alive AND the denial to carry its own
  // code. These codes are the contract A1 implements.
  const denied = await post('/sqlnotebook/execute', { workspaceId: 'ws-1', path: 'sample.db', sql: `ATTACH DATABASE 'sample.db' AS other` })
  const denialCode = denied.json?.error?.code ?? denied.json?.blocks?.[0]?.error?.code
  gate('A1', 'read-only connection denies ATTACH with SQL_AUTHORIZATION_DENIED',
    denialCode === 'SQL_AUTHORIZATION_DENIED', `code=${denialCode ?? '-'} status=${denied.status}`)

  const scratch = await post('/sqlnotebook/execute', { workspaceId: 'ws-1', path: 'sample.db', sql: 'CREATE TEMP TABLE g(x); INSERT INTO g VALUES (1); SELECT count(*) AS n FROM g' })
  const persisted = await post('/sqlnotebook/execute', { workspaceId: 'ws-1', path: 'sample.db', sql: 'SELECT count(*) AS n FROM g' })
  gate('A1', 'temporary tables survive across executes in one connection',
    scratch.json?.blocks?.length === 3 && Number(persisted.json?.blocks?.[0]?.rows?.[0]?.[0]) === 1,
    `scratch=${scratch.json?.blocks?.length} then=${JSON.stringify(persisted.json?.blocks?.[0]?.rows)}`)

  const writableOne = await post('/sqlnotebook/open', { workspaceId: 'ws-1', path: 'sample.db', writable: true })
  const writableTwo = await post('/sqlnotebook/open', { workspaceId: 'ws-1', path: 'sample.db', writable: true })
  gate('A1', 'a second writable connection to the same file is refused with a named code',
    writableTwo.json?.error?.code === 'SQL_WRITE_OCCUPIED', `code=${writableTwo.json?.error?.code ?? '-'} first=${writableOne.status}`)

  const readOnlyThenWrite = await post('/sqlnotebook/open', { workspaceId: 'ws-1', path: 'second.db', writable: true })
  gate('A1', 'opening a second file is unaffected by the first file being occupied',
    readOnlyThenWrite.status !== 404 && readOnlyThenWrite.json?.error?.code !== 'SQL_WRITE_OCCUPIED', `code=${readOnlyThenWrite.json?.error?.code ?? '-'}`)

  const tables = await post('/sqlnotebook/tables', { workspaceId: 'ws-1', path: 'sample.db' })
  gate('A4', 'tables route lists tables and views with a cap and a truncation flag',
    Array.isArray(tables.json?.tables) && tables.json?.tables?.some(entry => entry.name === 't') && typeof tables.json?.truncated === 'boolean',
    JSON.stringify(tables.json?.tables)?.slice(0, 80))

  const columns = await post('/sqlnotebook/columns', { workspaceId: 'ws-1', path: 'sample.db', table: 't' })
  gate('A4', 'columns route returns declared types for one table (lazy schema tree)',
    Array.isArray(columns.json?.columns) && columns.json.columns.length === 3, JSON.stringify(columns.json?.columns)?.slice(0, 80))

  // Same hole as the ATTACH gate: the route's absence returned an error object, which this
  // assertion counted as "refused". A table name that is not a plain identifier must be
  // refused by the columns route itself, with its own code.
  const quoteTable = await post('/sqlnotebook/columns', { workspaceId: 'ws-1', path: 'sample.db', table: 't"; DROP TABLE t;--' })
  gate('A4', 'columns refuses a non-identifier table name with SQL_INVALID_TABLE',
    quoteTable.json?.error?.code === 'SQL_INVALID_TABLE', `code=${quoteTable.json?.error?.code ?? '-'}`)
}

// Source-level canaries for milestones whose real assertions live in vitest specs added
// with the same PR (a spec importing a missing module would break `npm run typecheck`,
// so those slices are tracked here and asserted properly once the code exists).
const shell = await readFile(path.join(here, '..', 'src', 'client', 'shell', 'ModeSwitch.tsx'), 'utf8').catch(() => '')
gate('A4', 'rail carries a sql mode between terminal and kernels', /mode: 'sql'/u.test(shell))
const types = await readFile(path.join(here, '..', 'src', 'client', 'model', 'workbench-types.ts'), 'utf8').catch(() => '')
gate('A4', 'SidebarMode union extended with sql', /'sql'/u.test(types))
const locales = await readFile(path.join(here, '..', 'src', 'client', 'core', 'locales.ts'), 'utf8').catch(() => '')
gate('A4', 'locales define sqlnotebook keys (both dictionaries)', /'sqlnotebook\./u.test(locales))
const document = await readFile(path.join(here, '..', 'src', 'client', 'sql', 'sql-notebook-document.ts'), 'utf8').catch(() => '')
gate('A2', '.sqlnb parser exists and is declared never-throwing', /export function parseSqlNotebook/u.test(document))
const runtime = await readFile(path.join(here, '..', 'src', 'client', 'sql', 'sql-runtime.ts'), 'utf8').catch(() => '')
gate('A3', 'sql runtime exposes cancel as a partial affordance', /cancel/u.test(runtime))

if (host !== undefined) await host.close()

const factsFailed = facts.filter(entry => !entry.ok)
const selected = only === undefined ? gates : gates.filter(entry => entry.tag === only)
const red = selected.filter(entry => !entry.ok)
console.log(`\n[summary] facts ${facts.length - factsFailed.length}/${facts.length} green · gates${only ? ` (${only})` : ''} ${selected.length - red.length}/${selected.length} green`)

if (factsFailed.length > 0) {
  console.error(`\nRUNTIME DRIFT — ${factsFailed.length} fact(s) no longer hold on this runtime:`)
  for (const entry of factsFailed) console.error(`  - ${entry.name}`)
  console.error('The design rests on these. Re-derive the affected decisions before continuing.')
  process.exit(2)
}
if (red.length > 0) {
  console.log(`\nEXPECTED RED — ${red.length} gate(s) awaiting their milestone:`)
  for (const entry of red) console.log(`  - ${entry.tag} ${entry.name}`)
  process.exit(1)
}
console.log('\nALL SELECTED GATES GREEN.')
process.exit(0)

async function sha256(file) {
  try { return createHash('sha256').update(await readFile(file)).digest('hex') }
  catch { return undefined }
}
