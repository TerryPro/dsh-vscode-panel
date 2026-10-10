/**
 * Find Python interpreters and Jupyter kernels that can serve one Workspace.
 *
 * A notebook needs a kernel, and a kernel needs an interpreter that can import
 * `ipykernel`. VS Code solves this by asking its Python extension; the workbench
 * has no such dependency, so the Host looks in the places a project's environment
 * actually lives, in order of "closest to this workspace":
 *
 * 1. an environment directory inside the Workspace (`.venv`, `venv`, `env`, `.conda`,
 *    plus one level of sub-directories for monorepo layouts);
 * 2. `uv`'s and `conda`'s standard environment locations for the Workspace;
 * 3. the `py` launcher's registered interpreters on Windows, then `python`/`python3`
 *    on `PATH` everywhere;
 * 4. installed Jupyter kernelspecs (`kernel.json` directories), whose argv the Host
 *    re-points at the interpreter it resolved.
 *
 * Every candidate is *probed*, not assumed: one short `-c` script reports its
 * version and whether `ipykernel` imports. A kernel with no working interpreter is
 * still returned (with a reason) because "what is missing" is the answer the user
 * needs, and the plugin never installs anything on its own.
 */

import { execFile } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, win32 } from 'node:path'
import { promisify } from 'node:util'
import type { KernelChoice, KernelEnvironment } from '../../shared/notebook-protocol.ts'
import { WorkbenchHttpError } from '../http.ts'

const execFileAsync = promisify(execFile)

/** Bounds that keep discovery from turning into a fork bomb on a big monorepo. */
export const KERNEL_DISCOVERY_LIMITS = {
  maxInterpreters: 8,
  maxKernelspecs: 16,
  probeTimeoutMs: 8_000,
  probeMaxOutputBytes: 64 * 1024,
  /** One discovery result per Workspace is cached for this long. */
  cacheTtlMs: 60_000,
}

/** Environment directory names that commonly hold a project's interpreter. */
const VENV_DIRECTORY_NAMES = ['.venv', 'venv', 'env', '.conda', 'conda-env'] as const

/** One-line probe: version, prefix, and whether `ipykernel` imports here. */
const INTERPRETER_PROBE = [
  'import json,sys',
  'out={"version": "%d.%d.%d" % sys.version_info[:3], "prefix": sys.prefix}',
  'try:',
  '    import ipykernel',
  '    out["ipykernel"]=getattr(ipykernel,"__version__","unknown")',
  'except Exception as error:',
  '    out["ipykernel_error"]=type(error).__name__',
  'try:',
  '    import ipykernel_launcher  # noqa: F401',
  '    out["launcher"]=True',
  'except Exception:',
  '    out["launcher"]=False',
  'print(json.dumps(out))',
].join('\n')

export interface InterpreterProbe {
  interpreterPath: string
  pythonVersion: string
  /** `sys.prefix`, so this interpreter's own kernelspec directory can be read. */
  prefix: string
  ipykernel: boolean
  ipykernelVersion?: string
  /** Whether `ipykernel_launcher` (the module the kernel is started with) imports. */
  launcher: boolean
  /** Why the probe failed, when it did. */
  reason?: string
}

export interface KernelspecRecord {
  name: string
  displayName: string
  language: string
  argv: string[]
  /** Directory of the `kernel.json`, for the picker's provenance line. */
  directory: string
  interruptMode?: string
  debugger: boolean
}

interface DiscoveryCacheEntry {
  at: number
  environments: KernelEnvironment[]
  kernels: KernelChoice[]
}

const discoveryCache = new Map<string, DiscoveryCacheEntry>()

function isWindows(): boolean {
  return process.platform === 'win32'
}

/** Absolute path of the interpreter inside one environment directory. */
export function interpreterPathForEnvironment(directory: string): string {
  return isWindows() ? join(directory, 'Scripts', 'python.exe') : join(directory, 'bin', 'python')
}

/** One interpreter location, with the workspace-relative environment it belongs to. */
export interface InterpreterCandidate {
  path: string
  kind: KernelEnvironment['kind']
  environmentPath: string
}

/**
 * Candidate interpreter paths for a Workspace root, best-first.
 *
 * Ordering is the whole point: a project's own `.venv` must win over a machine
 * Python, because that is where the user's `pandas` actually is. Candidates that
 * are not files are dropped before the cap is applied, so five absent directory
 * names cannot crowd out the real interpreter behind them.
 */
export async function candidateInterpreters(workspaceRoot: string): Promise<InterpreterCandidate[]> {
  const candidates: InterpreterCandidate[] = []
  const seen = new Set<string>()
  const push = (path: string, kind: KernelEnvironment['kind'], environmentPath: string): void => {
    const lower = path.toLowerCase()
    if (seen.has(lower)) return
    seen.add(lower)
    candidates.push({ path, kind, environmentPath })
  }

  for (const name of VENV_DIRECTORY_NAMES) {
    push(interpreterPathForEnvironment(join(workspaceRoot, name)), name === '.conda' ? 'conda' : 'venv', name)
  }
  // One level of sub-directories, for `apps/api/.venv` layouts, without a deep walk.
  for (const entry of await readableDirectories(workspaceRoot)) {
    for (const name of VENV_DIRECTORY_NAMES) {
      push(interpreterPathForEnvironment(join(workspaceRoot, entry, name)), name === '.conda' ? 'conda' : 'venv', `${entry}/${name}`)
    }
  }

  if (isWindows()) {
    for (const path of await pyLauncherInterpreters()) push(path, 'system', '')
  }
  for (const name of ['python', 'python3']) {
    for (const path of await which(name)) push(path, 'system', '')
  }
  for (const path of await uvManagedInterpreters()) push(path, 'uv', '')

  const existing = await Promise.all(candidates.map(async candidate => (
    await exists(candidate.path) ? candidate : undefined
  )))
  return existing.filter((candidate): candidate is InterpreterCandidate => candidate !== undefined)
    .slice(0, KERNEL_DISCOVERY_LIMITS.maxInterpreters)
}

async function readableDirectories(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    return entries
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
      .map(entry => entry.name)
      .slice(0, 24)
  } catch {
    return []
  }
}

/** Resolve one command name on `PATH`, the way a shell would. */
async function which(command: string): Promise<string[]> {
  const probe = isWindows() ? { command: 'where', args: [command] } : { command: 'which', args: [command] }
  try {
    const { stdout } = await execFileAsync(probe.command, probe.args, {
      encoding: 'utf8',
      timeout: 4_000,
      windowsHide: true,
      maxBuffer: KERNEL_DISCOVERY_LIMITS.probeMaxOutputBytes,
    })
    return stdout.split(/\r?\n/u).map(line => line.trim()).filter(line => line !== '')
  } catch {
    return []
  }
}

/** Ask the Windows `py` launcher for every registered interpreter. */
async function pyLauncherInterpreters(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('py', ['-0p'], {
      encoding: 'utf8',
      timeout: 4_000,
      windowsHide: true,
      maxBuffer: KERNEL_DISCOVERY_LIMITS.probeMaxOutputBytes,
    })
    return stdout
      .split(/\r?\n/u)
      .map(line => /[A-Za-z]:\\.*python\.exe$/u.exec(line)?.[0] ?? '')
      .filter(line => line !== '')
  } catch {
    return []
  }
}

/** `uv`'s managed CPythons, which exist even on machines with no system Python. */
async function uvManagedInterpreters(): Promise<string[]> {
  const root = isWindows()
    ? process.env['APPDATA'] === undefined ? [] : [join(process.env['APPDATA'], 'uv', 'python')]
    : process.env['HOME'] === undefined ? [] : [join(process.env['HOME'], '.local', 'share', 'uv', 'python')]
  const found: string[] = []
  for (const directory of root) {
    let entries: string[] = []
    try {
      entries = await readdir(directory)
    } catch {
      continue
    }
    // Newest first: the directory names carry the version.
    for (const entry of entries.sort().reverse()) {
      const candidate = isWindows()
        ? join(directory, entry, 'python.exe')
        : join(directory, entry, 'bin', 'python')
      if (await exists(candidate)) found.push(candidate)
      if (found.length >= 3) break
    }
  }
  return found
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * Run the interpreter probe for one candidate.
 *
 * @returns the probe result, or a result carrying only a `reason` when the
 * interpreter is missing or fails to answer — never a throw, so one broken
 * environment cannot hide the working one behind it.
 */
export async function probeInterpreter(interpreterPath: string): Promise<InterpreterProbe> {
  const failure = (reason: string): InterpreterProbe => ({
    interpreterPath,
    pythonVersion: '',
    prefix: '',
    ipykernel: false,
    launcher: false,
    reason,
  })
  if (!await exists(interpreterPath)) return failure('interpreter not found')
  try {
    // `-E` keeps a foreign `PYTHONPATH` out of the answer, and running from the
    // interpreter's own directory keeps a stray `json.py` in any working directory
    // from shadowing the standard library and faking a negative result. Unlike the
    // bridge, this probe must *not* use isolated mode: `ipykernel` installed with
    // `pip install --user` lives in the user site, which `-I` hides.
    const { stdout } = await execFileAsync(interpreterPath, ['-E', '-B', '-c', INTERPRETER_PROBE], {
      cwd: dirname(interpreterPath),
      encoding: 'utf8',
      timeout: KERNEL_DISCOVERY_LIMITS.probeTimeoutMs,
      windowsHide: true,
      maxBuffer: KERNEL_DISCOVERY_LIMITS.probeMaxOutputBytes,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    })
    const line = stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1) ?? ''
    const parsed = JSON.parse(line) as Record<string, unknown>
    return {
      interpreterPath,
      pythonVersion: typeof parsed['version'] === 'string' ? parsed['version'] : '',
      prefix: typeof parsed['prefix'] === 'string' ? parsed['prefix'] : '',
      ipykernel: typeof parsed['ipykernel'] === 'string',
      ...(typeof parsed['ipykernel'] === 'string' ? { ipykernelVersion: parsed['ipykernel'] } : {}),
      launcher: parsed['launcher'] === true,
      ...(parsed['launcher'] === true ? {} : { reason: 'ipykernel is not installed in this environment' }),
    }
  } catch (error: unknown) {
    const code = error !== null && typeof error === 'object' && 'code' in error
      ? String((error as { code: unknown }).code)
      : ''
    if (code.includes('ETIMEDOUT')) return failure('this interpreter did not answer in time')
    if (code === 'ENOENT') return failure('interpreter not executable')
    return failure('this interpreter could not be probed')
  }
}

/**
 * Kernel-spec directories to read, best-first.
 *
 * Jupyter's own precedence is per-environment before machine-wide, so the
 * `share/jupyter/kernels` of every interpreter that proved it can run a kernel is
 * searched before `APPDATA`/`~/.local` and the system directories. That is what
 * makes a kernel `ipykernel install`ed into a specific environment visible to this
 * workspace, and what lets a kernel installed into a prefix outside `PATH` — a DSH
 * runtime, a conda env — be found and started by its own interpreter.
 */
export function kernelspecDirectories(
  workspaceRoot: string,
  interpreterPrefixes: readonly string[] = [],
  environmentPaths: readonly string[] = [],
): string[] {
  const directories: string[] = []
  // Environments inside the Workspace, relative to it.
  for (const environmentPath of environmentPaths) {
    if (environmentPath === '') continue
    directories.push(join(workspaceRoot, environmentPath, 'share', 'jupyter', 'kernels'))
  }
  // Each usable interpreter's own prefix, which is where `--user`-style installs land.
  for (const prefix of interpreterPrefixes) {
    if (prefix === '') continue
    directories.push(join(prefix, 'share', 'jupyter', 'kernels'))
  }
  if (isWindows()) {
    if (process.env['APPDATA'] !== undefined) directories.push(join(process.env['APPDATA'], 'jupyter', 'kernels'))
    if (process.env['ProgramData'] !== undefined) directories.push(join(process.env['ProgramData'], 'jupyter', 'kernels'))
  } else {
    if (process.env['HOME'] !== undefined) {
      directories.push(join(process.env['HOME'], '.local', 'share', 'jupyter', 'kernels'))
    }
    if (process.env['JUPYTER_DATA_DIR'] !== undefined) {
      directories.push(join(process.env['JUPYTER_DATA_DIR'], 'kernels'))
    }
    directories.push('/usr/local/share/jupyter/kernels', '/usr/share/jupyter/kernels')
  }
  return [...new Set(directories)]
}

/**
 * Read the `kernel.json` files under one directory.
 *
 * A kernelspec is read, not executed: only the argv, display name, and language are
 * taken, and the interpreter placeholder is substituted by the caller. Anything
 * unreadable is skipped, because a broken third kernel must not hide two good ones.
 */
export async function readKernelspecs(directory: string): Promise<KernelspecRecord[]> {
  let entries: string[] = []
  try {
    entries = await readdir(directory)
  } catch {
    return []
  }
  const specs: KernelspecRecord[] = []
  for (const name of entries.slice(0, KERNEL_DISCOVERY_LIMITS.maxKernelspecs)) {
    const specDirectory = join(directory, name)
    try {
      const raw = await readFile(join(specDirectory, 'kernel.json'), 'utf8')
      const value = JSON.parse(raw) as Record<string, unknown>
      if (!Array.isArray(value['argv']) || typeof value['display_name'] !== 'string') continue
      const argv = value['argv'].filter(entry => typeof entry === 'string') as string[]
      const metadata = typeof value['metadata'] === 'object' && value['metadata'] !== null
        ? value['metadata'] as Record<string, unknown>
        : {}
      specs.push({
        name,
        displayName: value['display_name'],
        language: typeof value['language'] === 'string' ? value['language'] : 'python',
        argv,
        directory: specDirectory,
        ...(typeof value['interrupt_mode'] === 'string' ? { interruptMode: value['interrupt_mode'] } : {}),
        debugger: metadata['debugger'] === true,
      })
    } catch {
      continue
    }
  }
  return specs
}

/**
 * Turn a kernelspec argv into a launch command for one resolved interpreter.
 *
 * `{connection_file}`, `{resource_dir}`, and `{sys.executable}` are the spec's own
 * placeholders. The first argv entry is normally an absolute interpreter path and is
 * replaced with the one the Host verified, so a spec written for another machine's
 * Python still starts here.
 */
export function kernelArgvForInterpreter(
  spec: KernelspecRecord,
  connectionFile: string,
  interpreterPath: string,
  resourceDirectory: string,
): string[] {
  const argv = spec.argv.map(entry => entry
    .replace(/\{connection_file\}/gu, connectionFile)
    .replace(/\{resource_dir\}/gu, resourceDirectory)
    .replace(/\{sys\.executable\}/gu, interpreterPath))
  if (argv.length === 0) return argv
  const head = argv[0] ?? ''
  const looksLikeInterpreter = /(?:^|[/\\])(?:python(?:3(?:\.\d+)?)?|pythonw(?:3(?:\.\d+)?)?)(?:\.exe)?$/iu.test(head)
    || head.toLowerCase().endsWith('python.exe')
  // A head that is neither an interpreter nor an already-substitutable path is left
  // alone: rewriting a wrapper program would silently change what gets executed.
  if (looksLikeInterpreter && head !== interpreterPath) argv[0] = interpreterPath
  return argv
}

/** Whether a kernelspec names the Python ipykernel launcher we can drive. */
export function isPythonIpykernelSpec(spec: KernelspecRecord): boolean {
  const joined = spec.argv.join(' ')
  return spec.language === 'python' && /ipykernel(?:_launcher)?/u.test(joined)
}

/**
 * The interpreter a kernelspec names for itself.
 *
 * A spec's argv begins with the interpreter that was active when it was installed,
 * which is the honest answer to "which Python does this kernel use" — and the only
 * one that works for a kernel installed into a prefix outside `PATH`. A relative
 * `python` is refused, since it would resolve through the DSH host's `PATH` rather
 * than the environment the spec belongs to.
 */
export function specInterpreterOf(spec: KernelspecRecord): string | undefined {
  const head = spec.argv[0]
  if (head === undefined || head === '') return undefined
  if (!isAbsoluteInterpreter(head)) return undefined
  return head
}

/** Whether one argv entry is an absolute path to a Python interpreter. */
export function isAbsoluteInterpreter(value: string): boolean {
  if (!win32.isAbsolute(value) && !value.startsWith('/')) return false
  return /(?:^|[/\\])(?:python(?:3(?:\.\d+)?)?|pythonw(?:3(?:\.\d+)?)?)(?:\.exe)?$/iu.test(value)
}

/**
 * Discover every usable kernel for one Workspace root.
 *
 * @param workspaceRoot canonical absolute path from `WorkspaceBackend.rootProcessPath`.
 * @returns environments plus a picker list, best-first, with reasons for the rest.
 */
export async function discoverKernels(workspaceRoot: string): Promise<{
  environments: KernelEnvironment[]
  kernels: KernelChoice[]
}> {
  const cached = discoveryCache.get(workspaceRoot.toLowerCase())
  if (cached !== undefined && Date.now() - cached.at < KERNEL_DISCOVERY_LIMITS.cacheTtlMs) {
    return { environments: cached.environments, kernels: cached.kernels }
  }

  const candidates = await candidateInterpreters(workspaceRoot)
  const environments: KernelEnvironment[] = []
  const usable: { interpreter: InterpreterProbe; kind: KernelEnvironment['kind']; environmentPath: string }[] = []
  // Probed in parallel, then re-sorted: candidate order is the priority, and a
  // slow broken environment must not displace the workspace `.venv`.
  const probes = await Promise.all(candidates.map(async candidate => ({
    candidate,
    probe: await probeInterpreter(candidate.path),
  })))
  for (const { candidate, probe } of probes) {
    environments.push({
      path: candidate.environmentPath,
      interpreterPath: probe.interpreterPath,
      pythonVersion: probe.pythonVersion,
      ipykernel: probe.ipykernel && probe.launcher,
      ...(probe.ipykernelVersion === undefined ? {} : { ipykernelVersion: probe.ipykernelVersion }),
      kind: candidate.kind,
    })
    if (probe.ipykernel && probe.launcher) {
      usable.push({
        interpreter: probe,
        kind: candidate.kind,
        environmentPath: candidate.environmentPath,
      })
    }
  }

  const kernels: KernelChoice[] = usable.map(entry => ({
    name: 'python3',
    displayName: `Python ${entry.interpreter.pythonVersion} (${entry.environmentPath === '' ? 'system' : entry.environmentPath})`,
    language: 'python',
    interpreterPath: entry.interpreter.interpreterPath,
    available: true,
    source: entry.kind === 'system' ? 'system' : entry.kind,
    ...(entry.environmentPath === '' ? {} : { environmentPath: entry.environmentPath }),
  }))

  // Installed kernelspecs are first-class entries, and each is probed at the
  // interpreter *its own argv names*. That is what makes a kernel installed into a
  // prefix outside `PATH` — a DSH runtime, a conda env, a uv CPython — startable
  // without asking the user to put anything on `PATH`.
  const specDirectories = kernelspecDirectories(
    workspaceRoot,
    usable.map(entry => entry.interpreter.prefix),
    usable.map(entry => entry.environmentPath),
  )
  const seenSpecs = new Set<string>()
  const probeCache = new Map<string, InterpreterProbe>()
  for (const directory of specDirectories) {
    for (const spec of await readKernelspecs(directory)) {
      if (seenSpecs.has(spec.name)) continue
      seenSpecs.add(spec.name)
      if (!isPythonIpykernelSpec(spec)) {
        kernels.push({
          name: spec.name,
          displayName: spec.displayName,
          language: spec.language,
          available: false,
          reason: 'this workbench launches Python kernels only',
          source: 'kernelspec',
        })
        continue
      }
      const named = specInterpreterOf(spec)
      let probe: InterpreterProbe | undefined
      if (named !== undefined) {
        probe = probeCache.get(named)
        if (probe === undefined) {
          probe = await probeInterpreter(named)
          probeCache.set(named, probe)
        }
      }
      if (probe !== undefined && probe.ipykernel && probe.launcher) {
        kernels.push({
          name: spec.name,
          displayName: spec.displayName,
          language: spec.language,
          interpreterPath: probe.interpreterPath,
          argv: spec.argv,
          available: true,
          source: 'kernelspec',
        })
        continue
      }
      // A spec whose own interpreter is unreachable may still be startable by a
      // discovered environment — the common case for a stale `python3` spec.
      const fallback = usable[0]
      if (fallback === undefined) {
        kernels.push({
          name: spec.name,
          displayName: spec.displayName,
          language: spec.language,
          available: false,
          reason: probe?.reason ?? 'this kernel names no interpreter this machine can run',
          source: 'kernelspec',
        })
        continue
      }
      kernels.push({
        name: spec.name,
        displayName: spec.displayName,
        language: spec.language,
        interpreterPath: fallback.interpreter.interpreterPath,
        argv: spec.argv,
        available: true,
        source: 'kernelspec',
        ...(fallback.environmentPath === '' ? {} : { environmentPath: fallback.environmentPath }),
      })
    }
  }

  discoveryCache.set(workspaceRoot.toLowerCase(), { at: Date.now(), environments, kernels })
  return { environments, kernels }
}

/** The single best kernel to start when the user did not choose one. */
export function defaultKernelChoice(kernels: readonly KernelChoice[]): KernelChoice {
  const available = kernels.find(kernel => kernel.available)
  if (available === undefined) {
    throw new WorkbenchHttpError(409, 'KERNEL_UNAVAILABLE', kernels.length === 0
      ? 'no Python interpreter was found for this workspace.'
      : 'no available Jupyter kernel: install ipykernel into the environment you want to use.')
  }
  return available
}

/** Invalidate one Workspace's cached discovery, after an environment changed. */
export function forgetKernelDiscovery(workspaceRoot: string): void {
  discoveryCache.delete(workspaceRoot.toLowerCase())
}

/** Exposed for tests: the win32 path helper the POSIX/Windows branch depends on. */
export const windowsPathApi = win32
