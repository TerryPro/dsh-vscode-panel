# 笔记本功能补齐 · 逐条改动设计稿

针对 [README.zh.md](../README.zh.md) 「笔记本」章节所述能力，对照官方 Jupyter/JupyterLab 与 VS Code Jupyter 插件做过的缺口分析，逐条给出**落点、方案、取舍、测试与风险**。

约定：

- 每条编号 `D<n>`，标注批次（一 = 正确性，二 = 接通已有能力，三 = 交互基线，四 = 新能力）。
- 「落点」是文件与函数级位置；「测试」写清断言落在哪个真实输出面上（AGENTS.md 的交付门槛要求）。
- 涉及内核链路的条目标注 `🔗`，实现后必须重跑 `npm run test:kernel` / `test:example`（见文末「门禁」）。

---

## 批次一 · 正确性

### D1 `nbformat_minor < 5`（无 cell id）的笔记本无法结构化编辑 🔗

**问题**

`parseNotebook` 给缺 id 的单元格合成 `dsh-cell-<index>`，但这个 id **只活在渲染模型里**；`applyNotebookMutation` 走 `cellIndexOf` 在原始 JSON 树上按 `cell['id']` 查找，于是找不到：

```
parsed cell ids: dsh-cell-0 | minor: 4
set-source    -> THREW CELL_NOT_FOUND
set-kind      -> THREW CELL_NOT_FOUND
insert        -> THREW CELL_NOT_FOUND
clear-outputs -> THREW CELL_NOT_FOUND
move / delete -> OK          （这两个按 index 操作，所以看起来「还能用」）
```

实测自构建产物 `lib/types/client/notebook/notebook-document.js`，输入是 `nbformat_minor: 4`、cell 无 `id` 的文档。后果有两层：

1. 这类笔记本一打开就改不了任何一格 —— `mutate()` 没有 try/catch，异常从 CodeMirror 的 `updateListener` 里抛出。
2. 跑完的单元格输出被 `commitRunOutputs` 的 `instanceof NotebookEditError` 静默吞掉 → **输出丢了，界面上看不出来**。

GitHub 上大量真实笔记本是 minor 4 或更早（Jupytext、老 papermill、手工文件），所以这不是边角。现有 `tests/notebook-document.spec.ts:99-103` 只断言了 parse 侧合成 id，没把 mutation 路径连上测，因此覆盖率为 0。

**落点**

- [src/client/notebook/notebook-document.ts](../src/client/notebook/notebook-document.ts)：`parseNotebook`（第 223 行的合成 id）、`editNotebook`（第 272 行）、`cellIndexOf`（第 317 行）。

**方案：首次结构化编辑时把 id 规范化进树（normalize-on-edit）**

```ts
/**
 * 单元格 id 的唯一算法。parse 侧与写盘侧必须是同一个函数：run state 里的
 * cellId 来自渲染模型，一旦两处推导不一致，输出就找不到落点——而这种错位
 * 的表现是「跑完什么都没写进去」，不是报错。
 */
export function syntheticCellId(index: number): string {
  return `dsh-cell-${index}`
}

/**
 * 把缺 id 的单元格补上 id，并在真的补过之后把 nbformat_minor 提到 5。
 *
 * 只在编辑入口跑，不在 parse 跑：parse 是纯读，打开一个只读笔记本不应该
 * 让文件产生 diff。而一旦用户改了任何一格，写出的文件就必须带 id ——
 * nbformat 4.5 起 id 是必需的，Jupyter 自己也这么写。
 */
function ensureCellIds(value: Record<string, unknown>): boolean {
  const cells = value['cells']
  if (!Array.isArray(cells)) return false
  let added = false
  cells.forEach((candidate, index) => {
    if (!isRecord(candidate)) return
    const id = candidate['id']
    if (typeof id === 'string' && id !== '') return
    candidate['id'] = syntheticCellId(index)
    added = true
  })
  if (!added) return false
  value['nbformat'] = Math.max(NBFORMAT_MINIMUM, typeof value['nbformat'] === 'number' ? value['nbformat'] : NBFORMAT_MINIMUM)
  const minor = typeof value['nbformat_minor'] === 'number' ? value['nbformat_minor'] : 0
  value['nbformat_minor'] = Math.max(minor, 5)
  return true
}
```

`editNotebook` 里在 `apply(value, format)` 之前调 `ensureCellIds(value)`。`parseNotebook` 改用 `syntheticCellId(index)`，删掉内联字面量。

被排除的替代方案：让 `cellIndexOf` 在找不到 id 时按 `dsh-cell-<index>` 回退去解析索引 —— **不安全**。索引会随 insert/delete/move 变化，而一次 run 的 `cellId` 必须跨越这些操作保持稳定（`notebook-runtime.ts` 的队列正是在 run 期间按 id 找格）。

**测试**

- `tests/notebook-document.spec.ts`
  - 无 id 文档（minor 4）：`applyNotebookMutation(text, { op: 'set-source', cellId: parseNotebook(text).cells[0]!.id, source })` **不抛**，且输出 JSON 里该 cell 有 `id`、`nbformat_minor >= 5`。
  - 同一文档连做两次编辑：第二次不再新增 id（幂等）。
  - 混合文件（部分有 id）：已有 id 一律不动。
  - 全链路形状：`{ op: 'set-outputs' }` 对无 id 文档能把 outputs 写进原 cell。
- `tests/notebook-runtime.spec.ts`：`commitRunOutputs` 在无 id 文档上**确实**调用了 `bridge.setDraft`（现在会被吞，等于零断言）。
- 🔗 `scripts/probe-example.mjs` 不变；但新增一个 `examples` 之外的 minor-4 临时文档进 `probe-kernel.mjs`：跑一格、断言输出写回文件。（可选，D1 的单元测试已经把逻辑封死，探针优先保 stdin/rich 路径。）

**风险与兼容**：唯一可见副作用是「老笔记本一编辑就多了 id 字段和 minor=5」。这是 nbformat 的正规形状，Jupyter 打开无差异。

---

### D2 stdin 通道缺失 → 单元格里的 `input()` 会卡死内核 🔗（严重度最高）

**问题**

`execute_request` 里写了 `allow_stdin: true`（[kernel-session.ts:322](../src/host/kernel/kernel-session.ts)），而 `input_request` 是在 **shell 通道**的 handler 里解析的（第 603-618 行）。但按协议，`input_request` 由内核发在 **stdin(ROUTER) 通道**上：

> **stdin**: this ROUTER socket is connected to all frontends, and it allows the kernel to request input from the active frontend when `raw_input` is called. The frontend that executed the code has a DEALER socket that acts as a 'virtual keyboard' for the kernel.
> The stdin socket of the client is **required to have the same zmq IDENTITY as the client's shell socket**.
> —— [Jupyter messaging spec](https://jupyter-protocol.readthedocs.io/en/latest/messaging.html)

ipykernel 的实现同样如此：`_input_request()` 用 `self.session.send(self.stdin_socket, "input_request", content, parent, ident=ident)` 发出，然后阻塞在 `zmq.select([self.stdin_socket])` 等回包。

而 `connectChannels` 只建了 shell / iopub / control 三个 socket —— `stdin_port` 在连接文件里分配了（`prepareConnectionFile` 写了 5 个端口），却没有任何 socket 连上去。同时 `zmtp.ts` 的 `readyFrame` 恒发**空 Identity**（第 80-87 行），即使建了 stdin socket，`ident = self._parent_ident["shell"]` 也是空的，ROUTER 无法路由回来。

结果：单元格调用 `input()` → 内核把消息塞进自己 ROUTER 的空队列 → 宿主永远收不到 → 前端不出现输入框 → **该 run 永久 pending**，只能中断。README 第 92 行把「停在 `input()` 上的单元格会给出输入框」写成卖点，而它只有 reducer 级假帧测试（`notebook-model.spec.ts:132`、`notebook-surface.spec.tsx:203`），`probe-scenarios.mjs` 里没有任何 input 场景 —— 典型的「假帧测过了，真链路没测」。

**落点**

- [src/host/kernel/zmtp.ts](../src/host/kernel/zmtp.ts)：`ZmtpSocketOptions`、`readyFrame`。
- [src/host/kernel/kernel-session.ts](../src/host/kernel/kernel-session.ts)：`connectChannels`、`receiveShell`（新增 `receiveStdin`）、`replyInput`、`stop`、`fail`、`KernelEndpoints`。

**方案**

1. **ZMTP identity 可设**

```ts
export interface ZmtpSocketOptions {
  host: string
  port: number
  socketType: ZmtpSocketType
  /**
   * ZMTP READY 的 Identity 属性。DEALER 连 ROUTER 时必须带非空 identity，否则
   * 对端的 ROUTER 没有可路由的名字：ipykernel 正是用 shell 连接的 identity 作
   * 为 `input_request` 的投递目标，所以 shell 与 stdin 必须报同一个值。
   */
  identity?: string
  subscriptions?: readonly string[]
  signalTimeoutMs?: number
}

function readyFrame(socketType: ZmtpSocketType, identity: string): Buffer {
  return commandFrame(Buffer.concat([
    Buffer.from([5]),
    Buffer.from('READY', 'latin1'),
    readyProperty('Socket-Type', socketType),
    // libzmq 的 NULL 握手要求 Identity 存在；有值才谈得上路由。
    readyProperty('Identity', identity),
  ]))
}
```

默认（`identity` 未传）保持 `''`，即现有 shell/iopub/control 行为不变 —— 降低风险。

2. **session 里加第四通道**

```ts
interface KernelEndpoints {
  ip: string
  shellPort: number
  iopubPort: number
  stdinPort: number      // 新增
  controlPort: number
}

/** shell 与 stdin 共用的 ZMTP identity：input_request 靠它找回本前端。 */
private readonly clientIdentity = randomUUID()
```

`connectChannels` 里：`waitForPort` 增加 stdin 端口（kernel 的 ROUTER 也 bind 端口，等得到）；建

```ts
const stdin = new ZmtpSocket({
  host: endpoints.ip,
  port: endpoints.stdinPort,
  socketType: 'DEALER',
  identity: this.clientIdentity,
})
stdin.on('message', frames => { this.receiveStdin(frames) })
stdin.on('close', error => { if (!this.stopping) this.fail(error?.message ?? 'the kernel stdin channel closed') })
this.stdin = stdin
```

shell 用同一个 `identity: this.clientIdentity` 建（这是让 `ident` 非空的必需一步）。

`receiveStdin`：解 `input_request` → 存 `this.inputRequest = message` → publish `{ type: 'input_request', ... }`；其它类型忽略。`receiveShell` 的 `input_request` 分支**保留**（某些内核实现会发在 shell；留着是纯兼容，不会双重触发，因为 `replyInput` 之后 `inputRequest` 置 null）。

`replyInput` 改发 stdin：

```ts
const socket = this.stdin?.usable === true ? this.stdin : this.requireSocket(this.shell, 'shell')
```

`stop()` / `fail()` 的 socket 数组加 `this.stdin`；`bridgeCommand`/连接文件不动。

3. **把 stdin 变成常驻门禁**

[scripts/probe-scenarios.mjs](../scripts/probe-scenarios.mjs) 新增 `scenarioInput`：

```js
/** 内核的 input() 必须变成前端的一次问答，而不是把 run 卡死。 */
export async function scenarioInput(client, check) {
  const before = client.stream.lastSequence()
  await client.post('/execute', { ...client.handle, code: 'name = input("who? ")', cellId: 'c9' })
  const asked = await until(() => client.stream.state.frames.find(f => f.type === 'input_request' && f.cellId === 'c9'), 15_000)
  check('input() reached the frontend as an input_request', asked !== undefined, String(asked?.prompt))
  check('the prompt text survived the wire', asked?.prompt === 'who? ', String(asked?.prompt))
  const answered = await client.post('/input', { ...client.handle, value: 'ada' })
  check('the answer was accepted', answered.status === 200 && answered.value?.accepted === true)
  check('the parked cell finished after the answer', await settled(client, 'c9', 30_000))
  const readBack = await run(client, 'name', 'c10')
  const item = client.stream.forCell('c10', 'cell_output').map(f => f.item).find(i => i?.kind === 'execute_result')
  check('the value typed at the prompt landed in the namespace', item?.data?.['text/plain'] === "'ada'", String(item?.data?.['text/plain']))
  // getpass 走同一条通道，但必须标成密码
  await client.post('/execute', { ...client.handle, code: 'import getpass\ngetpass.getpass("pw: ")', cellId: 'c11' })
  const pw = await until(() => client.stream.forCell('c11', 'input_request').at(-1), 15_000)
  check('getpass asked for a password', pw?.password === true)
  await client.post('/input', { ...client.handle, value: 'x' })
  await settled(client, 'c11', 30_000)
}
```

并在 [probe-kernel.mjs](../scripts/probe-kernel.mjs) 的场景序列里挂上（放在 `scenarioIntrospection` 之后、`scenarioPoll` 之前）。`notebookBody()` 要补 `c9`/`c10`/`c11` 三个空 cell 作为 id 载体。

4. **示例笔记本也要覆盖**（否则 `test:example` 仍是「假设」）

`examples/python_data_analysis/sales_notebook.ipynb` 增加一格 `answer = input(...)`；[probe-example.mjs](../scripts/probe-example.mjs) 的循环里像现在特判 `time.sleep` 那样特判：

```js
const wantsInput = /\binput\(|getpass\.getpass\(/u.test(cell.source)
if (wantsInput) {
  // 等 input_request，然后回答 —— 否则这一格永远不完成。
  ...
}
```

**取舍**：不实现 stdin 通道、把 `allow_stdin` 改成 `false`，也能让「卡死」变成「明确报错」，代价 3 行。但那会让 README 那条卖点变成错误描述，且 `getpass`/`pwd` 一类交互全部退化。**建议实现完整通道**；如果你想先止血，可以第一步只做 `allow_stdin: false` + locales 里一句「此工作台暂不支持 `input()`」，第二步再补通道（两种顺序我都写成可独立交付的）。

**测试**：上面探针（真链路）+ `tests/notebook-kernel-protocol.spec.ts` 新增 `readyFrame` 带 identity 时的**字节形状**断言（这一条纯单测能测到真实输出面：解析回的 READY 属性里 `Identity` 必须是我们给的值）。

---

### D3 `update_display_data` 污染写出的 `.ipynb`，且不看 `display_id` 🔗

**问题（两点）**

1. 替换策略是「永远替换最后一个 item」（[notebook-model.ts:376-380](../src/client/notebook/notebook-model.ts)），而不是按 `metadata.transient.display_id` 匹配。单条 tqdm 恰好没事；**两条并列进度条**、或「先 print 再 update」会覆盖错对象。宿主侧根本没读 `transient`（`display_data` 分支只取 `data`/`metadata`），所以客户端也拿不到 id。
2. `notebookOutputToRecord` 原样写出 `output_type: "update_display_data"`（[notebook-document.ts:181-182](../src/client/notebook/notebook-document.ts)）。nbformat v4 schema 只允许 `stream` / `display_data` / `execute_result` / `error`；`update_display_data` 是**运行期消息，不落盘**，Jupyter 保存的 notebook 里从不含它。结果：**本工作台保存过的笔记本在 Jupyter / VS Code 里打开会撞上不认识的 output 类型**。这与 README 第 85 行「`.ipynb` written by this workbench opens unchanged in Jupyter」直接冲突。

**落点**

- `notebook-document.ts`：`readOutputs`、`notebookOutputFromRecord`、`notebookOutputToRecord`。
- `notebook-model.ts`：`appendOutputItem`。
- `kernel-session.ts`：`display_data` / `update_display_data` 分支透传 `transient.display_id`。
- `notebook-protocol.ts`：`NotebookOutputItem` 的 `display_data` 变体加 `displayId?: string`。

**方案**

```ts
// kernel-session.ts：spec 里 transient 与 data/metadata 平级
case 'display_data':
case 'update_display_data': {
  const transient = isRecord(content['transient']) ? content['transient'] : undefined
  const displayId = typeof transient?.['display_id'] === 'string' ? transient['display_id'] : undefined
  this.publishOutput(msgId, cell, {
    kind: type === 'update_display_data' ? 'update_display_data' : 'display_data',
    data: bundle(content['data']),
    metadata: bundle(content['metadata']),
    ...(displayId === undefined ? {} : { displayId }),
  })
  return
}
```

```ts
// notebook-model.ts：按 display_id 定位，找不到就追加（Jupyter 语义的保守版）
if (item.kind === 'update_display_data') {
  const asDisplay: NotebookOutputItem = { kind: 'display_data', data: item.data, metadata: item.metadata, ...id }
  if (item.displayId === undefined) { /* 退回旧的「替换最后一项」，兼容无 id 的老内核 */ }
  else {
    const index = lastIndexIf(outputs, o => o.displayId === item.displayId)
    if (index < 0) return [...outputs, asDisplay]
    return [...outputs.slice(0, index), asDisplay, ...outputs.slice(index + 1)]
  }
}
```

```ts
// notebook-document.ts：落盘只写 nbformat 认识的形状
case 'update_display_data':
  // nbformat 里没有 update_display_data：它是运行期的重绘消息。写成 display_data
  // 是 Jupyter 自己的做法，也是「本工作台保存的文件能被别的前端打开」的前提。
  return { output_type: 'display_data', data: item.data, metadata: item.metadata }
```

读取侧：`notebookOutputFromRecord` 的 `'update_display_data'` case 保留（容忍外部文件里已存在的脏数据），但立即归一成 `display_data`，不再产生 `update_display_data`。

`displayId` 是运行期字段 → `notebookOutputToRecord` 必须丢弃它（写进 `metadata` 也不对，会污染 Jupyter 的 metadata 语义）。

**测试**

- `tests/notebook-model.spec.ts`：两条 `displayId` 不同的 `update_display_data` 交替更新 → 各自只改自己那条（**关键回归**，现在的形状必红）；无 `displayId` 时仍替换最后一项（旧行为不回归）；`displayId` 首次出现时追加而非覆盖。
- `tests/notebook-document.spec.ts`：`set-outputs` 写一条 `update_display_data` → 文件里 `output_type === 'display_data'` 且**不含** `displayId`；读一个含 `display_data` 的文件仍得 `display_data`。
- 🔗 `scenarioRich` 扩展（纯 IPython 内置 API，不引第三方依赖）：

```python
from IPython.display import display, HTML
display(HTML('<p>a</p>'), display_id='bar-a')
display(HTML('<p>b</p>'), display_id='bar-b')
from IPython.display import update_display
update_display(HTML('<p>A2</p>'), display_id='bar-a')
```

断言：最终 `cell_output` 里 `bar-a` 被就地更新、`bar-b` 不受影响、且两条 `displayId` 都在帧上。

---

### D4 `Ctrl+Shift+Enter` 实际跑的是「当前格」，README 说「运行全部」

**问题**：[NotebookSurface.tsx:312-316](../src/client/notebook/NotebookSurface.tsx) 判定的是 `modifier && event.altKey && event.shiftKey`，所以纯 `Ctrl/Cmd+Shift+Enter` 落到末尾的 `if (event.key === 'Enter')` → `runFocused()`。README 两份都写着 `Ctrl+Shift+Enter` = 运行全部。

**方案**：修代码（README 是意图，实现是笔误），并把判定顺序写成互斥分支：

```ts
if (!modifier) return
if (event.altKey && event.shiftKey && event.key === 'Enter') { /* Ctrl+Alt+Shift+Enter：留给「重启并运行全部」，见 D18 */ }
else if (event.altKey && event.key === 'Enter') { /* 运行并在下方新建 */ }
else if (event.shiftKey && event.key === 'Enter') { /* 运行全部 */ }
else if (event.key === 'Enter') { /* 运行当前 */ }
```

同时保留现有「无 modifier 的 `Shift+Enter` 运行当前格」（Jupyter 语义）。这条要在注释里说明为什么顺序重要：`Ctrl+Shift+Enter` 与 `Ctrl+Alt+Enter` 都带 `Enter`，先判哪个就赢。

**测试**：`tests/notebook-surface.spec.tsx` 现有快捷键只覆盖了 `Ctrl+Enter`。补三条真实断言：`Ctrl+Shift+Enter` → `api.kernelExecute` 被调用 N 次（按文档里的 code 格数）、`Ctrl+Alt+Enter` → 1 次 + `onEdit` 收到一个新增 cell、`Ctrl+Alt+Shift+Enter`（D19 落地后再加）。

---

### D5 刷新/重连后：不能中断正在跑的格，`In[n]` 归零，language 回落

**问题**

- 中断按钮的 disabled 依据**本地** `state.cells`（[NotebookSurface.tsx:816, 841-850](../src/client/notebook/NotebookSurface.tsx)）。reload 后 runtime 新建、`cells` 为空 → README 承诺「刷新页面不会打断正在执行的单元格」成立，但**刷新后没有任何按钮能停它**。
- `KernelConnection` 从 SSE `snapshot` 拿到 `executionCount` / `language`、从 poll 拿到 `executionCount`，却只把 `phase` 交给 handler（[kernel-connection.ts:159-167, 217-221](../src/client/notebook/kernel-connection.ts)）。所以状态栏的 `In[12]` reload 后归零、单元格高亮回落 python —— 都是「界面报出一个已经存在的事实为不存在」。
- `runElapsedMs` / `activeRunCellIds` / `hasActiveRun` 是导出但**无人调用**的死 API；「跑久了还是卡住了」这件事现在没有任何读数。

**方案**

1. handlers 增一条通道：

```ts
export interface KernelConnectionHandlers {
  // …现有
  /** 传输握手带回来的内核事实（执行计数、语言），reload 后据此重建读数。 */
  facts(next: { phase: KernelPhase; executionCount?: number; language?: KernelLanguage }): void
}
```

`snapshot` 与 `verifyByPolling` / `pollNow` 都调用它。runtime 侧新增 action `{ type: 'session-facts', executionCount?, language? }` —— **只写 kernel 字段，绝不清 cells**（不能复用 `kernel`/`session` action，那两个会 `cells: {}` 把在跑的 run 抹掉）。

2. 中断条件：

```ts
const canInterrupt = running || state.kernel.phase === 'busy'
```

3. 运行时长：`startedAt` 不进 `NotebookCellRunState`（model 保持无时钟纯函数，`applyFrame` 才可测），改由 `NotebookRuntime` 记 `Map<cellId, number>`，暴露 `runStartedAt(tabId, cellId)`；单元格 header 用 `useNow(1000)`（[KernelPanel.tsx:31-39](../src/client/notebook/KernelPanel.tsx) 里已有同款 hook，抽到 `src/client/core/use-now.ts` 共用）+ `runElapsedMs` 渲染 `运行中 · 12s`。超过阈值（如 30s）用 warn 色。

**测试**

- `tests/notebook-connection.spec.ts`：fake EventSource 发一个带 `executionCount: 7` / `language: {name:'r'}` 的 snapshot → 断言 `facts` 被调用且值正确；poll 路径同理（这条覆盖的是「真实返回面」，不是拼参数）。
- `tests/notebook-kernel-status.spec.tsx`：cells 为空但 `executionCount=7` → 仍显示 `In[7]`。
- `tests/notebook-surface.spec.tsx`：`kernel.phase === 'busy'` 且无任何本地 run → 中断按钮**可用**。

---

### D6 宿主产出的英文原因/提示直接进 UI（违反仓库文案红线）

**问题**：AGENTS.md 要求所有面向用户的字符串走 `locales.ts` 且中英对等。但以下英文散文穿过契约直接渲染：

- [discovery.ts](../src/host/kernel/discovery.ts)：`'this workbench launches Python kernels only'`、`'this kernel names no interpreter this machine can run'` → 进 `<option>` 文本与 `choice.reason`。
- [kernel-backend.ts:233-235](../src/host/kernel-backend.ts)：`'no Python interpreter was found for this workspace; install Python, or add a .venv to the workspace.'`、`'no Python environment here has ipykernel installed; run: python -m pip install ipykernel'` → 进 `state.kernel.message` → 渲染进 tooltip（[NotebookSurface.tsx:899-905](../src/client/notebook/NotebookSurface.tsx)）。
- 内核 `phase.message`（启动失败时是内核 stderr 的一行，含 Python 报错文本）：这是**诊断**，不是文案，保持原样合理。

**方案：宿主回 code，客户端出文案**

```ts
// shared/notebook-protocol.ts
/** 为什么某个内核在这里起不来：宿主只报类别，文案属于客户端。 */
export type KernelReason =
  | 'python-only'
  | 'no-interpreter'
  | 'ipykernel-missing'
  | 'launcher-missing'
  | 'probe-timeout'

export interface KernelChoice {
  // …
  available: boolean
  reason?: KernelReason
  /** 诊断文本，只进 title，不进 label；不得含宿主绝对路径。 */
  detail?: string
}

/** 「这个工作区跑不了笔记本」的一句话原因，同样是 code。 */
export type KernelNotice = 'no-interpreter' | 'no-ipykernel'

export interface KernelDiscoverResult {
  usable: boolean
  kernels: KernelChoice[]
  environments: KernelEnvironment[]
  notice?: KernelNotice
  /** 供文案插值的数字事实，不是消息。 */
  interpreterCount?: number
  environmentCount?: number
}
```

locales 新增（中英同步）：

| key | zh | en |
| --- | --- | --- |
| `notebook.reasonPythonOnly` | 本工作台只启动 Python 内核 | this workbench launches Python kernels only |
| `notebook.reasonNoInterpreter` | 这台机器上跑不了它写明的解释器 | its interpreter cannot be run on this machine |
| `notebook.reasonIpykernelMissing` | 未安装 ipykernel | ipykernel is not installed |
| `notebook.reasonLauncherMissing` | 缺少 ipykernel_launcher | ipykernel_launcher is missing |
| `notebook.reasonProbeTimeout` | 探测超时 | the probe timed out |
| `notebook.noticeNoInterpreter` | 这个工作区没找到 Python 解释器；安装 Python，或在工作区里加一个 `.venv`。 | No Python interpreter for this workspace; install Python, or add a `.venv` to the workspace. |
| `notebook.noticeNoIpykernel` | 这里没有装 ipykernel 的 Python 环境，运行：`python -m pip install ipykernel` | No Python environment here has ipykernel installed; run `python -m pip install ipykernel`. |

渲染侧：`NotebookToolbar` 的 `<option>` 用 `t(choice.reason)`；`kernelTitle()` 遇到 `notice` code 时用 `t()`，**其它** `message`（内核诊断）原样作 title —— 这条边界要在注释里写明：类别 → 文案，事实 → 原样。

**边界（明确不做）**：`WorkbenchHttpError` 的 message 保持中文硬编码，与文件/Git 接口一致（`http.ts` 里 `publicFailureMessage` 就是这个形状）；本轮不把整套错误码国际化，只把**会显示给用户看的分类信息**改成 code。设计稿把它记为已知不一致，避免看起来像遗漏。

**测试**

- `tests/kernel-backend.spec.ts` / `notebook-surface.spec.tsx`：断言 `kernels[i].reason` 属于 code 联合（不能是散文）；`discover` 不可用时 result 带 `notice` 而非 `message`。
- `tests/locales.spec.ts` 新增的「每个 key 必须被消费」断言（机制见 D17，本条只定 code 词汇表）：

```ts
/**
 * notebook.* 与 kernels.* 前缀的每个 key 都必须被消费。
 * 这两个前缀是笔记本功能的全部文案，AGENTS.md 要求新增要同时写两边，
 * 而两边都写了却没人用的 key 只会让下一位读者以为「那个功能已经有了」。
 */
it('every notebook and kernel string is used by the client', async () => { …扫描 src/client/**… })
```

> 只做这两个前缀，不做全表：其余前缀有历史欠账，一次铺开会把无关模块拖进这个改动里。

新 spec 若单独成文件，必须加进 `tsconfig.test.json` 的 `files` 白名单。

---

### D7 `notebook.oversized` 是一条几乎不可达的死分支

**问题**：`MAX_STRUCTURED_NOTEBOOK_BYTES = 8 MiB`，而 `maxFileBytes` 默认 2 MiB；宿主在 `/file/read` 就 413 了（[workspace-backend.ts:93-100](../src/host/workspace-backend.ts)）。默认配置下客户端永远拿不到 >8MiB 的文本 → `notebook.oversized` 文案永不出现。这正是 AGENTS.md 禁止的「设置页说一套、代码执行另一套」的邻居问题：**文案描述了一个界面永远走不到的状态**。

**方案：结构化视图的上限成为一等配置，并与宿主读取上限挂钩**

1. 客户端导出常量供宿主读（**默认值不得两处声明**）：

```ts
// notebook-document.ts
/** 笔记本视图的结构化编辑上限；作为 `notebookMaxStructuredBytes` 的默认值。 */
export const NOTEBOOK_STRUCTURED_MAX_BYTES = 4 * 1024 * 1024
```

2. `Config` 新增 `notebookMaxStructuredBytes`：`min = 64 KiB`、`max = maxFileBytes 的上限（16 MiB）`、`default = NOTEBOOK_STRUCTURED_MAX_BYTES`；`CONFIG_FIELDS` 加中英 title/description（要点：「超过此大小的笔记本只读不绘单元格；调高它会增加浏览器解析整个 JSON 的成本」）。`src/index.ts` 把它传给一个客户端可读的位置 —— 现有 `readPluginConfig()` 已经返回全部字段，客户端直接复用，无需新接口。
3. `parseNotebook(text, limitBytes = NOTEBOOK_STRUCTURED_MAX_BYTES)`：客户端在 `EditorTabBody` 把 controller 缓存的配置值传进来（controller 在挂载时读一次 `/config`）。
4. 提示文案补一句「为什么」：`notebook.oversized` 改为「此笔记本超过单元格视图的上限（{bytes}），请改用源码视图」，带 `{bytes}` 占位符 → `locales.spec.ts` 的占位符一致性断言会自动看守。

**测试**

- `tests/plugin-config.spec.ts`（已有「设置页显示值 == 代码常量」的锁死测试）扩展覆盖新字段。
- `tests/notebook-document.spec.ts`：`parseNotebook(huge, 100).oversized === true`、`parseNotebook(huge).oversized` 仍按导出常量 —— 证明上限可注入，而不是把 8MiB 换成另一个魔数。

---

## 批次二 · 接通已经存在的能力（收益/成本比最高）

### D8 单元格补全与悬停：三层接口都通，UI 一个调用都没有

**现状**：`/complete`、`/inspect`、`/is-complete` 在 [index.ts:420-425](../src/index.ts) 注册、[api.ts:267-294](../src/client/model/api.ts) 有方法、宿主 `kernel-backend.ts:406-472` 已实现并向内核发请求、`probe-scenarios.mjs:scenarioIntrospection` 已经用真 ipykernel 验证过回答正确。**唯一缺的是客户端调用点**（全仓 `grep kernelComplete|kernelInspect|kernelIsComplete` 只命中 api.ts 的定义）。所以现在单元格里既没有 Tab 补全也没有 docstring 悬停 —— 而这是「像不像一个真笔记本」的第一体感。

**落点**

- 新：`src/client/notebook/cell-introspection.ts`
- 改：[src/client/editor/editor-setup.ts](../src/client/editor/editor-setup.ts)（补全可注入）、[CodeEditor.tsx](../src/client/editor/CodeEditor.tsx)（透传扩展）、`NotebookSurface.tsx`（组装）

**方案**

1. `editor-setup.ts` 把 preset 变成带选项的工厂，保持零参行为不变：

```ts
export interface EditorSetupOptions {
  /**
   * 用自己的补全源替换 CodeMirror 的内置源。
   *
   * notebook 单元格要的是内核的补全：`df.` 后面有什么，只有运行中的内核知道。
   * preset 里的 `autocompletion()` 不接受配置（同 foldMarker 那次处理，我们复制
   * 了 preset 的内容），所以在这里换成 override 形式。
   */
  completionOverride?: readonly CompletionSource[]
  hover?: Extension
}

export function dshEditorSetup(options: EditorSetupOptions = {}): Extension[] { … }

/** 旧导出名保留，转调零参工厂：所有既有调用点与测试不受影响。 */
export const dshEditorSetupExtensions: Extension[] = dshEditorSetup()
```

2. `CodeEditorProps` 增 `extraExtensions?: Extension`（默认 `undefined`），在 `EditorState.create` 的 extensions 数组末尾拼上；**不入 effect deps**（CodeMirror 扩展在 mount 时定型，与现有 `languageOverride` 同一约定，注释里写明改这些值需要 remount）。

3. 内核补全源：

```ts
export interface KernelIntrospectionAccess {
  /** 未连接内核时返回 null，一次请求都不发。 */
  session(): { kernelId: string; token: string } | null
  complete(input: { kernelId: string; token: string; code: string; cursorPos: number }): Promise<KernelCompletionResult>
  inspect(input: { kernelId: string; token: string; code: string; cursorPos: number }): Promise<KernelInspectResult>
  workspaceId: string
}

/**
 * 只在光标紧跟一个可补全的 token 时打网络：内核请求是有超时的同步往返
 * （kernelRequestTimeoutMs），每个字符都问一遍会把打字变成等回复。
 */
const COMPLETABLE_BEFORE = /[\w.]{1,64}$/u

export function kernelCompletionSource(access: KernelIntrospectionAccess): CompletionSource {
  return async (context) => {
    if (!context.explicit && !COMPLETABLE_BEFORE.test(context.state.doc.sliceString(Math.max(0, context.pos - 64), context.pos))) return null
    const session = access.session()
    if (session === null) return null
    if (context.state.doc.lineAt(context.pos).text.trimStart().startsWith('#')) return null
    const code = context.state.doc.toString()
    try {
      // 协议 5.2 起 cursor_pos **必须**是 codepoint 偏移，而 CodeMirror 的位置是
      // UTF-16 码元偏移；非 BMP 字符（emoji、部分 CJK 扩展字）会让两者相差每字符 1。
      // 不转换的后果是补全插错位置，且只在含 emoji 的单元格里出现——极难归因。
      const cursorPos = utf16OffsetToCodepoint(code, context.pos)
      const result = await access.complete({ ...session, code, cursorPos })
      // 请求在途时用户继续打字：作废这个结果，不要用一个过期回答填界面。
      if (context.state.doc.toString() !== code) return null
      if (result.matches.length === 0) return null
      return {
        // 反向换算回 CodeMirror 位置；内核给的 start/end 同样是 codepoint。
        from: codepointOffsetToUtf16(code, result.cursorStart),
        to: codepointOffsetToUtf16(code, result.cursorEnd),
        options: result.matches.map(label => ({ label, type: 'keyword' })),
        validFor: /^[\w.]*$/u,
      }
    } catch {
      return null   // 补全失败绝不是错误状态：安静地没有建议，比打断打字好。
    }
  }
}

/** UTF-16 码元偏移 → Unicode codepoint 偏移（协议 5.2 的硬要求）。 */
export function utf16OffsetToCodepoint(text: string, offset: number): number
/** codepoint 偏移 → UTF-16 码元偏移，越界时夹紧到串长。 */
export function codepointOffsetToUtf16(text: string, offset: number): number
```

两个换算函数放 `cell-introspection.ts`，**纯函数、单独测**：`𨭎𨭎 = 1` 里光标在第 2 个字符后，`utf16OffsetToCodepoint` 必须给出 2 而不是 4（这正是 spec 里举的那个例子）。

4. 悬停用 `@codemirror/view` 的 `hoverTooltip`（`package.json` 已直接依赖 `@codemirror/view`；`CompletionSource` 来自 `@codemirror/autocomplete`，与 `editor-setup.ts` 现有 import 同源，不新增任何浏览器依赖 —— AGENTS.md 红线）：

```ts
export function kernelHoverExtension(access: KernelIntrospectionAccess): Extension {
  return hoverTooltip(async (view, pos) => {
    const session = access.session()
    if (session === null) return null
    const word = view.state.wordAt(pos)
    // `wordAt` 返回 `TextRange | null`（不是 undefined）——仓库开了 strict，
    // 写 `=== undefined` 会直接编译失败，这里按真实签名判。
    if (word === null) return null
    try {
      const result = await access.inspect({ ...session, code: view.state.doc.toString(), cursorPos: pos })
      if (!result.found || result.text === '') return null
      return {
        pos: word.from,
        end: word.to,
        create: () => {
          const dom = document.createElement('pre')
          dom.className = 'dsh-notebook-hover'
          dom.textContent = result.text.slice(0, 4_000)
          return { dom }
        },
      }
    } catch { return null }
  }, { hideOnChange: true })
}
```

`textContent`（不是 `innerHTML`）—— 内核的 docstring 是不可信内容，与输出区同一立场。

5. **`is_complete_request` 第一期不接**，理由写进注释与 README 已知限制：Jupyter 前端也不用它做运行门控（ipykernel 自己会执行到块结束），它只服务 `%magic` 续行提示；在没有对应 UI 之前发请求只是浪费一次同步往返。接口保持就绪。

6. `api.ts` 的 `postKernel` 增加可选 `signal?: AbortSignal`（补全需要可取消），默认不传 → 现有调用零改动。

**测试（新 `tests/notebook-cell-introspection.spec.ts`，记得进 `tsconfig.test.json`）**

- 光标在 `pd.` 上：`access.complete` 被调用，且收到的 `code` 是**整格文本**、`cursorPos` 是**光标的 codepoint 偏移**（协议 5.2 的硬要求，注释里点明，因为这是最容易测错的一条）。
- 返回的 `cursorStart/cursorEnd` 被原样用作 `from/to`（否则补全会插错位置）。
- `session()` 为 null 时**不发请求**（断言调用次数为 0）。
- `access.complete` reject 时返回 `null` 而非抛出（界面不能被打断）。
- 光标在 `#` 注释行内不发请求。
- 用真实 `CompletionContext`（CodeMirror 允许在测试里构造 state）而不是手搓参数对象 —— 否则又变成「在自己测试里拼一遍参数再断言那个字面量」。

---

### D9 UI 暴露 `split` / `merge-down` / `clear-outputs`（模型和单测都已存在）

**现状**：三个 mutation 在 `notebook-document.ts` 已实现、`notebook-document.spec.ts:210/220` 已断言，但 `NotebookSurface` 没有任何入口 —— 纯浪费的既有能力。`clear-outputs` 有 mutation 无按钮（工具栏只有全局清除）。

**方案**

- 单元格 header 溢出的三个点菜单 → 复用 primitives 的 `Menu`/`MenuSurface`（CSV 的 `CsvContextMenu.tsx` 已有同款用法，观感一致）。条目：**拆分单元格（在光标处）**、**与下方单元格合并**、**清除本单元格输出**、**清空单元格内容**（用上 `notebook.clearCell`）、**复制单元格内容**。
- `split` 需要的 offset 来自 `CodeEditor` 已有的 `onCursorChange`；`EditorCursorState` 目前只给 `line/column/selected*`，**增加 `offset: number`**（`state.selection.main.head`），一处小改，别处也能用。
- 菜单项点击时从 runtime 读当前格的 cursor offset（surface 已持 `NotebookRuntime`，加一个 `cellCursor` 局部 map）。

**测试**：`notebook-surface.spec.tsx`

- 光标在第 6 个字符 → 「拆分」产生两格、id 不同、第二格 outputs 为空且 `execution_count === null`。
- 「合并」把下一格 source 与 outputs 并进本格，并删掉下一格。
- 「清除本单元格输出」只影响该格，其它格 outputs 原样（现在的全局清除已经测过，这条测的是「只清一格」）。

---

### D10 `text/latex` 交给 KaTeX —— 但不碰未公开的内部 API

**核查**：primitives 内部有 `renderTexToReact`（`lib/types/markdown/katex.d.ts`），但 `lib/types/index.d.ts` **没有导出它**，而且 `package.json` 的 `dsh.client.inject` 白名单里没有 primitives 的子路径。深路径 import 一个未公开的内部模块去接 KaTeX，会随 DSH 升级无声炸掉。

**方案：把 TeX 包进 `MarkdownText`**（零新依赖，`MarkdownText` 已经在用，且它自带 `katex/dist/katex.min.css` 与 KaTeX 的三段式错误处理）

```ts
// src/client/notebook/notebook-latex.ts（新，纯函数）
/**
 * Jupyter 的 text/latex 转成 MarkdownText 能吃的 TeX 语法。
 *
 * 内核给的是裸 TeX，可能已经自带 $ 或 \[ \] 定界符；MarkdownText 只认
 * $...$/$$...$$，所以这里做归一而不是二次包裹 —— 包错方向的直接后果是
 * 公式显示成字面文本，且看起来像「KaTeX 坏了」。
 */
export function latexToMarkdown(tex: string): string
```

归一规则（实现时按此表逐条测）：

| 输入形状 | 输出 |
| --- | --- |
| `\\alpha` | `$\\alpha$` |
| 已含 `$…$` | 原样 |
| `\\[ … \\]` | `$$…$$` |
| `$$…$$` | 原样（不重复包） |
| `\\begin{equation}…\\end{equation}` | `$$…$$`（保留环境） |
| 空/全空白 | `''`（渲染分支直接跳过） |

渲染侧：`{choice.kind === 'latex' && <MarkdownText text={latexToMarkdown(String(choice.value))} labels={markdownLabels} />}`；`notebook-output.ts` 的 `kindForMime('text/latex')` 保持 `'latex'`（择优与「显示为」切换都还需要这个类别）。

**测试**：`tests/notebook-latex.spec.ts`（新）逐条覆盖上表；`notebook-surface.spec.tsx` 断言 latex 输出**不再**渲染成 `<pre class=outputLatex>`，而是走 MarkdownText 的桩。

---

### D11 输出高度上限与展开（大输出的第一道可用性问题）

**现状**：`notebook.module.css` 里 `.outputList` / `.outputStdout` 等**没有任何 `max-height`**（已 grep 确认）。一次刷屏输出把整个笔记本撑出屏幕，用户要滚很久才回到代码。Jupyter 与 VS Code 都限制输出高度并给「展开」。

**方案**

- CSS：文本类输出块（`.outputStdout/.outputStderr/.outputError/.outputText/.outputJson`）默认 `max-height: 22rem; overflow: auto`；`.outputHtml` 已有 `overflow: auto`，加同上限。
- `CellView` 增 `outputExpanded: boolean`（不写盘，属于本地视图）。折叠态底部一枚「展开输出 / 收起输出」按钮，仅当内容超过上限时出现（用 `scrollHeight > clientHeight` 判定，封装成 `useOverflowing(ref, deps)` 小 hook）。
- `Shift+O`（命令模式，D12）切这一状态，与 Jupyter 一致；locales 新增 `notebook.expandOutput`/`notebook.collapseOutput`。
- 现有那个 `labels.output` 折叠按钮（整块输出显隐）**保留** —— 它和「单块高度展开」是两个不同动作，title 要写清楚区别。

**测试**

- `tests/notebook-output-theme.spec.ts` 已经在用 `ruleBody(selector)` 直接断言 CSS 规则体（`overflow`、`border-inline-start`、`scrollbar-gutter` 那批），本条沿用同一手法加两条：`ruleBody('.outputStdout')` 等文本块必须 `match(/max-height:\s*\d+rem/u)` 且含 `overflow:\s*auto`。这条防的是「后来者顺手删掉」。
- `notebook-surface.spec.tsx`：jsdom 里 `scrollHeight` 恒为 0，所以断言落在**按钮的 aria-label 切换**与 `data-expanded` 属性上（可控地 mock 那个 hook），不去假装测到了溢出。

---

### D12 命令模式与 Jupyter 快捷键集

**为什么这是一条而不是若干条**：`A`/`B`/`DD`/`M`/`Y`/`↑↓`/`Z`/`Shift+M`/`Shift+O` 全部依赖同一个「当前格处于命令态还是编辑态」的前提。分开做会出现一半按键生效、一半被吞进代码的中间态。

**方案**

1. model 增纯状态：`NotebookState.mode: 'command' | 'edit'`，action `{ type: 'mode', mode }`。identity 保持：同值返回同一对象。
2. `Esc` → `mode: 'command'` **且** blur 当前 CodeMirror（命令态的键不能打进代码，这是整个设计的关键约束，注释写清）。`Enter` / `i`（命令态）→ 进编辑态并 focus 回本格。
3. 命令态单键（根 div `onKeyDown`，`event.target` 在 `.cm-editor` 内时**不响应**，避免与 CodeMirror 抢键）：`A` 上方插、`B` 下方插、`DD` 删除（两次 D，300ms 窗口，用 ref 记时间戳）、`M`→markdown、`Y`→code、`↑`/`↓` 移焦点、`Shift+M` 合并、`Shift+O` 折叠输出、`Z` 撤销（D13）。
4. `Esc` 语义调整：现在是「markdown 格退出编辑并渲染」。改成 **任何格**按 `Esc` 都进命令态；markdown 格额外把 `editingMarkdown` 置 false（现有行为保留）。补一条：`Esc` 关闭补全弹层的既有短路（[NotebookSurface.tsx:295-299](../src/client/notebook/NotebookSurface.tsx)）必须留在最前面，否则用户按 `Esc` 关建议列表会被踢出编辑器。
5. 无障碍：命令态在 `aria-live="polite"` 里播报「命令模式」（locales `notebook.modeCommand`/`modeEdit`）；命令态给根容器一个 `data-mode="command"`，键盘用户看不见焦点环时至少有状态可读。
6. 焦点模型：命令态下焦点落在根 div（`tabIndex={-1}` + `focus()`）。这样 CodeMirror 收不到单键，也不需要给每个格加「editable 切换」（那会让代码格闪一下、丢滚动位置）。

**测试**（`notebook-surface.spec.tsx`，逐条正向 + 一条最重要的负向）

- `Esc` 后按 `b` → 文档里新增一格，且**代码内容里没有多出字母 `b`**（负向断言，防住整个设计里唯一的灾难）。
- `A`/`B` 插入位置相对焦点格正确。
- `DD` 删除；`D` 单次不删（防误删）。
- `M`/`Y` 换类型，且只调该类型负责的字段。
- `↑`/`↓` 移动 `focusedCellId`。
- `Shift+O` 切 `data-output-expanded`。

---

### D13 单元格结构级撤销（`DD` 必须可撤销）

**方案**：不动 CodeMirror 的 `history()`（那是格内文本），做**文档级快照栈** `src/client/notebook/notebook-undo.ts`：

```ts
export interface NotebookUndoStack {
  /** 一次结构编辑前调用；同 op 类型且间隔 < 500ms 的合并成一条。 */
  record(text: string, focus: string | null, op: string): void
  undo(): { text: string; focus: string | null } | null
  readonly depth: number
  clear(): void
}
```

- 上限 100 条（每条约等于一次全文件 JSON 文本，笔记本可达 MiB 级 → 上限按 **字节** 而非条数：16 MiB，超出丢最旧；这条要说清，因为它决定了内存代价）。
- 挂在 `NotebookRuntime` 的 tab 生命周期上（`forget(tabId)` 释放），不挂 surface（reload 后栈为空是正确的：文件就是真相）。
- `Ctrl+Z`：命令态 → 结构栈；编辑态 → 让 CodeMirror 处理（浏览器焦点在其内，根 div 收不到，天然分层）。

**测试**：`tests/notebook-undo.spec.ts`（纯模块）：record/合并窗口/字节上限/undo 返回原 text 与 focus。`notebook-surface.spec.tsx`：`DD` 删格后 `Ctrl+Z`（命令态）恢复，**且 id 与原来一致**（否则 run state 会错位——这条把 D1 的 id 稳定性再一次钉住）。

---

### D14 图片输出点击放大（复用 primitives 的 `ImageLightbox`）

`primitives` 公开导出 `ImageLightbox` 与 `ImageLightboxLabels`（已核对 index.d.ts）。给 `.outputImage` 加 `role="button"` + 点击开 lightbox + `Enter` 同效（键盘可达）；`ImageLightboxLabels` 需要的字段实施时按其 d.ts 从 locales 补。
**测试**：`notebook-surface.spec.tsx` 用 `ImageLightbox` 的桩断言「点击后组件被渲染」，不去测 lightbox 本身。

### D15 输出的「显示为」切换 —— 把 `alternatives`/`prefer` 用起来

`chooseNotebookRender(data, prefer)` 与 `alternatives` 已实现且 `prefer` 分支有测试，UI 从不传 → 现在无法在 `text/html` 与 `text/plain` 之间切换（VS Code/Jupyter 都有这个）。
**方案**：`choice.alternatives.length > 1` 时，输出区右上给 `Menu`，选中值存 `CellView.preferredMime[`${cellId}:${index}`]`，渲染时 `chooseNotebookRender(item.data, prefer)`。
**测试**：surface 层「选 `text/plain` 后渲染 `<pre>`，选 `text/html` 后渲染 sanitized div」；`notebook-output.spec.ts` 补 `prefer` 指向 bundle 里不存在的 mime 时回退默认择优。

### D16 选内核后写回 `metadata.kernelspec`

契约里 `NotebookKernelMetadata` 定义了却无人使用（死导出）。
**方案**：新 mutation `{ op: 'set-kernelspec', name, displayName, language }` → 写 `metadata.kernelspec.{name,display_name,language}` + `metadata.language_info.name`，其余键不动。
**只在用户显式选择时写**，auto-connect 不写 —— 否则打开一个 R 笔记本会把它悄悄改成 python。这条判断必须写进注释。
**测试**：`notebook-document.spec.ts` 保留其它 metadata 键；`notebook-runtime.spec.ts`/surface：选择器换内核后 draft 含新 kernelspec；**auto-connect 路径断言 draft 未被改动**（负向）。

### D17 消灭零消费 locale key 与 `notebookWidgetNotice` 死分支

我 grep 出 9 个 `notebook.*` key 在 `src/` 里除 locales.ts 外零引用：`errorState`、`copyFailed`、`sourceOf`、`executionFailed`、`toggleOutputs`、`cellLanguage`、`clearCell`、`kernelStartingHint`、`outputsNotSavedHint`。其中三条是**该用而漏用的错误反馈**：

| key | 处置 |
| --- | --- |
| `copyFailed` | `copyOutput` 失败时按钮文案变「复制失败」（现在 `navigator.clipboard` 被拒 → 静默返回 false，用户以为复制成功）|
| `executionFailed` | `runCell` 返回 false 时在输出区显示一行 `role="alert"` |
| `errorState` | 单元格 header 补一个 error 标签（现在只有 running/queued/interrupted 三种，缺出错那一格的状态）|
| `sourceOf` / `cellLanguage` | 用作 CodeEditor `ariaLabel` 与类型下拉的 `aria-label` |
| `clearCell` | D9 菜单项「清空单元格内容」|
| `kernelStartingHint` | 状态栏 starting 态的 title（现在 title 只重复 label）|
| `outputsNotSavedHint` | 输出区 `title`（说明输出会写进文件，与 Jupyter 一致）|
| `toggleOutputs` | **删键**（中英同步删）：与 D11 的展开/收起语义重叠，保留会让两处都像同一个动作 |

另：`notebookWidgetNotice()` 的 if/else 两分支返回**同一个字符串**、`modelId` 算了不用；且该字符串未本地化。改为返回 `code | null`（`'widget-unsupported'`），surface 侧 `t()` 出文案；分支按「有 text 兜底 → null（显示兜底）／无兜底 → code」真正分开。

**测试**：D6 的「每个 notebook/kernels key 必须被消费」断言即回归网；`notebook-output.spec.ts` 更新 widget notice 用例（现在断的是英文散文，改断 code），并补「两分支真的不同」这条 —— 这正是当前代码的形状缺陷。

---

## 批次三 · 交互基线（给接口形状，实施细节在实现时展开）

### D18 Run Above / Run Below / Run Selected / Restart & Run All

- `NotebookRuntime.runCells` 已是队列 + `drainQueue`（在 `phase === 'ready'` 时续跑，[notebook-runtime.ts:161](../src/client/notebook/notebook-runtime.ts)）。所以：
  - `runAbove/ runBelow` = `runCells(tabId, ws, path, cells.slice(0, i))` / `slice(i)`，**零新机制**。
  - `Restart & Run All` = `restart()` 之后把 ids 交给 `runCells`；`restart` 内部 `session` action 会清 cells，而 `acceptFrame` 收到新会话的 `phase==='ready'` 时自动 `drainQueue` —— 现有衔接正好可用，不需要新代码路径。这一条要在实现时验证（`notebook-runtime.spec.ts` 里断「restart 后队列自动排空」）。
- `Run Selected` 需要多格选择：`NotebookState.selection: readonly string[]`（model 里与 `focusedCellId` 并列；identity 保护同 D12）。

### D19 单元格拖拽重排

`move` 目前只支持 `direction: -1|1`。新增 `{ op: 'move-to', cellId, index }`（纯函数、单测易写），`EditorTabs.tsx` 已有标签拖拽的 DOM 模式可参照（`draggable` + 放置区高亮）。

### D20 笔记本大纲与单元格折叠

- 折叠：`CellView.folded`，折叠只渲染 header。
- 大纲：第一期给「单元格列表 + markdown 标题」下拉跳转，复用 `MarkdownOutline.tsx`（它接的是 `MarkdownOutlineEntry[]`，从 `document.cells` 里提取标题即可，`markdown-outline.ts` 现成）。
- 落地调整：只提取 markdown 单元格里的标题，代码格/raw 格不再按首行进大纲——大纲是目录，`df = load(...)`、`# 注释` 这类源码行不是标题；单元格本身仍可通过单元格列表与折叠导航。见 `notebook-outline.ts`。

### D21 单元格菜单与键盘可达性统一入口

D9 的菜单 + D12 的快捷键共用一份 `cellCommands` 描述表（label key / 快捷键 / 可用条件），避免按钮与快捷键两套逻辑漂移。

---

## 批次四 · 新能力（可行性与边界，本轮不实现）

### D22 变量查看器

唯一可用通道是 `execute_request.user_expressions`，宿主现在硬编码 `{}`（[kernel-session.ts:319](../src/host/kernel/kernel-session.ts)）。改造路径：`session.execute(code, cellId, silent, userExpressions)` → `completeRun` 从 `execute_reply.content.user_expressions` 取值 → 新帧 `{ type: 'user-expressions', msgId, values }` → 侧栏渲染。变量名单需要先 `%who_ls` 一次（VS Code 亦如此）。**不要轮询变量**：每次 run 之后带一组，成本可控。工作量集中在 UI。

### D23 ipywidgets / plotly

需要 comm 通道 + widget state 协议 + 前端 widget 视图实现 —— 判定为**独立项目**。本轮只做两件事：(a) 宿主不再静默丢弃 comm 帧（`kernel-session.ts:773-785` 的 default 分支保留丢弃，但补一行 debug 计数，让「为什么没显示」可诊断）；(b) D17 的 notice 文案说清「未安装 widget 前端扩展时只显示文本兜底」，与 README 已知限制对齐。

### D24 `.py`（percent format）导出 / 导入

纯客户端字符串变换，`src/client/notebook/notebook-py.ts`：`cellsToPercentScript(document)` / `percentScriptToNotebook(text)`（`# %%`、`# %% [markdown]`）。可完整单测、不碰内核。价值高（这是 Jupytext / VS Code Interactive 用户的主路径）。风险仅在换行与 `source` 形态归一 —— 复用 `splitNotebookLines` / `joinNotebookText` 即可。

### D25 笔记本按 cell 对齐的 diff

Git 面板现在把 `.ipynb` 当整文件 JSON 文本 diff，输出一变噪声极大。方案：`notebook-diff.ts` 先按 cell `id` 对齐，id 缺失/新增时按 source 相似度做 LCS，输出 per-cell 状态；渲染仍走 `DiffSurface`。中等工作量，收益是「能看懂一次 run 改了什么」。

### D26 非 Python kernelspec

`discovery.ts` 已解析 `argv` / `interrupt_mode` / `debugger`，`kernelCommandForPlan` 已能把任意 spec 的解释器重定位。真正的门槛只有 `isPythonIpykernelSpec` 一个判断。放宽前必须验证：bridge 的 `JPY_INTERRUPT_EVENT` / `JPY_PARENT_PID` 语义对 R/Julia kernel 是否成立、`interrupt_mode: signal` 与 `message` 的差异、`input()` 语义（R 是 `readline()`）。**必须先加探针场景再改代码**，否则 README 那条限制会被删掉而功能仍不可用。

### D27 调试器（DAP）

`debug_request`/`debug_reply` 走 control 通道、`debug_event` 走 iopub，`KernelDescription.debugger` 已解出。需要一个 DAP 客户端 + 断点/步进/调用栈 UI。明确不在本轮；若要立项，它是「批次四里最大的一个」。

### D28 对话侧驱动笔记本（本项目独有的差异化）

让 DSH 的 agent 运行单元格 / 读取输出，是官方 Jupyter 和 VS Code 都给不了的能力。**前置未知项**：插件能否向对话注册工具（本仓目前只用 sidebar/editor/conversation 的注册槽位，`@deepseek-ai/dsh-client-ui-slots` 是否暴露工具注册需先调研）。设计稿把它标为「先验证 API，再设计」，不承诺排期。

---

## 实施顺序与依赖

```
D1 ─┐
D2 ─┼─→ D3 ─→ D4,D5,D7   （批次一：无相互依赖，可并行；D3 依赖 D1 之外无）
D6 ─┘（D6 与所有 UI 文案改动耦合，先定 code 词汇表再动 D9/D12/D17）

D8,D9,D10,D11,D14,D15,D16 ─ 独立，可任意顺序
D12 ─→ D13（撤销栈需要命令模式的 Z）
D17 ─→ 依赖 D9/D11/D12/D13 落地后才能跑「每个 key 必须被消费」的断言
```

一条 PR 只做一件事（AGENTS.md），建议切分：

1. `fix(notebook): 让无 cell id 的笔记本可结构化编辑`（D1）
2. `fix(kernel): 连接 stdin 通道，让 input() 成为一次问答`（D2）
3. `fix(notebook): 输出写盘只写 nbformat 认识的形状，按 display_id 重绘`（D3）
4. `fix(notebook): Ctrl+Shift+Enter 运行全部；重连后恢复内核读数与中断`（D4+D5）
5. `refactor(kernel): 内核不可用原因改为 code`（D6）
6. `feat(notebook): 单元格补全与 docstring 悬停`（D8）
7. `feat(notebook): 拆分/合并/逐格清除输出 + 命令模式快捷键 + 结构撤销`（D9+D12+D13，这三条我建议分三个 commit 但一份 PR，因为它们共用一张命令表）
8. `feat(notebook): latex/图片/显示形式 + kernelspec 写回`（D10/D14/D15/D16）
9. `chore(locales): 消费或删除全部未引用的 notebook key`（D17）

---

## 门禁（每条改动收尾前）

四条全绿，缺一不可：

```sh
npm run typecheck      # 新 spec 记得加进 tsconfig.test.json 的 files 白名单
npm test
npm run build
npm run test:bundle
```

涉及内核链路（D2、D3、D6、D16 与一切动 `src/host/kernel/**` 的改动）再加三条：

```sh
npm run test:kernel
npm run test:example
npm run test:isolation
```

**当前这台机器跑不了内核门禁**：PATH 上解析到的 `python` 所在环境里没有 `ipykernel`（`import ipykernel` 抛 `ModuleNotFoundError`），也没有其它带 ipykernel 的解释器。所以 D2/D3 的实现与验证必须在一个装有 `ipykernel` 的环境里完成 —— 我不会把「真链路已验证」写进任何未跑过探针的条目结论里。可选做法：

```powershell
# 建一个一次性环境（不属于插件行为，只服务于本机验证）
python -m venv .venv         # 仓库根目录，会被 D2 的发现顺序第 1 条命中
.\.venv\Scripts\python.exe -m pip install ipykernel
npm run test:kernel
```

验证完是否保留 `.venv` 由你定；它不在 `package.json` 的 `files` 里，不会进发布包。

另外，README.md / README.zh.md 需要在这些条目落地时同步的段落：

- 「快捷键。」（第 95 行）：D4 修正、D12 的整套新键。
- 第 92 行 `input()`：D2 之后才是真的；D3 之后 tqdm 那段要改成「按 `display_id` 就地重绘」。
- 第 85 行「`.ipynb` written by this workbench opens unchanged in Jupyter」：D3 之后这句话才成立，实现前建议在文档里先降级为已知限制。
- 「已知限制。」（第 221-222 行）：D8 之后从限制里去掉「补全」相关（如果有）、D22/D23 未做的部分保留。
- 「配置。」表：D7 新增 `notebookMaxStructuredBytes` 一行。
- 内核管理一节：D6 之后不可用原因变成中文（中英各自来自 locales）。
