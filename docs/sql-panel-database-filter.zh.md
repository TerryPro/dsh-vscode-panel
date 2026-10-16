# SQL 面板的「按数据库筛选笔记」· 逐条改动设计稿

> **这份文件的用法**：它是本仓库既有的 `docs/` 设计稿形状（对照 [sql-ui-scope-design.zh.md](./sql-ui-scope-design.zh.md)），可以原样作为 GitHub issue 发布：
> `gh issue create --title "SQL 面板：按数据库筛选笔记列表，并支持在库上新建笔记" --label ready-for-agent --body-file docs/sql-panel-database-filter.zh.md`。
> 本仓的工单按 [docs/agents/issue-tracker.md](./agents/issue-tracker.md) 落在 GitHub Issues 上，本文是它的文件形态。

**一句话**：侧栏 SQL 面板的笔记列表现在无条件列出工作区里所有 `.sqlnb`，读者手里有五个库、二十份笔记时无法回答「哪些笔记是 `demo.db` 的」。本稿在列表上方加一枚**数据库下拉做筛选**，并让「选中一个库 → 在它上面新建笔记」成为一条现成的路径。

约定：

- 每条编号 `D<n>`，按落地顺序排列。
- 「落点」写到文件:行级；**行号是写本文时（HEAD `4848748` + 本会话未提交改动）的值，动手前先 grep 锚点文本**——本仓长期有并发改动，行号只能当线索。
- 「测试」写清断言落在哪个真实输出面上（AGENTS.md 的交付门槛要求）。
- 本稿**不新增任何宿主路由、不新增客户端依赖、不改 `.sqlnb` 格式**；`src/host/` 与 `src/shared/sql-protocol.ts` 一行都不动。

---

## 0. 先解决归属冲突：这不是把 ADR 0008 删掉的东西搬回来

[ADR 0008](./adr/0008-sql-ui-scope-split.md) 第 26 条写着：

> **面板不再扫描工作区**：那次遍历只为填库下拉，下拉走后面板没有东西可喂。

本稿要让面板重新扫工作区找 `.db`，看着像推翻它。两处都不是：

1. **那条已经作废**。面板现在正扫着工作区——`SqlPanel.tsx` 的 `scanSqlNotebooks`（为上半张笔记列表）。0008 那句话描述的是它自己那一轮的产物，之后被笔记列表这一版改动越过了。本稿要顺手把它订正（D6），不能让一条 ADR 继续陈述一件已经不成立的事实。
2. **语义不同**。0008 移走的是**连接控件**，本稿加的是**筛选控件**：

   | | 0008 移走的库下拉 | 本稿加的库下拉 |
   | --- | --- | --- |
   | 选完之后发生什么 | 改变当前笔记的连接目标（要再点「连接」） | 只改变列表可见范围，不碰任何句柄 |
   | 归属 | 中栏工具条 | 侧栏面板 |
   | 会不会打开/关闭句柄 | 会 | **不会**（D7 把它钉成断言） |

   0008 否掉重复的理由是「两个长得一模一样的数据库下拉并列时，读者无法判断点哪个作数」。本稿会让两枚库下拉同时存在，所以**必须靠位置与措辞把它们区分开**，否则就是精确重演 0008 要解决的问题（见 §4）。

### 与既成记录的偏离（必须一起改，不能让它悄悄不一致）

1. **给 ADR 0008 第 26 条加勘误**，说明「面板不再扫描工作区」已被笔记列表越过，且本稿的库下拉是筛选面不是连接面。
2. **新增 [ADR 0009「筛选面可以重复，连接面不可以」](./adr/)**（承接 0008 编号）：写下这条界线——同一个数据可以在两处出现，只要两处**动作不同**；同一动作不能出现在两处。0008 删的是动作的重复，本稿加的是视图的收窄。
3. **订正 `SqlPanel.tsx` 的头注释**（第 1–12 行）。它现在自陈「Top half: workspace scan … Bottom half: schema tree」，加上筛选后这句要重写，否则下一轮读者会以为下拉是连接入口。

---

## D1 一趟遍历同时收集笔记与库

**为什么先做这个**：面板现在为笔记扫一趟目录，本稿还要为库再扫一趟——**两趟串行 HTTP 往返**正是本会话刚修过的那个「半天才显示」的根因（实测 200 次串行往返、`node_modules` 吃掉 181/200 预算）。不合并就是刚填完的坑再挖一遍。

**落点**

- 新建 `src/client/sql/sql-workspace-scan.ts`：一趟 BFS，同时产出 `notebooks` 与 `databases` 两份列表。逐目录 `await` 的部分照 `sql-notebook-scan.ts` 的 `mapWithLimit` 思路，笔记正文的读取仍在遍历之后单独一批（只有笔记要读文件，库不用）。
- **两处预算不一致，必须显式处理**：`SQL_NOTEBOOK_SCAN_MAX_RESULTS = 100`（`sql-notebook-scan.ts:38`）与 `SQL_SCAN_MAX_RESULTS = 50`（`sql-database-scan.ts:34`）。合并后是**两个独立的计数上限**，不是取一个公共值——笔记到 100 就停止收集笔记、库到 50 就停止收集库，**两者都满才提前结束遍历**。取一个公共值会让其中一份列表悄悄变短。
- `truncated` 拆成 `notebooksTruncated` / `databasesTruncated`。现在两个模块共用一个布尔位；合并后若仍共用，「笔记扫全了但库被截断」会一起显示截断提示，那是假话。目录预算耗尽与读取失败两个原因仍然合并进两个位（它们对读者的含义相同：这份列表不全）。
- 跳过目录的集合 `SKIPPED_DIRECTORIES`（`.git` / `node_modules`）从 `sql-database-scan.ts:44` 与 `sql-notebook-scan.ts:50` **上提到新模块，两处共用一份**。两份各写各的正是分叉的开始。
- 删除 `sql-notebook-scan.ts` 与 `sql-database-scan.ts` 的两个 `scan*` 函数，改为新模块的单一入口。

**测试**（新建 `tests/sql-workspace-scan.spec.ts`，并登记进 `tsconfig.test.json` 的 `files` 白名单）

- 断言**一趟**：`list` 的调用次数等于单趟预算，而不是两趟之和。这条是 D1 存在的理由，也是唯一能证伪「合并」的断言。
- 两份列表各自独立截断：造一个 60 个库 + 10 个笔记的工作区，`databasesTruncated === true` 且 `notebooksTruncated === false`。
- 笔记的 `explicitDatabase` 仍解析得出（把本会话已修的「整文件读取」回归用例搬过来，别在重构中丢掉）。
- `.SQLNB` 大写仍被收集（`isSqlNotebookPath` 语义），`.db-wal` / `.db-shm` 伴生文件不进库列表。

---

## D2 缓存承载两份列表，并支持失效重扫

**落点**

- `src/client/sql/sql-workspace-cache.ts`：`SqlWorkspaceSnapshot` 从 `SqlNotebookScan | null` 改为 D1 的合并结果类型；`ensure` / `refresh` / `invalidate` 的 generation 语义**保持不变**（本会话刚修过「陈旧遍历覆盖新结果」的竞态，别在改类型时丢掉那个 token 判断）。
- `SqlWorkspaceScanner` 接口不变（`list` + `readNotebook`）。

**测试**（`tests/sql-workspace-cache.spec.ts` 已有 13 条，含竞态与跨工作区的回归）

- 现有断言全部保持绿——它们是回归护栏，不是要跟着改的对象。
- 新增：一次 `ensure` 同时给出两份列表；`invalidate` 后两份都重扫。

---

## D3 列表上方的筛选下拉

**落点**

- `src/client/sql/SqlPanel.tsx`：在 `notebookListContent`（第 426 行）的**列表容器内部顶端**加一枚 `<select>`，不放 `panelHeader`（第 500 行）。
  **为什么在列表里而不是头部**：面板头部是列表与结构树共用的，下拉放那里会读成「整栏的作用域」——但它只管列表。这条位置选择走的是仓库自己写下的判据（`ca2296c`）：**提示留在离它解释的东西近的那一处**。
- 筛选值域：`''`（全部）｜ D1 的某个库路径｜ `UNASSOCIATED` 哨兵值（见 §4）。
- 筛选依据：`notebook.explicitDatabase?.path === 选中值`。**只看笔记文件里记录的库**，不看运行时当前连着什么——这样筛选结果与行上第二行同源，不会出现「筛进来了却显示未连接」。
- 选中值存在 controller 上（新字段，如 `sqlPanelDatabaseFilter`），**不存 localStorage**：它跟缓存同生命周期，切面板回来还在，换工作区自动作废。

**测试**（`tests/sql-panel.spec.tsx`）

- 不选时列表 = 全部笔记（现有那条「scans the workspace on mount and lists every .sqlnb」必须继续绿，它是回归基线）。
- 选 `demo.db` → 只剩记录该库的行；记录别的库的行不在。
- 选 `UNASSOCIATED` → 只剩没有 `explicitDatabase` 的行。
- 筛选**不改变**行上的库名显示（同源的可见证据）。

---

## D4 在选中的库上新建笔记

**这条几乎不用写新逻辑**——文件树双击 `.db` 走的就是这条路：`FileTree.tsx:294` 的 `createNotebook(parentPath(path), 'database', path)`，底层是 `sql-notebook-create.ts:58` 的 `createSqlNotebook({ directory, seed: 'database', database })`，它已经会：命名 `库名-N.sqlnb`、写入 `connection` 记录、冲突时递增重试。

**落点**

- 下拉旁一枚「新建笔记」按钮，**仅在选中了具体库时可用**（选「全部」或「未关联」时没有目标库，禁用而不是隐藏——隐藏会让按钮宽度跳动）。
- 目录取**该库的同目录**（与文件树双击一致）。
- 建完 `controller.openFile(...)` 打开它。**不**调 `connectNewSqlNotebook`：那条是「从零建的笔记」用的入口，它按参数决定连 `:memory:` 还是连指定库（`controller.ts:652` 的分支）。这里的笔记文件**已经记录了目标库**，surface 挂载时的 `autoConnect` 会连到它——再调一次是同一个库连两遍，且把「rail 新建」那条路径的语义混进筛选面板。
- 失败路径照 `FileTree.tsx` 的现成分支：`path === null`（50 个名字全被占）时报错，不静默。

**测试**

- 选中 `demo.db` → 点新建 → `createFile` 被调用的路径是 `demo-1.sqlnb` 且落在 `demo.db` 的同目录。
- 新建后**当前筛选结果里出现这条新笔记**——这条要求 D5 的失效重扫，缺了它就是「建完了但列表里看不见」。
- 选「全部」时按钮 `disabled`。

---

## D5 新建/删除笔记后失效缓存

**这是本稿新暴露的缺口**：`SqlWorkspaceCache` 目前只有一个失效点——`controller.ts:274` 的 `if (previous !== workspaceId) this.sqlWorkspaceCache.invalidate()`。现在没有「面板内新建笔记」这个入口所以没人撞上；D4 一加上就会。

**落点**

- `controller.ts`：笔记文件保存成功、以及文件树新建/删除 `.sqlnb` 之后，调 `sqlWorkspaceCache.invalidate()`。
- 判据用现成的 `isSqlNotebookPath`，不新增概念。

**权衡**：不做这条，D4 的新建会在视觉上「没反应」（笔记建好了，列表里没有）。这是可接受的功能缺陷还是必须做，取决于你——我列在 D4 之后，因为它独立可回滚。

---

## D6 工具条的库下拉共用同一份缓存

**为什么**：工具条的 `useDatabaseScan`（`use-database-scan.ts`）现在**每次 surface 挂载都重扫一趟全工作区**，且没有任何缓存——与 D1 合并后，这就是第二趟重复遍历，正是 D1 要消灭的东西。

**落点**

- `use-database-scan.ts` 改为读 `controller.sqlWorkspaceCache` 的 `databases` 一份；它的「重扫」按钮改为 `invalidate()` + `ensure()`。
- 保留它现有的 generation 语义（本会话修过「旧遍历覆盖新遍历」的同类竞态）。

**权衡 / 可分离**：这条改动工具条的行为（结果从「每次挂载重扫」变成「用缓存 + 手动刷新」）。它和 D1–D4 可以分开评审、分开回滚，但**不做的代价是留下两趟遍历**，与 D1 的初衷冲突。我倾向做，且把它排在最后——前面几条不依赖它。

---

## D7 文档与 ADR

- 新增 ADR 0009（见 §0 偏离 2）。
- 给 ADR 0008 第 26 条加勘误。
- `docs/sqlite-workbench-requirements.zh.md` 的 N0-P0-2 / N0-P1-8 附近补一句：面板的库下拉是筛选面。
- `SqlPanel.tsx` 头注释重写（§0 偏离 3）。

---

## 措辞与区分（§4：怎么让两枚库下拉不打架）

| | 工具条那枚（连接） | 面板这枚（筛选） |
| --- | --- | --- |
| 位置 | 中栏笔记工具条 | 侧栏笔记列表顶端 |
| 标签 | 「选择数据库」 | **「按库筛选」** |
| 默认项 | 无（空占位） | **「全部数据库」** |
| 旁边是什么 | 连接 / 断开按钮 | 新建笔记按钮 |

标签必须不同——「选择数据库」是工具条连接下拉的原话，面板复用就会让两枚下拉读成同一个动作。

新增文案（中英各一份，`locales.ts`）：

- `sqlnotebook.filterByDatabase` — 「按库筛选」/ "Filter by database"
- `sqlnotebook.filterAllDatabases` — 「全部数据库」/ "All databases"
- `sqlnotebook.filterUnassociated` — 「未关联任何库」/ "No database recorded"
- `sqlnotebook.databaseNotebooksEmpty` — 「该库还没有笔记。」/ "This database has no notebooks yet."
- `sqlnotebook.newNotebookOnDatabase` — 「在此库上新建笔记」/ "New notebook on this database"

**不能用现成的 `sqlnotebook.workspaceNotebooksEmpty`**（「工作区里还没有 SQL 笔记。」）：选中一个库、它恰好没有笔记时，那句话是假话——工作区里有笔记，只是不在这个库下。

---

## 验收标准

| # | 断言 | 落在哪个真实输出面 |
| --- | --- | --- |
| 1 | 不选库时列表 = 全部笔记 | 面板 DOM 行数 |
| 2 | 选 `demo.db` → 只剩记录该库的笔记 | 面板 DOM 行 |
| 3 | 选一个没有笔记的库 → 空态是「该库还没有笔记」 | 面板 DOM 文案 |
| 4 | 选库 → 新建 → 新笔记出现在**当前筛选结果内**，且记录了该库 | `createFile` 参数 + 重扫后的 DOM |
| 5 | 筛选**不改变任何连接状态**、不打开/关闭句柄 | **`sqlOpen` 调用数为 0** |
| 6 | 下半张结构树仍跟活动笔记，切换筛选不动它 | `sqlTables` 调用参数不变 |
| 7 | 一趟遍历同时产出两份列表 | `list` 调用次数 ≤ 单趟预算 |
| 8 | 刷新按钮一次覆盖两份列表 | 一次 `refresh` 后两份都变 |

**第 5 条是整个设计的可证伪核心**：它是「这是筛选而不是连接」的唯一硬证据。实现者只要不小心在选库时顺手连了一下，这条就红。

---

## 改动量预估

| 文件 | 改动 |
| --- | --- |
| `sql-workspace-scan.ts`（新建） | ~150 行，吸收两个 scan 模块 |
| `sql-notebook-scan.ts` / `sql-database-scan.ts` | 删除，或退化为薄再导出 |
| `sql-workspace-cache.ts` | 快照类型 + 失效点 |
| `SqlPanel.tsx` | 下拉 + 筛选 + 新建入口 + 空态，约 +80 行 |
| `sql-panel.module.css` | 列表顶端一行 |
| `use-database-scan.ts`（D6） | 改为读缓存 |
| `locales.ts` | +5 键（中英各一份） |
| `docs/adr/` | +1 篇，0008 加勘误 |
| 测试 | 新建 1 个 spec，改 2 个 |

**不碰**：`src/host/`、`src/shared/sql-protocol.ts`、`.sqlnb` 格式、任何宿主路由、任何连接语义。

---

## 待定（不阻塞开工，但会影响验收）

1. **筛选是否要记忆到工作区之外**（localStorage）？本稿选「不」——它跟扫描缓存同生命周期，换工作区还留着旧筛选值会指向一个不存在的库。
2. **D5 / D6 要不要与 D1–D4 同批**？本稿倾向 D6 同批（否则留下两趟遍历），D5 可推后。
