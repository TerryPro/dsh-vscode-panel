# 笔记本「编辑与运行体验」开发计划

范围：缺口分析里的 **A 组（A1–A10）**，即 VS Code / 官方 Jupyter 有、本工作台完全没有、用户感知最强的那一批。
批次二（补全/悬停/latex/输出上限）与批次四（变量查看器/ipywidgets/导出）不在本计划内，见 [notebook-change-design.zh.md](notebook-change-design.zh.md)。

估算是人日，按熟悉本仓代码的人算；每条都给了「必红的测试」，因为没有回归用例的里程碑不算完成（AGENTS.md 的交付门槛）。

---

## 总览

| 里程碑 | 内容 | 估算 | 依赖 | 本机可全绿？ |
| --- | --- | --- | --- | --- |
| **M0** | D1：无 cell id 的笔记本无法结构化编辑 | 0.5–1 | 无 | ✅ 只需 `npm test` |
| **M1** | 只补按钮，不碰交互模型：A3 / A4 / A5 / A6 / A9 | 1–1.5 | M0 | ✅ |
| **M2** | 命令模式：A1（含 A2 的 `Esc` 语义）+ A8 撤销 + A7 拖拽 | 1.5–2 | M0、M1 | ✅ |
| **M3** | 格式兼容与收尾：A10（raw / attachments）+ README 中英同步 | 0.5–1 | M1、M2 | ✅ |
| 合计 | | **4.5–6.5 人日** | | |

**关键排期事实**：A 组全部改动只碰客户端（`src/client/notebook/**`、`src/client/editor/**`），不需要真内核，所以四条门禁（`typecheck` / `test` / `build` / `test:bundle`）在**本机现在就能跑绿**。需要装有 `ipykernel` 的 Python 的是 D2（stdin 通道）与 D3（`display_id`），它们被排除在本计划外，另开。

---

## M0 · 地基（为什么排在所有 A 组之前）

A 组几乎每一条都是**结构性编辑**：拆分、合并、移动、删除、插入。而这些操作全都靠「按 cell id 在 JSON 树里定位」：

```
输入：nbformat_minor: 4、cell 无 id 的笔记本
set-source    -> THREW CELL_NOT_FOUND
set-kind      -> THREW CELL_NOT_FOUND
insert        -> THREW CELL_NOT_FOUND
clear-outputs -> THREW CELL_NOT_FOUND
split/merge   -> 同样会 THREW（新加的 mutation 走同一条查找路径）
```

也就是：**不修 M0，M1/M2 交付的按钮在任何一份老笔记本上点了就抛异常**，而且输出会被静默丢掉。GitHub 上大量笔记本是 minor 4 或更早（Jupytext、老 papermill、手工文件），不是边角。

- 落点：[notebook-document.ts](../src/client/notebook/notebook-document.ts) —— `parseNotebook` 的合成 id 改为导出 `syntheticCellId(index)`；`editNotebook` 在 `apply()` 之前跑 `ensureCellIds(value)`，补 id 时顺带把 `nbformat_minor` 提到 5。
- 只做一次（幂等），且**不在 parse 阶段写**：打开只读笔记本不该让文件产生 diff。
- 不做「按索引回退查找」：索引会随 insert/delete/move 变化，而一次 run 的 `cellId` 必须跨这些操作稳定（M2 的撤销栈同样依赖这一点）。

必红的测试：

1. `tests/notebook-document.spec.ts`：minor-4 无 id 文档，用 `parseNotebook(text).cells[0].id` 做 `set-source` → 不抛，输出 JSON 里该 cell 有 id 且 `nbformat_minor >= 5`。
2. 同一文档连做两次编辑 → id 不重复生成（幂等）。
3. 混合文件（部分 cell 有 id）→ 已有 id 一律不动。
4. `tests/notebook-runtime.spec.ts`：`commitRunOutputs` 在无 id 文档上**确实**调用了 `bridge.setDraft`（现在会被 `NotebookEditError` 吞掉，等于零断言）。

完成判据：上述 4 条 + 四条门禁绿。

---

## M1 · 只补按钮（收益/成本比最高，风险最低）

不动焦点模型、不加快捷键，所以不会与 CodeMirror 抢键。全部落点在 [NotebookSurface.tsx](../src/client/notebook/NotebookSurface.tsx) + 一个新增的单元格菜单。

| 项 | 加什么 | 已有的东西 | 估算 |
| --- | --- | --- | --- |
| A3 | **Run Above / Run Below**：以焦点格为界切一段 ids 丢给队列 | `runCells()` + `drainQueue()` 已是「按 `phase==='ready'` 续跑」的真队列（[notebook-runtime.ts:273-288, 466-481](../src/client/notebook/notebook-runtime.ts)），**零新机制** | 0.25 |
| A4 | **Restart & Run All** | `restart()` 内部 `session` action 会清 cells，而 `acceptFrame` 收到新会话 `phase==='ready'` 时自动 `drainQueue` —— 衔接现成 | 0.25 |
| A5 | **拆分 / 合并**入口（单元格 `⋯` 菜单） | `split`、`merge-down` 两个 mutation + 单测都在（[notebook-document.ts:420-452](../src/client/notebook/notebook-document.ts#L420-L452)）；只差菜单和 cursor offset | 0.5 |
| A6 | **逐格清除输出** | `clear-outputs` mutation 已实现（[:466-470](../src/client/notebook/notebook-document.ts)），UI 只有全局清除 | 0.1 |
| A9 | **笔记本大纲**（跳转 + 代码/输出块折叠） | [MarkdownOutline.tsx](../src/client/markdown/MarkdownOutline.tsx) 与 `extractMarkdownOutline` 现成，从 `document.cells` 喂标题 | 0.5 |

**A2 为什么不在这一批**：把 `Esc` 从「只作用于 markdown 格」改成「任何格都生效」看起来只是几行，但 `Esc` 的语义属于命令模式这个前提 —— 单独放开 `Esc`，按下去仍然没有后续的单键可用，用户只会觉得「Esc 不知把焦点弄哪去了」。所以 A2 随 M2 一起做，那里才能同时给出 `Esc` 之后的完整行为。

实施细节（两条容易踩的）：

- A5 的拆分点需要光标偏移。[CodeEditor.tsx](../src/client/editor/CodeEditor.tsx) 的 `EditorCursorState` 现在只有 `line/column/selected*`，**加一个 `offset: number`**（= `state.selection.main.head`）。改动一处，别处也能用。
- 菜单复用 primitives 的 `Menu` / `MenuSurface`，照 [CsvContextMenu.tsx](src/client/csv/CsvContextMenu.tsx) 的既有用法，保证与其它结构化视图观感一致，不自己造浮层。

必红的测试（`tests/notebook-surface.spec.tsx`）：

1. 光标在第 6 个字符 → 拆分产生两格、id 不同、第二格 `outputs` 为空且 `execution_count === null`。
2. 合并 → 下一格的 source 与 outputs 并进本格，并删掉下一格。
3. 逐格清除 → 只影响该格，其它格 outputs 原样。
4. Run Below → `api.kernelExecute` 调用次数 = 焦点格之后的 code 格数，顺序为文档序（断在真实 API 调用面上，不是自己拼参数）。
5. Restart & Run All → 先 restart 后队列自动排空，中间没有手工 setTimeout。
6. 大纲 → 列出 markdown 标题，点击把对应格滚入视野（断 `scrollIntoView` 被调用的 target id）。

文案：本里程碑会消费掉两枚现存的零引用键（`notebook.clearCell`、`notebook.outputsShown/Hidden` 的语义分工），并新增 `runAbove`、`runBelow`、`splitCell`、`mergeDown`、`restartRunAll`、`outline` 等 —— **中英同时写**（`en` 被类型约束为 `Record<keyof typeof zh, string>`，漏一边直接编译失败）。

完成判据：以上 6 条 + 门禁 + 新 spec 已进 `tsconfig.test.json` 的 `files` 白名单。

---

## M2 · 命令模式（必须与撤销同批交付）

A1 一上线，`A`/`B`/`D`/`M`/`Y` 这些单键就会与 CodeMirror 抢输入。**没有 A8 的 `DD` 是危险的删除**，所以 A1/A8/A7 捆在一起，且这一批必须自带那条负向回归。

| 项 | 内容 |
| --- | --- |
| A1（含 A2） | model 加 `NotebookState.mode: 'command' \| 'edit'` + action（同值返回同一对象，保住 `useSyncExternalStore` 的 identity 短路）。`Esc` = 任何格进命令态并 blur CodeMirror；`Enter`/`i` = 进编辑态并 focus 回格。命令态单键：`A`/`B` 插格、`DD` 删（300ms 窗口）、`M`/`Y` 换型、`↑↓` 移焦、`Shift+M` 合并、`Shift+O` 折叠输出、`Z` 撤销 |
| A8 | `src/client/notebook/notebook-undo.ts`：文档级快照栈，挂在 tab 生命周期（`runtime.forget(tabId)` 释放）。上限按**字节**（16 MiB）而非条数 —— 一份笔记本每次快照约等于整份 JSON 文本。同 op 且间隔 < 500ms 合并成一条 |
| A7 | 拖拽重排：`{ op: 'move-to', cellId, index }`；DOM 模式照 [EditorTabs.tsx:83-84](../src/client/editor/EditorTabs.tsx#L83-L84) 的标签拖拽与放置区高亮 |

三条硬约束（写进注释，别只写进 PR 描述）：

1. **`Esc` 关补全弹层的短路必须留在最前面** —— [NotebookSurface.tsx:295-299](../src/client/notebook/NotebookSurface.tsx#L295-L299)。命令态重写 `Esc` 语义时很容易把它挤掉，后果是「按 Esc 关建议列表被踢出编辑器」。
2. 命令态下焦点落在根容器（`tabIndex={-1}` + `focus()`），CodeMirror 拿不到键 —— 这比给每格做 editable 切换好：后者会让代码格闪一下并丢滚动位置。
3. 快捷键与菜单项读**同一张 `cellCommands` 表**（label key / 键 / 可用条件），避免按钮和快捷键两套逻辑漂移；M1 交付的菜单就是这张表的第一个消费者。

必红的测试：

1. **负向（整批最重要）**：`Esc` 后按 `b` → 文档新增一格，**且任何格的 source 里不多出字母 `b`**。
2. `DD` 删格 → `Ctrl+Z`（命令态）恢复，且 **id 与原来一致**（否则在跑的 run state 会错位；这条同时把 M0 的 id 稳定性再钉一次）。
3. `D` 单次不删（防误删）。
4. `A`/`B` 插入位置相对焦点格正确；`M`/`Y` 只调该类型负责的字段。
5. 快照栈达到字节上限时丢最旧、`clear()` 后 `depth === 0`（`tests/notebook-undo.spec.ts`，纯模块）。
6. 拖到 index 3 → 顺序正确，且被拖格的 id 不变。

无障碍：命令态在 `aria-live="polite"` 播报「命令模式」，根容器给 `data-mode="command"`（看不见焦点环的键盘用户至少能读到状态）。

估算 1.5–2 人日。

---

## M3 · 格式兼容与收尾

| 项 | 内容 | 估算 |
| --- | --- | --- |
| A10 | Raw 格可创建（现在只作为「文件里已有的类型」被识别）；读取并显示 `attachments`，带附件的 markdown 格不再显示成空文本 | 0.5 |
| 文案清扫 | 本组功能落地后，把「每个 `notebook.*` / `kernels.*` key 必须被消费」的断言加进 `tests/locales.spec.ts` —— 这条只在功能都接上后才有意义，早加会把还没做的功能逼成占位消费 | 0.25 |
| 文档 | README.md / README.zh.md 同步「快捷键。」一节（第 94–95 行）与「已知限制。」：命令模式、新键、大纲 | 0.25 |

四条门禁 + 中英两份 README 同时改（AGENTS.md 的仓库文档要求）。

---

## PR 切分（一条 PR 只做一件事）

```
M0  fix(notebook): 让无 cell id 的笔记本可结构化编辑
M1a feat(notebook): 单元格菜单——拆分/合并/逐格清除
M1b feat(notebook): Run Above / Run Below / Restart & Run All
M1c feat(notebook): 笔记本大纲与单元格折叠
M2a feat(notebook): 命令模式与 Jupyter 快捷键集
M2b feat(notebook): 单元格结构级撤销
M2c feat(notebook): 拖拽重排单元格
M3  feat(notebook): Raw 单元格与 attachments + 文案消费断言 + README
```

M0 单独先发（它是后面所有 PR 的公共依赖，且改动面小、评审快）。M1a/M1b/M1c 可并行。M2a→M2b 必须同批合入（见上）。

---

## 每个里程碑的统一门禁

```sh
npm run typecheck      # 新 spec 记得加进 tsconfig.test.json 的 files 白名单
npm test
npm run build
npm run test:bundle
```

A 组不需要 `test:kernel` / `test:example` / `test:isolation`（不动 `src/host/kernel/**`）。若某个改动顺手碰了内核链路，那三条立刻变成必跑，且需要一台装有 `ipykernel` 的 Python —— 本机当前没有，届时先建 `.venv` 再跑。

失败就修到失败原因消失，不用 `expect(true).toBe(true)`、跳过用例或放宽断言凑绿。

---

## 风险表

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 单键与 CodeMirror 抢输入 | 用户打字被打断，笔记本变得不可用 | 命令态 blur + 根容器持焦；测试 1 的负向断言常驻 |
| 撤销栈吃内存 | 大笔记本 × 100 次编辑 → 数百 MB | 上限按字节 16 MiB，超出丢最旧；tab 关闭即释放 |
| `Esc` 短路被挤掉 | 按 Esc 关建议列表却被踢出编辑器 | 约束 1 写进代码注释 + 一条专门用例 |
| 老笔记本改完多出 `id` 字段 | 用户看到 diff 意外变大 | 这是 nbformat 4.5 的正规形状；在 README 里说明「编辑会补全 cell id」 |
| 新文案只写中文 | `en` 有类型约束，直接编译失败 | 无需额外缓解，编译器兜底；但 `locales.spec.ts` 的占位符一致性也要跟着新 key 走 |

---

## 本计划不包含（另开）

- **D2 stdin 通道缺失** → 单元格里的 `input()` 会把 run 永久卡死（最严重的正确性问题，需要 `ipykernel` 环境 + 探针场景）。
- **D3 `update_display_data` 污染写出的 `.ipynb`** → 本工作台保存的笔记本在 Jupyter/VS Code 里会撞上不认识的 output 类型。
- **D6 宿主英文散文直接进 UI**、**D7 `oversized` 死分支**、批次二（补全/悬停/latex/输出高度）、批次四（变量查看器、ipywidgets、`.py` 导出、diff、非 Python 内核、DAP、对话侧驱动）。
