/**
 * The kernel readout in the editor status bar.
 *
 * The notebook toolbar carries a kernel chip, but it only exists in notebook view.
 * Switch a tab to source and the file becomes plain JSON while its kernel keeps
 * running in the background with nothing on screen saying so — the one place a reader
 * looks for "what is this tab attached to" goes quiet exactly when the answer matters
 * most. This strip renders in both modes.
 *
 * It reuses the toolbar's own chip classes, so the two cannot drift apart in colour or
 * size, and it adds three facts the toolbar never showed: how many prompts the kernel
 * has run, how many cells a Run All still owes, and whether the event stream silently
 * fell back to polling.
 */

import { useCallback, useSyncExternalStore } from 'react'
import type { NotebookRuntime } from './notebook-runtime.ts'
import { initialNotebookState } from './notebook-model.ts'
import { describeKernelStatus, type KernelStatusTranslate } from './notebook-kernel-status.ts'
import notebookCss from './notebook.module.css'
import editorCss from '../editor/editor.module.css'

export interface NotebookKernelStatusProps {
  runtime: NotebookRuntime
  tabId: string
  t: KernelStatusTranslate
  /**
   * Omit the name chip when the notebook toolbar is on screen and already carries it.
   *
   * The toolbar is sticky, so in notebook view both surfaces would spell the kernel's
   * name at the same time. The strip's rule is to say what nothing else on screen
   * says: in notebook view that is the prompt count, the queue, and a degraded
   * transport; in source view the toolbar is gone, so it carries the whole readout.
   */
  hideChip?: boolean
}

export function NotebookKernelStatus({ runtime, tabId, t, hideChip = false }: NotebookKernelStatusProps) {
  // Read through the peek surface: `store(tabId)` creates a runtime on first access,
  // and a component must not mutate the runtime map while it renders. A tab that has
  // no runtime yet wakes this reader when one appears — see `peekSubscribe`.
  const subscribe = useCallback((listener: () => void) => runtime.peekSubscribe(tabId, listener), [runtime, tabId])
  const getSnapshot = useCallback(() => runtime.peekState(tabId), [runtime, tabId])
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  // Queue depth lives on the runtime rather than in the snapshot because it is a
  // client-side schedule, not kernel state. Every change to it is followed by a
  // dispatch, so this read is current whenever the component re-renders.
  const view = describeKernelStatus(state ?? initialNotebookState(), runtime.peekPendingQueueLength(tabId), t)

  return (
    <>
      {!hideChip && (
        <span className={notebookCss.kernelStatus} data-phase={view.tone} title={view.title}>
          <span className={notebookCss.kernelDot} aria-hidden="true" />
          {view.label}
        </span>
      )}
      {view.extras.map(extra => (
        <span
          key={extra.text}
          className={extra.warn === true ? notebookCss.kernelStatusWarning : editorCss.editorStatusBarItem}
          {...(extra.title === undefined ? {} : { title: extra.title })}
        >
          {extra.text}
        </span>
      ))}
    </>
  )
}
