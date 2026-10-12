#!/usr/bin/env node
/**
 * Launcher for the SQL-notebook gate (`npm run test:sql`).
 *
 * The design of the SQL notebook rests on measured behaviour of `node:sqlite` on the
 * *host* runtime, which is the Electron-embedded Node (v24.x) inside the running DSH
 * app — not whatever Node happens to be on PATH. So the real scenarios must execute
 * there. This file runs on PATH node only to locate that host binary and re-exec the
 * scenario bundle under `ELECTRON_RUN_AS_NODE=1`, which makes the Electron executable
 * behave as a plain Node of the embedded version.
 *
 * No personal absolute path is baked in. Discovery order:
 *   1. `--host <path>`            (explicit, e.g. CI or a non-standard install)
 *   2. `$env:DSH_HOST_EXE`        (persisted by the developer)
 *   3. process discovery          (the live host that loaded this plugin)
 * If none resolves, the gate fails with instructions rather than silently degrading to
 * PATH node — because running on the wrong runtime would make the assertions lie.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const scenarios = path.join(here, 'probe-sql-scenarios.mjs')

function argHost(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--host') return argv[i + 1]
    if (a.startsWith('--host=')) return a.slice('--host='.length)
  }
  return undefined
}

/**
 * Ask the OS for the executable of a live process whose command line loads
 * dsh-desktop-host. The result is only a fallback: an explicit `--host` or
 * `$env:DSH_HOST_EXE` always wins.
 */
function discoverHost() {
  const needle = 'dsh-desktop-host'
  // A tab written as a character code. A literal backtick in the command string below
  // would be parsed as a JS interpolation, which is what broke the first revision.
  const tab = String.fromCharCode(9)
  try {
    if (process.platform === 'win32') {
      const script = '$ErrorActionPreference="SilentlyContinue";' +
        `Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%${needle}%'" | ` +
        'ForEach-Object {' +
        ' $p = $_.ExecutablePath;' +
        " if (-not $p) { $p = ($_.CommandLine -split '\\s+', 2)[0].Trim([char]34) };" +
        ' if ($p) { Write-Output ($p + [char]' + tab.charCodeAt(0) + ' + $_.ProcessId) }' +
        ' }'
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf8', timeout: 20000 })
      for (const line of out.split(/\r?\n/u)) {
        const exe = line.split(tab)[0]?.trim()
        if (exe !== undefined && exe !== '' && /[\\/]/u.test(exe)) return exe
      }
      return undefined
    }
    const out = execFileSync('ps', ['-Ao', 'pid=,args='], { encoding: 'utf8', timeout: 20000 })
    for (const line of out.split(/\r?\n/u)) {
      if (!line.includes(needle)) continue
      const rest = line.trim().replace(/^\d+\s+/u, '')
      const exe = rest.split('\0')[0].trim().split(/\s+/u)[0]
      if (exe.startsWith('/')) return exe
    }
    return undefined
  } catch {
    return undefined
  }
}

const host = argHost(process.argv.slice(2)) ?? process.env.DSH_HOST_EXE ?? discoverHost()

if (host === undefined || host === '') {
  console.error(
    'test:sql could not locate the DSH host runtime, which is required because the ' +
    'assertions measure node:sqlite behaviour on THAT runtime (not PATH node).\n' +
    'Provide it one of three ways:\n' +
    '  npm run test:sql -- --host "/path/to/DSH host executable"\n' +
    '  set DSH_HOST_EXE=/path/to/DSH host executable\n' +
    '  or run while the DSH app that loaded this plugin is open',
  )
  process.exit(2)
}

const child = spawnSync(host, [scenarios, ...process.argv.slice(2).filter(a => a !== '--host' && !a.startsWith('--host='))], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
})
process.exit(child.status ?? 1)
