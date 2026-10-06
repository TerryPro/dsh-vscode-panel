/** One split editor pane: its own tab strip, per-pane toolbar, terminals, and body. */

import { useState } from 'react'
import type { ComponentType } from 'react'
import { Button, IconCloseOutlineMedium, type MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { EditorView } from '@codemirror/view'
import type { GitLineDecorationLabels } from '../git/git-line-decorations.ts'
import type {
  EditorGroup,
  EditorPaneId,
  WorkbenchController,
  WorkbenchState,
  WorkbenchTab,
  WorkbenchTerminalTab,
} from '../model/controller.ts'
import type { WorkbenchKey } from '../core/locales.ts'
import { EditorTabs } from './EditorTabs.tsx'
import { EditorTabBody } from './EditorTabBody.tsx'
import { IconBoldOutline16, IconBulletListOutline16, IconInlineCodeOutline16, IconItalicOutline16, IconLinkOutline16, IconRevertOutline16, IconSplitHorizontalOutline16, IconSplitVerticalOutline16, IconTableOutline16 } from './EditorViewIcons.tsx'
import { runMarkdownCommand, type MarkdownCommandKind } from '../markdown/markdown-format.ts'
import { TerminalSurface } from '../terminal/TerminalSurface.tsx'
import css from './editor.module.css'

const MARKDOWN_FORMAT_COMMANDS: readonly { kind: MarkdownCommandKind; Icon: ComponentType<{ size?: number }>; labelKey: WorkbenchKey }[] = [
  { kind: 'bold', Icon: IconBoldOutline16, labelKey: 'markdown.bold' },
  { kind: 'italic', Icon: IconItalicOutline16, labelKey: 'markdown.italic' },
  { kind: 'code', Icon: IconInlineCodeOutline16, labelKey: 'markdown.code' },
  { kind: 'link', Icon: IconLinkOutline16, labelKey: 'markdown.link' },
  { kind: 'table', Icon: IconTableOutline16, labelKey: 'markdown.table' },
  { kind: 'bulletList', Icon: IconBulletListOutline16, labelKey: 'markdown.list' },
]

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

export function EditorPane({
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
