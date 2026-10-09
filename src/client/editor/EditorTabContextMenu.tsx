/**
 * VS Code-style context menu for the editor tab strip. Rows are grouped the way
 * the official editor menu groups them — close family, then save/revert, then
 * path and reveal, then layout — and every row reflects what the clicked tab
 * actually is: a Diff or terminal tab never offers Save, and a terminal offers
 * no path actions.
 */

import {
  IconCloseOutlineMedium,
  IconCopyOutlineMedium,
  IconFolderOpenOutlineMedium,
  IconRefreshOutlineMedium,
  IconTrashOutlineMedium,
  Menu,
  type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkbenchTab } from '../model/controller.ts'
import { isMacPlatform } from '../core/platform.ts'
import { IconSaveOutline16, IconSplitHorizontalOutline16, IconSplitVerticalOutline16 } from './EditorViewIcons.tsx'
import css from './editor.module.css'

export type EditorTabMenuAction =
  | 'close'
  | 'close-others'
  | 'close-right'
  | 'close-saved'
  | 'close-all'
  | 'save'
  | 'revert'
  | 'copy-path'
  | 'copy-relative-path'
  | 'reveal'
  | 'split-right'
  | 'split-down'

/** Where the menu was opened: the tab it targets and the pointer rect anchoring it. */
export interface EditorTabMenuTarget {
  tab: WorkbenchTab
  rect: DOMRect
}

interface EditorTabContextMenuProps {
  target: EditorTabMenuTarget | null
  /** Tabs in the same pane as the target; the close family is scoped to this strip. */
  tabs: readonly WorkbenchTab[]
  /** Whether the editor column is already split into two panes. */
  split: boolean
  onClose: () => void
  onSelect: (action: EditorTabMenuAction, tab: WorkbenchTab) => void
  t: TranslateNS<'workbench'>
}

export function EditorTabContextMenu(props: EditorTabContextMenuProps) {
  const target = props.target
  return (
    <Menu
      open={target !== null}
      onClose={props.onClose}
      items={target === null
        ? []
        : menuItems(target.tab, props.tabs, props.split, props.t)}
      onSelect={(id) => {
        props.onClose()
        if (target !== null && isEditorTabMenuAction(id)) props.onSelect(id, target.tab)
      }}
      getAnchorRect={() => props.target?.rect ?? null}
      dense
      compact
      portal
      anchor={<span className={css.tabMenuAnchor} aria-hidden="true" />}
    />
  )
}

function menuItems(
  tab: WorkbenchTab,
  tabs: readonly WorkbenchTab[],
  split: boolean,
  t: TranslateNS<'workbench'>,
): MenuEntry[] {
  const index = tabs.findIndex(candidate => candidate.id === tab.id)
  const dirty = tab.kind === 'file' && tab.dirty
  // Terminals hold live processes, so "Close Saved" never counts them; the other
  // batch rows do, matching VS Code where they close like any other editor.
  const hasOthers = tabs.some(candidate => candidate.id !== tab.id)
  const hasRight = index >= 0 && tabs.slice(index + 1).length > 0
  const hasSaved = tabs.some(candidate => candidate.kind === 'diff' || (candidate.kind === 'file' && !candidate.dirty))
  const file = tab.kind === 'file'
  const hasPath = tab.kind !== 'terminal'
  const saveShortcut = isMacPlatform() ? { keys: ['⌘', 'S'], aria: 'Meta+S' } : { keys: ['Ctrl', 'S'], aria: 'Control+S' }
  return [
    { id: 'close', label: t('editor.tabClose'), icon: <IconCloseOutlineMedium size={14} /> },
    {
      id: 'close-others',
      label: t('editor.tabCloseOthers'),
      icon: <IconCloseOutlineMedium size={14} />,
      disabled: !hasOthers,
    },
    {
      id: 'close-right',
      label: t('editor.tabCloseRight'),
      icon: <IconCloseOutlineMedium size={14} />,
      disabled: !hasRight,
    },
    {
      id: 'close-saved',
      label: t('editor.tabCloseSaved'),
      icon: <IconCloseOutlineMedium size={14} />,
      disabled: !hasSaved,
    },
    { id: 'close-all', label: t('editor.tabCloseAll'), icon: <IconTrashOutlineMedium size={14} />, danger: true },
    { type: 'separator', id: 'tab-close-separator' },
    {
      id: 'save',
      label: t('editor.tabSave'),
      icon: <IconSaveOutline16 size={14} />,
      shortcut: saveShortcut,
      disabled: !file || !dirty,
    },
    {
      id: 'revert',
      label: t('editor.tabRevert'),
      icon: <IconRefreshOutlineMedium size={14} />,
      disabled: !file,
    },
    { type: 'separator', id: 'tab-path-separator' },
    {
      id: 'copy-path',
      label: t('editor.tabCopyPath'),
      icon: <IconCopyOutlineMedium size={14} />,
      disabled: !hasPath,
    },
    {
      id: 'copy-relative-path',
      label: t('editor.tabCopyRelativePath'),
      icon: <IconCopyOutlineMedium size={14} />,
      disabled: !hasPath,
    },
    {
      id: 'reveal',
      label: t('editor.tabReveal'),
      icon: <IconFolderOpenOutlineMedium size={14} />,
      disabled: !hasPath,
    },
    ...(split || tabs.length < 2 ? [] : [
      { type: 'separator' as const, id: 'tab-split-separator' },
      { id: 'split-right', label: t('editor.tabSplitRight'), icon: <IconSplitHorizontalOutline16 size={14} /> },
      { id: 'split-down', label: t('editor.tabSplitDown'), icon: <IconSplitVerticalOutline16 size={14} /> },
    ]),
  ]
}

const EDITOR_TAB_MENU_ACTIONS: readonly EditorTabMenuAction[] = [
  'close',
  'close-others',
  'close-right',
  'close-saved',
  'close-all',
  'save',
  'revert',
  'copy-path',
  'copy-relative-path',
  'reveal',
  'split-right',
  'split-down',
]

export function isEditorTabMenuAction(id: string): id is EditorTabMenuAction {
  return (EDITOR_TAB_MENU_ACTIONS as readonly string[]).includes(id)
}
