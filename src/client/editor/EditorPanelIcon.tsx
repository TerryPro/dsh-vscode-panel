/** 与 DSH 线性图标体系一致的中栏编辑器开关图标（中间色块代表编辑列）。 */

export function IconEditorPanelOutline16({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <rect x="2.25" y="2.75" width="11.5" height="10.5" rx="1.75" stroke="currentColor" strokeWidth="1.25" />
      <rect x="6.75" y="5" width="2.5" height="6" rx="0.75" fill="currentColor" />
    </svg>
  )
}
