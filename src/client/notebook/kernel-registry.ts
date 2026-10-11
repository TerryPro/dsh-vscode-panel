/**
 * Client-side view of every kernel the Host is running for one Workspace.
 *
 * The panel behind this is deliberately read-mostly: the Host never hands out kernel
 * tokens here, so this store can show what is running and reclaim only what is
 * genuinely unreachable. Everything else a reader might want to do to a kernel is
 * reached by opening the notebook that owns it, which is why a row is clickable.
 *
 * Polling rather than a held stream: the list changes on the order of seconds, and an
 * extra SSE connection would attach a listener to each kernel it describes — which
 * would make every kernel look watched and disable the very reclaim the panel offers.
 */

import type { KernelListResult, KernelListing, KernelPhase } from '../../shared/notebook-protocol.ts'
import type { WorkbenchApi } from '../model/api.ts'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

export interface KernelRegistryState {
  workspaceId: string | null
  loading: boolean
  result: KernelListResult | null
  error: string | null
  /** Ids with a reclaim in flight, so a double click cannot send two. */
  reclaiming: readonly string[]
}

const INITIAL_STATE: KernelRegistryState = {
  workspaceId: null,
  loading: false,
  result: null,
  error: null,
  reclaiming: [],
}

/** How often the panel re-reads the list while it is open. */
export const KERNEL_POLL_INTERVAL_MS = 4_000

export interface KernelLogger {
  warn(message: string): void
}

export class KernelRegistry {
  readonly store: SnapshotStore<KernelRegistryState> = createSnapshotStore(INITIAL_STATE)
  private timer: ReturnType<typeof setInterval> | null = null
  private generation = 0

  constructor(private readonly api: WorkbenchApi, private readonly logger: KernelLogger) {}

  get state(): KernelRegistryState {
    return this.store.getSnapshot()
  }

  /**
   * Start refreshing one Workspace's kernel list.
   *
   * Called when the panel mounts. The first read is immediate so the panel is never
   * blank for a poll interval, and a second `watch` for the same Workspace is a no-op
   * rather than a second timer.
   */
  watch(workspaceId: string): void {
    const current = this.store.getSnapshot()
    if (this.timer !== null && current.workspaceId === workspaceId) return
    this.stopTimer()
    // Invalidate whatever refresh is in flight: a list for the previous Workspace
    // arriving after this call would show the wrong kernels under a correct-looking
    // header, which is worse than a moment of blank.
    this.generation += 1
    this.store.update(state => {
      state.workspaceId = workspaceId
      state.result = null
      state.error = null
      state.loading = true
    })
    void this.refresh(workspaceId)
    this.timer = setInterval(() => { void this.refresh(workspaceId) }, KERNEL_POLL_INTERVAL_MS)
    this.timer.unref?.()
  }

  /** Stop refreshing; called when the panel unmounts or the Workspace changes. */
  unwatch(): void {
    this.stopTimer()
    this.generation += 1
  }

  dispose(): void {
    this.unwatch()
  }

  private stopTimer(): void {
    if (this.timer === null) return
    clearInterval(this.timer)
    this.timer = null
  }

  async refresh(workspaceId: string): Promise<void> {
    const generation = this.generation
    this.store.update(state => {
      // A first load has nothing to show yet, so the panel can say "loading"; a
      // refresh keeps the previous rows rather than flashing empty every 4 seconds.
      state.loading = state.result === null
    })
    try {
      const result = await this.api.kernelList(workspaceId)
      if (generation !== this.generation) return
      this.store.update(state => {
        state.result = result
        state.error = null
        state.loading = false
      })
    } catch (error: unknown) {
      if (generation !== this.generation) return
      this.store.update(state => {
        state.loading = false
        state.error = error instanceof Error ? error.message : String(error)
      })
      this.logger.warn(`workbench-layout: kernel list refresh failed: ${String(error)}`)
    }
  }

  /**
   * Reclaim a kernel the Host has judged unreachable.
   *
   * The Host re-checks this on its own side; a refusal here is a real signal that the
   * kernel became reachable (or was never unreachable), not a race the panel should
   * paper over, so the failure is surfaced and the list re-read.
   */
  async reclaim(workspaceId: string, kernelId: string): Promise<boolean> {
    const state = this.store.getSnapshot()
    if (state.reclaiming.includes(kernelId)) return false
    this.store.update(next => {
      next.reclaiming = [...next.reclaiming, kernelId]
    })
    try {
      await this.api.kernelReclaim(kernelId, workspaceId)
      await this.refresh(workspaceId)
      return true
    } catch (error: unknown) {
      this.logger.warn(`workbench-layout: kernel reclaim failed: ${String(error)}`)
      await this.refresh(workspaceId)
      return false
    } finally {
      this.store.update(next => {
        next.reclaiming = next.reclaiming.filter(candidate => candidate !== kernelId)
      })
    }
  }

  /** Kernels for `workspaceId`, or none if the cached list belongs to another one. */
  kernelsFor(workspaceId: string | undefined): KernelListing[] {
    const state = this.store.getSnapshot()
    if (workspaceId === undefined || state.workspaceId !== workspaceId) return []
    return [...(state.result?.kernels ?? [])]
  }
}

/**
 * Compact "how long since anyone watched this" label.
 *
 * Units stay as abbreviations because they are conventional in every locale the
 * workbench ships, which keeps one string key instead of four.
 */
export function kernelIdleLabel(now: number, lastEngagedAt: number): string {
  const seconds = Math.max(0, Math.floor((now - lastEngagedAt) / 1000))
  if (seconds < 5) return 'now'
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h`
}

/**
 * Which caption a kernel row carries.
 *
 * Returns the message key rather than a string so this stays testable and free of a
 * translator dependency. `busy` wins over `phase`: a kernel mid-run is the one state
 * a reader must not misread, and its phase can lag the run by a frame.
 */
export function kernelStatusKey(
  phase: KernelPhase,
  busy: boolean,
): 'kernels.running' | 'kernels.starting' | 'kernels.idle' | 'kernels.failed' | 'kernels.terminating' | 'kernels.terminated' {
  if (busy) return 'kernels.running'
  if (phase === 'busy' || phase === 'idle' || phase === 'ready') return 'kernels.idle'
  if (phase === 'starting' || phase === 'absent') return 'kernels.starting'
  if (phase === 'failed') return 'kernels.failed'
  if (phase === 'terminating') return 'kernels.terminating'
  return 'kernels.terminated'
}
