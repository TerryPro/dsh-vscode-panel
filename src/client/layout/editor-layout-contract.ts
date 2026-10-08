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
 * A rule closes a panel section and must span the sidebar column's full width.
 * It cannot be a border on that section: the shell's `.regionArea` clips overflow
 * and reclaims only 4px of the sidebar's 12px inline padding on the left, so a
 * border drawn in there stops 8px short of the column edge — the visible gap.
 * Rules are therefore painted by overlay elements appended to the AppFrame, which
 * already contains the columns and is not clipped.
 *
 * `[panel-header]` marks the header that closes against the middle column's tab
 * bar (`[panel-rule-anchor]`); `[panel-rule-section]` marks any other section that
 * simply needs its bottom edge closed, such as the commit box.
 */
export const PANEL_RULE_ANCHOR_ATTRIBUTE = 'data-dsh-workbench-panel-rule-anchor'
export const PANEL_HEADER_ATTRIBUTE = 'data-dsh-workbench-panel-header'
export const PANEL_RULE_SECTION_ATTRIBUTE = 'data-dsh-workbench-panel-rule-section'
export const PANEL_RULE_ATTRIBUTE = 'data-dsh-workbench-panel-rule'
export const PANEL_RULE_OVERLAY_ATTRIBUTE = 'data-dsh-workbench-panel-rule-overlay'
export const PANEL_HEADER_HEIGHT_PROPERTY = '--dsh-workbench-panel-header-height'

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
