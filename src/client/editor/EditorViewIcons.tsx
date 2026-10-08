/** 编辑器视图开关图标，沿用 DSH 线性图标体系（stroke=currentColor）。 */

/** 自动换行：整行文字到边后折返下一行（末行带向下回折箭头）。 */
export function IconWordWrapOutline16({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 4h12" />
      <path d="M2 8h7a2.5 2.5 0 0 1 0 5H7.5" />
      <path d="M9 11.5 6.5 13 9 14.5" />
      <path d="M2 13h1.5" />
    </svg>
  )
}

/** 内联差异：左右分栏对比，一侧为删除(−)、一侧为新增(+)。 */
export function IconInlineDiffOutline16({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M8 2.5v11" />
      <path d="M4 8h2.5" />
      <path d="M9.75 8h2.5M11 6.75v2.5" />
    </svg>
  )
}

/** 预览：眼睛图标，表示渲染预览视图。 */
export function IconPreviewOutline16({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M1.8 8S4.3 3.8 8 3.8 14.2 8 14.2 8 11.7 12.2 8 12.2 1.8 8 1.8 8Z" />
      <circle cx="8" cy="8" r="1.9" />
    </svg>
  )
}

/** 分栏：左右两栏并排，表示源码与预览同屏。 */
export function IconSplitViewOutline16({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M8 3v10" />
    </svg>
  )
}

/** 源码：尖括号 </>，表示编辑原始文本。 */
export function IconSourceOutline16({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 5 3 8l3 3" />
      <path d="M10 5l3 3-3 3" />
    </svg>
  )
}

/** 交互：浏览器窗口中带运行三角，表示在沙箱内执行文档自带脚本。 */
export function IconInteractiveOutline16({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M2 5.5h12" />
      <path d="M7 8.4 9.6 9.9 7 11.4Z" />
    </svg>
  )
}

/** 编辑器水平分栏（左右两列）：外框中间一条竖分割线。 */
export function IconSplitHorizontalOutline16({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M8 2.5v11" />
    </svg>
  )
}

/** 编辑器垂直分栏（上下两行）：外框中间一条横分割线。 */
export function IconSplitVerticalOutline16({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M2 8h12" />
    </svg>
  )
}

/** 还原：向左回退的撤销箭头。 */
export function IconRevertOutline16({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3.5 6.5h6a3 3 0 0 1 0 6H6.5" />
      <path d="M6 4 3.5 6.5 6 9" />
    </svg>
  )
}

/** 加粗：粗体字母 B。 */
export function IconBoldOutline16({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6.75 3.5h3.25a2.5 2.5 0 0 1 0 5H6.75z" />
      <path d="M6.75 8.5h3.75a2.75 2.75 0 0 1 0 5.5H6.75z" />
      <path d="M6.75 3.5v10.5" />
    </svg>
  )
}

/** 斜体：带上下衬线的斜线 I。 */
export function IconItalicOutline16({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 3.5h4" />
      <path d="M5 12.5h4" />
      <path d="M9.5 3.5 6.5 12.5" />
    </svg>
  )
}

/** 行内代码：尖括号 </>。 */
export function IconInlineCodeOutline16({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 5.5 3.25 8 6 10.5" />
      <path d="M10 5.5 12.75 8 10 10.5" />
    </svg>
  )
}

/** 链接：两节相扣的链条。 */
export function IconLinkOutline16({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6.75 9.25 9.25 6.75" />
      <path d="M7.75 5.5 8.9 4.35a2.4 2.4 0 0 1 3.4 3.4l-1.15 1.15" />
      <path d="M8.25 10.5 7.1 11.65a2.4 2.4 0 0 1-3.4-3.4l1.15-1.15" />
    </svg>
  )
}

/** 表格：三行三列网格。 */
export function IconTableOutline16({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.5" y="3.5" width="11" height="9" rx="1" />
      <path d="M2.5 6.75h11" />
      <path d="M6.25 3.5v9" />
      <path d="M9.75 3.5v9" />
    </svg>
  )
}

/** 大纲：右侧缩进的层级目录条目，表示文档标题导航面板。 */
export function IconOutline16({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 3.5h11" />
      <path d="M5 7h8.5" />
      <path d="M5 10h8.5" />
      <path d="M2.5 13h9" />
    </svg>
  )
}

/** 结构图：左侧一个卡片分叉连向右侧两个卡片，表示节点关系画布。 */
export function IconGraphOutline16({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.5" y="6" width="4.5" height="4" rx="1" />
      <rect x="10" y="2" width="4.5" height="3.25" rx="1" />
      <rect x="10" y="10.75" width="4.5" height="3.25" rx="1" />
      <path d="M6 8h2a2 2 0 0 1 2-2v-1.5" />
      <path d="M6 8h2a2 2 0 0 0 2 2v2.75" />
    </svg>
  )
}

/** 无序列表：项目符号加行线。 */
export function IconBulletListOutline16({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6.5 4.5h7" />
      <path d="M6.5 8h7" />
      <path d="M6.5 11.5h7" />
      <circle cx="3.5" cy="4.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="3.5" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="3.5" cy="11.5" r="1" fill="currentColor" stroke="none" />
    </svg>
  )
}
