import { useCallback, useLayoutEffect, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import {
  FishLogo,
  IconFolderOpenOutlineMedium,
  IconQueueOutlineRegular,
  IconSettingsOutlineMedium,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkbenchController } from '../model/controller.ts'
import type { WorkbenchKey } from '../core/locales.ts'
import type { WorkbenchPanelNavigation } from '../model/workbench-types.ts'
import { IconSourceControlOutline16 } from '../git/SourceControlIcon.tsx'
import { IconTerminalOutline16 } from '../terminal/TerminalIcon.tsx'
import { IconConversationPanelOutline16 } from './ConversationPanelIcon.tsx'
import { IconEditorPanelOutline16 } from '../editor/EditorPanelIcon.tsx'
import { IconBackToSessionOutline16 } from './BackToSessionIcon.tsx'
import { createActivityDockMount } from '../layout/activity-dock-layout.ts'
import { createPanelBackSeatLayout } from '../layout/panel-back-seat-layout.ts'
import { createSidebarFooterLayout, SIDEBAR_SETTINGS_TRIGGER_ATTRIBUTE } from '../layout/sidebar-footer-layout.ts'
import { useWorkbench } from '../model/use-workbench.ts'
import css from './shell.module.css'

/**
 * The official shell owns sidebar fold state; its toggle button is the only
 * control that collapses/expands cleanly alongside the plugin's sidebar shadow.
 * The class suffix is a stable CSS-modules local name (`<hash>_toggle`).
 */
const OFFICIAL_SIDEBAR_TOGGLE_SELECTOR = 'button[class*="_toggle"]'

export type ModeSwitchProps = PropsRuntime<'sidebar.footer.action'> & PropsLocale<'workbench'> & {
  controller: WorkbenchController
  logger: { info(message: string): void }
  /** Official root panel navigation, supplying the way back the shell itself lacks. */
  panels: WorkbenchPanelNavigation
}

/**
 * The always-visible activity dock: an independent left column that survives
 * every sidebar fold state. Sessions releases the sidebar shadow back to DSH
 * while the dock itself stays mounted.
 */
export function ModeSwitch({ wide, controller, logger, panels, t }: ModeSwitchProps) {
  const state = useWorkbench(controller)
  // Subscribe identity must be stable across renders, and the official source's
  // `subscribe` needs its receiver, so bind both to the injected layout face.
  const subscribePanel = useCallback(
    (listener: () => void): (() => void) => panels.panelInfo.subscribe(listener),
    [panels],
  )
  const readPanel = useCallback(
    () => panels.panelInfo.getSnapshot().activePanelId,
    [panels],
  )
  const activePanelId = useSyncExternalStore(subscribePanel, readPanel, readPanel)
  const [target, setTarget] = useState<HTMLElement | null>(null)
  const [backSeat, setBackSeat] = useState<HTMLElement | null>(null)
  const items = [
    { mode: 'sessions' as const, label: t('mode.sessions'), icon: <IconQueueOutlineRegular size={18} /> },
    { mode: 'files' as const, label: t('mode.files'), icon: <IconFolderOpenOutlineMedium size={18} /> },
    { mode: 'git' as const, label: t('mode.git'), icon: <IconSourceControlOutline16 size={18} /> },
    { mode: 'terminal' as const, label: t('mode.terminal'), icon: <IconTerminalOutline16 size={18} /> },
  ]
  useLayoutEffect(() => {
    const mount = createActivityDockMount(css.activityDock!, setTarget, logger)
    const footer = createSidebarFooterLayout(logger)
    return () => {
      footer.dispose()
      mount.dispose()
    }
  }, [logger])
  // The Plugins page contributes no header slot, so its seat is opened through
  // the DOM and the button is portalled into it, staying owned by this component.
  // Only while a global panel is on screen: the seat's own reconciliation watches
  // every DOM mutation, and no panel means no seat to find.
  useLayoutEffect(() => {
    if (activePanelId === null) return undefined
    const seatLayout = createPanelBackSeatLayout(setBackSeat, logger)
    return () => { seatLayout.dispose() }
  }, [activePanelId, logger])
  const editorToggleLabel = state.editorExpanded ? t('editor.collapse') : t('editor.expand')
  const conversationToggleLabel = state.conversationExpanded ? t('editor.collapseConversation') : t('editor.expandConversation')
  const foldOfficialSidebar = (): void => {
    // Route every collapse/expand through the shell's own toggle so the column
    // geometry, rail, and middle-editor concession stay owned by DSH.
    document.querySelector<HTMLButtonElement>(OFFICIAL_SIDEBAR_TOGGLE_SELECTOR)?.click()
  }
  const selectMode = (mode: (typeof items)[number]['mode']): void => {
    // VSCode gesture: re-activating the current view folds the sidebar; from the
    // rail any icon both selects its view and expands the column.
    if (wide && state.sidebarMode === mode) {
      foldOfficialSidebar()
      return
    }
    controller.setSidebarMode(mode)
    if (!wide) foldOfficialSidebar()
  }
  const openSettings = (): void => {
    // Prefer the footer-layout tag, but fall back to any launcher inside the
    // official settings seat so the gear still opens Settings if the shell's
    // trigger markup differs from the expected `button[aria-haspopup='dialog']`.
    const tagged = document.querySelector<HTMLElement>(`[${SIDEBAR_SETTINGS_TRIGGER_ATTRIBUTE}]`)
    if (tagged !== null) {
      tagged.click()
      return
    }
    const seat = document.querySelector<HTMLElement>('[data-slot="sidebar.settings"]')
    const trigger = seat?.querySelector<HTMLElement>(
      "button[aria-haspopup='dialog'], button[aria-haspopup], [role='button'], button",
    ) ?? seat ?? null
    trigger?.click()
  }

  // One control answers for every global panel: the page header seat when the
  // Plugins page provides one, the dock otherwise.
  const backButton = (className: string, size: number) => (
    <Tooltip label={t('mode.backToSession')} delayMs={500}>
      <button
        type="button"
        className={className}
        aria-label={t('mode.backToSession')}
        onClick={() => { panels.selectPanel(null) }}
      >
        <IconBackToSessionOutline16 size={size} />
      </button>
    </Tooltip>
  )

  return (
    <>
      {target === null
        ? <span className={css.modeSwitchAnchor} aria-hidden />
        : createPortal((
          <>
            <div className={css.dockBrand} aria-hidden="true">
              <FishLogo />
            </div>
            <div className={css.modeSwitch} role="toolbar" aria-label={t('mode.bar')}>
            {items.map(item => (
              <Tooltip key={item.mode} label={item.label} delayMs={500}>
                <button
                  type="button"
                  className={css.modeButton}
                  data-active={state.sidebarMode === item.mode || undefined}
                  aria-label={item.label}
                  aria-pressed={state.sidebarMode === item.mode}
                  onClick={() => { selectMode(item.mode) }}
                >
                  {item.icon}
                </button>
              </Tooltip>
            ))}
            {/* DSH's own sidebar rows only ever select a global panel — their click
                handler is `selectPanel(id)`, never `selectPanel(null)` — so once one
                is open the shell offers no control that leaves it. The dock supplies
                that exit below the view icons, and only while a panel holds the
                center column, so the standing cluster never shifts. The Plugins page
                owns its exit in its own header instead, so the dock stands down
                whenever that seat exists and one control answers for every panel. */}
            {activePanelId === null || backSeat !== null ? null : (
              backButton(css.modeButton!, 18)
            )}
            <span className={css.activitySpacer} aria-hidden />
            <Tooltip label={editorToggleLabel} delayMs={500}>
              <button
                type="button"
                className={css.modeButton}
                aria-label={editorToggleLabel}
                aria-pressed={state.editorExpanded}
                onClick={() => { controller.toggleEditor() }}
              >
                <IconEditorPanelOutline16 size={18} />
              </button>
            </Tooltip>
            <Tooltip label={conversationToggleLabel} delayMs={500}>
              <button
                type="button"
                className={css.modeButton}
                aria-label={conversationToggleLabel}
                aria-pressed={state.conversationExpanded}
                onClick={() => { controller.toggleConversation() }}
              >
                <IconConversationPanelOutline16 size={18} />
              </button>
            </Tooltip>
            <Tooltip label={t('mode.settings')} delayMs={500}>
              <button
                type="button"
                className={css.modeButton}
                aria-label={t('mode.settings')}
                onClick={openSettings}
              >
                <IconSettingsOutlineMedium size={18} />
              </button>
            </Tooltip>
          </div>
          </>
        ), target)}
      {backSeat === null ? null : createPortal(backButton(css.panelBackButton!, 18), backSeat)}
    </>
  )
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    workbench: WorkbenchKey
  }
}
