import {
  IconFolderCloseMedium,
  IconPlusOutlineMedium,
  type IconProps,
} from '@deepseek-ai/dsh-client-ui-primitives'
import css from './CreateEntryIcons.module.css'

/** DSH 暂无通用文件图标；这里补齐与其 16px 轮廓体系一致的圆角折角文档。 */
export function IconFileOutline16({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
      data-icon="file"
    >
      <path
        d="M8.15 1.5H4C3.17157 1.5 2.5 2.17157 2.5 3V13C2.5 13.8284 3.17157 14.5 4 14.5H12C12.8284 14.5 13.5 13.8284 13.5 13V6.85C13.5 6.45218 13.342 6.07064 13.0607 5.78934L9.21066 1.93934C8.92936 1.65804 8.54782 1.5 8.15 1.5Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8.5 1.75V5C8.5 5.55228 8.94772 6 9.5 6H12.75"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** 圆角折角文件本体叠加 DSH 官方加号。 */
export function IconFileAddOutline16({ size = 16, className }: IconProps) {
  return (
    <span
      className={[css.composite, className].filter(Boolean).join(' ')}
      style={{ width: size, height: size }}
      aria-hidden="true"
      data-icon="file-add"
    >
      <IconFileOutline16 size={size} />
      <IconPlusOutlineMedium className={css.addGlyph} size={Math.max(8, Math.round(size / 2))} />
    </span>
  )
}

/** DSH 官方文件夹本体叠加官方加号。 */
export function IconFolderAddOutline16({ size = 16, className }: IconProps) {
  return (
    <span
      className={[css.composite, className].filter(Boolean).join(' ')}
      style={{ width: size, height: size }}
      aria-hidden="true"
      data-icon="folder-add"
    >
      <IconFolderCloseMedium size={size} />
      <IconPlusOutlineMedium className={css.addGlyph} size={Math.max(8, Math.round(size / 2))} />
    </span>
  )
}

/**
 * 数据库圆柱体：SQL 笔记的标记。
 *
 * 不复用文档折角图标，因为这两行菜单要一眼分得开——一个建普通文件，一个建笔记。
 * 中间那道弧线是圆柱体的堆叠线，也是它读起来像数据库而不是卷轴的原因。
 */
export function IconSqlNotebookOutline16({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
      data-icon="sql-notebook"
    >
      <ellipse cx="8" cy="4" rx="4.7" ry="1.7" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M3.3 4v8c0 .94 2.1 1.7 4.7 1.7s4.7-.76 4.7-1.7V4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3.3 8c0 .94 2.1 1.7 4.7 1.7s4.7-.76 4.7-1.7"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** 圆柱体叠加 DSH 官方加号：新建 SQL 笔记。 */
export function IconSqlNotebookAddOutline16({ size = 16, className }: IconProps) {
  return (
    <span
      className={[css.composite, className].filter(Boolean).join(' ')}
      style={{ width: size, height: size }}
      aria-hidden="true"
      data-icon="sql-notebook-add"
    >
      <IconSqlNotebookOutline16 size={size} />
      <IconPlusOutlineMedium className={css.addGlyph} size={Math.max(8, Math.round(size / 2))} />
    </span>
  )
}
