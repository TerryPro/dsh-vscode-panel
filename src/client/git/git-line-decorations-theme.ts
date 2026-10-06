import { EditorView } from '@codemirror/view'

/** Plugin-owned custom property: the gutter width both diff sides share. */
export const GIT_LINE_NUMBER_WIDTH_PROPERTY = '--dsh-workbench-git-line-number-width'

export const gitLineTheme = EditorView.theme({
  '.cm-gitChangeGutter': {
    width: '6px',
    minWidth: '6px',
    backgroundColor: 'var(--dsw-alias-bg-base)',
    borderRight: '0',
  },
  '.cm-gitChangeGutter .cm-gutterElement': {
    boxSizing: 'border-box',
    width: '6px',
    minWidth: '6px',
    padding: '0',
  },
  '.cm-gitChangedGutterElement': {
    position: 'relative',
  },
  '.cm-gitLineMarker': {
    position: 'absolute',
    inset: '0',
    display: 'block',
    width: '100%',
    minWidth: '0',
    padding: '0',
    border: '0',
    borderRadius: '2px',
    background: 'transparent',
    cursor: 'pointer',
  },
  '.cm-gitLineMarker::before': {
    content: '""',
    position: 'absolute',
    insetInlineStart: '1px',
    insetBlock: '0',
    width: '2px',
    borderRadius: '0 2px 2px 0',
    background: 'var(--dsw-alias-state-business-primary)',
  },
  '.cm-gitLineMarker[data-kind="added"]::before': {
    background: 'var(--dsw-alias-state-success-primary)',
  },
  '.cm-gitLineMarker[data-kind="deleted"]::before': {
    insetBlock: '-3px auto',
    insetInlineStart: '0',
    width: '0',
    height: '0',
    borderBlock: '3px solid transparent',
    borderInlineStart: '5px solid var(--dsw-alias-state-error-primary)',
    borderRadius: '0',
    background: 'transparent',
  },
  '.cm-gitLineMarker:hover, .cm-gitLineMarker:focus-visible, .cm-gitLineMarker[data-selected="true"]': {
    background: 'var(--dsw-alias-interactive-bg-hover)',
  },
  '.cm-gitLineMarker:focus-visible': {
    outline: '1px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))',
    outlineOffset: '-1px',
  },
  '.cm-tooltip.cm-gitChangePeek': {
    boxSizing: 'border-box',
    overflow: 'hidden',
    border: '1px solid var(--dsw-alias-border-inverted)',
    borderRadius: '12px',
    background: 'var(--dsw-specific-menu)',
    color: 'var(--dsw-alias-label-primary)',
    boxShadow: 'var(--dsw-shadow-lv3)',
  },
  '.cm-gitChangePeekHeader': {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '10px',
    minHeight: '38px',
    padding: '5px 7px 5px 12px',
    borderBottom: '1px solid var(--dsw-alias-border-l1)',
  },
  '.cm-gitChangePeekIdentity': {
    display: 'flex',
    alignItems: 'center',
    minWidth: '0',
    gap: '7px',
    font: 'var(--dsw-font-xxs-12)',
  },
  '.cm-gitChangePeekIdentity strong': {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontWeight: '600',
  },
  '.cm-gitChangePeekIdentity > span:last-child': {
    color: 'var(--dsw-alias-label-tertiary)',
  },
  '.cm-gitChangePeekDot': {
    flex: '0 0 auto',
    width: '7px',
    height: '7px',
    borderRadius: '50%',
    background: 'var(--dsw-alias-state-business-primary)',
  },
  '.cm-gitChangePeek[data-kind="added"] .cm-gitChangePeekDot': {
    background: 'var(--dsw-alias-state-success-primary)',
  },
  '.cm-gitChangePeek[data-kind="deleted"] .cm-gitChangePeekDot': {
    background: 'var(--dsw-alias-state-error-primary)',
  },
  '.cm-gitChangePeekActions': {
    display: 'flex',
    flex: '0 0 auto',
    alignItems: 'center',
    gap: '2px',
  },
  '.cm-gitChangePeekActions button': {
    minWidth: '0',
    height: '27px',
    padding: '0 8px',
    border: '0',
    borderRadius: '7px',
    background: 'transparent',
    color: 'var(--dsw-alias-label-secondary)',
    font: 'var(--dsw-font-xxs-12)',
    cursor: 'pointer',
  },
  '.cm-gitChangePeekActions button:hover, .cm-gitChangePeekActions button:focus-visible': {
    background: 'var(--dsw-alias-interactive-bg-hover)',
    color: 'var(--dsw-alias-label-primary)',
    outline: 'none',
  },
  '.cm-gitChangePeekBody': {
    minWidth: '0',
    background: 'var(--dsw-alias-markdown-code-block)',
  },
  '.cm-gitChangePeekHunkHeader': {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
    padding: '7px 10px',
    borderBottom: '1px solid var(--dsw-alias-border-l1)',
    color: 'var(--dsw-alias-label-tertiary)',
    font: 'var(--dsw-font-xxs-12)',
  },
  '.cm-gitChangePeekHunkHeader code': {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    font: 'var(--dsw-font-markdown-code-block)',
  },
  '.cm-gitChangePeekRows': {
    maxHeight: '260px',
    overflow: 'auto',
    paddingBlock: '5px',
    font: 'var(--dsw-font-markdown-code-block)',
  },
  '.cm-gitChangePeekRow': {
    display: 'grid',
    gridTemplateColumns: `var(${GIT_LINE_NUMBER_WIDTH_PROPERTY}) var(${GIT_LINE_NUMBER_WIDTH_PROPERTY}) 14px minmax(0, 1fr)`,
    alignItems: 'start',
    minHeight: '20px',
    color: 'var(--dsw-alias-label-primary)',
  },
  '.cm-gitChangePeekLineNumber': {
    boxSizing: 'border-box',
    minHeight: '20px',
    paddingInlineEnd: '5px',
    color: 'var(--dsw-alias-label-tertiary)',
    textAlign: 'right',
    userSelect: 'none',
  },
  '.cm-gitChangePeekLineNumber[data-side="new"]': {
    borderInlineEnd: '1px solid var(--dsw-alias-border-l1)',
  },
  '.cm-gitChangePeekPrefix': {
    minHeight: '20px',
    textAlign: 'center',
    userSelect: 'none',
  },
  '.cm-gitChangePeekCode': {
    minWidth: '0',
    minHeight: '20px',
    paddingInlineEnd: '10px',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    font: 'inherit',
  },
  '.cm-gitChangePeekRow[data-diff-kind="removed"] .cm-gitChangePeekPrefix, .cm-gitChangePeekRow[data-diff-kind="removed"] .cm-gitChangePeekCode': {
    color: 'var(--dsw-alias-state-error-primary)',
  },
  '.cm-gitChangePeekRow[data-diff-kind="removed"]': {
    background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 11%, transparent)',
  },
  '.cm-gitChangePeekRow[data-diff-kind="added"] .cm-gitChangePeekPrefix, .cm-gitChangePeekRow[data-diff-kind="added"] .cm-gitChangePeekCode': {
    color: 'var(--dsw-alias-state-success-primary)',
  },
  '.cm-gitChangePeekRow[data-diff-kind="added"]': {
    background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 11%, transparent)',
  },
  '.cm-gitChangePeekRow[data-diff-kind="removed"] [data-diff-segment="changed"]': {
    borderRadius: '2px',
    background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 23%, transparent)',
  },
  '.cm-gitChangePeekRow[data-diff-kind="added"] [data-diff-segment="changed"]': {
    borderRadius: '2px',
    background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 23%, transparent)',
  },
  '.cm-tooltip.cm-gitChangePeek > .cm-gitChangePeekResizeHandle': {
    position: 'absolute',
    zIndex: '3',
    boxSizing: 'border-box',
    padding: '0',
    border: '0',
    background: 'transparent',
    touchAction: 'none',
    userSelect: 'none',
  },
  '.cm-gitChangePeekResizeHandle': {
    insetBlock: '38px 10px',
    insetInlineEnd: '0',
    width: '8px',
    cursor: 'col-resize',
  },
  '.cm-tooltip.cm-gitChangePeek > .cm-gitChangePeekResizeHandle::after': {
    content: '""',
    position: 'absolute',
    boxSizing: 'border-box',
    opacity: '0',
    transition: 'opacity var(--ds-transition-duration-slow) var(--ds-ease-in-out)',
  },
  '.cm-gitChangePeekResizeHandle::after': {
    insetBlockStart: '50%',
    insetInlineEnd: '2px',
    width: '2px',
    height: '28px',
    borderRadius: '2px',
    background: 'var(--dsw-alias-label-tertiary)',
    transform: 'translateY(-50%)',
  },
  '.cm-gitChangePeek:hover .cm-gitChangePeekResizeHandle::after': {
    opacity: '0.45',
  },
  '.cm-gitChangePeekResizeHandle:hover::after, .cm-gitChangePeekResizeHandle:focus-visible::after, .cm-gitChangePeek[data-resizing] .cm-gitChangePeekResizeHandle::after': {
    opacity: '1',
  },
  '.cm-gitChangePeekResizeHandle:focus-visible': {
    outline: '1px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))',
    outlineOffset: '-2px',
  },
  '@media (prefers-reduced-motion: reduce)': {
    '.cm-gitChangePeekResizeHandle::after': {
      transition: 'none',
    },
  },
})
