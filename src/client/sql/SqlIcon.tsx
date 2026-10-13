/** 与 DSH 线性图标体系一致的 SQL 笔记入口图标：圆柱体，一眼是数据库而不是文档。 */

export function IconSqlOutline16({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <ellipse cx="8" cy="3.6" rx="4.6" ry="1.9" stroke="currentColor" strokeWidth="1.25" />
      {/* 柱身与中间那道堆叠线：两笔合起来才是「一叠数据」，只画椭圆会像图钉。 */}
      <path d="M3.4 3.6v8.8c0 1.05 2.06 1.9 4.6 1.9s4.6-.85 4.6-1.9V3.6" stroke="currentColor" strokeWidth="1.25" />
      <path d="M3.4 8c0 1.05 2.06 1.9 4.6 1.9S12.6 9.05 12.6 8" stroke="currentColor" strokeWidth="1.25" />
    </svg>
  )
}
