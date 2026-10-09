import { useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import { Button, Modal, Toast, type MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { EditorGroup, EditorPaneId, WorkbenchController, WorkbenchState, WorkbenchTab } from '../model/controller.ts'
import { tabsForCloseScope } from '../model/tab-model.ts'
import { EditorEmpty } from './EditorShared.tsx'
import { EditorPane } from './EditorPane.tsx'
import type { EditorTabMenuAction } from './EditorTabContextMenu.tsx'
import { SplitDivider } from './SplitDivider.tsx'
import { useWorkbench } from '../model/use-workbench.ts'
import { resolveWorkbenchWorkspaceId } from '../model/workspace-binding.ts'
import { copyTextToClipboard } from '../core/clipboard.ts'
import css from './editor.module.css'

export type WorkbenchEditorProps = PropsRuntime<'rightbar.session'> & PropsLocale<'workbench'> & {
  controller: WorkbenchController
  activateWorkspace: (workspaceId: string | undefined) => void
}

/** One transient banner for menu feedback (path copies); keyed so a repeat re-shows it. */
interface EditorNotice {
  text: string
  failed: boolean
  sequence: number
}

/** Middle multi-file surface, with Markdown preview as the default mode. */
export function WorkbenchEditor({ sessionId, useSessions, useWorkspaces, controller, activateWorkspace, t }: WorkbenchEditorProps) {
  const state = useWorkbench(controller)
  const [pendingClose, setPendingClose] = useState<string | null>(null)
  const [closing, setClosing] = useState(false)
  const [dragOverPane, setDragOverPane] = useState<EditorPaneId | null>(null)
  const [notice, setNotice] = useState<EditorNotice | null>(null)
  // Batch closes (Close Others/Right/Saved/All) run one tab at a time so each
  // dirty draft still gets its own confirmation; this is what is left to close.
  const pendingBatch = useRef<string[]>([])
  // This seat is session-scoped, so its own identity addresses the Workspace;
  // the Session list only supplies the recency ranking for an ungrouped Session.
  const sessions = useSessions(snapshot => snapshot.byId)
  const workspaces = useWorkspaces(snapshot => snapshot.items)
  const workspaceId = useMemo(
    () => resolveWorkbenchWorkspaceId(workspaces, sessionId, sessions),
    [sessions, sessionId, workspaces],
  )
  const findTab = (id: string | undefined): WorkbenchTab | undefined =>
    id === undefined ? undefined : state.tabs.find(candidate => candidate.id === id)
  const tab = findTab(state.activeTabId)
  const resolvePaneTabs = (group: EditorGroup): WorkbenchTab[] => group.tabIds
    .map(id => findTab(id))
    .filter((candidate): candidate is WorkbenchTab => candidate !== undefined)
  const primaryTabs = resolvePaneTabs(state.panes.primary)
  const secondaryTabs = state.editorSplit ? resolvePaneTabs(state.panes.secondary) : []
  const primaryActive = primaryTabs.find(candidate => candidate.id === state.panes.primary.activeTabId)
  const secondaryActive = secondaryTabs.find(candidate => candidate.id === state.panes.secondary.activeTabId)
  const closeTab = pendingClose === null ? undefined : findTab(pendingClose)
  // A pane's Git baseline only tracks an editable file buffer (not a Markdown preview).
  const baselineFor = (active: WorkbenchTab | undefined) => ({
    tabId: active?.kind === 'file' && active.file !== null && active.markdownMode !== 'preview' ? active.id : undefined,
    fileVersion: active?.kind === 'file' ? active.file?.version : undefined,
    lineVersion: active?.kind === 'file' ? state.gitLineVersions?.[active.path] : undefined,
  })
  const primaryBaseline = baselineFor(primaryActive)
  const secondaryBaseline = baselineFor(secondaryActive)
  const gitLineLabels = useMemo(() => ({
    added: t('editor.gitAddedChange'),
    modified: t('editor.gitModifiedChange'),
    deleted: t('editor.gitDeletedChange'),
    before: t('editor.gitHeadVersion'),
    current: t('editor.gitCurrentVersion'),
    previous: t('editor.gitPreviousChange'),
    next: t('editor.gitNextChange'),
    revert: t('editor.gitRevertChange'),
    close: t('editor.gitClosePeek'),
    resizeWidth: t('editor.gitResizePeekWidth'),
  }), [t])
  const markdownLabels = useMemo<MarkdownLabels>(() => ({
    code: { copyLabel: t('markdown.copy'), copiedLabel: t('markdown.copied') },
    footnotes: t('markdown.footnotes'),
  }), [t])
  const panesRef = useRef<HTMLDivElement>(null)

  useEffect(() => { activateWorkspace(workspaceId) }, [activateWorkspace, workspaceId])
  useEffect(() => { controller.setSession(sessionId) }, [controller, sessionId])
  useEffect(() => {
    if (primaryBaseline.tabId !== undefined) void controller.ensureGitBaseline(primaryBaseline.tabId)
  }, [primaryBaseline.fileVersion, primaryBaseline.lineVersion, primaryBaseline.tabId, controller, state.gitHead])
  useEffect(() => {
    if (secondaryBaseline.tabId !== undefined) void controller.ensureGitBaseline(secondaryBaseline.tabId)
  }, [controller, secondaryBaseline.fileVersion, secondaryBaseline.lineVersion, secondaryBaseline.tabId, state.gitHead])
  useEffect(() => {
    if (pendingClose !== null && (closeTab?.kind !== 'file' || (!closeTab.dirty && !closeTab.saving))) {
      setPendingClose(null)
    }
  }, [closeTab, pendingClose])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 's') return
      const snapshot = controller.store.getSnapshot()
      const current = snapshot.tabs.find(candidate => candidate.id === snapshot.activeTabId)
      if (current?.kind !== 'file' || current.file === null) return
      event.preventDefault()
      void controller.save(current.id)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [controller])

  if (workspaceId === undefined) return <EditorEmpty text={t('editor.emptyWorkspace')} />
  if (state.workspaceId !== workspaceId) return <EditorEmpty text={t('editor.loading')} />
  if (state.tabs.length === 0 || tab === undefined) return <EditorEmpty text={t('editor.empty')} />

  const showNotice = (text: string, failed = false): void => {
    // A functional update keeps the sequence monotonic even when two copies land
    // in the same tick; the key is what re-mounts and re-shows the banner.
    setNotice(current => ({ text, failed, sequence: (current?.sequence ?? 0) + 1 }))
  }
  const requestClose = (tabId: string): void => {
    const target = findTab(tabId)
    if (target?.kind === 'file' && target.dirty) {
      controller.selectTab(tabId)
      setPendingClose(tabId)
      return
    }
    controller.closeTab(tabId)
  }
  /**
   * Close a batch one tab at a time, pausing on the first dirty draft so the
   * existing modal still guards it. `resume` continues after the user answers.
   */
  const runBatch = (ids: string[]): void => {
    for (let position = 0; position < ids.length; position += 1) {
      const id = ids[position]!
      const target = findTab(id)
      if (target === undefined) continue
      if (target.kind === 'file' && target.dirty) {
        // The modal answers for this one tab; the rest resume only once it closes.
        pendingBatch.current = ids.slice(position + 1)
        controller.selectTab(id)
        setPendingClose(id)
        return
      }
      controller.closeTab(id)
    }
    pendingBatch.current = []
  }
  const continueBatch = (): void => {
    const rest = pendingBatch.current
    pendingBatch.current = []
    if (rest.length > 0) runBatch(rest)
  }
  const saveAndClose = async (): Promise<void> => {
    if (pendingClose === null) return
    setClosing(true)
    const saved = await controller.save(pendingClose)
    const closed = saved && controller.closeTab(pendingClose)
    if (closed) setPendingClose(null)
    setClosing(false)
    if (closed) continueBatch()
  }
  const discardAndClose = (): void => {
    const target = pendingClose
    if (target !== null) controller.closeTab(target, true)
    setPendingClose(null)
    if (target !== null) continueBatch()
  }
  const copyTabPath = async (tab: WorkbenchTab, absolute: boolean): Promise<void> => {
    if (tab.kind === 'terminal') return
    try {
      if (absolute) {
        const resolved = await controller.api.absolutePath(workspaceId, tab.path)
        await copyTextToClipboard(resolved.absolutePath)
        showNotice(t('editor.tabCopiedPath'))
      } else {
        await copyTextToClipboard(tab.path)
        showNotice(t('editor.tabCopiedRelativePath'))
      }
    } catch {
      showNotice(t('files.copyFailed'), true)
    }
  }
  const revealTab = (tab: WorkbenchTab): void => {
    if (tab.kind === 'terminal') return
    controller.setSidebarMode('files')
    controller.requestSidebarAction('files.reveal', workspaceId, tab.path)
  }
  const findPaneOf = (tabId: string): EditorPaneId | undefined =>
    state.panes.primary.tabIds.includes(tabId)
      ? 'primary'
      : state.panes.secondary.tabIds.includes(tabId) ? 'secondary' : undefined
  const runTabMenuAction = (action: EditorTabMenuAction, tab: WorkbenchTab): void => {
    // The close family is scoped to the strip the menu opened on, not the whole pool.
    const paneTabs = resolvePaneTabs(state.panes[findPaneOf(tab.id) ?? state.activePane])
    switch (action) {
      case 'close':
        requestClose(tab.id)
        return
      case 'close-others':
        runBatch(tabsForCloseScope(paneTabs, tab.id, 'others').map(candidate => candidate.id))
        return
      case 'close-right':
        runBatch(tabsForCloseScope(paneTabs, tab.id, 'right').map(candidate => candidate.id))
        return
      case 'close-saved':
        runBatch(tabsForCloseScope(paneTabs, tab.id, 'saved').map(candidate => candidate.id))
        return
      case 'close-all':
        runBatch(tabsForCloseScope(paneTabs, tab.id, 'all').map(candidate => candidate.id))
        return
      case 'save':
        if (tab.kind === 'file') void controller.save(tab.id)
        return
      case 'revert':
        controller.revert(tab.id)
        return
      case 'copy-path':
        void copyTabPath(tab, true)
        return
      case 'copy-relative-path':
        void copyTabPath(tab, false)
        return
      case 'reveal':
        revealTab(tab)
        return
      case 'split-right':
        controller.splitWithTab(tab.id, 'horizontal')
        return
      case 'split-down':
        controller.splitWithTab(tab.id, 'vertical')
        return
    }
  }
  // Per-pane HTML5 drop target: only the primary pane gates drag-over on the split being open.
  const paneDropProps = (pane: EditorPaneId, enabled: boolean) => ({
    onDragOver: enabled
      ? (event: DragEvent<HTMLDivElement>) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDragOverPane(pane) }
      : undefined,
    onDragLeave: () => { setDragOverPane(current => current === pane ? null : current) },
    onDrop: (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault()
      setDragOverPane(null)
      const movedTabId = event.dataTransfer.getData('text/plain')
      if (movedTabId !== '') controller.moveTabToPane(movedTabId, pane)
    },
  })

  return (
    <section className={css.editorRoot} data-dsh-workbench-editor="">
      <div
        ref={panesRef}
        className={css.editorPanes}
        data-split={state.editorSplit && secondaryActive !== undefined || undefined}
        data-split-orientation={state.editorSplitOrientation}
      >
        <div
          className={css.editorPanePrimary}
          data-dsh-editor-pane="primary"
          style={state.editorSplit && secondaryActive !== undefined
            ? { flexGrow: state.editorSplitRatio, flexShrink: 1, flexBasis: 0 }
            : undefined}
          onPointerDownCapture={() => { controller.focusPane('primary') }}
          {...paneDropProps('primary', state.editorSplit)}
        >
          <EditorPane
            pane="primary"
            tabs={primaryTabs}
            group={state.panes.primary}
            state={state}
            workspaceId={workspaceId}
            controller={controller}
            t={t}
            gitLineLabels={gitLineLabels}
            markdownLabels={markdownLabels}
            showSplitControls
            onRequestClose={requestClose}
            onMenuAction={runTabMenuAction}
          />
          {dragOverPane === 'primary' && <div className={css.editorPaneDropOverlay} />}
        </div>
        {state.editorSplit && secondaryActive !== undefined && (
          <>
            <SplitDivider
              orientation={state.editorSplitOrientation}
              ratio={state.editorSplitRatio}
              containerRef={panesRef}
              label={t('editor.resizeSplit')}
              onCommit={ratio => { controller.setSplitRatio(ratio) }}
            />
            <div
              className={css.editorPaneSecondary}
              data-dsh-editor-pane="secondary"
              style={{ flexGrow: 1 - state.editorSplitRatio, flexShrink: 1, flexBasis: 0 }}
              onPointerDownCapture={() => { controller.focusPane('secondary') }}
              {...paneDropProps('secondary', true)}
            >
              <EditorPane
                pane="secondary"
                tabs={secondaryTabs}
                group={state.panes.secondary}
                state={state}
                workspaceId={workspaceId}
                controller={controller}
                t={t}
                gitLineLabels={gitLineLabels}
                markdownLabels={markdownLabels}
                onRequestClose={requestClose}
                onMenuAction={runTabMenuAction}
              />
              {dragOverPane === 'secondary' && <div className={css.editorPaneDropOverlay} />}
            </div>
          </>
        )}
      </div>
      {state.tabs.length === 0 || tab === undefined ? <EditorEmpty text={t('editor.empty')} /> : null}
      <Modal
        open={closeTab !== undefined}
        onClose={() => { if (!closing) { pendingBatch.current = []; setPendingClose(null) } }}
        closeLabel={t('editor.cancelClose')}
        title={t('editor.closeUnsavedTitle')}
        {...closeTab === undefined
          ? {}
          : closeTab.kind === 'file'
            ? { description: t('editor.closeUnsavedDescription', { path: closeTab.path }) }
            : {}}
        footer={(
          <>
            <Button variant="outline" disabled={closing} onClick={() => { pendingBatch.current = []; setPendingClose(null) }}>{t('editor.cancelClose')}</Button>
            <Button variant="outline" className={css.discardAction} disabled={closing} onClick={discardAndClose}>{t('editor.discardClose')}</Button>
            <Button variant="primary" disabled={closing} onClick={() => { void saveAndClose() }}>
              {closing ? t('editor.saving') : t('editor.saveClose')}
            </Button>
          </>
        )}
      >
        {closeTab !== undefined && closeTab.kind !== 'terminal' && closeTab.error !== null && closeTab.error !== undefined && (
          <div className={css.editorModalError} role="alert">{closeTab.error}</div>
        )}
      </Modal>
      {notice === null ? null : (
        <Toast
          key={notice.sequence}
          text={notice.text}
          {...notice.failed ? {} : { tone: 'success' as const }}
          onDone={() => { setNotice(current => current?.sequence === notice.sequence ? null : current) }}
        />
      )}
    </section>
  )
}
