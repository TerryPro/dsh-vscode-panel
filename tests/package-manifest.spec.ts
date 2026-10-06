import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('published package metadata', () => {
  it('contains both Host and client entries plus an isolated patch row', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      name: string
      repository: { type: string; url: string }
      exports: Record<string, unknown>
      dependencies: Record<string, string>
      peerDependencies: Record<string, string>
      dsh: { bundle: { patch: string }; client: { inject: string[]; platform: string } }
    }
    expect(manifest.name).toBe('@lsq64737/dsh-workbench-layout')
    expect(manifest.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/lsq-dsh-plugins/dsh-workbench-layout.git',
    })
    expect(manifest.exports).toHaveProperty('./client')
    expect(manifest.dependencies['@codemirror/merge']).toMatch(/^\^6\./u)
    expect(manifest.dependencies['@xterm/xterm']).toMatch(/^\^6\./u)
    expect(manifest.peerDependencies['@deepseek-ai/dsh-api-terminal-controller']).toContain('^0.2.0-rc.2')
    expect(manifest.peerDependencies['@deepseek-ai/dsh-api-gateway']).toContain('^0.2.0-rc.2')
    expect(manifest.dependencies['node-pty']).toBeUndefined()
    expect(manifest.dependencies.ws).toBeUndefined()
    expect(manifest.peerDependencies['@deepseek-ai/dsh-workspace']).toBe('^0.1.5-rc.1 || ^0.2.0-rc.2')
    expect(manifest.dsh).toEqual(expect.objectContaining({
      bundle: { patch: './cordis.patch.yml' },
      client: expect.objectContaining({
        inject: expect.arrayContaining(['@deepseek-ai/dsh-client-ui-layout', '@deepseek-ai/dsh-api-terminal-controller']),
        platform: 'web',
      }),
    }))
    const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    expect(patch).toContain('inject: [webRuntime, workspaceRegistry]')
  })

  it('accepts the DSH runtime every dsh peer was built against', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      peerDependencies: Record<string, string>
      dsh: { client: { inject: string[] } }
    }
    // DSH's boot preflight evaluates every @deepseek-ai/dsh* peer against the
    // running version and refuses (or warns about) a plugin whose ranges exclude
    // it, so each range must carry the clause matching the tested runtime.
    const dshPeers = Object.entries(manifest.peerDependencies)
      .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
    expect(dshPeers.length).toBeGreaterThan(0)
    for (const [name, range] of dshPeers) {
      expect(range.split('||').map(clause => clause.trim()), name).toContain('^0.2.0-rc.2')
    }
  })

  it('does not publish personal paths or private-network examples in documentation', async () => {
    const docs = await Promise.all(['README.md', 'README.zh.md'].map(name => readFile(new URL(`../${name}`, import.meta.url), 'utf8')))
    for (const text of docs) {
      expect(text).not.toMatch(/\/(?:home|Users)\//u)
      expect(text).not.toMatch(/[A-Z]:\\/u)
      expect(text).not.toMatch(/(?:localhost|127\.0\.0\.1|192\.168\.)/u)
    }
  })
})
