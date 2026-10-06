import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, RiskConfirmation } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  GitBranches,
  GitCommit,
  GitFileStatus,
  GitGraph,
  GitRemoteOperation,
  GitRemotes,
  GitStatus,
  GitTargetRemoteOperation,
} from '../../shared/contracts.ts'
import type { WorkbenchController } from '../model/controller.ts'
import { GitChangesView } from './GitChangesView.tsx'
import { GitBranchDialog, type GitBranchDialogMode } from './GitBranchDialog.tsx'
import { GitCommitActionDialog, type GitCommitActionRequest } from './GitCommitActionDialog.tsx'
import {
  GitGraphView,
  type CommitFilesState,
  type GitCommitDetailKind,
  type GitCommitMenuAction,
} from './GitGraphView.tsx'
import { GitRepositoryToolbar } from './GitRepositoryToolbar.tsx'
import { GitRemoteDialog, type GitRemoteDialogMode, type GitRemoteDraft } from './GitRemoteDialog.tsx'
import { copyTextToClipboard } from '../core/clipboard.ts'
import { useWorkbench } from '../model/use-workbench.ts'
import css from './git.module.css'

const GIT_PANEL_REFRESH_INTERVAL_MS = 5_000

interface GitPanelProps {
  controller: WorkbenchController
  workspaceId: string | undefined
  t: TranslateNS<'workbench'>
}

/** 组合源码管理状态；具体的更改、提交图和仓库工具栏各自保持独立。 */
export function GitPanel({ controller, workspaceId, t }: GitPanelProps) {
  const workbench = useWorkbench(controller)
  const activeTab = workbench.tabs.find(tab => tab.id === workbench.activeTabId)
  const activeDiff = activeTab?.kind === 'diff' ? activeTab.diff : null
  const refreshId = useRef(0)
  const graphPageRequestId = useRef(0)
  const graphPagePending = useRef(false)
  const activeWorkspace = useRef(workspaceId)
  activeWorkspace.current = workspaceId
  const view = workbench.gitView
  const changeLayout = workbench.gitChangeLayout
  const graphFileLayout = workbench.gitGraphFileLayout
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [branches, setBranches] = useState<GitBranches | null>(null)
  const [graph, setGraph] = useState<GitGraph | null>(null)
  const [graphLoadingMore, setGraphLoadingMore] = useState(false)
  const [graphLoadError, setGraphLoadError] = useState<string | null>(null)
  const [expandedCommit, setExpandedCommit] = useState<string | null>(null)
  const [expandedKind, setExpandedKind] = useState<GitCommitDetailKind>('commit')
  const [commitFiles, setCommitFiles] = useState<Record<string, CommitFilesState>>({})
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [branchDialog, setBranchDialog] = useState<{
    mode: GitBranchDialogMode
    source?: { ref: string; label: string }
  } | null>(null)
  const [branchDialogError, setBranchDialogError] = useState<string | null>(null)
  const [remoteDialog, setRemoteDialog] = useState<GitRemoteDialogMode | null>(null)
  const [remotes, setRemotes] = useState<GitRemotes | null>(null)
  const [remoteDialogError, setRemoteDialogError] = useState<string | null>(null)
  const [discardRequest, setDiscardRequest] = useState<{ scope: 'all' } | { scope: 'file'; file: GitFileStatus } | null>(null)
  const [discardAcknowledged, setDiscardAcknowledged] = useState(false)
  const [commitActionRequest, setCommitActionRequest] = useState<GitCommitActionRequest | null>(null)
  const [commitActionError, setCommitActionError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    if (workspaceId === undefined) return
    const request = ++refreshId.current
    graphPageRequestId.current += 1
    graphPagePending.current = false
    setGraphLoadingMore(false)
    setGraphLoadError(null)
    setLoading(true)
    setError(null)
    try {
      const nextStatus = await controller.api.gitStatus(workspaceId)
      const [nextGraph, nextBranches] = nextStatus.available
        ? await Promise.all([controller.api.gitGraph(workspaceId), controller.api.gitBranches(workspaceId)])
        : [null, null]
      if (request !== refreshId.current) return
      setStatus(nextStatus)
      controller.acceptGitStatus?.(workspaceId, nextStatus)
      setGraph(nextGraph)
      setBranches(nextBranches)
      setCommitFiles({})
      setExpandedCommit(null)
      setExpandedKind('commit')
    } catch (reason: unknown) {
      if (request === refreshId.current) setError(messageOf(reason))
    } finally {
      if (request === refreshId.current) setLoading(false)
    }
  }, [controller, workspaceId])

  useEffect(() => {
    refreshId.current += 1
    setStatus(null)
    setBranches(null)
    setGraph(null)
    setGraphLoadingMore(false)
    setGraphLoadError(null)
    setBusy(null)
    setMessage('')
    setError(null)
    setResult(null)
    setExpandedCommit(null)
    setExpandedKind('commit')
    setCommitFiles({})
    setBranchDialog(null)
    setBranchDialogError(null)
    setRemoteDialog(null)
    setRemotes(null)
    setRemoteDialogError(null)
    setDiscardRequest(null)
    setDiscardAcknowledged(false)
    setCommitActionRequest(null)
    setCommitActionError(null)
    void refresh()
  }, [refresh])

  const busyRef = useRef(busy)
  busyRef.current = busy

  useEffect(() => {
    if (workspaceId === undefined) return
    const poll = (): void => {
      if (document.visibilityState === 'hidden' || busyRef.current !== null) return
      void refresh()
    }
    const timer = window.setInterval(poll, GIT_PANEL_REFRESH_INTERVAL_MS)
    window.addEventListener('focus', poll)
    document.addEventListener('visibilitychange', poll)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', poll)
      document.removeEventListener('visibilitychange', poll)
    }
  }, [workspaceId, refresh])

  const loadMoreGraph = useCallback(async (): Promise<void> => {
    if (workspaceId === undefined || graph === null || loading || !graph.truncated || graphPagePending.current) return
    const targetWorkspace = workspaceId
    const refreshRequest = refreshId.current
    const pageRequest = ++graphPageRequestId.current
    const offset = graph.nextOffset
    graphPagePending.current = true
    setGraphLoadingMore(true)
    setGraphLoadError(null)
    try {
      const page = await controller.api.gitGraph(targetWorkspace, offset)
      if (activeWorkspace.current !== targetWorkspace || refreshId.current !== refreshRequest || graphPageRequestId.current !== pageRequest) return
      setGraph(current => current === null ? current : appendGraphPage(current, page))
    } catch (reason: unknown) {
      if (activeWorkspace.current === targetWorkspace && refreshId.current === refreshRequest && graphPageRequestId.current === pageRequest) {
        setGraphLoadError(messageOf(reason))
      }
    } finally {
      if (graphPageRequestId.current === pageRequest) {
        graphPagePending.current = false
        setGraphLoadingMore(false)
      }
    }
  }, [controller, graph, loading, workspaceId])
  const requestMoreGraph = useCallback(() => { void loadMoreGraph() }, [loadMoreGraph])

  /** 编排一次独占的 Git 变更操作：置 busy、清空提示、竞态守卫、错误上报与收尾。 */
  const runGitOperation = async <T,>(config: {
    busy: string
    perform: (targetWorkspace: string) => Promise<T>
    onSuccess?: (value: T, targetWorkspace: string) => Promise<void> | void
    error?: (message: string) => void
    clearError?: boolean
    clearResult?: boolean
    onStart?: () => void
  }): Promise<void> => {
    if (workspaceId === undefined) return
    const targetWorkspace = workspaceId
    setBusy(config.busy)
    if (config.clearError !== false) setError(null)
    if (config.clearResult !== false) setResult(null)
    config.onStart?.()
    try {
      const value = await config.perform(targetWorkspace)
      if (activeWorkspace.current !== targetWorkspace) return
      await config.onSuccess?.(value, targetWorkspace)
    } catch (reason: unknown) {
      if (activeWorkspace.current === targetWorkspace) (config.error ?? setError)(messageOf(reason))
    } finally {
      if (activeWorkspace.current === targetWorkspace) setBusy(null)
    }
  }

  const update = async (targetWorkspace: string, operation: () => Promise<GitStatus>): Promise<boolean> => {
    setError(null)
    try {
      const next = await operation()
      if (activeWorkspace.current !== targetWorkspace) return false
      setStatus(next)
      controller.acceptGitStatus?.(targetWorkspace, next)
      return true
    } catch (reason: unknown) {
      if (activeWorkspace.current !== targetWorkspace) return false
      setError(messageOf(reason))
      return false
    }
  }

  const stage = async (file: GitFileStatus): Promise<void> => {
    if (workspaceId === undefined) return
    if (await update(workspaceId, () => controller.api.gitStage(workspaceId, file.path))) {
      controller.closeDiffTabs(workspaceId)
      await controller.openDiff(workspaceId, file.path, true)
    }
  }

  const unstage = async (file: GitFileStatus): Promise<void> => {
    if (workspaceId === undefined) return
    if (await update(workspaceId, () => controller.api.gitUnstage(workspaceId, file.path))) {
      controller.closeDiffTabs(workspaceId)
      await controller.openDiff(workspaceId, file.path, false)
    }
  }

  const batchIndexOperation = (operation: 'stage' | 'unstage'): Promise<void> => runGitOperation({
    busy: `${operation}-all`,
    perform: targetWorkspace => operation === 'stage'
      ? controller.api.gitStageAll(targetWorkspace)
      : controller.api.gitUnstageAll(targetWorkspace),
    onSuccess: (next, targetWorkspace) => {
      setStatus(next)
      controller.acceptGitStatus?.(targetWorkspace, next)
      controller.closeDiffTabs(targetWorkspace)
      setResult(t(operation === 'stage' ? 'git.stageAllDone' : 'git.unstageAllDone'))
    },
  })

  const requestDiscard = (request: { scope: 'all' } | { scope: 'file'; file: GitFileStatus }): void => {
    if (workbench.tabs.some(tab => tab.kind === 'file' && tab.dirty)) {
      setError(t('git.unsavedOperation'))
      return
    }
    setDiscardAcknowledged(false)
    setDiscardRequest(request)
  }

  const confirmDiscard = (): Promise<void> => {
    if (discardRequest === null) return Promise.resolve()
    const request = discardRequest
    return runGitOperation({
      busy: 'discard',
      error: message => { setDiscardRequest(null); setError(message) },
      perform: async (targetWorkspace) => {
        const next = request.scope === 'all'
          ? await controller.api.gitDiscardAll(targetWorkspace)
          : await controller.api.gitDiscard(targetWorkspace, request.file.path)
        controller.resetWorkspaceView(targetWorkspace)
        return next
      },
      onSuccess: (next, targetWorkspace) => {
        setStatus(next)
        controller.acceptGitStatus?.(targetWorkspace, next)
        setDiscardRequest(null)
        setResult(t(request.scope === 'all' ? 'git.discardAllDone' : 'git.discardDone'))
      },
    })
  }

  const commit = (): Promise<void> => runGitOperation({
    busy: 'commit',
    perform: targetWorkspace => controller.api.gitCommit(targetWorkspace, message),
    onSuccess: async (committed, targetWorkspace) => {
      setMessage('')
      setResult(committed.summary)
      controller.closeDiffTabs(targetWorkspace)
      await refresh()
    },
  })

  const showCommitDetails = async (commitValue: GitCommit, kind: GitCommitDetailKind, toggle = true): Promise<void> => {
    if (workspaceId === undefined) return
    const targetWorkspace = workspaceId
    if (expandedCommit === commitValue.hash && expandedKind === kind) {
      if (toggle) setExpandedCommit(null)
      return
    }
    setExpandedCommit(commitValue.hash)
    setExpandedKind(kind)
    const key = `${kind}:${commitValue.hash}`
    if (commitFiles[key] !== undefined) return
    setCommitFiles(current => ({ ...current, [key]: { state: 'loading' } }))
    try {
      const value = kind === 'commit'
        ? await controller.api.gitCommitFiles(targetWorkspace, commitValue.hash)
        : await controller.api.gitComparisonFiles(targetWorkspace, commitValue.hash)
      if (activeWorkspace.current !== targetWorkspace) return
      setCommitFiles(current => ({ ...current, [key]: { state: 'ready', value } }))
    } catch (reason: unknown) {
      if (activeWorkspace.current !== targetWorkspace) return
      setCommitFiles(current => ({
        ...current,
        [key]: { state: 'error', message: messageOf(reason) },
      }))
    }
  }

  const commitMenuAction = async (action: GitCommitMenuAction, commitValue: GitCommit): Promise<void> => {
    if (action === 'copy') {
      try {
        await copyTextToClipboard(commitValue.hash)
        setResult(t('git.commitMenu.copied', { hash: commitValue.shortHash }))
        setError(null)
      } catch {
        setError(t('git.commitMenu.copyFailed'))
      }
      return
    }
    if (action === 'branch') {
      setBranchDialogError(null)
      setBranchDialog({
        mode: 'create-from',
        source: { ref: commitValue.hash, label: `${commitValue.shortHash} · ${commitValue.subject}` },
      })
      return
    }
    if (action === 'compare') {
      await showCommitDetails(commitValue, 'comparison', false)
      return
    }
    if (workbench.tabs.some(tab => tab.kind === 'file' && tab.dirty)) {
      setError(t('git.unsavedOperation'))
      return
    }
    setCommitActionError(null)
    setCommitActionRequest({ action, commit: commitValue })
  }

  const confirmCommitAction = (): Promise<void> => {
    if (commitActionRequest === null) return Promise.resolve()
    const request = commitActionRequest
    return runGitOperation({
      busy: `commit-${request.action}`,
      clearError: false,
      error: setCommitActionError,
      onStart: () => { setCommitActionError(null) },
      perform: async (targetWorkspace) => {
        const value = await controller.api.gitCommitAction(targetWorkspace, request.action, request.commit.hash)
        controller.resetWorkspaceView(targetWorkspace)
        return value
      },
      onSuccess: async value => {
        setCommitActionRequest(null)
        setResult(value.summary)
        await refresh()
      },
    })
  }

  const switchBranch = (ref: string): Promise<void> => {
    if (workspaceId === undefined) return Promise.resolve()
    if (workbench.tabs.some(tab => tab.kind === 'file' && tab.dirty)) {
      setError(t('git.unsavedOperation'))
      return Promise.resolve()
    }
    const target = branches?.branches.find(branch => branch.ref === ref)
    return runGitOperation({
      busy: 'switch',
      perform: async (targetWorkspace) => {
        await controller.api.gitSwitchBranch(targetWorkspace, ref)
        controller.resetWorkspaceView(targetWorkspace)
      },
      onSuccess: async () => {
        setResult(`${t('git.switchedBranch')} ${target?.name ?? ref}`)
        await refresh()
      },
    })
  }

  const manageBranch = (nameOrRef: string, source?: string): Promise<void> => {
    if (workspaceId === undefined || branchDialog === null) return Promise.resolve()
    const operation = branchDialog.mode
    const switchesWorktree = operation === 'create' || operation === 'create-from'
    if (switchesWorktree && workbench.tabs.some(tab => tab.kind === 'file' && tab.dirty)) {
      setBranchDialogError(t('git.unsavedOperation'))
      return Promise.resolve()
    }
    return runGitOperation({
      busy: `branch-${operation}`,
      error: setBranchDialogError,
      onStart: () => { setBranchDialogError(null) },
      perform: async (targetWorkspace) => {
        if (operation === 'create' || operation === 'create-from') {
          await controller.api.gitCreateBranch(targetWorkspace, nameOrRef, source)
          controller.resetWorkspaceView(targetWorkspace)
        } else if (operation === 'rename') {
          await controller.api.gitRenameBranch(targetWorkspace, nameOrRef)
        } else {
          await controller.api.gitDeleteBranch(targetWorkspace, nameOrRef)
        }
      },
      onSuccess: async () => {
        setBranchDialog(null)
        setResult(t(`git.branchDialog.${operation}.done`))
        await refresh()
      },
    })
  }

  const remoteOperation = (operation: GitRemoteOperation): Promise<void> => {
    if (workspaceId === undefined) return Promise.resolve()
    if ((operation === 'pull' || operation === 'sync') && workbench.tabs.some(tab => tab.kind === 'file' && tab.dirty)) {
      setError(t('git.unsavedOperation'))
      return Promise.resolve()
    }
    return runGitOperation({
      busy: operation,
      perform: async (targetWorkspace) => {
        await controller.api.gitRemoteOperation(targetWorkspace, operation)
        if (operation === 'pull' || operation === 'sync') controller.resetWorkspaceView(targetWorkspace)
      },
      onSuccess: async () => {
        setResult(t(`git.${operation}Done`))
        await refresh()
      },
    })
  }

  const openRemoteDialog = async (mode: GitRemoteDialogMode): Promise<void> => {
    if (workspaceId === undefined) return
    const targetWorkspace = workspaceId
    setRemoteDialog(mode)
    setRemotes(null)
    setRemoteDialogError(null)
    try {
      const value = await controller.api.gitRemotes(targetWorkspace)
      if (activeWorkspace.current === targetWorkspace) setRemotes(value)
    } catch (reason: unknown) {
      if (activeWorkspace.current === targetWorkspace) setRemoteDialogError(messageOf(reason))
    }
  }

  const saveRemote = (draft: GitRemoteDraft): Promise<void> => runGitOperation({
    busy: 'remote-config',
    clearError: false,
    clearResult: false,
    error: setRemoteDialogError,
    onStart: () => { setRemoteDialogError(null) },
    perform: targetWorkspace => draft.currentName === undefined
      ? controller.api.gitAddRemote(targetWorkspace, draft)
      : controller.api.gitUpdateRemote(targetWorkspace, draft.currentName, draft),
    onSuccess: async value => {
      setRemotes(value)
      setRemoteDialog(null)
      setResult(t('git.remoteDialog.saved'))
      await refresh()
    },
  })

  const deleteRemote = (name: string): Promise<void> => runGitOperation({
    busy: 'remote-config',
    clearError: false,
    clearResult: false,
    error: setRemoteDialogError,
    onStart: () => { setRemoteDialogError(null) },
    perform: targetWorkspace => controller.api.gitDeleteRemote(targetWorkspace, name),
    onSuccess: async value => {
      setRemotes(value)
      setRemoteDialog(null)
      setResult(t('git.remoteDialog.deleted'))
      await refresh()
    },
  })

  const targetRemoteOperation = (
    operation: GitTargetRemoteOperation,
    remote: string,
    branch?: string,
  ): Promise<void> => {
    if (workspaceId === undefined) return Promise.resolve()
    if (operation === 'pull' && workbench.tabs.some(tab => tab.kind === 'file' && tab.dirty)) {
      setRemoteDialogError(t('git.unsavedOperation'))
      return Promise.resolve()
    }
    return runGitOperation({
      busy: `remote-${operation}`,
      clearError: false,
      clearResult: false,
      error: setRemoteDialogError,
      onStart: () => { setRemoteDialogError(null) },
      perform: async (targetWorkspace) => {
        await controller.api.gitTargetRemoteOperation(targetWorkspace, operation, remote, branch)
        if (operation === 'pull') controller.resetWorkspaceView(targetWorkspace)
      },
      onSuccess: async () => {
        setRemoteDialog(null)
        setResult(t(`git.remoteDialog.target.${operation}Done`, { remote }))
        await refresh()
      },
    })
  }

  if (workspaceId === undefined) return <div className={css.emptyState}>{t('git.emptyWorkspace')}</div>
  const stagedFiles = status?.files.filter(isStaged) ?? []
  const changedFiles = status?.files.filter(hasWorktreeChange) ?? []
  const showingChanges = view === 'changes'
  const activeFileLayout = showingChanges ? changeLayout : graphFileLayout
  return (
    <div className={css.panelBody}>
      <GitRepositoryToolbar
        status={status}
        branches={branches}
        view={view}
        fileLayout={activeFileLayout}
        busy={busy}
        onToggleView={() => { controller.toggleGitView() }}
        onFileLayoutChange={layout => {
          controller.setGitFileLayout(view, layout)
        }}
        onSwitchBranch={ref => { void switchBranch(ref) }}
        onOpenBranchDialog={mode => { setBranchDialogError(null); setBranchDialog({ mode }) }}
        onRemoteOperation={operation => { void remoteOperation(operation) }}
        onOpenRemoteDialog={mode => { void openRemoteDialog(mode) }}
        onRefresh={() => {
          controller.closeDiffTabs(workspaceId)
          void refresh()
        }}
        t={t}
      />
      {error !== null && <div className={css.error} role="alert">{error}</div>}
      {result !== null && <div className={css.success} role="status">{result}</div>}
      {loading && status === null && <div className={css.emptyState}>{t('files.loading')}</div>}
      {status?.available === false && <div className={css.emptyState}>{status.message}</div>}
      {status?.available === true && showingChanges && (
        <>
          <div className={css.commitBox}>
            <textarea
              value={message}
              placeholder={t('git.commitPlaceholder')}
              aria-label={t('git.commitPlaceholder')}
              rows={2}
              onChange={event => { setMessage(event.currentTarget.value) }}
            />
            <Button variant="primary" size="sm" disabled={stagedFiles.length === 0 || message.trim() === '' || busy !== null} onClick={() => { void commit() }}>
              {busy === 'commit' ? t('git.committing') : t('git.commit')}
            </Button>
          </div>
          <GitChangesView
            stagedFiles={stagedFiles}
            changedFiles={changedFiles}
            layout={changeLayout}
            selectedKind={activeDiff?.kind === 'staged' || activeDiff?.kind === 'worktree' ? activeDiff.kind : undefined}
            selectedPath={activeDiff?.path}
            busy={busy !== null}
            onOpen={(file, staged) => { void controller.openDiff(workspaceId, file.path, staged) }}
            onStage={file => { void stage(file) }}
            onUnstage={file => { void unstage(file) }}
            onStageAll={() => { void batchIndexOperation('stage') }}
            onUnstageAll={() => { void batchIndexOperation('unstage') }}
            onDiscard={file => { requestDiscard({ scope: 'file', file }) }}
            onDiscardAll={() => { requestDiscard({ scope: 'all' }) }}
            t={t}
          />
        </>
      )}
      {status?.available === true && view === 'graph' && (
        <GitGraphView
          graph={graph}
          expandedCommit={expandedCommit}
          expandedKind={expandedKind}
          commitFiles={commitFiles}
          fileLayout={graphFileLayout}
          selectedRevision={activeDiff?.revision}
          selectedPath={activeDiff?.path}
          selectedKind={activeDiff?.kind === 'commit' || activeDiff?.kind === 'comparison' ? activeDiff.kind : undefined}
          loadingMore={graphLoadingMore}
          loadError={graphLoadError}
          onToggle={commitValue => { void showCommitDetails(commitValue, 'commit') }}
          onOpen={(commitValue, path) => {
            if (expandedKind === 'comparison') void controller.openComparisonDiff(workspaceId, commitValue, path)
            else void controller.openCommitDiff(workspaceId, commitValue, path)
          }}
          onMenuAction={(action, commitValue) => { void commitMenuAction(action, commitValue) }}
          onLoadMore={requestMoreGraph}
          t={t}
        />
      )}
      <GitBranchDialog
        mode={branchDialog?.mode ?? null}
        status={status}
        branches={branches}
        {...branchDialog?.source === undefined ? {} : { initialSource: branchDialog.source }}
        busy={busy?.startsWith('branch-') === true}
        error={branchDialogError}
        onClose={() => { if (busy === null) setBranchDialog(null) }}
        onSubmit={(nameOrRef, source) => { void manageBranch(nameOrRef, source) }}
        t={t}
      />
      <GitRemoteDialog
        mode={remoteDialog}
        remotes={remotes}
        status={status}
        busy={busy?.startsWith('remote-') === true}
        error={remoteDialogError}
        onClose={() => { if (busy === null) setRemoteDialog(null) }}
        onSave={draft => { void saveRemote(draft) }}
        onDelete={name => { void deleteRemote(name) }}
        onRun={(operation, remote, branch) => { void targetRemoteOperation(operation, remote, branch) }}
        t={t}
      />
      <RiskConfirmation
        open={discardRequest !== null}
        title={t(discardRequest?.scope === 'all' ? 'git.discardDialog.allTitle' : 'git.discardDialog.fileTitle')}
        description={t(discardRequest?.scope === 'all' ? 'git.discardDialog.allDescription' : 'git.discardDialog.fileDescription', {
          path: discardRequest?.scope === 'file' ? discardRequest.file.path : '',
        })}
        acknowledgeLabel={t('git.discardDialog.acknowledge')}
        cancelLabel={t('git.discardDialog.cancel')}
        closeLabel={t('git.discardDialog.cancel')}
        confirmLabel={t('git.discardDialog.confirm')}
        acknowledged={discardAcknowledged}
        disabled={busy === 'discard'}
        onAcknowledgedChange={setDiscardAcknowledged}
        onCancel={() => { if (busy !== 'discard') setDiscardRequest(null) }}
        onConfirm={() => { void confirmDiscard() }}
      />
      <GitCommitActionDialog
        request={commitActionRequest}
        busy={busy?.startsWith('commit-') === true}
        error={commitActionError}
        onClose={() => { if (busy?.startsWith('commit-') !== true) setCommitActionRequest(null) }}
        onConfirm={() => { void confirmCommitAction() }}
        t={t}
      />
    </div>
  )
}

function appendGraphPage(current: GitGraph, page: GitGraph): GitGraph {
  const seen = new Set(current.commits.map(commit => commit.hash))
  const commits = [...current.commits]
  for (const commit of page.commits) {
    if (seen.has(commit.hash)) continue
    seen.add(commit.hash)
    commits.push(commit)
  }
  return { commits, truncated: page.truncated, nextOffset: page.nextOffset }
}

function isStaged(file: GitFileStatus): boolean {
  return file.index !== ' ' && file.index !== '?'
}

function hasWorktreeChange(file: GitFileStatus): boolean {
  return file.worktree !== ' ' || file.index === '?'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
