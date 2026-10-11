/**
 * 左栏内核面板：本工作区正在运行的全部内核，以及回收无人查看的那个。
 *
 * 面板刻意是只读的。Host 不会在这里交出任何内核令牌，所以本面板无法向别人的内核里
 * 注入代码或打断它——那些操作只能在打开对应笔记本后完成。唯一不受令牌约束的破坏性
 * 动作是"回收"，而 Host 会自己再校验一次：确实没有任何页面在看它。
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { KernelListing } from '../../shared/notebook-protocol.ts'
import type { WorkbenchController } from '../model/controller.ts'
import { kernelIdleLabel, kernelStatusKey } from './kernel-registry.ts'
import { IconKernelOutline16 } from './KernelIcon.tsx'
import css from './kernel-panel.module.css'

export interface KernelPanelProps {
  controller: WorkbenchController
  workspaceId: string | undefined
  t: TranslateNS<'workbench'>
}

/**
 * A clock the component re-reads on a timer.
 *
 * Idle duration is relative to *now*, so a row rendered once would freeze at "12s"
 * while the kernel sits there for an hour. The list itself already refreshes every few
 * seconds, but a refresh can be skipped (an in-flight request, a hidden tab), and the
 * age must not silently stop advancing.
 */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()) }, intervalMs)
    timer.unref?.()
    return () => { clearInterval(timer) }
  }, [intervalMs])
  return now
}

export function KernelPanel({ controller, workspaceId, t }: KernelPanelProps) {
  const registry = controller.kernelRegistry
  const subscribe = useCallback((onChange: () => void) => registry.store.subscribe(onChange), [registry])
  const read = useCallback(() => registry.store.getSnapshot(), [registry])
  const snapshot = useSyncExternalStore(subscribe, read, read)
  const now = useNow(1_000)

  useEffect(() => {
    if (workspaceId === undefined) return
    registry.watch(workspaceId)
    return () => { registry.unwatch() }
  }, [registry, workspaceId])

  if (workspaceId === undefined) {
    return <div className={css.panelBody}><div className={css.emptyState}>{t('terminal.emptyWorkspace')}</div></div>
  }

  const result = snapshot.result
  const kernels = snapshot.workspaceId === workspaceId ? (result?.kernels ?? []) : []
  const capacity = result ?? {
    kernels: [],
    maxKernelsPerWorkspace: 0,
    maxKernelsTotal: 0,
    totalKernels: 0,
  }
  const atLimit = kernels.length >= capacity.maxKernelsPerWorkspace

  return (
    <div className={css.panelBody}>
      <header className={css.panelHeader} data-dsh-workbench-panel-header="">
        <span className={css.panelTitle}>{t('kernels.title')}</span>
        <button
          type="button"
          className={css.refreshButton}
          aria-label={t('kernels.refresh')}
          title={t('kernels.refresh')}
          onClick={() => { void registry.refresh(workspaceId) }}
        >
          <span className={css.refreshGlyph} aria-hidden="true">↻</span>
        </button>
      </header>

      {result !== null && (
        <div className={atLimit ? `${css.capacity} ${css.capacityFull}` : css.capacity}>
          {t('kernels.capacity', {
            used: String(kernels.length),
            max: String(capacity.maxKernelsPerWorkspace),
            total: String(capacity.totalKernels),
            totalMax: String(capacity.maxKernelsTotal),
          })}
          {atLimit && <div className={css.capacityWarning}>{t('kernels.capacityFull')}</div>}
        </div>
      )}

      {snapshot.error !== null && (
        <div className={css.errorState} role="alert">
          {t('kernels.unavailable', { message: snapshot.error })}
        </div>
      )}

      <div className={css.kernelList} role="list">
        {snapshot.loading && <div className={css.emptyState}>{t('kernels.loading')}</div>}
        {!snapshot.loading && kernels.length === 0 && (
          <div className={css.emptyState}>{t('kernels.empty')}</div>
        )}
        {kernels.map(kernel => (
          <KernelRow
            key={kernel.kernelId}
            kernel={kernel}
            now={now}
            busy={snapshot.reclaiming.includes(kernel.kernelId)}
            onOpen={() => { void controller.openFile(workspaceId, kernel.path) }}
            onReclaim={() => { void registry.reclaim(workspaceId, kernel.kernelId) }}
            t={t}
          />
        ))}
      </div>
    </div>
  )
}

function KernelRow({
  kernel,
  now,
  busy,
  onOpen,
  onReclaim,
  t,
}: {
  kernel: KernelListing
  now: number
  busy: boolean
  onOpen: () => void
  onReclaim: () => void
  t: TranslateNS<'workbench'>
}) {
  const status = kernelStatusKey(kernel.phase, kernel.busy)
  const openLabel = t('kernels.openNotebook', { path: kernel.path })
  return (
    <div className={css.kernelEntry} role="listitem" data-orphan={kernel.orphan || undefined}>
      <div className={css.kernelRow}>
        <span className={css.statusDot} data-status={status} aria-hidden="true" />
        {/*
          The path is the row's identity and the way back to the kernel: a reader who
          wants to *use* a kernel opens its notebook, because that is the only place
          that holds its token.
        */}
        <button type="button" className={css.kernelName} onClick={onOpen} title={openLabel} aria-label={openLabel}>
          {kernel.path}
        </button>
        <span className={css.kernelPhase}>{t(status)}</span>
      </div>
      <div className={css.kernelMeta}>
        <span className={css.kernelMetaItem}>{kernel.displayName}</span>
        <span className={css.kernelMetaItem}>{t('kernels.promptCount', { count: String(kernel.executionCount) })}</span>
        {kernel.pid !== null && (
          <span className={css.kernelMetaItem}>{t('kernels.processId', { pid: String(kernel.pid) })}</span>
        )}
        <span className={css.kernelMetaItem}>
          {kernel.attached > 0
            ? t('kernels.watchers', { count: String(kernel.attached) })
            : t('kernels.noWatchers')}
        </span>
        {kernel.attached === 0 && (
          <span className={css.kernelMetaItem}>{t('kernels.idleFor', { idle: kernelIdleLabel(now, kernel.lastEngagedAt) })}</span>
        )}
        {/*
          Reclaim is offered only when the Host has already decided it is safe: nothing
          is attached *and* the grace period has elapsed. Anything else and the row
          explains where to go instead of offering a button that would be refused.
        */}
        {kernel.orphan && (
          <button
            type="button"
            className={css.reclaimButton}
            disabled={!kernel.reclaimable || busy}
            title={kernel.reclaimable ? t('kernels.reclaim') : t('kernels.reclaimSettling')}
            onClick={onReclaim}
          >
            {busy ? t('kernels.reclaimBusy') : t('kernels.reclaim')}
          </button>
        )}
      </div>
      {kernel.orphan && <div className={css.orphanHint}>{t('kernels.orphanHint')}</div>}
    </div>
  )
}
