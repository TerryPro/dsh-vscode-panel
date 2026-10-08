/** 16px glyphs for the JSON view's toolbar and canvas controls. */

/** 全部展开：上下两个人字箭头朝外，表示分支打开。 */
export function IconExpandAll16({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4.5 6.5 8 3l3.5 3.5" />
      <path d="M4.5 9.5 8 13l3.5-3.5" />
    </svg>
  )
}

/** 全部收拢：上下两个人字箭头朝内，表示分支合上。 */
export function IconCollapseAll16({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4.5 3 8 6.5 11.5 3" />
      <path d="M4.5 13 8 9.5 11.5 13" />
    </svg>
  )
}

/** 复制值：两张叠放的纸，前面一张带一行文本线。 */
export function IconCopyValue16({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 3.5v-1a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1" />
      <path d="M8 9.5h3" />
    </svg>
  )
}

/** 复制路径：同样的两张纸，前面一张带一个斜杠，表示路径分隔。 */
export function IconCopyPath16({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 3.5v-1a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1" />
      <path d="M8.4 11.6 9.9 8.4" />
    </svg>
  )
}

/** 四向箭头：拖动平移开关。 */
export function IconMove16({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2.5v11M2.5 8h11M8 2.5 6.2 4.3M8 2.5l1.8 1.8M8 13.5l-1.8-1.8M8 13.5l1.8-1.8M2.5 8l1.8-1.8M2.5 8l1.8 1.8M13.5 8l-1.8-1.8M13.5 8l-1.8 1.8" />
    </svg>
  )
}

/** 带格的方框：画布背景网格开关。 */
export function IconGrid16({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" aria-hidden="true">
      <rect x="2.5" y="2.5" width="11" height="11" rx="1" />
      <path d="M6.2 2.5v11M9.8 2.5v11M2.5 6.2h11M2.5 9.8h11" />
    </svg>
  )
}
