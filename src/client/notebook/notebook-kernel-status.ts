/**
 * What the status bar says about the kernel behind a notebook.
 *
 * Pure on purpose: the strip's judgement — which sentence, which colour, which
 * readouts — is the part worth locking down, and it should be testable without a DOM
 * or a live kernel.
 *
 * The notebook toolbar carries a kernel chip too, but only in notebook view. This is
 * the one that keeps working in source view, where the file is just JSON and the
 * kernel is genuinely in the background, and it adds what the toolbar never showed:
 * how many prompts the kernel has run, how many cells a Run All still owes, and
 * whether the event stream silently fell back to polling.
 */

import type { WorkbenchKey } from '../core/locales.ts'
import type { NotebookState } from './notebook-model.ts'

/** Dot colour, matching the toolbar chip so both read the same way. */
export type KernelStatusTone = 'idle' | 'busy' | 'starting' | 'failed' | 'absent'

export interface KernelStatusReadout {
  text: string
  /** Present only when the readout needs explaining on hover. */
  title?: string
  /**
   * Report a fault rather than a fact.
   *
   * Carried explicitly because a tooltip is not one: `In[12]` explains itself and must
   * stay grey, while a degraded transport is the one readout worth colouring.
   */
  warn?: boolean
}

export interface KernelStatusView {
  tone: KernelStatusTone
  /** The kernel's own name, or a word saying there is none. */
  label: string
  /** Hover sentence: the state in words, or the failure the Host reported. */
  title: string
  /** Prompt count, queue depth, degraded transport. */
  extras: KernelStatusReadout[]
}

/**
 * Translate the keys this view needs.
 *
 * Typed as the workbench's own key union rather than `string`: the shell's translator
 * only accepts known keys, and a function that rejects unknown ones cannot be passed
 * where any string is promised.
 */
export type KernelStatusTranslate = (key: WorkbenchKey, values?: Record<string, string>) => string

export function describeKernelStatus(
  state: NotebookState,
  pendingQueue: number,
  t: KernelStatusTranslate,
): KernelStatusView {
  const kernel = state.kernel
  const connected = kernel.kernelId !== null
  const extras: KernelStatusReadout[] = []

  if (connected && kernel.executionCount > 0) {
    // Jupyter's own prompt number: the one fact that tells a reader whether the
    // variables they are about to use were actually computed in this session.
    extras.push({
      text: `In[${kernel.executionCount}]`,
      title: t('notebook.statusPromptCount', { count: String(kernel.executionCount) }),
    })
  }
  if (pendingQueue > 0) {
    extras.push({ text: t('notebook.statusQueue', { count: String(pendingQueue) }) })
  }
  if (connected && kernel.transport === 'poll') {
    // A silent fallback would look identical to a live stream, so the strip says
    // which one is carrying the frames — in the warn colour, because it is slower
    // than the reader expects.
    extras.push({ text: t('notebook.statusPolling'), title: t('notebook.statusPollingHint'), warn: true })
  }

  if (kernel.busy) {
    return { tone: 'starting', label: kernel.displayName === '' ? t('notebook.kernelDisconnected') : kernel.displayName, title: t('notebook.kernelStarting'), extras }
  }
  if (kernel.phase === 'failed') {
    return { tone: 'failed', label: t('notebook.kernelFailed'), title: kernel.message ?? t('notebook.kernelFailed'), extras }
  }
  if (!connected) {
    // A notebook that has not run anything yet is not an error: running a cell starts
    // the kernel. Saying "no kernel available" here would invent a problem.
    return {
      tone: 'absent',
      label: t('notebook.kernelDisconnected'),
      title: kernel.message ?? t('notebook.runWithoutKernelHint'),
      extras,
    }
  }
  if (kernel.phase === 'busy') {
    return { tone: 'busy', label: kernel.displayName, title: t('notebook.kernelBusy'), extras }
  }
  if (kernel.phase === 'starting') {
    return { tone: 'starting', label: kernel.displayName, title: t('notebook.kernelStarting'), extras }
  }
  if (kernel.phase === 'ready' || kernel.phase === 'idle') {
    return { tone: 'idle', label: kernel.displayName, title: t('notebook.kernelIdle'), extras }
  }
  // `terminating` / `terminated`: the id is still held for a moment, but there is
  // nothing running any more, so the strip stops claiming a live kernel.
  return { tone: 'absent', label: t('notebook.kernelDisconnected'), title: t('notebook.kernelDisconnected'), extras }
}
