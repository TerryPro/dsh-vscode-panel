/** Shared workspace path naming helpers used by both the Host and browser halves. */

/**
 * Return the last segment of a workspace-relative (or absolute) path.
 *
 * Backslashes are normalized to forward slashes first so a Windows-style path
 * still yields its file name. A trailing separator produces an empty string,
 * matching the segment after the final slash.
 */
export function basename(path: string): string {
  const normalized = path.replace(/\\/gu, '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}
