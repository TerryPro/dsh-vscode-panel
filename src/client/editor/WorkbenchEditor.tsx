import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentType } from 'react'
import { Button, FishLogo, IconCloseOutlineMedium, MarkdownText, type MarkdownLabels, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { EditorView } from '@codemirror/view'
import type { WorkspaceImageFile } from '../../shared/contracts.ts'
import type { GitLineDecorationLabels } from '../git/git-line-decorations.ts'
import type {
  EditorGroup,
  EditorPaneId,
  EditorSplitOrientation,
  WorkbenchController,
  WorkbenchState,
  WorkbenchTab,
  WorkbenchTerminalTab,
} from '../core/controller.ts'
import { CodeEditor } from './CodeEditor.tsx'
import { EditorStatusBar } from './EditorStatusBar.tsx'
import { IconBoldOutline16, IconBulletListOutline16, IconInlineCodeOutline16, IconInlineDiffOutline16, IconInteractiveOutline16, IconItalicOutline16, IconLinkOutline16, IconOutline16, IconPreviewOutline16, IconRevertOutline16, IconSourceOutline16, IconSplitHorizontalOutline16, IconSplitViewOutline16, IconSplitVerticalOutline16, IconTableOutline16, IconWordWrapOutline16 } from './EditorViewIcons.tsx'
import type { EditorCursorState } from './CodeEditor.tsx'
import { EditorTabs } from './EditorTabs.tsx'
import { GitDiffEditor } from '../git/GitDiffEditor.tsx'
import { HtmlPreview } from './HtmlPreview.tsx'
import { isHtmlPath, resolveRelativePath } from './html-preview.ts'
import type { ReadHtmlRelative } from './html-preview.ts'
import type { WorkbenchKey } from '../core/locales.ts'
import { MarkdownOutline } from '../markdown/MarkdownOutline.tsx'
import { extractMarkdownOutline } from '../markdown/markdown-outline.ts'
import { runMarkdownCommand, type MarkdownCommandKind } from '../markdown/markdown-format.ts'
import { attachSplitScrollSync } from '../markdown/markdown-split-scroll.ts'
import { TerminalSurface } from '../terminal/TerminalSurface.tsx'
import { useWorkbench } from '../core/use-workbench.ts'
import { resolveWorkbenchWorkspaceId } from '../layout/workspace-binding.ts'
import css from '../core/Workbench.module.css'

export type WorkbenchEditorProps = PropsRuntime<'rightbar.session'> & PropsLocale<'workbench'> & {
  controller: WorkbenchController
  activateWorkspace: (workspaceId: string | undefined) => void
}

interface EditorTabBodyProps {
  tab: WorkbenchTab
  active: boolean
  workspaceId: string
  controller: WorkbenchController
  t: TranslateNS<'workbench'>
  gitLineLabels: GitLineDecorationLabels
  markdownLabels: MarkdownLabels
  /** Reports the editable view up so the header format toolbar can act on the active pane. */
  onViewReady?: (view: EditorView | null) => void
}

interface SplitDividerProps {
  orientation: EditorSplitOrientation
  ratio: number
  containerRef: React.RefObject<HTMLDivElement>
  onCommit: (ratio: number) => void
  label: string
}

const MARKDOWN_FORMAT_COMMANDS: readonly { kind: MarkdownCommandKind; Icon: ComponentType<{ size?: number }>; labelKey: WorkbenchKey }[] = [
  { kind: 'bold', Icon: IconBoldOutline16, labelKey: 'markdown.bold' },
  { kind: 'italic', Icon: IconItalicOutline16, labelKey: 'markdown.italic' },
  { kind: 'code', Icon: IconInlineCodeOutline16, labelKey: 'markdown.code' },
  { kind: 'link', Icon: IconLinkOutline16, labelKey: 'markdown.link' },
  { kind: 'table', Icon: IconTableOutline16, labelKey: 'markdown.table' },
  { kind: 'bulletList', Icon: IconBulletListOutline16, labelKey: 'markdown.list' },
]

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

function EditorEmpty({ text }: { text: string }) {
  return (
    <div className={css.editorEmpty} data-dsh-workbench-editor="">
      <FishLogo size={34} />
      <span>{text}</span>
    </div>
  )
}

function ImagePreview({ image }: { image: WorkspaceImageFile }) {
  const source = `data:${image.mimeType};base64,${image.content}`
  return (
    <div className={css.imagePreview}>
      <img className={css.imagePreviewImage} src={source} alt={image.path} />
    </div>
  )
}

interface EditorPaneProps {
  pane: EditorPaneId
  tabs: WorkbenchTab[]
  group: EditorGroup
  state: WorkbenchState
  sessionId: string
  workspaceId: string
  controller: WorkbenchController
  t: TranslateNS<'workbench'>
  gitLineLabels: GitLineDecorationLabels
  markdownLabels: MarkdownLabels
  showSplitControls?: boolean
  onRequestClose: (tabId: string) => void
}

/** One split editor pane: its own tab strip, per-pane toolbar, terminals, and body. */
function EditorPane({
  tabs,
  group,
  state,
  sessionId,
  workspaceId,
  controller,
  t,
  gitLineLabels,
  markdownLabels,
  showSplitControls,
  onRequestClose,
}: EditorPaneProps) {
  const [editorView, setEditorView] = useState<EditorView | null>(null)
  const activeId = group.activeTabId
  const tab = activeId === undefined ? undefined : tabs.find(candidate => candidate.id === activeId)
  const terminals = tabs.filter((candidate): candidate is WorkbenchTerminalTab => candidate.kind === 'terminal')
  return (
    <>
      <header className={css.editorHeader}>
        <EditorTabs
          tabs={tabs}
          activeTabId={activeId}
          gitDecorations={state.gitDecorations}
          onSelect={tabId => { controller.selectTab(tabId) }}
          onClose={onRequestClose}
          t={t}
        />
        {tab !== undefined && tab.kind === 'file' && tab.file !== null && (
          <div className={css.editorActions}>
            {tab.file.markdown && tab.markdownMode !== 'preview' && (
              <div className={css.markdownToolbar} role="group" aria-label={t('editor.markdownFormat')}>
                {MARKDOWN_FORMAT_COMMANDS.map(({ kind, Icon, labelKey }) => (
                  <button
                    key={kind}
                    type="button"
                    title={t(labelKey)}
                    aria-label={t(labelKey)}
                    onClick={() => { if (editorView !== null) runMarkdownCommand(editorView, kind) }}
                  >
                    <Icon />
                  </button>
                ))}
              </div>
            )}
            {tab.dirty && (
              <Button size="sm" variant="toolbar" aria-label={t('editor.revert')} title={t('editor.revert')} onClick={() => { controller.revert(tab.id) }}><IconRevertOutline16 /></Button>
            )}
          </div>
        )}
        {showSplitControls && (
          <div className={css.editorSplitControls}>
            <button
              type="button"
              className={css.editorSplitAction}
              aria-label={t('editor.splitHorizontal')}
              title={t('editor.splitHorizontal')}
              aria-pressed={state.editorSplit && state.editorSplitOrientation === 'horizontal'}
              onClick={() => { controller.toggleSplit('horizontal') }}
            ><IconSplitHorizontalOutline16 /></button>
            <button
              type="button"
              className={css.editorSplitAction}
              aria-label={t('editor.splitVertical')}
              title={t('editor.splitVertical')}
              aria-pressed={state.editorSplit && state.editorSplitOrientation === 'vertical'}
              onClick={() => { controller.toggleSplit('vertical') }}
            ><IconSplitVerticalOutline16 /></button>
            {state.editorSplit && (
              <button
                type="button"
                className={css.editorSplitAction}
                aria-label={t('editor.closeSplit')}
                title={t('editor.closeSplit')}
                onClick={() => { controller.toggleSplit() }}
              ><IconCloseOutlineMedium size={13} /></button>
            )}
          </div>
        )}
      </header>
      {tab !== undefined && tab.kind !== 'terminal' && tab.error !== null && (
        <div className={css.editorError} role="alert">{tab.error}</div>
      )}
      {tab !== undefined && tab.kind === 'file' && tab.externalChange !== null && (
        <div className={css.editorExternalChange} role="status">
          <span>{tab.externalChange.kind === 'changed'
            ? t('editor.externalChanged')
            : t('editor.externalDeleted')}</span>
          <div className={css.editorExternalActions}>
            {tab.externalChange.kind === 'changed'
              ? (
                <>
                  <Button size="sm" variant="toolbar" onClick={() => { controller.reloadExternalFile(tab.id) }}>
                    {t('editor.reloadExternal')}
                  </Button>
                  <Button size="sm" variant="toolbar" onClick={() => { controller.keepCurrentDraft(tab.id) }}>
                    {t('editor.keepCurrent')}
                  </Button>
                </>
              )
              : (
                <Button size="sm" variant="toolbar" onClick={() => { onRequestClose(tab.id) }}>
                  {t('editor.closeDeleted')}
                </Button>
              )}
          </div>
        </div>
      )}
      {terminals.map(terminal => (
        <div
          key={terminal.id}
          className={css.terminalTabBody}
          hidden={terminal.id !== activeId}
        >
          <TerminalSurface
            tab={terminal}
            sessionId={sessionId}
            active={terminal.id === activeId}
            controller={controller}
            t={t}
          />
        </div>
      ))}
      {tab !== undefined && tab.kind !== 'terminal' && (
        <EditorTabBody
          tab={tab}
          active
          workspaceId={workspaceId}
          controller={controller}
          t={t}
          gitLineLabels={gitLineLabels}
          markdownLabels={markdownLabels}
          onViewReady={setEditorView}
        />
      )}
    </>
  )
}

/** One pane's tab surface: file editor with status bar, Diff, image, or previews. */
function EditorTabBody({
  tab,
  active,
  workspaceId,
  controller,
  t,
  gitLineLabels,
  markdownLabels,
  onViewReady,
}: EditorTabBodyProps) {
  const [cursor, setCursor] = useState<EditorCursorState>({ line: 1, column: 1, selectedChars: 0, selectedLines: 0 })
  const previewRef = useRef<HTMLDivElement>(null)
  const [localView, setLocalView] = useState<EditorView | null>(null)
  const isHtmlTab = tab.kind === 'file' && tab.file !== null && isHtmlPath(tab.path)
  const showEditor = tab.kind === 'file'
    && tab.file !== null
    && !(isHtmlTab && tab.htmlMode !== 'source')
    && !(tab.file.markdown && tab.markdownMode === 'preview')
  // Read an interactive preview's local dependency relative to the opened HTML file;
  // the resolved path is still scope-checked by the workspace backend.
  const htmlBasePath = tab.kind === 'file' ? tab.path : undefined
  const readHtmlResource = useMemo<ReadHtmlRelative | undefined>(() => {
    if (htmlBasePath === undefined) return undefined
    const basePath = htmlBasePath
    return async (reference, signal) => {
      const resolved = resolveRelativePath(basePath, reference)
      const file = await controller.api.readFile(workspaceId, resolved)
      signal.throwIfAborted()
      return file.content
    }
  }, [controller, htmlBasePath, workspaceId])
  const handleViewReady = (view: EditorView | null): void => {
    setLocalView(view)
    if (active) onViewReady?.(view)
  }
  // Outline only makes sense where a rendered preview is shown (preview or split).
  const fileTab = tab.kind === 'file' ? tab : null
  const outlineEntries = useMemo(() => {
    if (fileTab === null || fileTab.file === null || fileTab.file.markdown !== true) return []
    if (fileTab.markdownMode !== 'preview' && fileTab.markdownMode !== 'split') return []
    return fileTab.outlineVisible === true ? extractMarkdownOutline(fileTab.draft) : []
  }, [fileTab])
  const handleOutlineSelect = useCallback((index: number): void => {
    const container = previewRef.current
    if (container === null) return
    const headings = container.querySelectorAll('h1, h2, h3, h4, h5, h6')
    headings[index]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])
  useEffect(() => {
    const scroller = localView?.scrollDOM
    const preview = previewRef.current
    if (scroller === undefined || preview === null) return undefined
    return attachSplitScrollSync(scroller, preview)
  }, [localView, tab.id])

  if (tab.kind === 'terminal') return null
  if (tab.kind === 'diff') {
    if (tab.diff === null) return <EditorEmpty text={tab.error ?? t('editor.loading')} />
    const diff = tab.diff
    return (
      <GitDiffEditor
        diff={diff}
        viewMode={controller.store.getSnapshot().diffViewMode}
        onViewModeChange={mode => { controller.setDiffViewMode(mode) }}
        t={t}
      />
    )
  }
  if (tab.loading || (tab.file === null && tab.image === null)) {
    return <EditorEmpty text={tab.error ?? t('editor.loading')} />
  }
  if (tab.image !== null) return <ImagePreview image={tab.image} />
  if (tab.file === null) return <EditorEmpty text={tab.error ?? t('editor.loading')} />
  return (
    <div className={css.editorFileArea}>
      <div className={css.editorFileBody}>
        {isHtmlTab && tab.htmlMode !== 'source'
          ? (
            <HtmlPreview
              html={tab.draft}
              title={t('editor.htmlFrame')}
              loadingText={t('editor.loading')}
              failedText={t('editor.htmlFailed')}
              interactive={tab.htmlMode === 'interactive'}
              readResource={readHtmlResource}
            />
          )
          : tab.file.markdown && tab.markdownMode === 'preview'
            ? (
              <>
                <div ref={previewRef} className={css.markdownPreview}><MarkdownText text={tab.draft} labels={markdownLabels} /></div>
                {tab.outlineVisible === true && (
                  <MarkdownOutline entries={outlineEntries} labels={{ title: t('editor.outline'), empty: t('editor.outlineEmpty') }} onSelect={handleOutlineSelect} />
                )}
              </>
            )
            : (
              <>
                <CodeEditor
                  key={tab.id}
                  value={tab.draft}
                  ariaLabel={tab.path}
                  path={tab.path}
                  onChange={(value, source) => { controller.setDraft(value, source, tab.id) }}
                  onCursorChange={setCursor}
                  onGitHunkOpen={() => { controller.logGitHunkOpen(tab.path) }}
                  onGitHunkResize={width => { controller.logGitHunkResize(tab.path, width) }}
                  onGitHunkResizeStorageError={operation => { controller.logGitHunkResizeStorageError(operation) }}
                  onGitHunkDismissOutside={() => { controller.logGitHunkDismissOutside(tab.path) }}
                  onViewReady={handleViewReady}
                  inlineDiff={tab.inlineDiff}
                  wrap={tab.wrap}
                  {...tab.gitBaseline?.available === true && !tab.gitBaseline.binary
                    ? { gitOriginal: tab.gitBaseline.original }
                    : {}}
                  gitLabels={gitLineLabels}
                />
                {tab.file.markdown && tab.markdownMode === 'split' && (
                  <>
                    <div ref={previewRef} className={css.markdownPreviewPane}><MarkdownText text={tab.draft} labels={markdownLabels} /></div>
                    {tab.outlineVisible === true && (
                      <MarkdownOutline entries={outlineEntries} labels={{ title: t('editor.outline'), empty: t('editor.outlineEmpty') }} onSelect={handleOutlineSelect} />
                    )}
                  </>
                )}
              </>
            )}
      </div>
      <EditorStatusBar
        cursor={cursor}
        path={tab.path}
        content={tab.draft}
        t={t}
        showPosition={showEditor}
        actions={(
          <>
            {tab.file.markdown && (
              <div className={css.editorStatusBarSwitch} role="group" aria-label={t('editor.preview')}>
                <button type="button" className={css.editorStatusBarAction} data-active={tab.markdownMode === 'preview' || undefined} aria-label={t('editor.preview')} title={t('editor.preview')} onClick={() => { controller.setMarkdownMode('preview', tab.id) }}><IconPreviewOutline16 /></button>
                <button type="button" className={css.editorStatusBarAction} data-active={tab.markdownMode === 'split' || undefined} aria-label={t('editor.split')} title={t('editor.split')} onClick={() => { controller.setMarkdownMode('split', tab.id) }}><IconSplitViewOutline16 /></button>
                <button type="button" className={css.editorStatusBarAction} data-active={tab.markdownMode === 'source' || undefined} aria-label={t('editor.source')} title={t('editor.source')} onClick={() => { controller.setMarkdownMode('source', tab.id) }}><IconSourceOutline16 /></button>
              </div>
            )}
            {tab.file.markdown && tab.markdownMode !== 'source' && (
              <button type="button" className={css.editorStatusBarAction} data-active={tab.outlineVisible === true || undefined} aria-label={t('editor.outline')} title={t('editor.outline')} aria-pressed={tab.outlineVisible === true} onClick={() => { controller.toggleMarkdownOutline(tab.id) }}><IconOutline16 /></button>
            )}
            {isHtmlTab && (
              <div className={css.editorStatusBarSwitch} role="group" aria-label={t('editor.preview')}>
                <button type="button" className={css.editorStatusBarAction} data-active={tab.htmlMode !== 'interactive' && tab.htmlMode !== 'source' || undefined} aria-label={t('editor.preview')} title={t('editor.preview')} onClick={() => { controller.setHtmlMode('preview', tab.id) }}><IconPreviewOutline16 /></button>
                <button type="button" className={css.editorStatusBarAction} data-active={tab.htmlMode === 'interactive' || undefined} aria-label={t('editor.htmlInteractive')} title={t('editor.htmlInteractive')} onClick={() => { controller.setHtmlMode('interactive', tab.id) }}><IconInteractiveOutline16 /></button>
                <button type="button" className={css.editorStatusBarAction} data-active={tab.htmlMode === 'source' || undefined} aria-label={t('editor.source')} title={t('editor.source')} onClick={() => { controller.setHtmlMode('source', tab.id) }}><IconSourceOutline16 /></button>
              </div>
            )}
            {showEditor && (
              <button type="button" className={css.editorStatusBarAction} aria-label={t('editor.wrap')} title={t('editor.wrap')} aria-pressed={tab.wrap} onClick={() => { controller.setEditorWrap(tab.id, !tab.wrap) }}><IconWordWrapOutline16 /></button>
            )}
            {showEditor && tab.gitBaseline?.available === true && !tab.gitBaseline.binary && (
              <button type="button" className={css.editorStatusBarAction} aria-label={t('editor.showDiff')} title={t('editor.showDiff')} aria-pressed={tab.inlineDiff} onClick={() => { controller.setEditorInlineDiff(tab.id, !tab.inlineDiff) }}><IconInlineDiffOutline16 /></button>
            )}
          </>
        )}
      />
    </div>
  )
}

/** Draggable separator that resizes the two split editor panes. */
function SplitDivider({ orientation, ratio, containerRef, onCommit, label }: SplitDividerProps) {
  const handleRef = useRef<HTMLDivElement>(null)
  const frame = useRef<number | null>(null)
  const pending = useRef<number | null>(null)

  const commit = (next: number): void => {
    pending.current = clampSplitRatio(next)
    if (frame.current !== null) return
    const requestFrame = window.requestAnimationFrame?.bind(window) ?? ((callback: () => void) => setTimeout(callback, 16) as unknown as number)
    frame.current = requestFrame(() => {
      frame.current = null
      const value = pending.current
      if (value !== null) onCommit(value)
    })
  }

  const fit = (): void => {
    const container = containerRef.current
    const handle = handleRef.current
    if (container === null || handle === null) return
    const rect = container.getBoundingClientRect()
    if (orientation === 'horizontal') {
      const usable = Math.max(1, rect.width - handle.offsetWidth)
      commit((handle.getBoundingClientRect().left - rect.left) / usable)
    } else {
      const usable = Math.max(1, rect.height - handle.offsetHeight)
      commit((handle.getBoundingClientRect().top - rect.top) / usable)
    }
  }
  const fitRef = useRef(fit)
  fitRef.current = fit

  const lockBody = (): void => {
    document.documentElement.dataset.dshSplitDragging = orientation
  }
  const unlockBody = (): void => {
    delete document.documentElement.dataset.dshSplitDragging
  }

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    lockBody()
  }
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId) !== true) return
    const container = containerRef.current
    if (container === null) return
    event.preventDefault()
    const rect = container.getBoundingClientRect()
    const handle = event.currentTarget.getBoundingClientRect()
    const pointer = orientation === 'horizontal' ? event.clientX : event.clientY
    const start = orientation === 'horizontal' ? rect.left : rect.top
    const thickness = orientation === 'horizontal' ? handle.width : handle.height
    const usable = (orientation === 'horizontal' ? rect.width : rect.height) - thickness
    commit((pointer - start) / Math.max(1, usable))
  }
  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId) === true) {
      event.currentTarget.releasePointerCapture?.(event.pointerId)
    }
    unlockBody()
  }

  useEffect(() => {
    const handle = handleRef.current
    if (handle === null) return undefined
    const storeRatio = (): number => pending.current ?? clampSplitRatio(ratio)
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.target !== handle && !handle.contains(event.target as Node)) return
      const horizontalKeys = event.key === 'ArrowLeft' || event.key === 'ArrowRight'
      const verticalKeys = event.key === 'ArrowUp' || event.key === 'ArrowDown'
      if (orientation === 'horizontal' ? !horizontalKeys : !verticalKeys) return
      const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown'
      const delta = (event.shiftKey ? 0.1 : 0.02) * (forward ? 1 : -1)
      event.preventDefault()
      onCommit(clampSplitRatio(storeRatio() + delta))
    }
    window.addEventListener('keydown', onKeyDown)
    const onResize = (): void => { fitRef.current() }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onResize)
      delete document.documentElement.dataset.dshSplitDragging
      if (frame.current !== null) {
        if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(frame.current)
        else clearTimeout(frame.current as unknown as ReturnType<typeof setTimeout>)
        frame.current = null
      }
    }
  }, [containerRef, onCommit, ratio])

  return (
    <div
      ref={handleRef}
      className={css.editorSplitDivider}
      role="separator"
      tabIndex={0}
      aria-orientation={orientation === 'horizontal' ? 'vertical' : 'horizontal'}
      aria-label={label}
      title={label}
      aria-valuenow={Math.round(ratio * 100)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => { onCommit(0.5) }}
    />
  )
}

const SPLIT_RATIO_MIN = 0.2
const SPLIT_RATIO_MAX = 0.8

function clampSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5
  return Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, ratio))
}
