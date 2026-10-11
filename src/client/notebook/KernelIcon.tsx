/** 与 DSH 线性图标体系一致的内核入口图标：堆叠的节点，表示"一个正在运行的会话"。 */

export function IconKernelOutline16({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="4.1" r="2.1" stroke="currentColor" strokeWidth="1.25" />
      <circle cx="4" cy="11.4" r="2.1" stroke="currentColor" strokeWidth="1.25" />
      <circle cx="12" cy="11.4" r="2.1" stroke="currentColor" strokeWidth="1.25" />
      <path d="M6.7 5.9 5.2 9.5M9.3 5.9l1.5 3.6M6.1 11.4h3.8" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  )
}
