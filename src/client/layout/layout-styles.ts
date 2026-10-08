/** 通过稳定属性调整 DSH 现有 AppFrame 内部组件的列顺序。 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import {
  ASSISTANT_ACTIONS_ATTRIBUTE,
  ASSISTANT_METRICS_ATTRIBUTE,
  ASSISTANT_METRICS_WRAP_ATTRIBUTE,
  CONVERSATION_NARROW_ATTRIBUTE,
  CONVERSATION_ROOT_ATTRIBUTE,
  createConversationLayout,
  FLOATING_MENU_LEFT_PROPERTY,
  FLOATING_MENU_TOP_PROPERTY,
  FLOATING_MODEL_MENU_ATTRIBUTE,
  type ConversationLayout,
} from './conversation-layout.ts'
import {
  createConversationFileRouting,
  type ConversationFileController,
  type ConversationFileRouting,
} from './conversation-file-routing.ts'
import {
  createEditorTrackTransition,
  type EditorTrackTransition,
} from '../editor/editor-track-transition.ts'
import {
  CONVERSATION_COLLAPSED_ATTRIBUTE,
  EDITOR_COLLAPSED_ATTRIBUTE,
  EDITOR_RELEASE_ATTRIBUTE,
  EDITOR_TRANSITION_ATTRIBUTE,
  FRAME_ATTRIBUTE,
  PANEL_HEADER_ATTRIBUTE,
  PANEL_HEADER_HEIGHT_PROPERTY,
  PANEL_RULE_ATTRIBUTE,
  PANEL_RULE_OVERLAY_ATTRIBUTE,
  TRANSITION_CONVERSATION_WIDTH,
  TRANSITION_EDITOR_WIDTH,
  TRANSITION_SIDEBAR_WIDTH,
} from './editor-layout-contract.ts'
import {
  createGlobalPanelLayout,
  EDITOR_HOST_ATTRIBUTE,
  GLOBAL_PANEL_ATTRIBUTE,
  type GlobalPanelLayout,
  type GlobalPanelSource,
} from './global-panel-layout.ts'
import {
  createPanelRuleLayout,
  type PanelRuleLayout,
} from './panel-rule-layout.ts'
import {
  createDetailsTrackLayout,
  DETAILS_TRACK_ATTRIBUTE,
  DETAILS_TRACK_DRAGGING_ATTRIBUTE,
  DETAILS_TRACK_FALLBACK_ATTRIBUTE,
  DETAILS_TRACK_HANDLE_ATTRIBUTE,
  DETAILS_TRACK_NATIVE_HANDLE_ATTRIBUTE,
  DETAILS_TRACK_SIDEBAR_WIDTH,
  DETAILS_TRACK_WIDTH,
  SIDEBAR_TRACK_HANDLE_ATTRIBUTE,
  type DetailsTrackLayout,
} from './details-track-layout.ts'

export { EDITOR_COLLAPSED_ATTRIBUTE } from './editor-layout-contract.ts'

export interface WorkbenchEditorVisibilityStore {
  getSnapshot(): { editorExpanded: boolean; conversationExpanded: boolean }
  subscribe(listener: () => void): () => void
}

const CSS = `
@property ${TRANSITION_SIDEBAR_WIDTH} {
  syntax: '<length>';
  inherits: false;
  initial-value: 0px;
}

@property ${TRANSITION_EDITOR_WIDTH} {
  syntax: '<length>';
  inherits: false;
  initial-value: 0px;
}

@property ${TRANSITION_CONVERSATION_WIDTH} {
  syntax: '<length>';
  inherits: false;
  initial-value: 0px;
}

[${FRAME_ATTRIBUTE}]:not([${EDITOR_COLLAPSED_ATTRIBUTE}]):not([data-rightbar-collapsed]):not([data-rightbar-fullscreen]) > :nth-child(2),
[${FRAME_ATTRIBUTE}]:not([${EDITOR_COLLAPSED_ATTRIBUTE}])[${DETAILS_TRACK_FALLBACK_ATTRIBUTE}] > :nth-child(2),
[${FRAME_ATTRIBUTE}][${EDITOR_TRANSITION_ATTRIBUTE}] > :nth-child(2) {
  grid-column: 3;
  grid-row: 1;
  border-left: 1px solid var(--dsw-alias-border-l1);
  /* The Windows titlebar rounds the CenterColumn's top-left corner for the
     native center layout; once relocated to the right edge that curve becomes
     a notch at the editor|conversation seam, so square it off. */
  border-radius: 0;
  background: var(--dsw-specific-sidebar-fill);
}

/* Only the native ConversationRoot inside CenterColumn's official slot wrapper
   receives the workbench surface. InputBar and its phase-bearing textarea stay
   wholly owned by DSH's official component styles. */
[${FRAME_ATTRIBUTE}]:not([${EDITOR_COLLAPSED_ATTRIBUTE}]):not([data-rightbar-collapsed]):not([data-rightbar-fullscreen]) > :nth-child(2) [${CONVERSATION_ROOT_ATTRIBUTE}],
[${FRAME_ATTRIBUTE}]:not([${EDITOR_COLLAPSED_ATTRIBUTE}])[${DETAILS_TRACK_FALLBACK_ATTRIBUTE}] > :nth-child(2) [${CONVERSATION_ROOT_ATTRIBUTE}],
[${FRAME_ATTRIBUTE}][${EDITOR_TRANSITION_ATTRIBUTE}] > :nth-child(2) [${CONVERSATION_ROOT_ATTRIBUTE}] {
  background: var(--dsw-specific-sidebar-fill);
}

/* The official active composer mask references the original center surface;
   only its backdrop stop follows the relocated conversation surface. */
[${FRAME_ATTRIBUTE}]:not([${EDITOR_COLLAPSED_ATTRIBUTE}]):not([data-rightbar-collapsed]):not([data-rightbar-fullscreen]) > :nth-child(2) [${CONVERSATION_ROOT_ATTRIBUTE}][data-phase='active'] [data-composer-seat],
[${FRAME_ATTRIBUTE}]:not([${EDITOR_COLLAPSED_ATTRIBUTE}])[${DETAILS_TRACK_FALLBACK_ATTRIBUTE}] > :nth-child(2) [${CONVERSATION_ROOT_ATTRIBUTE}][data-phase='active'] [data-composer-seat],
[${FRAME_ATTRIBUTE}][${EDITOR_TRANSITION_ATTRIBUTE}] > :nth-child(2) [${CONVERSATION_ROOT_ATTRIBUTE}][data-phase='active'] [data-composer-seat] {
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--dsw-specific-sidebar-fill) 0%, transparent) 0px,
    var(--dsw-specific-sidebar-fill) 36px
  );
}

[${FRAME_ATTRIBUTE}]:not([${EDITOR_COLLAPSED_ATTRIBUTE}]):not([data-rightbar-collapsed]):not([data-rightbar-fullscreen]) > :nth-child(3),
[${FRAME_ATTRIBUTE}]:not([${EDITOR_COLLAPSED_ATTRIBUTE}])[${DETAILS_TRACK_FALLBACK_ATTRIBUTE}] > :nth-child(3),
[${FRAME_ATTRIBUTE}][${EDITOR_TRANSITION_ATTRIBUTE}] > :nth-child(3) {
  grid-column: 2;
  grid-row: 1;
  /* The relocated editor becomes the middle column's left edge, so it owns the
     divider against the sidebar (the native sidebar border-right is dropped
     below to keep a single line on every platform). */
  border-left: 1px solid var(--dsw-alias-border-l1) !important;
}

[${FRAME_ATTRIBUTE}]:not([${EDITOR_COLLAPSED_ATTRIBUTE}]):not([data-rightbar-collapsed]):not([data-rightbar-fullscreen]) > :nth-child(1),
[${FRAME_ATTRIBUTE}]:not([${EDITOR_COLLAPSED_ATTRIBUTE}])[${DETAILS_TRACK_FALLBACK_ATTRIBUTE}] > :nth-child(1),
[${FRAME_ATTRIBUTE}][${EDITOR_TRANSITION_ATTRIBUTE}] > :nth-child(1) {
  border-right: none;
}

/* Collapsing the middle editor returns the conversation to AppFrame's centre
   track, where the shell draws no left edge at all on Windows and a 0.5px l3
   hairline elsewhere, and rounds that corner by 16px. Every other workbench
   seam — including the top divider this file paints on all three columns — is a
   square 1px l1 line, so toggling the editor visibly thins the seam and curls a
   notch into the top divider where it meets the rounded corner. Keep the seam
   identical in both states, and leave it alone when the sidebar is collapsed
   too: there the centre reaches the window edge, where no divider belongs. */
[${FRAME_ATTRIBUTE}][${EDITOR_COLLAPSED_ATTRIBUTE}]:not([data-sidebar-collapsed]) > :nth-child(2) {
  border-left: 1px solid var(--dsw-alias-border-l1);
  border-radius: 0;
}

[${FRAME_ATTRIBUTE}][${EDITOR_COLLAPSED_ATTRIBUTE}]:not([data-sidebar-collapsed]) > :nth-child(1) {
  border-right: none;
}

/* The app menu bar lives in the frame's top padding (the titlebar strip), so
   the content columns begin below it (top = padding-top). Draw the divider on
   each column's top edge so it lands at the menu bar's bottom on every
   platform, instead of the frame's own top edge (which sits behind the bar). */
[${FRAME_ATTRIBUTE}] > :nth-child(1),
[${FRAME_ATTRIBUTE}] > :nth-child(2),
[${FRAME_ATTRIBUTE}] > :nth-child(3) {
  border-top: 1px solid var(--dsw-alias-border-l1);
}

/* The sidebar panel rules. They close a panel section and must span the whole
   column, so they cannot be borders on those sections: the shell's .regionArea
   clips overflow and reclaims only 4px of the sidebar's 12px inline padding on
   the left, which leaves any line drawn in there 8px short of the column edge —
   and a negative margin cannot cross the clip either. Nor can they be background
   layers on the column or the sidebar root, because each sits behind the next
   element's own fill and would replace the macOS vibrancy gradients.

   They are therefore real elements appended to the frame: the frame already
   contains the columns, is not clipped, and paints its trailing children above
   every column fill. A pseudo-element cannot be used because the panel has more
   than one rule and a frame has one ::after.

   The stroke is the tab bar's own declaration — the same border-bottom width and
   the same token — rather than a 1px background fill of the same size. Blink
   quantises a border's edges onto the device grid but paints a background at its
   exact fractional width, so two visually identical CSS rules render two
   different lines: at the 125%/150% scales Windows defaults to, a 1px fill
   spreads over an extra device row and reads heavier than the border it
   continues. Identical primitive, identical geometry, identical colour. */
[${FRAME_ATTRIBUTE}] > [${PANEL_RULE_OVERLAY_ATTRIBUTE}] {
  position: absolute;
  /* left, top, and width come from panel-rule-layout.ts, per rule, so no host
     padding is assumed and the lines cannot drift on another platform or zoom. */
  height: 0;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  pointer-events: none;
}

/* With its rule published, the header row is sized by the same measurement so
   its content ends where the middle column's content begins, and its last row
   is reserved for the rule exactly as the tab bar reserves its own. Without a
   measurement (collapsed middle column) the row keeps DSH's natural height. */
[${FRAME_ATTRIBUTE}][${PANEL_RULE_ATTRIBUTE}] [${PANEL_HEADER_ATTRIBUTE}] {
  box-sizing: border-box;
  height: var(${PANEL_HEADER_HEIGHT_PROPERTY}, auto);
  min-height: 0;
  padding-block: 0 1px;
}

[${FRAME_ATTRIBUTE}]:not([${EDITOR_COLLAPSED_ATTRIBUTE}])[${DETAILS_TRACK_ATTRIBUTE}]:not([data-rightbar-collapsed]):not([data-rightbar-fullscreen]),
[${FRAME_ATTRIBUTE}][${DETAILS_TRACK_FALLBACK_ATTRIBUTE}] {
  grid-template-columns:
    var(${DETAILS_TRACK_SIDEBAR_WIDTH})
    minmax(0, 1fr)
    var(${DETAILS_TRACK_WIDTH}) !important;
}

/* The shell freezes the sidebar content at an inline width (native cols.sidebar)
   so its collapse slide never reflows. The workbench sidebar handle drives the
   grid track instead, which would otherwise leave the file tree / Git content
   pinned to the native width while the column grows. Let the sidebar root fill
   its column so the content tracks the dragged width. Scoped to the expanded,
   plugin-driven track states so the native collapse/expand slide keeps its own
   frozen width. */
[${FRAME_ATTRIBUTE}]:not([${EDITOR_COLLAPSED_ATTRIBUTE}])[${DETAILS_TRACK_ATTRIBUTE}]:not([data-sidebar-collapsed]):not([data-rightbar-collapsed]):not([data-rightbar-fullscreen]) > :nth-child(1) [class*="_root"],
[${FRAME_ATTRIBUTE}][${DETAILS_TRACK_FALLBACK_ATTRIBUTE}]:not([data-sidebar-collapsed]) > :nth-child(1) [class*="_root"] {
  width: 100% !important;
}

/* During a visibility toggle, keep the reordered occupants fixed and animate
   two registered length tracks. Registering the variables is required for
   Firefox and Chromium to interpolate their dependent grid geometry. */
[${FRAME_ATTRIBUTE}][${EDITOR_TRANSITION_ATTRIBUTE}] {
  grid-template-columns:
    var(${TRANSITION_SIDEBAR_WIDTH})
    minmax(0, var(${TRANSITION_EDITOR_WIDTH}))
    minmax(0, var(${TRANSITION_CONVERSATION_WIDTH})) !important;
  transition:
    ${TRANSITION_EDITOR_WIDTH} var(--ds-transition-duration-slow) var(--ds-ease-in-out),
    ${TRANSITION_CONVERSATION_WIDTH} var(--ds-transition-duration-slow) var(--ds-ease-in-out) !important;
}

/* Swapping reordered and native track definitions must be one atomic layout
   update. Otherwise AppFrame animates the reversed native tracks a second time
   and briefly gives the collapsed editor the full conversation width. */
[${FRAME_ATTRIBUTE}][${EDITOR_RELEASE_ATTRIBUTE}] {
  transition: none !important;
}

/* Collapsing the conversation column zeroes the workbench right track so the
   middle editor takes the freed width; the resize handles hide with it. */
[${FRAME_ATTRIBUTE}][${CONVERSATION_COLLAPSED_ATTRIBUTE}]:not([${EDITOR_COLLAPSED_ATTRIBUTE}]) {
  ${DETAILS_TRACK_WIDTH}: 0px !important;
}

[${FRAME_ATTRIBUTE}][${CONVERSATION_COLLAPSED_ATTRIBUTE}]:not([${EDITOR_COLLAPSED_ATTRIBUTE}]) > [${DETAILS_TRACK_HANDLE_ATTRIBUTE}],
[${FRAME_ATTRIBUTE}][${CONVERSATION_COLLAPSED_ATTRIBUTE}]:not([${EDITOR_COLLAPSED_ATTRIBUTE}]) > [${DETAILS_TRACK_NATIVE_HANDLE_ATTRIBUTE}] {
  display: none;
}

[${FRAME_ATTRIBUTE}][${DETAILS_TRACK_DRAGGING_ATTRIBUTE}] {
  transition: none !important;
}

[${FRAME_ATTRIBUTE}][${DETAILS_TRACK_ATTRIBUTE}]:not([${DETAILS_TRACK_FALLBACK_ATTRIBUTE}]) > [${DETAILS_TRACK_NATIVE_HANDLE_ATTRIBUTE}] {
  left: calc(100% - var(${DETAILS_TRACK_WIDTH})) !important;
}

[${FRAME_ATTRIBUTE}] > [${DETAILS_TRACK_HANDLE_ATTRIBUTE}] {
  position: absolute;
  top: 0;
  bottom: 0;
  left: calc(100% - var(${DETAILS_TRACK_WIDTH}));
  width: 8px;
  margin-left: -4px;
  cursor: col-resize;
  z-index: 2;
  touch-action: none;
  transition: left var(--ds-transition-duration-slow) var(--ds-ease-in-out);
}
[${FRAME_ATTRIBUTE}][${DETAILS_TRACK_DRAGGING_ATTRIBUTE}] > [${DETAILS_TRACK_HANDLE_ATTRIBUTE}],
[${FRAME_ATTRIBUTE}][${DETAILS_TRACK_DRAGGING_ATTRIBUTE}] > [${DETAILS_TRACK_NATIVE_HANDLE_ATTRIBUTE}] {
  transition: none;
}

/* Plugin-owned sidebar divider: the AppFrame native handle is not surfaced in
   the workbench, so this drives the first track via the mirrored width variable.
   The frame reserves the dock width as inline padding, and the absolute left is
   measured from the frame padding edge (x=0), so the track boundary sits at
   dock width + sidebar width. */
[${FRAME_ATTRIBUTE}] > [${SIDEBAR_TRACK_HANDLE_ATTRIBUTE}] {
  position: absolute;
  top: var(--dsh-windows-titlebar-height, 0px);
  bottom: 0;
  left: calc(48px + var(${DETAILS_TRACK_SIDEBAR_WIDTH}));
  width: 8px;
  margin-left: -4px;
  cursor: col-resize;
  z-index: 12;
  touch-action: none;
}

[${FRAME_ATTRIBUTE}] > [${SIDEBAR_TRACK_HANDLE_ATTRIBUTE}]::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 3px;
  width: 2px;
  background: transparent;
}

[${FRAME_ATTRIBUTE}] > [${SIDEBAR_TRACK_HANDLE_ATTRIBUTE}]:hover::after,
[${FRAME_ATTRIBUTE}] > [${SIDEBAR_TRACK_HANDLE_ATTRIBUTE}]:active::after {
  background: var(--dsw-alias-brand-primary);
}

/* Give the editor|conversation divider the same hover highlight as the sidebar
   handle, on both the adopted native handle and the blank-session fallback. */
[${FRAME_ATTRIBUTE}] > [${DETAILS_TRACK_HANDLE_ATTRIBUTE}]::after,
[${FRAME_ATTRIBUTE}] > [${DETAILS_TRACK_NATIVE_HANDLE_ATTRIBUTE}]::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 3px;
  width: 2px;
  background: transparent;
}

[${FRAME_ATTRIBUTE}] > [${DETAILS_TRACK_HANDLE_ATTRIBUTE}]:hover::after,
[${FRAME_ATTRIBUTE}] > [${DETAILS_TRACK_HANDLE_ATTRIBUTE}]:active::after,
[${FRAME_ATTRIBUTE}] > [${DETAILS_TRACK_NATIVE_HANDLE_ATTRIBUTE}]:hover::after,
[${FRAME_ATTRIBUTE}] > [${DETAILS_TRACK_NATIVE_HANDLE_ATTRIBUTE}]:active::after {
  background: var(--dsw-alias-brand-primary);
}

[${FRAME_ATTRIBUTE}] > [data-rightbar-col]::after {
  display: none !important;
}

/* The native failure row reserves its code as a full auto-sized third column.
   Once conversation moves into the narrow right track that leaves only a few
   words per line for the actual message, so the code moves below the copy. */
[${FRAME_ATTRIBUTE}] > :nth-child(2)[${CONVERSATION_NARROW_ATTRIBUTE}] [role='status']:has(> code) {
  grid-template-columns: 10px minmax(0, 1fr);
  column-gap: 8px;
  row-gap: 2px;
}

[${FRAME_ATTRIBUTE}] > :nth-child(2)[${CONVERSATION_NARROW_ATTRIBUTE}] [role='status']:has(> code) > code {
  grid-column: 2;
  grid-row: 2;
  min-width: 0;
  max-width: 100%;
  overflow-wrap: anywhere;
  white-space: normal;
}

/* The official assistant footer keeps its metrics in one nowrap span and its
   action row at a fixed 28px height. Only rows whose real rendered contents
   exceed their available width receive a second wrapping line, regardless of
   the conversation column's coarse responsive breakpoint. */
[${FRAME_ATTRIBUTE}] > :nth-child(2)
  [${ASSISTANT_ACTIONS_ATTRIBUTE}][${ASSISTANT_METRICS_WRAP_ATTRIBUTE}] {
  flex-wrap: wrap;
  align-content: flex-start;
  height: auto;
  min-height: 28px;
  column-gap: 10px;
  row-gap: 2px;
}

[${FRAME_ATTRIBUTE}] > :nth-child(2)
  [${ASSISTANT_ACTIONS_ATTRIBUTE}][${ASSISTANT_METRICS_WRAP_ATTRIBUTE}]
  [${ASSISTANT_METRICS_ATTRIBUTE}] {
  flex: 1 0 100%;
  box-sizing: border-box;
  padding-left: 0;
  line-height: 20px;
  overflow-wrap: anywhere;
  white-space: normal;
}

/* Keep the official composer toolbar on one row. Fixed actions retain their
   hit targets; gaps, effort text, and the flexible model label concede. */
[${FRAME_ATTRIBUTE}] > :nth-child(2)[${CONVERSATION_NARROW_ATTRIBUTE}] [data-input-scroll] + div {
  gap: 4px;
}

[${FRAME_ATTRIBUTE}] > :nth-child(2)[${CONVERSATION_NARROW_ATTRIBUTE}] [data-input-scroll] + div > div:first-child {
  flex: 0 1 auto;
  gap: 8px;
}

[${FRAME_ATTRIBUTE}] > :nth-child(2)[${CONVERSATION_NARROW_ATTRIBUTE}] [data-input-scroll] + div > div:first-child > div {
  gap: 6px;
}

[${FRAME_ATTRIBUTE}] > :nth-child(2)[${CONVERSATION_NARROW_ATTRIBUTE}] [data-input-scroll] + div > div:last-child {
  flex: 1 1 0;
  justify-content: flex-end;
  gap: 6px;
}

[${FRAME_ATTRIBUTE}] > :nth-child(2)[${CONVERSATION_NARROW_ATTRIBUTE}] [data-slot='conversation.input.model'] > div {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 100%;
}

[${FRAME_ATTRIBUTE}] > :nth-child(2)[${CONVERSATION_NARROW_ATTRIBUTE}] [data-slot='conversation.input.model'] button[aria-haspopup='menu'] {
  width: auto;
  max-width: 100%;
  padding-inline: 8px;
}

[${FRAME_ATTRIBUTE}] > :nth-child(2)[${CONVERSATION_NARROW_ATTRIBUTE}] [data-slot='conversation.input.model'] button[aria-haspopup='menu'] > span:nth-of-type(2) {
  display: none;
}

/* Only the PermissionSelect chevron is omitted from the left tool group.
   The Plan chip and conversation-header disclosure controls remain intact. */
[${FRAME_ATTRIBUTE}] > :nth-child(2)[${CONVERSATION_NARROW_ATTRIBUTE}] [data-input-scroll] + div > div:first-child > div:first-of-type > span:first-child > button {
  padding-inline: 8px;
}

[${FRAME_ATTRIBUTE}] > :nth-child(2)[${CONVERSATION_NARROW_ATTRIBUTE}] [data-input-scroll] + div > div:first-child > div:first-of-type > span:first-child > button > span[aria-hidden]:last-child,
[${FRAME_ATTRIBUTE}] > :nth-child(2)[${CONVERSATION_NARROW_ATTRIBUTE}] [data-slot='conversation.input.model'] button[aria-haspopup='menu'] > svg:last-child {
  display: none;
}

/* Fixed positioning escapes the native conversation scroll/root clipping
   chain while the node remains in its official React tree for focus, outside
   click, keyboard navigation, and unmount ownership. */
[${FRAME_ATTRIBUTE}] [${FLOATING_MODEL_MENU_ATTRIBUTE}] {
  position: fixed !important;
  top: var(${FLOATING_MENU_TOP_PROPERTY}, 12px) !important;
  right: auto !important;
  bottom: auto !important;
  left: var(${FLOATING_MENU_LEFT_PROPERTY}, 12px) !important;
  z-index: 1000 !important;
}

/* A global \`main\` panel (the Plugins page, or one another plugin registers)
   replaces the Conversation in the center column, and DSH then hides every
   Session subtree of the right column — which is where the workbench editor
   lives, since it takes the session-scoped \`rightbar.session\` seat. While the
   reorder keeps the panel on the right, hold open exactly the Session host that
   was on screen before the panel opened, so the files stay visible beside it.
   The official host rule is \`._session[hidden]{display:none}\` (0,2,0); this
   selector is heavier and only ever matches the single claimed host. */
[${FRAME_ATTRIBUTE}][${GLOBAL_PANEL_ATTRIBUTE}]:not([${EDITOR_COLLAPSED_ATTRIBUTE}]) > :nth-child(3) [${EDITOR_HOST_ATTRIBUTE}] {
  display: contents !important;
}
`

/** 安装可收起的列顺序样式，并为工作台右栏提供响应式会话轨道。 */
export function installWorkbenchLayout(
  ctx: ClientContext,
  visibility: WorkbenchEditorVisibilityStore,
  fileController: ConversationFileController,
  panelInfo: GlobalPanelSource,
): void {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.dshWorkbenchLayout = ''
    style.textContent = CSS
    document.head.appendChild(style)

    let frame: HTMLElement | null = null
    let detailsTrack: DetailsTrackLayout | undefined
    let conversationLayout: ConversationLayout | undefined
    let conversationFileRouting: ConversationFileRouting | undefined
    let editorTransition: EditorTrackTransition | undefined
    let globalPanel: GlobalPanelLayout | undefined
    let panelRule: PanelRuleLayout | undefined
    let editorExpanded = visibility.getSnapshot().editorExpanded
    const synchronizeVisibility = (): void => {
      const nextExpanded = visibility.getSnapshot().editorExpanded
      editorTransition?.setExpanded(nextExpanded)
      editorExpanded = nextExpanded
      frame?.toggleAttribute(EDITOR_COLLAPSED_ATTRIBUTE, !nextExpanded)
      frame?.toggleAttribute(CONVERSATION_COLLAPSED_ATTRIBUTE, !visibility.getSnapshot().conversationExpanded)
      detailsTrack?.setEnabled(nextExpanded)
    }
    const attach = (): void => {
      const next = document.querySelector<HTMLElement>('[data-shell-overlay]')?.parentElement ?? null
      if (next === frame) return
      globalPanel?.dispose()
      globalPanel = undefined
      panelRule?.dispose()
      panelRule = undefined
      conversationLayout?.dispose()
      conversationLayout = undefined
      conversationFileRouting?.dispose()
      conversationFileRouting = undefined
      editorTransition?.dispose()
      editorTransition = undefined
      detailsTrack?.dispose()
      detailsTrack = undefined
      frame?.removeAttribute(FRAME_ATTRIBUTE)
      frame?.removeAttribute(EDITOR_COLLAPSED_ATTRIBUTE)
      frame?.removeAttribute(CONVERSATION_COLLAPSED_ATTRIBUTE)
      frame = next
      if (frame === null) return
      frame.setAttribute(FRAME_ATTRIBUTE, '')
      frame.toggleAttribute(EDITOR_COLLAPSED_ATTRIBUTE, !editorExpanded)
      frame.toggleAttribute(CONVERSATION_COLLAPSED_ATTRIBUTE, !visibility.getSnapshot().conversationExpanded)
      detailsTrack = createDetailsTrackLayout(frame, ctx.logger, editorExpanded)
      editorTransition = createEditorTrackTransition(
        frame,
        ctx.logger,
        editorExpanded,
        availableWidth => detailsTrack?.resolvePreferredWidth(availableWidth) ?? 0,
      )
      globalPanel = createGlobalPanelLayout(frame, panelInfo, ctx.logger)
      panelRule = createPanelRuleLayout(frame, ctx.logger)
      const conversationColumn = frame.children.item(1)
      if (conversationColumn instanceof HTMLElement) {
        conversationLayout = createConversationLayout(conversationColumn, ctx.logger)
        conversationFileRouting = createConversationFileRouting(conversationColumn, fileController, ctx.logger)
      }
    }
    attach()
    const documentObserver = new MutationObserver(attach)
    documentObserver.observe(document.body, { childList: true, subtree: true })
    const unsubscribeVisibility = visibility.subscribe(synchronizeVisibility)
    ctx.logger.info('workbench-layout: native AppFrame tracks, root-scoped conversation surface, and wrapping narrow assistant metrics adopted')
    return () => {
      documentObserver.disconnect()
      unsubscribeVisibility()
      globalPanel?.dispose()
      panelRule?.dispose()
      conversationLayout?.dispose()
      conversationFileRouting?.dispose()
      editorTransition?.dispose()
      detailsTrack?.dispose()
      frame?.removeAttribute(FRAME_ATTRIBUTE)
      frame?.removeAttribute(EDITOR_COLLAPSED_ATTRIBUTE)
      frame?.removeAttribute(CONVERSATION_COLLAPSED_ATTRIBUTE)
      style.remove()
    }
  }, 'workbench-layout: AppFrame column presentation')
}
