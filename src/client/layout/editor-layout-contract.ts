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
 * The rule closes a sidebar panel header and must be collinear with the middle
 * column's tab bar. It is painted by a pseudo-element on the AppFrame rather
 * than as a border on the header, and its box plus the matching header height
 * are measured at runtime (see panel-rule-layout.ts).
 */
export const PANEL_RULE_ANCHOR_ATTRIBUTE = 'data-dsh-workbench-panel-rule-anchor'
export const PANEL_HEADER_ATTRIBUTE = 'data-dsh-workbench-panel-header'
export const PANEL_RULE_ATTRIBUTE = 'data-dsh-workbench-panel-rule'
export const PANEL_RULE_LEFT_PROPERTY = '--dsh-workbench-panel-rule-left'
export const PANEL_RULE_TOP_PROPERTY = '--dsh-workbench-panel-rule-top'
export const PANEL_RULE_WIDTH_PROPERTY = '--dsh-workbench-panel-rule-width'
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
