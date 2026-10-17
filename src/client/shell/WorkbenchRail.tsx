/** 收起侧栏的模式化快捷操作；复用官方 36px rail 几何。 */

import {
  IconListPenOutlineMedium,
  IconRefreshOutlineMedium,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { IconCommitGraphOutline16 } from '../git/CommitGraphIcon.tsx'
import type { WorkbenchController, WorkbenchTerminalTab } from '../model/controller.ts'
import type { TerminalDot } from '../model/controller.ts'
import { IconFileAddOutline16, IconFolderAddOutline16, IconSqlNotebookAddOutline16 } from '../files/CreateEntryIcons.tsx'
import { IconSqlOutline16 } from '../sql/SqlIcon.tsx'
import { activeSqlNotebook } from '../sql/sql-notebook-tab.ts'
import { createSqlNotebook } from '../sql/sql-notebook-create.ts'
import { IconTerminalAddOutline16, IconTerminalOutline16 } from '../terminal/TerminalIcon.tsx'
import { terminalDot } from '../terminal/terminal-dot.ts'
import { terminalName } from '../terminal/terminal-name.ts'
import { useWorkbench } from '../model/use-workbench.ts'
import css from './shell.module.css'

interface WorkbenchRailProps {
  controller: WorkbenchController
  workspaceId: string | undefined
  expandSidebar(): void
  t: TranslateNS<'workbench'>
}

export function WorkbenchRail({ controller, workspaceId, expandSidebar, t }: WorkbenchRailProps) {
  const state = useWorkbench(controller)
  const requestAndExpand = (action: 'files.newFile' | 'files.newDirectory'): void => {
    controller.requestSidebarAction(action, workspaceId)
    expandSidebar()
  }

  /**
   * Create a notebook from the collapsed rail.
   *
   * The same three steps the file tree takes — write the file, open it, then connect it to
   * `:memory:` — because the rail is that entry with the panel folded away, not a second one.
   */
  const createNotebookAndOpen = async (): Promise<void> => {
    if (workspaceId === undefined) return
    const target = workspaceId
    const path = await createSqlNotebook({ api: controller.api, workspaceId: target, directory: '', seed: 'empty' })
    if (path === null) {
      // Every generated name was taken, and a rail has nowhere to show a reason. Opening the file
      // view is one gesture from the reader's fingers and lands them where the tree reports it.
      controller.setSidebarMode('files')
      return
    }
    await controller.openFile(target, path)
    await controller.connectNewSqlNotebook(target, path)
  }

  if (state.sidebarMode === 'files') {
    return (
      <RailActions label={t('mode.files')}>
        <RailButton label={t('files.newFile')} disabled={workspaceId === undefined} onClick={() => { requestAndExpand('files.newFile') }}>
          <IconFileAddOutline16 size={18} />
        </RailButton>
        <RailButton label={t('files.newDirectory')} disabled={workspaceId === undefined} onClick={() => { requestAndExpand('files.newDirectory') }}>
          <IconFolderAddOutline16 size={18} />
        </RailButton>
      </RailActions>
    )
  }

  if (state.sidebarMode === 'git') {
    const graph = state.gitView === 'graph'
    return (
      <RailActions label={t('mode.git')}>
        <RailButton
          label={graph ? t('git.switchToChanges') : t('git.switchToGraph')}
          active={graph}
          disabled={workspaceId === undefined}
          onClick={() => {
            controller.toggleGitView()
            expandSidebar()
          }}
        >
          {graph ? <IconListPenOutlineMedium size={18} /> : <IconCommitGraphOutline16 size={18} />}
        </RailButton>
      </RailActions>
    )
  }

  if (state.sidebarMode === 'terminal') {
    const terminals = state.tabs.filter((tab): tab is WorkbenchTerminalTab => tab.kind === 'terminal')
    return (
      <RailActions label={t('mode.terminal')}>
        <RailButton label={t('terminal.new')} disabled={workspaceId === undefined} onClick={() => { controller.openTerminal(workspaceId) }}>
          <IconTerminalAddOutline16 size={18} />
        </RailButton>
        {terminals.map(terminal => {
          const name = terminalName(terminal, t)
          return (
            <RailButton
              key={terminal.id}
              label={name}
              active={terminal.id === state.activeTabId}
              status={terminalDot(terminal, controller.terminalBinding(terminal))}
              onClick={() => { controller.selectTab(terminal.id) }}
            >
              <IconTerminalOutline16 size={18} />
            </RailButton>
          )
        })}
      </RailActions>
    )
  }

  if (state.sidebarMode === 'sql') {
    // The three things a reader can do with the SQL panel folded away. The middle one asks the
    // panel to re-read rather than reading anything itself: the tree and its requests belong to the
    // panel, and a request that goes through the store is one the panel consumes when it is mounted.
    const notebook = activeSqlNotebook(state)
    return (
      <RailActions label={t('mode.sql')}>
        <RailButton
          label={t('sqlnotebook.railOpenNotebook')}
          disabled={notebook === null}
          onClick={() => {
            if (notebook !== null) controller.selectTab(notebook.id)
          }}
        >
          <IconSqlOutline16 size={18} />
        </RailButton>
        <RailButton
          label={t('sqlnotebook.refreshSchema')}
          disabled={notebook === null}
          onClick={() => {
            controller.requestSidebarAction('sql.refreshSchema', workspaceId)
            expandSidebar()
          }}
        >
          <IconRefreshOutlineMedium size={18} />
        </RailButton>
        <RailButton
          label={t('sqlnotebook.railNewNotebook')}
          disabled={workspaceId === undefined}
          onClick={() => { void createNotebookAndOpen() }}
        >
          <IconSqlNotebookAddOutline16 size={18} />
        </RailButton>
      </RailActions>
    )
  }

  return null
}

function RailActions({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className={css.collapsedBody} role="toolbar" aria-label={label}>{children}</div>
}

function RailButton({
  label,
  children,
  active = false,
  disabled = false,
  status,
  onClick,
}: {
  label: string
  children: React.ReactNode
  active?: boolean
  disabled?: boolean
  status?: TerminalDot
  onClick(): void
}) {
  return (
    <Tooltip label={label} delayMs={500}>
      <button
        type="button"
        className={css.railButton}
        data-active={active || undefined}
        data-status={status}
        aria-label={label}
        aria-pressed={active || undefined}
        disabled={disabled}
        onClick={onClick}
      >
        {children}
      </button>
    </Tooltip>
  )
}
