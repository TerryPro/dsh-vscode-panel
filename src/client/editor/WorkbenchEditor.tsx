import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Modal, type MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { EditorGroup, EditorPaneId, WorkbenchController, WorkbenchTab } from '../core/controller.ts'
import { EditorEmpty } from './EditorShared.tsx'
import { EditorPane } from './EditorPane.tsx'
import { SplitDivider } from './SplitDivider.tsx'
import { useWorkbench } from '../core/use-workbench.ts'
import { resolveWorkbenchWorkspaceId } from '../layout/workspace-binding.ts'
import css from '../core/Workbench.module.css'

export type WorkbenchEditorProps = PropsRuntime<'rightbar.session'> & PropsLocale<'workbench'> & {
  controller: WorkbenchController
  activateWorkspace: (workspaceId: string | undefined) => void
}

/** Middle multi-file surface, with Markdown preview as the default mode. */
export function WorkbenchEditor({ sessionId, useSessions, useWorkspaces, controller, activateWorkspace, t }: WorkbenchEditorProps) {
  const state = useWorkbench(controller)
  const [pendingClose, setPendingClose] = useState<string | null>(null)
  const [closing, setClosing] = useState(false)
  const [dragOverPane, setDragOverPane] = useState<EditorPaneId | null>(null)
  // This seat is session-scoped, so its own identity addresses the Workspace;
  // the Session list only supplies the recency ranking for an ungrouped Session.
  const sessions = useSessions(snapshot => snapshot.byId)
  const workspaces = useWorkspaces(snapshot => snapshot.items)
  const workspaceId = useMemo(
    () => resolveWorkbenchWorkspaceId(workspaces, sessionId, sessions),
    [sessions, sessionId, workspaces],
  )
  const tab = state.tabs.find(candidate => candidate.id === state.activeTabId)
  const resolvePaneTabs = (group: EditorGroup): WorkbenchTab[] => group.tabIds
    .map(id => state.tabs.find(candidate => candidate.id === id))
    .filter((candidate): candidate is WorkbenchTab => candidate !== undefined)
  const primaryTabs = resolvePaneTabs(state.panes.primary)
  const secondaryTabs = state.editorSplit ? resolvePaneTabs(state.panes.secondary) : []
  const primaryActive = primaryTabs.find(candidate => candidate.id === state.panes.primary.activeTabId)
  const secondaryActive = secondaryTabs.find(candidate => candidate.id === state.panes.secondary.activeTabId)
  const closeTab = pendingClose === null ? undefined : state.tabs.find(candidate => candidate.id === pendingClose)
  const baselineTabId = primaryActive?.kind === 'file' && primaryActive.file !== null && primaryActive.markdownMode !== 'preview' ? primaryActive.id : undefined
  const baselineFileVersion = primaryActive?.kind === 'file' ? primaryActive.file?.version : undefined
  const baselineLineVersion = primaryActive?.kind === 'file' ? state.gitLineVersions?.[primaryActive.path] : undefined
  const secondaryBaselineTabId = secondaryActive?.kind === 'file' && secondaryActive.file !== null && secondaryActive.markdownMode !== 'preview' ? secondaryActive.id : undefined
  const secondaryBaselineFileVersion = secondaryActive?.kind === 'file' ? secondaryActive.file?.version : undefined
  const secondaryBaselineLineVersion = secondaryActive?.kind === 'file' ? state.gitLineVersions?.[secondaryActive.path] : undefined
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
    if (baselineTabId !== undefined) void controller.ensureGitBaseline(baselineTabId)
  }, [baselineFileVersion, baselineLineVersion, baselineTabId, controller, state.gitHead])
  useEffect(() => {
    if (secondaryBaselineTabId !== undefined) void controller.ensureGitBaseline(secondaryBaselineTabId)
  }, [controller, secondaryBaselineFileVersion, secondaryBaselineLineVersion, secondaryBaselineTabId, state.gitHead])
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

  const requestClose = (tabId: string): void => {
    const target = state.tabs.find(candidate => candidate.id === tabId)
    if (target?.kind === 'file' && target.dirty) {
      controller.selectTab(tabId)
      setPendingClose(tabId)
      return
    }
    controller.closeTab(tabId)
  }
  const saveAndClose = async (): Promise<void> => {
    if (pendingClose === null) return
    setClosing(true)
    const saved = await controller.save(pendingClose)
    if (saved && controller.closeTab(pendingClose)) setPendingClose(null)
    setClosing(false)
  }
  const discardAndClose = (): void => {
    if (pendingClose !== null) controller.closeTab(pendingClose, true)
    setPendingClose(null)
  }

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
          onDragOver={state.editorSplit
            ? (event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDragOverPane('primary') }
            : undefined}
          onDragLeave={() => { setDragOverPane(current => current === 'primary' ? null : current) }}
          onDrop={(event) => {
            event.preventDefault()
            setDragOverPane(null)
            const movedTabId = event.dataTransfer.getData('text/plain')
            if (movedTabId !== '') controller.moveTabToPane(movedTabId, 'primary')
          }}
        >
          <EditorPane
            pane="primary"
            tabs={primaryTabs}
            group={state.panes.primary}
            state={state}
            sessionId={sessionId}
            workspaceId={workspaceId}
            controller={controller}
            t={t}
            gitLineLabels={gitLineLabels}
            markdownLabels={markdownLabels}
            showSplitControls
            onRequestClose={requestClose}
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
              onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDragOverPane('secondary') }}
              onDragLeave={() => { setDragOverPane(current => current === 'secondary' ? null : current) }}
              onDrop={(event) => {
                event.preventDefault()
                setDragOverPane(null)
                const movedTabId = event.dataTransfer.getData('text/plain')
                if (movedTabId !== '') controller.moveTabToPane(movedTabId, 'secondary')
              }}
            >
              <EditorPane
                pane="secondary"
                tabs={secondaryTabs}
                group={state.panes.secondary}
                state={state}
                sessionId={sessionId}
                workspaceId={workspaceId}
                controller={controller}
                t={t}
                gitLineLabels={gitLineLabels}
                markdownLabels={markdownLabels}
                onRequestClose={requestClose}
              />
              {dragOverPane === 'secondary' && <div className={css.editorPaneDropOverlay} />}
            </div>
          </>
        )}
      </div>
      <Modal
        open={closeTab !== undefined}
        onClose={() => { if (!closing) setPendingClose(null) }}
        closeLabel={t('editor.cancelClose')}
        title={t('editor.closeUnsavedTitle')}
        {...closeTab === undefined
          ? {}
          : closeTab.kind === 'file'
            ? { description: t('editor.closeUnsavedDescription', { path: closeTab.path }) }
            : {}}
        footer={(
          <>
            <Button variant="outline" disabled={closing} onClick={() => { setPendingClose(null) }}>{t('editor.cancelClose')}</Button>
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
    </section>
  )
}
