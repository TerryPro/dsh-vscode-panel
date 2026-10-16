import { describe, expect, it } from 'vitest'
import { CancellingRequestFence, RequestFence } from '../src/client/core/request-fence.ts'

describe('请求栅栏', () => {
  it('同一 key 上更新的请求让旧请求过期，不同 key 互不作废', () => {
    const fence = new RequestFence()
    const first = fence.begin({ kind: 'file' }, undefined)
    const second = fence.begin({ kind: 'file' }, undefined)
    expect(fence.isLatest(first)).toBe(false)
    expect(fence.isLatest(second)).toBe(true)

    const other = fence.begin({ kind: 'diff' }, undefined)
    expect(fence.isLatest(second)).toBe(true)
    expect(fence.isLatest(other)).toBe(true)
  })

  it('结构化 key：种类、工作区、路径任一不同就是另一个 key', () => {
    const fence = new RequestFence()
    const base = fence.begin({ kind: 'file', workspaceId: 'ws', path: 'a.ts' }, undefined)
    fence.begin({ kind: 'diff', workspaceId: 'ws', path: 'a.ts' }, undefined)
    fence.begin({ kind: 'file', workspaceId: 'ws2', path: 'a.ts' }, undefined)
    fence.begin({ kind: 'file', workspaceId: 'ws', path: 'b.ts' }, undefined)
    fence.begin({ kind: 'file', workspaceId: 'ws' }, undefined)
    expect(fence.isLatest(base)).toBe(true)

    // 三个字段全同才算同一次请求。
    fence.begin({ kind: 'file', workspaceId: 'ws', path: 'a.ts' }, undefined)
    expect(fence.isLatest(base)).toBe(false)
  })

  it('两种语义各自独立：最旧的请求可以仍匹配当前目标，最新的请求也可以已经换了目标', () => {
    const fence = new RequestFence()
    const token = fence.begin({ kind: 'files.tree', workspaceId: 'ws' }, 'ws')
    const newer = fence.begin({ kind: 'files.tree', workspaceId: 'ws' }, 'ws')
    // 目标没变，身份照旧匹配；算不算数却已经不归它了。
    expect(fence.isLatest(token)).toBe(false)
    expect(fence.matches(token, 'ws')).toBe(true)

    // 反过来：最新的一次请求，目标也可能已经不是它启动时那个。
    expect(fence.isLatest(newer)).toBe(true)
    expect(fence.matches(newer, 'ws2')).toBe(false)
    expect(fence.matches(newer, 'ws')).toBe(true)
  })

  it('forget 之后旧凭证一律过期', () => {
    const fence = new RequestFence()
    const token = fence.begin({ kind: 'file', workspaceId: 'ws', path: 'a.ts' }, 'ws')
    fence.forget({ kind: 'file', workspaceId: 'ws', path: 'a.ts' })
    expect(fence.isLatest(token)).toBe(false)
  })

  it('可取消的栅栏：新请求 abort 上一次信号，cancelAll 把凭证一并作废', () => {
    const requests = new CancellingRequestFence()
    const first = requests.begin({ kind: 'terminal.shells' }, undefined)
    expect(first.signal.aborted).toBe(false)

    const other = requests.begin({ kind: 'terminal.shells', workspaceId: 'ws' }, undefined)
    expect(first.signal.aborted).toBe(false)

    const second = requests.begin({ kind: 'terminal.shells' }, undefined)
    expect(first.signal.aborted).toBe(true)
    expect(second.signal.aborted).toBe(false)
    expect(other.signal.aborted).toBe(false)
    expect(requests.isLatest(second)).toBe(true)

    requests.cancelAll()
    expect(second.signal.aborted).toBe(true)
    expect(other.signal.aborted).toBe(true)
    expect(requests.isLatest(second)).toBe(false)
  })
})
