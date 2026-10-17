import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './CreateEntryIcons.module.css'

/**
 * 新建条目的主标记：文档、文件夹、数据库、终端，四支同一套形制。
 *
 * 这套形制取自 DSH 官方成套图标（`IconProjectAddOutlineMedium`、`FileTypeIcon`）：矩形轮廓 + 填充分面
 * + 1.2 描边，而不是本仓原先那套「细线勾勒 + 右下角加号徽标」。徽标的代价在菜单里一次性付清：菜单行只有
 * 24px 高，`IconPlusOutlineMedium` 那根加号在 8px 时是一小团糊，而徽标那圈描边圆点正好压在文档的折角
 * 上，两者叠成的形状读起来像字母「C」。新建的意思由所在的行文案说（「新建文件」），图标不必再挂一个加号。
 *
 * 每支的 viewBox 都是 16：文件树的 16px 条目、面板头部的按钮与菜单里的这些标记排在同一条竖线上，改
 * viewBox 只会让这一列错位。菜单里该缩到多大由 `CreateEntryIcons.module.css` 的 `.menuIcon` 说。
 */
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
        d="M4 1.5h4.9L13.5 6.1V14a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V2a.5.5 0 0 1 .5-.5Z"
        fill="currentColor"
        fillOpacity="0.14"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      {/* The fold is its own filled wedge rather than a hairline across the corner: a 1.2px
          diagonal is what smudges first when the glyph is scaled down, and it is what turned the
          whole document into a "C" the last time these icons were drawn at a smaller size. */}
      <path d="M9.1 1.7v4.2h4.2L9.1 1.7Z" fill="currentColor" fillOpacity="0.5" />
      <path d="M6.5 8.6h3.6M6.5 11.2h3.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

/** 文件夹：一个填充书脊加一页纸，与文档一样只靠轮廓与填充分面，不再叠徽标。 */
export function IconFolderOutline16({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
      data-icon="folder"
    >
      <path
        d="M1.6 3.4a.9.9 0 0 1 .9-.9h2.6c.24 0 .47.1.64.27L7.1 4.1c.17.17.4.27.64.27h4.86a.9.9 0 0 1 .9.9v8.33a.9.9 0 0 1-.9.9H2.5a.9.9 0 0 1-.9-.9V3.4Z"
        fill="currentColor"
        fillOpacity="0.14"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path d="M1.6 6.3h12.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity="0.55" />
    </svg>
  )
}

/**
 * 数据库圆柱体：SQL 笔记的标记。
 *
 * 与文档、文件夹同一种轻重：轮廓 1.2、内部分面用填充表达。中间那道弧线是圆柱体的堆叠线，也是它读起来
 * 像数据库而不是卷轴的原因。
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
      <path
        d="M11.9 4v8c0 .86-1.75 1.55-3.9 1.55S4.1 12.86 4.1 12V4c0-.86 1.75-1.55 3.9-1.55S11.9 3.14 11.9 4Z"
        fill="currentColor"
        fillOpacity="0.14"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path
        d="M11.9 4c0 .86-1.75 1.55-3.9 1.55S4.1 4.86 4.1 4"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <path
        d="M4.1 8c0 .86 1.75 1.55 3.9 1.55S11.9 8.86 11.9 8"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      {/* The band between the two arcs is the stack line drawn as fill: at menu size a third
          hairline would close the gaps and read as a solid lozenge instead of a cylinder. */}
      <path d="M4.1 4.7a9 3 0 0 0 7.8 0v3.6a9 3 0 0 1-7.8 0V4.7Z" fill="currentColor" fillOpacity="0.22" />
    </svg>
  )
}

/**
 * 文件树「新建文件」行里的空文件标记。
 *
 * 与 `IconFileOutline16` 同一形制，但内容线让位给输入框：这一行紧挨着一根正在闪的光标，多两条灰线只会
 * 让人误以为文件名已经有内容。
 */
export function IconBlankFileOutline16({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
      data-icon="blank-file"
    >
      <path
        d="M4 1.5h4.9L13.5 6.1V14a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V2a.5.5 0 0 1 .5-.5Z"
        fill="currentColor"
        fillOpacity="0.14"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path d="M9.1 1.7v4.2h4.2L9.1 1.7Z" fill="currentColor" fillOpacity="0.5" />
    </svg>
  )
}

/**
 * 终端：面板头部的按钮、折叠轨道、中栏标签都用它。
 *
 * 与上面三支同一轻重，因为它与「新建文件」「新建文件夹」在面板头部同排出现：一支细线图标挨着三支填充
 * 图标，那一排就会看起来像少画了一个。
 */
export function IconTerminalOutline16({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
      data-icon="terminal"
    >
      <rect
        x="1.6"
        y="2.6"
        width="12.8"
        height="10.8"
        rx="1.8"
        fill="currentColor"
        fillOpacity="0.14"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path
        d="M4.6 6.1 6.5 8l-1.9 1.9M8.4 9.9h3"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** 终端叠加新建标记：与文件那两行同一形制、同一尺寸。 */
export function IconTerminalAddOutline16({ size = 16, className }: IconProps) {
  return <IconTerminalOutline16 size={size} className={[css.menuIcon, className].filter(Boolean).join(' ')} />
}

/**
 * 菜单「新建」三行用的同一支标记：文档、文件夹、数据库，尺寸与墨色一致。
 *
 * 三个都以 `size={14}` 交给官方菜单：那边 `.itemIcon` 是 12px 见方，而图标自己又带一个 16 的 viewBox，
 * 因此 14px 的外框在卡片里只剩 10.5px 可见。三支共用 `css.menuIcon` 的 14px 外框，所以同一列里不会出现
 * 一个高一个矮。加号徽标已去掉：新建的意思由行文案说，徽标在 24px 的菜单行里只会糊成一团。
 */
export function IconFileAddOutline16({ size = 16, className }: IconProps) {
  return <IconFileOutline16 size={size} className={[css.menuIcon, className].filter(Boolean).join(' ')} />
}

export function IconFolderAddOutline16({ size = 16, className }: IconProps) {
  return <IconFolderOutline16 size={size} className={[css.menuIcon, className].filter(Boolean).join(' ')} />
}

export function IconSqlNotebookAddOutline16({ size = 16, className }: IconProps) {
  return <IconSqlNotebookOutline16 size={size} className={[css.menuIcon, className].filter(Boolean).join(' ')} />
}
