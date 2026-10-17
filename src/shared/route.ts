/**
 * 路由表：一条路由在两侧共用的那一处声明。
 *
 * 路径、参数形状、回值形状都写在同一条声明里：客户端照形状写参数（写错名字过不了编译），
 * 宿主照路径查表找到自己的 handler。两个形状只在类型里存在，运行时只带走路径。
 */

/** 一条路由的参数与回值形状。 */
export interface RouteShapes<Params extends object, Result> {
  readonly params: Params
  readonly result: Result
}

/** 一条路由。 */
export interface Route<Params extends object = Record<string, never>, Result = unknown> {
  /** 完整路径：前缀已在各区域协议模块里拼好。 */
  readonly path: string
  /**
   * 参数与回值的形状。
   *
   * 这个字段在运行时永远缺席（`route()` 不填它）：它存在的意义只是把两个形状挂在同一条
   * 路由上，让类型系统把客户端的参数与宿主 handler 的回值都对着它检查。
   */
  readonly shapes?: RouteShapes<Params, Result>
}

/** 声明一条路由。 */
export function route<Params extends object = Record<string, never>, Result = unknown>(
  path: string,
): Route<Params, Result> {
  return { path }
}

/** 一条或一组路由组成的表：区域协议模块各自导出这样一张。 */
export type RouteTable = Record<string, Route<object, unknown>>

/** 取出一条路由的参数形状。 */
export type RouteParamsOf<R> = R extends Route<infer Params, unknown> ? Params : never

/** 取出一条路由的回值形状。 */
export type RouteResultOf<R> = R extends Route<object, infer Result> ? Result : never

/** 宿主每个路由键的 handler：参数由共享形状给出，回值也照它检查。 */
export type RouteHandlers<T extends RouteTable> = {
  [K in keyof T]: (params: RouteParamsOf<T[K]>) => Promise<RouteResultOf<T[K]>>
}
