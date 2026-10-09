/** Platform detection for the labels the workbench renders itself. */

/**
 * Whether the host runs on macOS, so menu rows can print `⌘` where the shell's
 * own bindings use `Ctrl`. DSH's desktop shell marks `<html>` with
 * `data-platform="darwin"`; plain web never sets it, so web falls back to the
 * browser's own platform string.
 */
export function isMacPlatform(): boolean {
  if (document.documentElement.dataset.platform === 'darwin') return true
  return /Mac|iPhone|iPad/iu.test(navigator.platform)
}
