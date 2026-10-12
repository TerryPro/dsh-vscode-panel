/** Browser half: additive mode switch plus shadowed sidebar/details occupants. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-terminal-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { WorkbenchApi } from './model/api.ts'
import { WorkbenchController } from './model/controller.ts'
import { installWorkbenchLayout } from './layout/layout-styles.ts'
import { installNativeRightbarEntry } from './layout/native-rightbar-entry.ts'
import { en, zh } from './core/locales.ts'
import { ModeSwitch } from './shell/ModeSwitch.tsx'
import { installGitDecorationRefresh } from './git/git-decoration-refresh.ts'
import { installOpenFileRefresh } from './editor/open-file-refresh.ts'
import { createWorkbenchWorkspaceActivator } from './model/workspace-layout.ts'
import { holdRightbarSeatWhileEditorVisible } from './model/rightbar-seat.ts'
import { WorkbenchEditor } from './editor/WorkbenchEditor.tsx'
import { WorkbenchSidebar } from './shell/WorkbenchSidebar.tsx'
import type { ConfigText } from '../shared/config-protocol.ts'
import { ConfigPanel } from './settings/ConfigPanel.tsx'
import './styles/global.module.css'

export const inject = ['slots', 'locale', 'layout', 'webTerminals']

/** Register the workbench UI without replacing DSH's AppFrame or conversation component. */
export function apply(ctx: ClientContext): void {
  const controller = new WorkbenchController(new WorkbenchApi(), {
    info: message => { ctx.logger.info(message) },
    warn: message => { ctx.logger.warn(message) },
  }, ctx.layout, ctx.webTerminals)
  const activateWorkspace = createWorkbenchWorkspaceActivator(controller, ctx.logger)
  ctx.effect(() => ctx.locale.register('workbench', { zh, en }), 'workbench-layout: dictionaries')
  ctx.effect(() => installOpenFileRefresh(controller), 'workbench-layout: open file refresh')
  ctx.effect(() => installGitDecorationRefresh(controller), 'workbench-layout: Git file decoration refresh')
  // DSH's own way into its right Sidebar is a header button that is always on
  // screen while this plugin holds the right-column seat, so it is the shortest
  // path from "I want the native Sidebar back" to releasing that seat.
  ctx.effect(() => installNativeRightbarEntry(controller, ctx.logger), 'workbench-layout: native right Sidebar entry')
  // A shell teardown closes the browser's notebook event streams. The kernels are left
  // running on purpose: the Host owns their reclaim timer, and a hot reload of this
  // panel must not throw away a run that is still going.
  ctx.effect(() => () => { controller.notebookRuntime.closeAllStreams() }, 'workbench-layout: notebook streams')

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'workbench-layout-modes',
    order: -100,
    locale: 'workbench',
    inject: () => ({ controller, logger: ctx.logger, panels: ctx.layout }),
  }, ModeSwitch))

  ctx.slots.inject('sidebar.workspaces', () => {
    let dispose: (() => void) | undefined
    const setActive = (active: boolean): void => {
      if (active && dispose === undefined) {
        dispose = ctx.slots.register({
          name: 'sidebar.workspaces',
          priority: -100,
          locale: 'workbench',
          inject: () => ({ controller }),
        }, WorkbenchSidebar)
      } else if (!active && dispose !== undefined) {
        dispose()
        dispose = undefined
      }
    }
    const detach = controller.attachSidebarShadow(setActive)
    return () => {
      detach()
      dispose?.()
    }
  })

  /*
   * The middle editor takes the official right column, because that is the only
   * session-scoped seat the frame places in its own column — and `rightbar.session`
   * is a *single* slot, so registering here necessarily shadows DSH's own
   * `RightbarSeat`, i.e. the entire native right Sidebar with its dock panel, guide
   * tabs, divider and track report.
   *
   * The seat is therefore held only while the middle column is on screen to fill it:
   * collapsing the editor releases the registration and the native right Sidebar
   * returns, fully usable beside the workbench sidebar. Expanding reclaims it. Same
   * shadow pattern as `sidebar.workspaces` above, driven by the editor's visibility
   * instead of the sidebar mode.
   */
  ctx.slots.inject('rightbar.session', () => holdRightbarSeatWhileEditorVisible(controller, {
    register: () => ctx.slots.register({
      name: 'rightbar.session',
      priority: -100,
      locale: 'workbench',
      inject: () => ({ controller, activateWorkspace }),
    }, WorkbenchEditor),
  }, ctx.logger))

  /*
   * The plugin's page on DSH's Settings dialog.
   *
   * The navigation row's title comes from the workbench dictionary like every other
   * user-facing string, through a bound translator rather than a hand-rolled lookup, so
   * an unfamiliar deployment locale still rides the shell's fallback chain.
   *
   * `pick` serves the field labels and descriptions, which arrive from the Host as
   * `{ zh, en }` pairs because the schema is their only home and the host cannot read
   * the browser's dictionary. Preferring the active locale and falling back to English
   * is the same rule the locale service itself applies.
   */
  const settingsT = ctx.locale.bind('workbench')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'workbench-layout',
    order: 30,
    locale: 'workbench',
    label: () => settingsT('config.nav'),
    inject: () => ({
      api: controller.api,
      logger: ctx.logger,
      pick: (text: ConfigText) => {
        const active = ctx.locale.getSnapshot().active.toLowerCase()
        return active.startsWith('zh') ? text.zh : text.en
      },
    }),
  }, ConfigPanel))

  installWorkbenchLayout(ctx, controller.store, controller, ctx.layout.panelInfo)
  ctx.logger.info('workbench-layout: stable native session action and official Workspace path header registered')
}
