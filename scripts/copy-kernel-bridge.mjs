// Copy the kernel bridge script beside the bundled host entry.
//
// tsdown only emits JavaScript, and the plugin host resolves the bridge relative to
// `lib/index.js`, so the published tree needs the `.py` file there. `package.json`
// lists it under `files`, which is a name allowlist rather than a `lib/**` glob: if
// this copy is missed, notebooks fail with KERNEL_BRIDGE_MISSING instead of the
// package silently shipping without it.
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = join(root, 'src', 'host', 'kernel', 'kernel-bridge.py')
const target = join(root, 'lib', 'kernel-bridge.py')

const bytes = await readFile(source)
// A kernel must parse this on any interpreter and any locale, so the shipped copy is
// ASCII-only: a non-ASCII byte here would break a kernel on a legacy-codepage host.
for (const [index, byte] of bytes.entries()) {
  if (byte > 0x7f) {
    const line = bytes.subarray(0, index).toString('utf8').split('\n').length
    throw new Error(`kernel-bridge.py:${line} carries a non-ASCII byte 0x${byte.toString(16)}`)
  }
}
await mkdir(dirname(target), { recursive: true })
await copyFile(source, target)
// Keep the executable bit for hosts that launch it directly.
await writeFile(target, bytes, { mode: 0o755 })
console.log(`kernel bridge copied to ${target} (${bytes.byteLength} bytes)`)
