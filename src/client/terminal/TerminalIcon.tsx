/** 与 DSH 线性图标体系一致的终端入口图标。 */

import { IconPlusOutlineMedium, type IconProps } from '@deepseek-ai/dsh-client-ui-primitives'
import badge from '../files/CreateEntryIcons.module.css'

export function IconTerminalOutline16({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <rect x="2.25" y="2.75" width="11.5" height="10.5" rx="1.75" stroke="currentColor" strokeWidth="1.25" />
      <path d="M4.5 6L6.25 7.75 4.5 9.5M8 9.5h3" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/**
 * 终端本体叠加 DSH 官方加号：新建终端。
 *
 * 与 `IconFileAddOutline16` / `IconFolderAddOutline16` 共用同一套徽标几何（`CreateEntryIcons` 的
 * `.composite` / `.addGlyph`），而不是另画一份。面板头部的按钮现在与文件面板同排同尺寸，加号若
 * 大小或偏移不同，一排里就会看到两个不一样大的徽标——这正是要消掉的那种不一致。
 */
export function IconTerminalAddOutline16({ size = 16, className }: IconProps) {
  return (
    <span
      className={[badge.composite, className].filter(Boolean).join(' ')}
      style={{ width: size, height: size }}
      aria-hidden="true"
      data-icon="terminal-add"
    >
      <IconTerminalOutline16 size={size} />
      <IconPlusOutlineMedium className={badge.addGlyph} size={Math.max(8, Math.round(size / 2))} />
    </span>
  )
}
