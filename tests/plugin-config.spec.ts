/**
 * The plugin's configuration surface.
 *
 * A settings UI is only trustworthy if the number it shows is the number the code
 * uses. That is not automatic here: `Config` declares defaults, and the host modules
 * declare their own constants, and the two once disagreed on the kernel ceilings
 * (3/8 against 4/16) with only one of them ever taking effect. These tests are the
 * seam that keeps them from drifting again — they read the shipped `Config` schema
 * rather than restating numbers, so a change on one side fails here instead of
 * silently changing behaviour.
 */
import { describe, expect, it } from 'vitest'
import { Config, name } from '../src/index.ts'
import { DEFAULT_KERNEL_LIMITS } from '../src/host/kernel-backend.ts'
import { KERNEL_DISCOVERY_LIMITS } from '../src/host/kernel/discovery.ts'
import { KERNEL_FRAME_BUFFER, KERNEL_MAX_CHUNK_CHARS, KERNEL_MAX_RUN_CHARS } from '../src/shared/notebook-protocol.ts'
import { GIT_GRAPH_PAGE_SIZE } from '../src/shared/contracts.ts'

/** Every declared field with its default, min, and max, straight off the schema. */
function fields() {
  const out = new Map<string, { default: unknown; min: number; max: number; description: string }>()
  for (const [key, entry] of Object.entries(Config.dict ?? {})) {
    const meta = entry?.meta
    out.set(key, {
      default: meta?.default,
      min: Number(meta?.min ?? -Infinity),
      max: Number(meta?.max ?? Infinity),
      description: typeof meta?.description === 'string' ? meta.description : '',
    })
  }
  return out
}

const declared = fields()

describe('plugin configuration', () => {
  it('exports a name and a schema the host can render', () => {
    expect(typeof name).toBe('string')
    expect(declared.size).toBeGreaterThan(0)
  })

  /**
   * The whole point of the file.
   *
   * Each default is compared to the constant the host code actually reads, so a
   * settings panel cannot promise one number while the manager enforces another.
   */
  it('defaults every kernel field to the value the host code uses', () => {
    const pairs = [
      ['kernelStartTimeoutMs', DEFAULT_KERNEL_LIMITS.startTimeoutMs],
      ['kernelRequestTimeoutMs', DEFAULT_KERNEL_LIMITS.requestTimeoutMs],
      ['kernelMaxPerWorkspace', DEFAULT_KERNEL_LIMITS.maxKernelsPerWorkspace],
      ['kernelMaxTotal', DEFAULT_KERNEL_LIMITS.maxKernelsTotal],
      ['kernelUnattendedTimeoutMs', DEFAULT_KERNEL_LIMITS.unattendedTimeoutMs],
      ['kernelReclaimGraceMs', DEFAULT_KERNEL_LIMITS.reclaimGraceMs],
      ['kernelReaperIntervalMs', DEFAULT_KERNEL_LIMITS.reaperIntervalMs],
      ['kernelHeartbeatMs', DEFAULT_KERNEL_LIMITS.heartbeatMs],
      ['kernelFrameBuffer', KERNEL_FRAME_BUFFER],
      ['kernelMaxOutputChunkChars', KERNEL_MAX_CHUNK_CHARS],
      ['kernelMaxOutputRunChars', KERNEL_MAX_RUN_CHARS],
      ['kernelDiscoveryCacheMs', KERNEL_DISCOVERY_LIMITS.cacheTtlMs],
      ['kernelProbeTimeoutMs', KERNEL_DISCOVERY_LIMITS.probeTimeoutMs],
      ['gitGraphPageSize', GIT_GRAPH_PAGE_SIZE],
    ] as const
    for (const [key, expected] of pairs) {
      expect(declared.get(key)?.default, key).toBe(expected)
    }
  })

  it('exposes the output frame budget that used to be a private constant', () => {
    // `MAX_RUN_FRAMES` was module-private, so the run cap a reader could hit had no
    // name anywhere they could set. It is now a field, and its default is the value
    // the session falls back to.
    expect(declared.has('kernelMaxOutputRunFrames')).toBe(true)
    expect(declared.get('kernelMaxOutputRunFrames')?.default).toBe(DEFAULT_KERNEL_LIMITS.maxOutputRunFrames)
  })

  it('gives every field a description, so the settings UI is self-explanatory', () => {
    // A bare number in a settings panel is an invitation to guess. Each field states
    // what it bounds and what raising it costs.
    const silent = [...declared.entries()].filter(([, entry]) => entry.description.trim().length === 0)
    expect(silent.map(([key]) => key)).toEqual([])
  })

  it('keeps each default inside its own declared range', () => {
    // A default outside its min/max would be rejected by the host's own validation
    // and leave the plugin running on a value nobody configured.
    for (const [key, entry] of declared) {
      const value = Number(entry.default)
      expect(Number.isFinite(value), key).toBe(true)
      expect(value >= entry.min, `${key} >= ${entry.min}`).toBe(true)
      expect(value <= entry.max, `${key} <= ${entry.max}`).toBe(true)
    }
  })

  it('parses a partial override against the declared defaults', () => {
    // The host hands the plugin whatever the user saved, not a full object; a field
    // the user never touched has to fall back rather than arrive as `undefined`,
    // because `KernelLimits` would then compare against `undefined` at runtime.
    const parsed = Config({ kernelMaxPerWorkspace: 5, kernelUnattendedTimeoutMs: 60_000 })
    expect(parsed.kernelMaxPerWorkspace).toBe(5)
    expect(parsed.kernelUnattendedTimeoutMs).toBe(60_000)
    expect(parsed.kernelMaxTotal).toBe(DEFAULT_KERNEL_LIMITS.maxKernelsTotal)
    expect(parsed.kernelFrameBuffer).toBe(KERNEL_FRAME_BUFFER)
  })

  it('rejects an out-of-range kernel ceiling instead of silently clamping', () => {
    // The per-workspace ceiling is bounded because each kernel is a Python process;
    // accepting 500 would turn a typo into a fork bomb.
    expect(() => { Config({ kernelMaxPerWorkspace: 999 }) }).toThrowError()
    expect(() => { Config({ kernelMaxTotal: 0 }) }).toThrowError()
  })

  it('accepts the zero that means "no grace period" for reclaim', () => {
    // Reclaiming immediately is a legitimate choice on a machine where nobody else
    // can open these files, so the floor is 0 rather than 1.
    expect(Config({ kernelReclaimGraceMs: 0 }).kernelReclaimGraceMs).toBe(0)
  })

  it('accepts a zero discovery cache, which is how a user forces a fresh probe', () => {
    expect(Config({ kernelDiscoveryCacheMs: 0 }).kernelDiscoveryCacheMs).toBe(0)
  })
})
