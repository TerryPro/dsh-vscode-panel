/**
 * The configuration behind the plugin's own settings page.
 *
 * The descriptors are built from the live schema rather than from a second table of
 * numbers, so the page can never show a default the code no longer uses — the failure
 * this project already hit once, when two files each declared the kernel ceilings.
 *
 * The schema arrives as three reads rather than as a schemastery object: this backend
 * needs a field's declared bounds, the value in force, and a validator, and knowing
 * nothing else is what keeps it testable without the real schema and free of its
 * generic shape.
 */

import type {
  ConfigFieldDescriptor,
  ConfigFieldMeta,
  ConfigGroup,
  ConfigKey,
  ConfigSnapshot,
  ConfigUnit,
} from '../shared/config-protocol.ts'
import { CONFIG_FIELDS } from '../shared/config-protocol.ts'
import { WorkbenchHttpError } from './http.ts'

/** How one field is best shown. Counts need no unit, so most rows only carry a group. */
interface FieldPresentation {
  group: ConfigGroup
  unit?: ConfigUnit
}

/**
 * Grouping for every field the configuration declares.
 *
 * Typed over `ConfigKey`, which is derived from the description table, so adding a
 * setting anywhere without saying where it belongs on the page is a compile error
 * rather than a field that silently never appears. That is stronger than a test, and
 * it is why there is no "uncovered fields" check to remember to run.
 */
export const CONFIG_PRESENTATION: Record<ConfigKey, FieldPresentation> = {
  maxFileBytes: { group: 'files', unit: 'bytes' },
  maxDirectoryEntries: { group: 'files' },
  gitTimeoutMs: { group: 'git', unit: 'ms' },
  gitMaxOutputBytes: { group: 'git', unit: 'bytes' },
  gitGraphPageSize: { group: 'git' },
  kernelStartTimeoutMs: { group: 'kernel-lifecycle', unit: 'ms' },
  kernelRequestTimeoutMs: { group: 'kernel-lifecycle', unit: 'ms' },
  kernelMaxPerWorkspace: { group: 'kernel-count' },
  kernelMaxTotal: { group: 'kernel-count' },
  kernelUnattendedTimeoutMs: { group: 'kernel-lifecycle', unit: 'ms' },
  kernelReclaimGraceMs: { group: 'kernel-lifecycle', unit: 'ms' },
  kernelReaperIntervalMs: { group: 'kernel-lifecycle', unit: 'ms' },
  kernelHeartbeatMs: { group: 'kernel-lifecycle', unit: 'ms' },
  kernelFrameBuffer: { group: 'kernel-lifecycle' },
  kernelMaxOutputChunkChars: { group: 'kernel-output' },
  kernelMaxOutputRunChars: { group: 'kernel-output', unit: 'bytes' },
  kernelMaxOutputRunFrames: { group: 'kernel-output' },
  kernelDiscoveryCacheMs: { group: 'kernel-discovery', unit: 'ms' },
  kernelProbeTimeoutMs: { group: 'kernel-discovery', unit: 'ms' },
}

/**
 * What the backend needs of the plugin's schema and running configuration.
 *
 * Three reads, not the schema object itself: this keeps the backend free of
 * schemastery's generic shape and testable without the real schema. Keys are the
 * declared `ConfigKey` union, so a typo cannot ask for a field that does not exist.
 */
export interface ConfigSource {
  /** The declared default and bounds of one field. */
  metaOf(key: ConfigKey): ConfigFieldMeta | undefined
  /** The value in force right now. */
  valueOf(key: ConfigKey): number | undefined
  /** Validate a proposal, or throw when the schema rejects it. */
  validate(proposed: Record<string, unknown>): Record<string, unknown>
}

export class ConfigBackend {
  /**
   * A write that passed validation but has not been applied.
   *
   * Applying means restarting the plugin, which disposes the effect serving this
   * request, so the reply must leave first. Holding the write as data rather than
   * acting inline is what makes that ordering explicit instead of depending on when a
   * `setImmediate` happens to fire.
   */
  private pending: Record<string, number> | undefined

  constructor(private readonly source: ConfigSource) {}

  read(): ConfigSnapshot {
    return { fields: this.descriptors() }
  }

  /** Validate a proposal and hold it until the reply has gone out. */
  stage(body: Record<string, unknown>): ConfigSnapshot {
    const proposed = body['config']
    if (proposed === null || typeof proposed !== 'object' || Array.isArray(proposed)) {
      throw new WorkbenchHttpError(400, 'INVALID_CONFIG', '配置必须是一个对象。')
    }
    const pending = this.normalize(proposed as Record<string, unknown>)
    this.pending = pending
    // Reported with the accepted values rather than the ones still in force: the reply
    // is what the page shows once the restart lands, and echoing the pre-restart
    // numbers would put a saved form back to the values the user just replaced.
    return { fields: this.descriptors(pending) }
  }

  /** The accepted write, once. Undefined when no write is waiting. */
  takePending(): Record<string, number> | undefined {
    const pending = this.pending
    this.pending = undefined
    return pending
  }

  /**
   * @param overrides - values to report instead of the ones in force, used by a write
   *   that has been accepted but not yet applied.
   */
  private descriptors(overrides?: Readonly<Record<string, number>>): ConfigFieldDescriptor[] {
    const fields: ConfigFieldDescriptor[] = []
    for (const [key, presentation] of Object.entries(CONFIG_PRESENTATION) as [ConfigKey, FieldPresentation][]) {
      const meta = this.source.metaOf(key)
      // A field the schema no longer declares has no bounds to show and nothing to
      // write, so it is left off rather than rendered with invented limits.
      if (meta === undefined) continue
      const declared = toFinite(meta.default)
      if (declared === undefined) continue
      fields.push({
        key,
        value: overrides?.[key] ?? this.source.valueOf(key) ?? declared,
        default: declared,
        min: toFinite(meta.min) ?? declared,
        max: toFinite(meta.max) ?? Number.MAX_SAFE_INTEGER,
        // The numbers come from the schema; the words come from the shared table,
        // which is also what the schema's own description is built from.
        title: CONFIG_FIELDS[key].title,
        description: CONFIG_FIELDS[key].description,
        group: presentation.group,
        unit: presentation.unit ?? 'count',
      })
    }
    return fields
  }

  /**
   * Check a proposal against the schema and return it normalized.
   *
   * The schema is the single authority, including on the ranges the page mirrors, so
   * the page cannot store what the host would refuse on the next start. Every field
   * must be present: the plugin restarts with this object as its whole configuration,
   * and omitting one would silently reset a setting nobody touched.
   */
  private normalize(proposed: Record<string, unknown>): Record<string, number> {
    for (const key of Object.keys(proposed)) {
      if (!(key in CONFIG_PRESENTATION)) {
        throw new WorkbenchHttpError(400, 'UNKNOWN_CONFIG_FIELD', `未知的配置项：${key}`)
      }
    }
    const missing = Object.keys(CONFIG_PRESENTATION).filter(key => proposed[key] === undefined)
    if (missing.length > 0) {
      throw new WorkbenchHttpError(400, 'INCOMPLETE_CONFIG', `缺少配置项：${missing.join('、')}`)
    }
    let resolved: Record<string, unknown>
    try {
      resolved = this.source.validate(proposed)
    } catch (error: unknown) {
      throw new WorkbenchHttpError(400, 'INVALID_CONFIG', `配置未通过校验：${reasonOf(error)}`)
    }
    const out: Record<string, number> = {}
    for (const key of Object.keys(CONFIG_PRESENTATION)) {
      const value = toFinite(resolved[key])
      if (value === undefined) {
        throw new WorkbenchHttpError(400, 'INVALID_CONFIG', `配置项 ${key} 不是一个有效数字。`)
      }
      out[key] = value
    }
    return out
  }
}

function toFinite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** A validation failure, reduced to what a user can act on. */
function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  // schemastery aggregates one issue per line. Keep the first, bounded, and free of
  // anything that reads like a host path.
  const first = message.split('\n')[0] ?? message
  return first.replace(/[A-Za-z]:\\[^\s]*|(?:^|\s)\/[^\s]*/gu, '[path]').trim().slice(0, 160)
}
