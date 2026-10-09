/** 左栏终端实例管理，与工作区而非会话绑定；状态取自官方终端模型镜像。 */

import { useEffect, useRef, useState } from 'react'
import {
  IconChevronDownOutlineRegular,
  IconCloseOutlineMedium,
  IconEditOutlineMedium,
  IconPlusOutlineMedium,
  Input,
  Menu,
  type MenuEntry,
  Modal,
  Tooltip,
  Button,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { IconTerminalOutline16 } from './TerminalIcon.tsx'
import { shellDisplayName } from './shell-display.ts'
import { terminalDot } from './terminal-dot.ts'
import { terminalName } from './terminal-name.ts'
import { terminalExitNote, terminalPhaseLabel, terminalStatusSegments } from './terminal-status.ts'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkbenchController, WorkbenchShellChoice, WorkbenchTerminalTab } from '../model/controller.ts'
import type { TerminalBinding } from '../model/controller.ts'
import type { WorkbenchKey } from '../core/locales.ts'
import { useWorkbench } from '../model/use-workbench.ts'
import css from './terminal.module.css'

export interface TerminalPanelProps {
  controller: WorkbenchController
  workspaceId: string | undefined
  t: TranslateNS<'workbench'>
}

/** Menu row that starts a terminal with no explicit shell, leaving the choice to the Host. */
const DEFAULT_SHELL = 'terminal:default-shell'

export function TerminalPanel({ controller, workspaceId, t }: TerminalPanelProps) {
  const state = useWorkbench(controller)
  const terminals = state.workspaceId === workspaceId
    ? state.tabs.filter((tab): tab is WorkbenchTerminalTab => tab.kind === 'terminal')
    : []
  const openedWorkspace = useRef<string | undefined>(undefined)
  const [renaming, setRenaming] = useState<WorkbenchTerminalTab | null>(null)
  useEffect(() => {
    if (workspaceId === undefined || openedWorkspace.current === workspaceId) return
    openedWorkspace.current = workspaceId
    if (terminals.length === 0) controller.openTerminal(workspaceId)
  }, [controller, terminals.length, workspaceId])

  if (workspaceId === undefined) return <div className={css.emptyState}>{t('terminal.emptyWorkspace')}</div>
  return (
    <div className={css.panelBody}>
      <header className={css.panelHeader} data-dsh-workbench-panel-header="">
        <span className={css.panelTitle}>{t('terminal.title')}</span>
        <NewTerminalMenu controller={controller} workspaceId={workspaceId} t={t} />
      </header>
      <div className={css.terminalList} role="list">
        {terminals.length === 0 && <div className={css.emptyState}>{t('terminal.empty')}</div>}
        {terminals.map((terminal) => {
          const name = terminalName(terminal, t)
          const binding = controller.terminalBinding(terminal)
          const segments = terminalStatusSegments(terminal, t)
          const exitNote = terminalExitNote(terminal, t)
          return (
            <div
              key={terminal.id}
              className={css.terminalEntry}
              data-active={terminal.id === state.activeTabId || undefined}
              role="listitem"
            >
              <div className={css.terminalRow}>
                <button
                  type="button"
                  className={css.terminalSelect}
                  onClick={() => { controller.selectTab(terminal.id) }}
                >
                  <span
                    className={css.terminalStatusDot}
                    data-status={terminalDot(terminal, binding)}
                    aria-hidden
                  />
                  <span className={css.terminalRowName}>{name}</span>
                  <span className={css.terminalRowStatus} title={terminal.shellPath}>
                    {terminalPhaseLabel(terminal, binding, t)}
                  </span>
                </button>
                <Tooltip label={t('terminal.rename')} delayMs={500}>
                  <button
                    type="button"
                    className={css.terminalRename}
                    aria-label={t('terminal.rename')}
                    onClick={() => { setRenaming(terminal) }}
                  >
                    <IconEditOutlineMedium size={13} />
                  </button>
                </Tooltip>
                <button
                  type="button"
                  className={css.terminalClose}
                  aria-label={t('terminal.close', { name })}
                  onClick={() => { controller.closeTab(terminal.id) }}
                >
                  <IconCloseOutlineMedium size={13} />
                </button>
              </div>
              {(segments.length > 0 || exitNote !== undefined) && (
                <div className={css.terminalStatusLine}>
                  {segments.map(segment => (
                    <span key={segment.key} className={css.terminalStatusItem} title={segment.title ?? segment.value}>
                      <span className={css.terminalStatusLabel}>{segment.label}</span>
                      <span className={css.terminalStatusValue}>{segment.value}</span>
                    </span>
                  ))}
                  {exitNote !== undefined && (
                    <span className={css.terminalStatusExit} data-status={terminal.status}>{exitNote}</span>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
      <RenameTerminalDialog
        tab={renaming}
        onClose={() => { setRenaming(null) }}
        onConfirm={(title) => {
          if (renaming !== null) controller.renameTerminal(renaming.id, title)
          setRenaming(null)
        }}
        t={t}
      />
    </div>
  )
}

/**
 * Modal that renames one terminal.
 *
 * A separate component so the draft clears itself on every open rather than
 * keeping whatever was typed for the previous terminal, the same way the file
 * tree's rename does.
 */
function RenameTerminalDialog({ tab, onClose, onConfirm, t }: {
  tab: WorkbenchTerminalTab | null
  onClose: () => void
  onConfirm: (title: string) => void
  t: TranslateNS<'workbench'>
}) {
  const [draft, setDraft] = useState('')
  useEffect(() => {
    setDraft(tab === null ? '' : terminalName(tab, t))
  }, [tab, t])
  const trimmed = draft.trim()
  const canConfirm = tab !== null && trimmed !== '' && trimmed !== tab.title
  const confirm = (): void => {
    if (canConfirm) onConfirm(trimmed)
  }
  return (
    <Modal
      open={tab !== null}
      title={t('terminal.renameTitle')}
      closeLabel={t('files.cancel')}
      description={tab === null ? '' : t('terminal.renameDescription', { name: terminalName(tab, t) })}
      onClose={onClose}
      footer={(
        <>
          <Button variant="outline" onClick={onClose}>{t('files.cancel')}</Button>
          <Button variant="primary" disabled={!canConfirm} onClick={confirm}>{t('terminal.renameConfirm')}</Button>
        </>
      )}
    >
      <label className={css.terminalRenameField}>
        <span>{t('terminal.renamePlaceholder')}</span>
        <Input
          autoFocus
          value={draft}
          onChange={event => { setDraft(event.currentTarget.value) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') confirm()
          }}
        />
      </label>
    </Modal>
  )
}

/**
 * New-terminal action whose list offers the shells the Host verifies for the
 * current Session. Without that choice the workbench could only ever start the
 * execution environment's default — `ComSpec`, i.e. CMD, on Windows — even
 * though the official terminal service also accepts `pwsh` and `powershell`.
 *
 * Discovery needs a Session, so the list is fetched when the menu opens rather
 * than on mount: a Workspace without a Session has no execution environment to
 * probe, and a stale list would offer shells the Host has since stopped
 * verifying. If discovery yields nothing, the menu keeps a single default row so
 * the action never dead-ends into "you cannot open a terminal".
 */
function NewTerminalMenu({ controller, workspaceId, t }: {
  controller: WorkbenchController
  workspaceId: string
  t: TranslateNS<'workbench'>
}) {
  const [open, setOpen] = useState(false)
  const [shells, setShells] = useState<readonly WorkbenchShellChoice[]>([])
  const [selectedShell, setSelectedShell] = useState<string | undefined>(undefined)
  const lifetime = useRef<AbortController | undefined>(undefined)
  const generation = useRef(0)

  const load = (): void => {
    lifetime.current?.abort()
    const probe = new AbortController()
    lifetime.current = probe
    const token = ++generation.current
    void controller.listShells(probe.signal).then((result) => {
      // A menu reopened before the previous probe settled owns the list state.
      if (generation.current !== token) return
      setShells(result.shells)
      setSelectedShell(result.selectedShell)
    })
  }

  useEffect(() => () => {
    generation.current += 1
    lifetime.current?.abort()
  }, [])

  const items: MenuEntry[] = shells.length === 0
    ? [{ id: DEFAULT_SHELL, label: t('terminal.defaultShell'), icon: <IconTerminalOutline16 size={14} /> }]
    : [
      { type: 'label', id: 'shell-heading', text: t('terminal.shellHeading') },
      ...shells.map(shell => ({ id: shell.path, label: shellDisplayName(shell.name), icon: <IconTerminalOutline16 size={14} /> })),
      { type: 'separator', id: 'shell-default-separator' },
      { id: DEFAULT_SHELL, label: t('terminal.defaultShell'), icon: <IconTerminalOutline16 size={14} /> },
    ]

  return (
    <span className={css.newTerminalSeat}>
      <Menu
        open={open}
        onClose={() => { setOpen(false) }}
        items={items}
        selectedId={selectedShell}
        onSelect={(id) => {
          setOpen(false)
          // The default row passes nothing, leaving the choice to the official
          // model; every other row is a verified path this browser now remembers.
          if (id === DEFAULT_SHELL) controller.openTerminal(workspaceId)
          else {
            controller.selectShell(id)
            controller.openTerminal(workspaceId, id)
          }
        }}
        align="end"
        dense
        portal
        anchor={(
          <Tooltip label={t('terminal.new')} side="bottom" delayMs={500}>
            <button
              type="button"
              className={css.newTerminalButton}
              aria-label={t('terminal.new')}
              aria-expanded={open}
              onClick={() => {
                if (!open) load()
                setOpen(value => !value)
              }}
            >
              <IconPlusOutlineMedium size={16} />
              <IconChevronDownOutlineRegular size={11} />
            </button>
          </Tooltip>
        )}
      />
    </span>
  )
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    workbench: WorkbenchKey
  }
}
