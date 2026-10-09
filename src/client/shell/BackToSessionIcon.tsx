/** 与 DSH 线性图标体系一致的“返回会话”图标（指向左侧的箭头，代表退出当前全局面板）。 */

export function IconBackToSessionOutline16({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M6.5 3.75 2.75 7.5 6.5 11.25"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3.25 7.5h6.1a3.4 3.4 0 0 1 3.4 3.4v.35"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  )
}
