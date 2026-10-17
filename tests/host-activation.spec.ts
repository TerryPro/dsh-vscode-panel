import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.ts'

/** Route registrations the fake Web server received from the plugin. */
function harness() {
  const routes: { kind: string; path: string }[] = []
  const ctx = new Context()
  ctx.provide('logger', { info: () => {}, warn: () => {}, error: () => {} })
  ctx.provide('webServer', {
    host: '127.0.0.1',
    register: (route: { kind: string; path: string }) => {
      routes.push(route)
      return () => {}
    },
  })
  // The plugin reads these through Context merges; none of them is touched while the
  // routes are registered, so empty stand-ins keep the activation honest without a
  // full Host. `webStartup` is the DSH 0.2.1 service that replaced `webRuntime`.
  ctx.provide('fs', {} as never)
  ctx.provide('workspaceRegistry', { get: () => undefined } as never)
  ctx.provide('webStartup', { trustedHosts: [] })
  return { ctx, routes }
}

describe('Host activation contract', () => {
  it('waits for the service DSH 0.2.1 actually provides', () => {
    // DSH 0.2.1 replaced the `webRuntime` service with `webStartup`. Injecting the
    // removed name does not fail the load: the fiber stays pending forever, so the
    // client half still renders while every Host route answers 404/405. Both the
    // loader row (cordis.patch.yml) and this module list must name the live service,
    // and the row is covered by the package-manifest spec.
    expect(plugin.inject).toContain('webStartup')
    expect(plugin.inject).not.toContain('webRuntime')
  })

  it('registers its routes through a real cordis fiber with only 0.2.1 services mounted', async () => {
    // The unit-level shape above cannot prove the fiber leaves `pending`; this boots
    // the real cordis runtime with exactly the services a 0.2.1 Host provides. A
    // stale inject name never resolves here, so awaiting the fiber would time out —
    // which is the failure mode the user saw, reproduced without DSH itself.
    const { ctx, routes } = harness()
    await ctx.plugin(plugin, plugin.Config({}))
    expect(routes.map(route => route.path).sort()).toEqual([
      '/dsh-workbench-layout',
      '/dsh-workbench-layout/kernel',
      '/dsh-workbench-layout/kernel/stream',
      '/dsh-workbench-layout/mermaid-runtime.js',
    ])
    await ctx.fiber.dispose()
  })
})
