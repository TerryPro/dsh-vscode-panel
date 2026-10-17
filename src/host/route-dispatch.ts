/**
 * 宿主这一半的路由表：建查表，再按路径调用 handler。
 *
 * 表本身（路径与两个形状）住在 `src/shared/route.ts` 与各区域协议模块里；这里只放宿主
 * 独有的那两件事——把声明变成查表，以及把请求体交给对应的 handler。
 */

import type { RouteHandlers, RouteTable } from '../shared/route.ts'

/** 一张表与它的 handler：宿主按路径查表要用的全部东西。 */
export interface RouteRegistry<T extends RouteTable> {
  readonly index: ReadonlyMap<string, keyof T & string>
  readonly handlers: RouteHandlers<T>
}

/** 由一张表建出「完整路径 → 路由键」的查表，同一条路径声明两次时报出来。 */
export function routeIndex<T extends RouteTable>(table: T): ReadonlyMap<string, keyof T & string> {
  const index = new Map<string, keyof T & string>()
  for (const key of Object.keys(table) as (keyof T & string)[]) {
    const spec = table[key]
    if (spec === undefined) continue
    const existing = index.get(spec.path)
    if (existing !== undefined) {
      throw new Error(`route path declared twice: ${spec.path} (${existing}, ${key})`)
    }
    index.set(spec.path, key)
  }
  return index
}

/**
 * 由一张表与它的 handler 建出查表。
 *
 * 同一条路径被声明两次会在这里报出来：那等于一条路由悄悄盖掉另一条。
 */
export function routeRegistry<T extends RouteTable>(table: T, handlers: RouteHandlers<T>): RouteRegistry<T> {
  return { index: routeIndex(table), handlers }
}

/** 按路径调用表里的 handler；没命中时回报「没这条路由」，由调用方决定报什么。 */
export async function dispatchRoute<T extends RouteTable>(
  registry: RouteRegistry<T>,
  path: string,
  body: Record<string, unknown>,
): Promise<{ readonly found: true; readonly value: unknown } | { readonly found: false }> {
  const key = registry.index.get(path)
  if (key === undefined) return { found: false }
  // 查出来的是运行时键，TS 不能把请求体与那一格声明的参数形状联系起来——形状的作用在
  // 客户端（写错参数名过不了编译）与 handler 表（参数与回值都对着声明检查）两侧。
  const value = await registry.handlers[key](body as never)
  return { found: true, value }
}
