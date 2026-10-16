/**
 * 请求栅栏：客户端回答「一个异步结果此刻还算不算数」的唯一一处。
 *
 * 它只记录与比较：工作区、路径与请求种类对它都是被比较的数据，不是它懂的概念。
 * 结果该丢弃、该取消、该不该重发，一概不由它决定。
 */

/** 一次请求的归属键。三个字段都只是数据：栅栏把它们整体比较，不解释含义。 */
export interface RequestFenceKey {
  readonly kind: string
  readonly workspaceId?: string
  /** 这次请求作用的对象标识：路径、标签 id 之类的字符串，由调用方决定。 */
  readonly path?: string
}

/** 一句话的身份：`begin` 时交给栅栏，比较时由调用方把「此刻的身份」传回来。 */
export type RequestIdentity = string | number | undefined

/** 一次请求的凭证：拿它回来问「我还算不算数」。 */
export interface RequestToken {
  readonly key: RequestFenceKey
  readonly id: number
  readonly identity: RequestIdentity
}

/** 记下每个 key 最新的一次请求。 */
export class RequestFence {
  private nextId = 0
  private readonly latest = new Map<string, number>()

  /** 开始一次请求，同时记下它此刻的目标身份（没有身份维度就不传）。 */
  begin(key: RequestFenceKey, identity?: RequestIdentity): RequestToken {
    this.nextId += 1
    const token: RequestToken = { key, id: this.nextId, identity }
    this.latest.set(keyOf(key), token.id)
    return token
  }

  /** 我是不是这个 key 的最新一次请求：同 key 上更新的请求会让我过期，目标相同也一样。 */
  isLatest(token: RequestToken): boolean {
    return this.latest.get(keyOf(token.key)) === token.id
  }

  /**
   * 我启动时那个目标还是当前目标吗。
   *
   * 只比这一个值，与有没有更新的请求无关；比的是值相等，所以离开再回来仍是同一个目标。
   */
  matches(token: RequestToken, identity: RequestIdentity): boolean {
    return token.identity === identity
  }

  /** 忘掉一个 key 的凭证（标签页关闭、组件卸载）：它的旧凭证从此一律过期。 */
  forget(key: RequestFenceKey): void {
    this.latest.delete(keyOf(key))
  }
}

/** 一次可取消的请求：栅栏凭证，加上一个会被同 key 下一次请求 abort 的信号。 */
export interface CancellableToken extends RequestToken {
  readonly signal: AbortSignal
}

/**
 * 需要真取消的调用方用它：同一 key 上新开一次请求，会立刻 abort 上一次的信号。
 *
 * 归属判定仍由内部的栅栏回答；`cancelAll()` 供组件卸载时收尾。
 */
export class CancellingRequestFence {
  private readonly fence = new RequestFence()
  private readonly pending = new Map<string, { key: RequestFenceKey; controller: AbortController }>()

  /** 开始一次可取消的请求。 */
  begin(key: RequestFenceKey, identity?: RequestIdentity): CancellableToken {
    const previous = this.pending.get(keyOf(key))
    previous?.controller.abort()
    const controller = new AbortController()
    this.pending.set(keyOf(key), { key, controller })
    return { ...this.fence.begin(key, identity), signal: controller.signal }
  }

  /** 我是不是这个 key 的最新一次请求。 */
  isLatest(token: RequestToken): boolean {
    return this.fence.isLatest(token)
  }

  /** 我启动时那个目标还是当前目标吗。 */
  matches(token: RequestToken, identity: RequestIdentity): boolean {
    return this.fence.matches(token, identity)
  }

  /** 结束这一轮：abort 每个还在飞的信号，并让它们的凭证一并过期。 */
  cancelAll(): void {
    for (const { key, controller } of this.pending.values()) {
      controller.abort()
      this.fence.forget(key)
    }
    this.pending.clear()
  }
}

/** 把结构化 key 压成一个可比较的字符串。分隔符用 NUL，种类与路径里不会出现它。 */
function keyOf(key: RequestFenceKey): string {
  return [key.kind, key.workspaceId ?? '', key.path ?? ''].join('\0')
}
