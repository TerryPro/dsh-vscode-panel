/** Shell naming for terminal rows and the new-terminal menu. */

/**
 * Shorten the executable name the Host reports (`pwsh.exe`, `cmd.exe`) to the
 * shell's own name, the way a terminal picker labels it. POSIX names have no
 * suffix, so they pass through unchanged.
 * @param name - executable file name from the official terminal model or shell discovery.
 * @returns display label without a trailing `.exe`.
 */
export function shellDisplayName(name: string): string {
  return name.replace(/\.exe$/iu, '')
}
