/**
 * The vocabulary behind the plugin's own settings page.
 *
 * The Host is the only place that knows both the declared schema and the values in
 * force, so it publishes a flat list of field descriptors and the client renders
 * them. Nothing here repeats a number: `default`, `min`, and `max` are read off the
 * `Config` schema at request time, which is what keeps a settings page from
 * promising a value the code no longer uses.
 */

import { WORKBENCH_API_PREFIX } from './contracts.ts'

/** Read the current configuration. */
export const CONFIG_READ_PATH = `${WORKBENCH_API_PREFIX}/config`

/** Apply a new configuration, which restarts the plugin. */
export const CONFIG_WRITE_PATH = `${WORKBENCH_API_PREFIX}/config/update`

/**
 * What a schema declares about one field, narrowed to what the page can use.
 *
 * The host reads these off its own schema and hands them over as plain data, which
 * keeps the settings backend from depending on schemastery's object shape — and keeps
 * a field with no numeric default from being published as `NaN`.
 */
export interface ConfigFieldMeta {
  default?: unknown
  min?: unknown
  max?: unknown
  description?: unknown
}

/** How a value is best shown to a human, without changing what is stored. */
export type ConfigUnit = 'count' | 'ms' | 'bytes'

/** Sections the settings page groups its fields into. */
export type ConfigGroup = 'files' | 'git' | 'kernel-count' | 'kernel-lifecycle' | 'kernel-output' | 'kernel-discovery'

/**
 * What each setting is called and what it bounds, in both languages.
 *
 * This is the single source: the host's `Config` schema reads its `.description()`
 * from here, and the settings page reads both. A description that exists in two
 * places is a description that will eventually disagree — the same class of bug that
 * had the kernel ceilings declared twice with different numbers.
 */
export const CONFIG_FIELDS = {
  maxFileBytes: { title: { zh: '文件大小上限', en: 'Maximum file size' }, description: { zh: '单个文件可打开或保存的最大字节数。超过的文件只报告大小，不会读进内存。', en: 'Largest file that opens or saves, in bytes. A bigger file reports its size instead of loading.' } },
  maxDirectoryEntries: { title: { zh: '目录条目上限', en: 'Directory entries' }, description: { zh: '文件树单层最多列出的条目数，用于挡住 `node_modules` 一类的巨型目录。', en: 'Entries per folder in the file tree, which keeps a `node_modules` from filling it.' } },
  gitTimeoutMs: { title: { zh: 'Git 操作超时', en: 'Git timeout' }, description: { zh: '单次 Git 操作的超时（毫秒）。浅克隆的仓库或慢速网络可以适当放宽。', en: 'Wall clock for one Git operation, in milliseconds. Raise it for slow networks and large repositories.' } },
  gitMaxOutputBytes: { title: { zh: 'Git 输出上限', en: 'Git output limit' }, description: { zh: '单次 Git 操作可回传的最大字节数。差异视图过大时会截断而不是拖住界面。', en: 'Output one Git operation may return, in bytes. A larger diff is truncated rather than blocking.' } },
  gitGraphPageSize: { title: { zh: '提交图每页条数', en: 'Graph page size' }, description: { zh: '提交图每页的提交数。滚动到底部会继续按需加载，加大只是减少请求次数。', en: 'Commits per page of the history graph. Scrolling loads more, so this only sets how many arrive at once.' } },
  kernelStartTimeoutMs: { title: { zh: '内核启动超时', en: 'Kernel start timeout' }, description: { zh: '等待内核打开端口的最长时间（毫秒）。conda 环境或首次导入大量包时可调高。', en: 'How long a kernel may take to open its ports, in milliseconds. Raise it for conda environments or a first heavy import.' } },
  kernelRequestTimeoutMs: { title: { zh: '内核请求超时', en: 'Kernel request timeout' }, description: { zh: '补全、悬停信息等一次内核请求的超时（毫秒）。这些请求不应让界面等待。', en: 'Timeout for one completion or introspection request, in milliseconds. These should never hold the interface.' } },
  kernelMaxPerWorkspace: { title: { zh: '单工作区内核数', en: 'Kernels per workspace' }, description: { zh: '单个工作区同时可运行的内核数。每个笔记本一个内核，超出的新笔记本会启动失败。', en: 'Kernels one workspace may run at once. Each notebook has one, so a new one fails to start past this.' } },
  kernelMaxTotal: { title: { zh: '全局内核总数', en: 'Kernels in total' }, description: { zh: '整个 DSH 进程同时可运行的内核总数。每个内核是一个 Python 进程，请留意内存占用。', en: 'Kernels this process may run at once. Each is a Python process, so this is memory, not tidiness.' } },
  kernelUnattendedTimeoutMs: { title: { zh: '无人查看保留时长', en: 'Unattended lifetime' }, description: { zh: '内核无人查看多久后被自动停止（毫秒）。关闭标签页后想保留变量，就调长它。', en: 'How long a kernel survives its notebook being closed, in milliseconds. Raise it to keep variables available longer.' } },
  kernelReclaimGraceMs: { title: { zh: '回收宽限期', en: 'Reclaim grace' }, description: { zh: '内核管理器允许回收一个刚失联内核前等待的时间（毫秒）。正在刷新的页面与关闭标签在瞬间是同一个样子，这段时间就是给它们的。', en: 'Grace before the kernel manager may reclaim a kernel that just went unattended, in milliseconds. A reloading page looks like a closed tab for a moment.' } },
  kernelReaperIntervalMs: { title: { zh: '回收扫描间隔', en: 'Reclaim sweep' }, description: { zh: '回收检查的间隔（毫秒）。只影响闲置内核最坏情况下的滞留时间。', en: 'How often reclamation is checked, in milliseconds. Only sets how long an idle kernel can linger.' } },
  kernelHeartbeatMs: { title: { zh: '事件流保活间隔', en: 'Stream keepalive' }, description: { zh: '事件流的保活间隔（毫秒）。若中间的代理会掐掉安静的长连接，就调小它。', en: 'Event-stream keepalive interval, in milliseconds. Lower it if a proxy drops quiet connections.' } },
  kernelFrameBuffer: { title: { zh: '重放缓冲帧数', en: 'Replay buffer' }, description: { zh: '每个内核为重放保留的事件帧数。断线后能补回多少输出取决于它；调大即增加宿主内存占用。', en: 'Events kept per kernel for replay, which is how much output a dropped stream can recover.' } },
  kernelMaxOutputChunkChars: { title: { zh: '单个输出块上限', en: 'Output block cap' }, description: { zh: '单个输出块的最大字符数，超出即截断并标注。', en: 'Characters in one output block before it is truncated with a notice.' } },
  kernelMaxOutputRunChars: { title: { zh: '单次运行输出上限', en: 'Run output cap' }, description: { zh: '单个单元格一次运行的最大输出字符数。超出后本次运行的余下输出被丢弃并给出提示。', en: 'Total output characters for one cell run. Past this the rest of the run is dropped with one notice.' } },
  kernelMaxOutputRunFrames: { title: { zh: '单次运行块数上限', en: 'Run block cap' }, description: { zh: '单个单元格一次运行的最大输出块数，与字符上限共同挡住刷屏。', en: 'Output blocks for one cell run, which with the character cap stops a print loop.' } },
  kernelDiscoveryCacheMs: { title: { zh: '内核发现缓存', en: 'Discovery cache' }, description: { zh: '内核发现结果的缓存时间（毫秒）。刚装好 ipykernel 却仍提示不可用时，把它调小或重启内核。', en: 'How long a kernel scan is reused, in milliseconds. Set 0 to re-probe every time after installing ipykernel.' } },
  kernelProbeTimeoutMs: { title: { zh: '解释器探测超时', en: 'Probe timeout' }, description: { zh: '探测一个解释器能否用作内核的超时（毫秒）。慢速磁盘或首次冷启动 conda 时可调高。', en: 'How long one interpreter may take to answer whether it can be a kernel, in milliseconds.' } },
} as const satisfies Record<string, {
  title: { zh: string; en: string }
  description: { zh: string; en: string }
}>

/** Every configuration key, derived from the table so the two cannot drift. */
export type ConfigKey = keyof typeof CONFIG_FIELDS

/** Localized copy for one field. */
export interface ConfigText {
  zh: string
  en: string
}

export interface ConfigFieldDescriptor {
  /** The `Config` key, which is also what the persisted YAML names. */
  key: ConfigKey
  /** The value in force right now. */
  value: number
  /** The schema's declared default, so the page can offer a reset. */
  default: number
  min: number
  max: number
  /** Field label, in both languages. */
  title: ConfigText
  /**
   * What the field bounds, in both languages.
   *
   * Carried as a pair rather than one string because the page renders it as the
   * explanation under each control and the workbench ships two locales: a single
   * string would leave one of them untranslated, and the schema is the only place
   * either copy should live.
   */
  description: ConfigText
  group: ConfigGroup
  unit: ConfigUnit
}

export interface ConfigSnapshot {
  fields: ConfigFieldDescriptor[]
}

export interface ConfigUpdateRequest {
  /** Every field, at the value it should hold. Absent keys keep their default. */
  config: Record<string, number>
}

export interface ConfigUpdateResult {
  /** True when the Host accepted the values and is restarting with them. */
  accepted: boolean
  fields: ConfigFieldDescriptor[]
}
