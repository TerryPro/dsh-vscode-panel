import { describe, expect, it } from 'vitest'
import { isTrustedWorkbenchRequest } from '../src/host/request-trust.ts'

describe('workbench browser trust fence', () => {
  it('accepts loopback and deployment-trusted authorities', () => {
    expect(isTrustedWorkbenchRequest({ host: 'localhost:3080' }, [])).toBe(true)
    expect(isTrustedWorkbenchRequest({ host: '127.9.8.7:3080' }, [])).toBe(true)
    expect(isTrustedWorkbenchRequest({ host: '[::1]:3080' }, [])).toBe(true)
    expect(isTrustedWorkbenchRequest(
      { host: 'workbench.example:3080', origin: 'http://workbench.example:3080' },
      ['workbench.example'],
    )).toBe(true)
  })

  it('honors exact-port trusted entries', () => {
    const headers = { host: 'workbench.example:3080', origin: 'http://workbench.example:3080' }
    expect(isTrustedWorkbenchRequest(headers, ['workbench.example:3080'])).toBe(true)
    expect(isTrustedWorkbenchRequest(headers, ['workbench.example:4000'])).toBe(false)
  })

  it('accepts the listener bind address independently of trusted entries', () => {
    // DSH 0.2.1 rejects wildcard binds and accepts the listener's own address in
    // its own fence; a workbench reached by that LAN literal must keep working
    // without an extra --trusted-host entry. Any port matches, like a port-less
    // trusted entry, because the browser dials one authority on any port.
    expect(isTrustedWorkbenchRequest({ host: '10.1.2.3:3080', origin: 'http://10.1.2.3:3080' }, [], '10.1.2.3')).toBe(true)
    expect(isTrustedWorkbenchRequest({ host: '10.1.2.3:4000' }, [], '10.1.2.3')).toBe(true)
    // Another remote literal is still refused: only the configured bind address earns that grant.
    expect(isTrustedWorkbenchRequest({ host: '10.1.2.4:3080' }, [], '10.1.2.3')).toBe(false)
    // An IPv6 bind keeps its brackets on the wire; a zone id is an interface selector, not address text.
    expect(isTrustedWorkbenchRequest({ host: '[fd00::1]:3080', origin: 'http://[fd00::1]:3080' }, [], 'fd00::1')).toBe(true)
    expect(isTrustedWorkbenchRequest({ host: '[fe80::1]:3080' }, [], 'fe80::1%12')).toBe(true)
  })

  it('rejects rebinding, cross-site, opaque, and malformed requests', () => {
    expect(isTrustedWorkbenchRequest({ host: 'untrusted.example' }, [])).toBe(false)
    expect(isTrustedWorkbenchRequest({ host: 'localhost:3080', 'sec-fetch-site': 'cross-site' }, [])).toBe(false)
    expect(isTrustedWorkbenchRequest({ host: 'localhost:3080', origin: 'https://other.example' }, [])).toBe(false)
    expect(isTrustedWorkbenchRequest({ host: 'localhost:3080', origin: 'null' }, [])).toBe(false)
    expect(isTrustedWorkbenchRequest({ host: 'bad host' }, [])).toBe(false)
    expect(isTrustedWorkbenchRequest({}, [])).toBe(false)
  })
})
