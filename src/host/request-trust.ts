/** DSH-compatible browser trust fence for the workbench Host route. */

import type { IncomingMessage } from 'node:http'

function parseAuthority(authority: string): URL | undefined {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

function canonicalAuthority(entry: string, parsed: URL): string {
  const port = parsed.port !== '' ? parsed.port : new URL(`https://${entry}`).port
  return port === '' ? parsed.hostname : `${parsed.hostname}:${port}`
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/u.test(part) && Number(part) <= 255)
}

function isTrustedAuthority(host: URL, trustedHosts: readonly string[]): boolean {
  return trustedHosts.some((entry) => {
    const trusted = parseAuthority(entry)
    if (trusted === undefined) return false
    return canonicalAuthority(entry, trusted) === trusted.hostname
      ? trusted.hostname === host.hostname
      : trusted.host === host.host
  })
}

/**
 * Whether the request authority names the listener's own bind address.
 *
 * DSH 0.2.1's fence accepts the bind IP independently of `trustedHosts` (a
 * concrete bind IP is no rebinding target), and rejects wildcard binds outright.
 * Mirroring that here keeps a deployment reached by its LAN address working
 * without a `--trusted-host` entry, while the Origin and cross-site checks below
 * still apply. Any `%zone` interface selector is stripped: it is not address text.
 */
function isBindAddressAuthority(host: URL, bindHost: string | undefined): boolean {
  if (bindHost === undefined) return false
  const zoneAt = bindHost.indexOf('%')
  const address = zoneAt === -1 ? bindHost : bindHost.slice(0, zoneAt)
  const bind = parseAuthority(address.includes(':') ? `[${address}]` : address)
  return bind !== undefined && bind.hostname === host.hostname
}

/**
 * Match the official DSH API fence: bind every request to loopback, the
 * listener's bind address, or a deployment-derived trusted Host, then reject
 * explicit cross-site markers.
 */
export function isTrustedWorkbenchRequest(
  headers: IncomingMessage['headers'],
  trustedHosts: readonly string[],
  bindHost?: string,
): boolean {
  const authority = headers.host
  if (typeof authority !== 'string') return false
  const host = parseAuthority(authority)
  if (host === undefined) return false
  if (!isLoopbackHostname(host.hostname)
    && !isTrustedAuthority(host, trustedHosts)
    && !isBindAddressAuthority(host, bindHost)) return false
  if (headers['sec-fetch-site'] === 'cross-site') return false

  const origin = headers.origin
  if (origin === undefined) return true
  if (typeof origin !== 'string') return false
  try {
    return new URL(origin).host === host.host
  } catch {
    return false
  }
}
