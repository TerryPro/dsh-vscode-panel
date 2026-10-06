import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  FishLogo,
  IconFolderOpenOutlineMedium,
  IconQueueOutlineRegular,
  IconSettingsOutlineMedium,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkbenchController } from './controller.ts'
import type { WorkbenchKey } from './locales.ts'
import { IconSourceControlOutline16 } from './SourceControlIcon.tsx'
import { IconTerminalOutline16 } from './TerminalIcon.tsx'
import { IconConversationPanelOutline16 } from './ConversationPanelIcon.tsx'
import { IconEditorPanelOutline16 } from './EditorPanelIcon.tsx'
import { createActivityDockMount } from './activity-dock-layout.ts'
import { createSidebarFooterLayout, SIDEBAR_SETTINGS_TRIGGER_ATTRIBUTE, type SidebarFooterLayout } from './sidebar-footer-layout.ts'
import { useWorkbench } from './use-workbench.ts'
import css from './Workbench.module.css'

/**
 * The official shell owns sidebar fold state; its toggle button is the only
 * control that collapses/expands cleanly alongside the plugin's sidebar shadow.
 * The class suffix is a stable CSS-modules local name (`<hash>_toggle`).
 */
const OFFICIAL_SIDEBAR_TOGGLE_SELECTOR = 'button[class*="_toggle"]'

export type ModeSwitchProps = PropsRuntime<'sidebar.footer.action'> & PropsLocale<'workbench'> & {
  controller: WorkbenchController
  logger: { info(message: string): void }
}

/**
 * The always-visible activity dock: an independent left column that survives
 * every sidebar fold state. Sessions releases the sidebar shadow back to DSH
 * while the dock itself stays mounted.
 */
export function ModeSwitch({ wide, controller, logger, t }: ModeSwitchProps) {
  const state = useWorkbench(controller)
  const [target, setTarget] = useState<HTMLElement | null>(null)
  const footerLayout = useRef<SidebarFooterLayout | null>(null)
  const items = [
    { mode: 'sessions' as const, label: t('mode.sessions'), icon: <IconQueueOutlineRegular size={18} /> },
    { mode: 'files' as const, label: t('mode.files'), icon: <IconFolderOpenOutlineMedium size={18} /> },
    { mode: 'git' as const, label: t('mode.git'), icon: <IconSourceControlOutline16 size={18} /> },
    { mode: 'terminal' as const, label: t('mode.terminal'), icon: <IconTerminalOutline16 size={18} /> },
  ]
  useLayoutEffect(() => {
    const mount = createActivityDockMount(css.activityDock!, setTarget, logger)
    const footer = createSidebarFooterLayout(wide, logger)
    footerLayout.current = footer
    return () => {
      footerLayout.current = null
      footer.dispose()
      mount.dispose()
    }
  }, [logger]) // wide updates through the stable footer layout below.
  useLayoutEffect(() => {
    footerLayout.current?.setWide(wide)
  }, [wide])
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

  return (
    target === null
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
        ), target)
)
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    workbench: WorkbenchKey
  }
}
