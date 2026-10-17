/** 中栏显隐布局与终端尺寸同步共享的稳定 DOM 契约。 */

export const FRAME_ATTRIBUTE = 'data-dsh-workbench-frame'
export const EDITOR_COLLAPSED_ATTRIBUTE = 'data-dsh-workbench-editor-collapsed'
export const EDITOR_TRANSITION_ATTRIBUTE = 'data-dsh-workbench-editor-transition'
export const EDITOR_RELEASE_ATTRIBUTE = 'data-dsh-workbench-editor-release'
export const CONVERSATION_COLLAPSED_ATTRIBUTE = 'data-dsh-workbench-conversation-collapsed'

export const TRANSITION_SIDEBAR_WIDTH = '--dsh-workbench-transition-sidebar-width'
export const TRANSITION_EDITOR_WIDTH = '--dsh-workbench-transition-editor-width'
export const TRANSITION_CONVERSATION_WIDTH = '--dsh-workbench-transition-conversation-width'

export const EDITOR_TRANSITION_START_EVENT = 'dsh-workbench:editor-transition-start'
export const EDITOR_TRANSITION_END_EVENT = 'dsh-workbench:editor-transition-end'

/**
 * Sidebar panel rule markers and geometry.
 *
 * A panel *section* that needs its bottom edge closed — the commit box, the SQL panes — still has
 * to have that edge painted from outside: the shell's `.regionArea` clips overflow and reclaims
 * only 4px of the sidebar's 12px inline padding on the left, so a border drawn in there stops 8px
 * short of the column edge, and a negative margin cannot cross the clip. Those rules are painted by
 * overlay elements appended to the AppFrame, which already contains the columns and is not clipped.
 *
 * A panel **header** is no longer one of them: it is a real toolbar, drawing its own fill and its
 * own bottom seam, and the layout contributes only the height that puts that seam on the middle
 * column's tab bar. The `[panel-header]` rules in `layout-styles.ts` cancel the shell's top inset
 * and widen the clip to the column edge, which is what makes a border in there reach as far as the
 * overlay used to.
 *
 * `[panel-header]` marks the header that closes against the middle column's tab bar
 * (`[panel-rule-anchor]`); `[panel-rule-section]` marks any other section that simply needs its
 * bottom edge closed, such as the commit box.
 */
export const PANEL_RULE_ANCHOR_ATTRIBUTE = 'data-dsh-workbench-panel-rule-anchor'
export const PANEL_HEADER_ATTRIBUTE = 'data-dsh-workbench-panel-header'
export const PANEL_RULE_SECTION_ATTRIBUTE = 'data-dsh-workbench-panel-rule-section'
export const PANEL_RULE_ATTRIBUTE = 'data-dsh-workbench-panel-rule'
export const PANEL_RULE_OVERLAY_ATTRIBUTE = 'data-dsh-workbench-panel-rule-overlay'
export const PANEL_HEADER_HEIGHT_PROPERTY = '--dsh-workbench-panel-header-height'

/**
 * Marks the middle column's own root, in both of its states.
 *
 * `WorkbenchEditor` puts it on `.editorRoot` when a file is open and `EditorShared`'s empty state
 * carries it otherwise, so it is the one handle that exists whether or not there are tabs. The
 * panel-rule layout reads it as the base for the edge the tab bar *would* occupy: the tab bar lives
 * in this column, and taking the sidebar column's top instead assumes the two columns share an
 * origin — an assumption that only holds because every test fixture put the frame at the viewport
 * origin.
 */
export const EDITOR_ROOT_ATTRIBUTE = 'data-dsh-workbench-editor'

/**
 * Mount seat the workbench opens inside the official Plugins page header. The
 * page contributes no header slot, so its missing way back to the Conversation
 * is contributed through the DOM instead.
 */
export const PANEL_BACK_SEAT_ATTRIBUTE = 'data-dsh-workbench-panel-back-seat'

/**
 * On the document root while the workbench shadows the official sessions browser.
 *
 * A contract rather than a shell detail, because the layout stylesheet scopes the sidebar geometry
 * overrides with it: the shell's padding belongs to the sessions browser, and only the workbench's
 * panels claim the middle column's tab-bar row. When the seat is released the marker goes with it
 * and the official sidebar's geometry is untouched.
 */
export const SIDEBAR_SHADOWED_ATTRIBUTE = 'data-dsh-workbench-sidebar-shadowed'

export interface EditorTransitionEventDetail {
  expanded: boolean
}

/** 只有工作台中栏处于展开态时，xterm 才能采用宿主宽度。 */
export function isEditorTrackExpanded(element: Element): boolean {
  const frame = element.closest(`[${FRAME_ATTRIBUTE}]`)
  return frame === null || !frame.hasAttribute(EDITOR_COLLAPSED_ATTRIBUTE)
}

/** 处理在过渡已经开始后才挂载的文件或终端视图。 */
export function isEditorTrackTransitioning(element: Element): boolean {
  const frame = element.closest(`[${FRAME_ATTRIBUTE}]`)
  return frame?.hasAttribute(EDITOR_TRANSITION_ATTRIBUTE) === true
    || frame?.hasAttribute(EDITOR_RELEASE_ATTRIBUTE) === true
}
