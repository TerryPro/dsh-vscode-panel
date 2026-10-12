import {
  IconCopyOutlineMedium,
  IconEditOutlineMedium,
  IconFolderOpenOutlineMedium,
  IconRefreshOutlineMedium,
  IconRightUpOutlineMedium,
  IconTrashOutlineMedium,
  Menu,
  type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceEntry } from '../../shared/contracts.ts'
import { IconFileAddOutline16, IconFileOutline16, IconFolderAddOutline16 } from './CreateEntryIcons.tsx'
import css from './files.module.css'

export type FileTreeMenuAction =
  | 'open'
  | 'new-file'
  | 'new-directory'
  | 'rename'
  | 'delete'
  | 'copy-relative-path'
  | 'copy-absolute-path'
  | 'reveal-in-file-manager'
  | 'refresh'
  | 'expand-all'
  | 'collapse-all'

export interface FileTreeMenuTarget {
  entry: WorkspaceEntry | null
  expanded: boolean
  rect: DOMRect
}

interface FileTreeContextMenuProps {
  target: FileTreeMenuTarget | null
  onClose: () => void
  onSelect: (action: FileTreeMenuAction) => void
  t: TranslateNS<'workbench'>
}

/** DSH 原生菜单承载文件树鼠标与键盘上下文操作。 */
export function FileTreeContextMenu(props: FileTreeContextMenuProps) {
  const entry = props.target?.entry ?? null
  return (
    <Menu
      open={props.target !== null}
      onClose={props.onClose}
      items={entry === null ? rootItems(props.t) : entryItems(entry, props.target?.expanded === true, props.t)}
      onSelect={(id) => {
        props.onClose()
        if (isFileTreeMenuAction(id)) props.onSelect(id)
      }}
      getAnchorRect={() => props.target?.rect ?? null}
      dense
      compact
      portal
      anchor={<span className={css.contextMenuAnchor} aria-hidden="true" />}
    />
  )
}

function rootItems(t: TranslateNS<'workbench'>): MenuEntry[] {
  return [
    { id: 'new-file', label: t('files.newFile'), icon: <IconFileAddOutline16 size={14} /> },
    { id: 'new-directory', label: t('files.newDirectory'), icon: <IconFolderAddOutline16 size={14} /> },
    { type: 'separator', id: 'root-refresh-separator' },
    { id: 'refresh', label: t('files.refresh'), icon: <IconRefreshOutlineMedium size={14} /> },
  ]
}

function entryItems(entry: WorkspaceEntry, expanded: boolean, t: TranslateNS<'workbench'>): MenuEntry[] {
  const mutable = entry.kind === 'file' || entry.kind === 'directory'
  const openLabel = entry.kind === 'directory'
    ? t(expanded ? 'files.collapseDirectory' : 'files.expandDirectory')
    : t('files.open')
  return [
    {
      id: 'open',
      label: openLabel,
      icon: entry.kind === 'directory' ? <IconFolderOpenOutlineMedium size={14} /> : <IconFileOutline16 size={14} />,
      disabled: entry.kind !== 'file' && entry.kind !== 'directory',
    },
    ...(entry.kind === 'directory' ? [
      { type: 'separator' as const, id: 'entry-expand-separator' },
      { id: 'expand-all', label: t('files.expandAll'), icon: <IconFolderOpenOutlineMedium size={14} /> },
      { id: 'collapse-all', label: t('files.collapseAll'), icon: <IconFolderOpenOutlineMedium size={14} /> },
      { type: 'separator' as const, id: 'entry-create-separator' },
      { id: 'new-file', label: t('files.newFile'), icon: <IconFileAddOutline16 size={14} /> },
      { id: 'new-directory', label: t('files.newDirectory'), icon: <IconFolderAddOutline16 size={14} /> },
    ] : []),
    { type: 'separator', id: 'entry-edit-separator' },
    { id: 'rename', label: t('files.rename'), icon: <IconEditOutlineMedium size={14} />, disabled: !mutable },
    { id: 'delete', label: t('files.delete'), icon: <IconTrashOutlineMedium size={14} />, danger: true, disabled: !mutable },
    { type: 'separator', id: 'entry-copy-separator' },
    { id: 'copy-relative-path', label: t('files.copyRelativePath'), icon: <IconCopyOutlineMedium size={14} /> },
    { id: 'copy-absolute-path', label: t('files.copyAbsolutePath'), icon: <IconCopyOutlineMedium size={14} /> },
    // The row is offered on every platform rather than only where the client thinks a file
    // manager exists: the browser's own OS is not necessarily the Host's, and the Host's
    // `REVEAL_UNSUPPORTED` answer with its message is a better report than a row that
    // silently vanished.
    { id: 'reveal-in-file-manager', label: t('files.revealInFileManager'), icon: <IconRightUpOutlineMedium size={14} />, disabled: !mutable },
  ]
}

/**
 * Every action the menus above can carry. The guard reads this list rather than restating
 * the comparison chain: a row added to a menu and forgotten here is a row that does nothing
 * when clicked, and one list the type has to satisfy makes that pair impossible to drift.
 */
const FILE_TREE_MENU_ACTIONS: readonly FileTreeMenuAction[] = [
  'open',
  'new-file',
  'new-directory',
  'rename',
  'delete',
  'copy-relative-path',
  'copy-absolute-path',
  'reveal-in-file-manager',
  'refresh',
  'expand-all',
  'collapse-all',
]

function isFileTreeMenuAction(id: string): id is FileTreeMenuAction {
  return (FILE_TREE_MENU_ACTIONS as readonly string[]).includes(id)
}
