import { describe, expect, it } from 'vitest'
import { route, type RouteHandlers, type RouteParamsOf, type RouteResultOf } from '../src/shared/route.ts'
import { routeIndex } from '../src/host/route-dispatch.ts'
import { CONFIG_PREAMBLE, CONFIG_READ_PATH, CONFIG_ROUTES, CONFIG_WRITE_PATH } from '../src/shared/config-protocol.ts'
import { FILE_ROUTES, GIT_ROUTES } from '../src/shared/contracts.ts'
import { KERNEL_ROUTES } from '../src/shared/notebook-protocol.ts'
import { SQL_ROUTES } from '../src/shared/sql-protocol.ts'
import { WORKBENCH_ROUTES } from '../src/index.ts'

describe('路由表', () => {
  it('把完整路径映射到路由键，没声明的路径查不到', () => {
    const table = {
      configRead: route<Record<string, never>, { fields: string[] }>(CONFIG_READ_PATH),
      fileRead: route<{ workspaceId: string; path: string }, string>('/dsh-workbench-layout/file/read'),
    }
    const index = routeIndex(table)

    expect(index.get(CONFIG_READ_PATH)).toBe('configRead')
    expect(index.get('/dsh-workbench-layout/file/read')).toBe('fileRead')
    // 没声明的路径不命中：宿主据此回答原来的 404。
    expect(index.get('/dsh-workbench-layout/nope')).toBeUndefined()
    expect(index.size).toBe(2)
  })

  it('同一条路径声明两次就报错，不悄悄盖掉一条路由', () => {
    const twice = { a: route('/same'), b: route('/same') }
    expect(() => routeIndex(twice)).toThrow(/declared twice/u)
  })

  it('形状只挂在声明上，运行时读不到它', () => {
    const spec = route<{ workspaceId: string }, number>('/x')
    expect(spec.path).toBe('/x')
    expect(spec.shapes).toBeUndefined()
  })

  it('形状随声明走：参数与回值从声明里取出来', () => {
    const params: RouteParamsOf<typeof CONFIG_ROUTES.readPluginConfig> = {}
    const result: RouteResultOf<typeof CONFIG_ROUTES.readPluginConfig> | undefined = undefined
    expect(params).toEqual({})
    expect(result).toBeUndefined()

    // handler 表的形状：每个键一个 handler，参数与回值都由声明约束。
    const handlers: RouteHandlers<typeof CONFIG_ROUTES> = {
      readPluginConfig: async () => ({ fields: [] }),
    }
    expect(Object.keys(handlers)).toEqual(['readPluginConfig'])
  })

  it('前导路由不进查表，但仍带着形状给客户端用', () => {
    const index = routeIndex(CONFIG_ROUTES)
    expect(index.has(CONFIG_READ_PATH)).toBe(true)
    // 配置写入那条由宿主在路由前导里自己处理，表里没有它。
    expect(index.has(CONFIG_WRITE_PATH)).toBe(false)
    expect(CONFIG_PREAMBLE.updatePluginConfig.path).toBe(CONFIG_WRITE_PATH)
  })

  it('宿主那张表：每个区域的声明都进了表，且同一条路径只出现一次', () => {
    // `routeIndex` 撞到重复路径会报错，所以这一句同时断言了「表里没有两条路由共用一个路径」。
    // 这不是假想的：SQL 与内核曾各自声明一个 `execute`，合并成一张表后先声明的那个会被
    // spread 悄悄盖掉，接口看起来还在、实际调的是另一个后端。
    const index = routeIndex(WORKBENCH_ROUTES)
    expect(index.size).toBe(Object.keys(WORKBENCH_ROUTES).length)

    // 每个区域至少一条：漏掉一个 spread 的代价是整块接口凭空消失。
    const oneOfEach = [
      CONFIG_READ_PATH,
      FILE_ROUTES.listDirectory.path,
      GIT_ROUTES.gitCommit.path,
      SQL_ROUTES.sqlExecute.path,
      KERNEL_ROUTES.kernelExecute.path,
    ]
    for (const path of oneOfEach) expect(index.has(path)).toBe(true)
  })
})
