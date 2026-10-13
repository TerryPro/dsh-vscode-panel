# SQL 笔记：需求与开发计划

一句话：左侧面板加一个模块，用类似笔记本的单元格样式写 SQL、逐格执行、就地看结果，直连工作区里的 SQLite 文件，用户不需要装任何东西。

> **术语先钉住**。本文说的「SQL 笔记」是一个独立模块，与仓库里既有的「笔记本」（走 Jupyter 协议、`.ipynb`、一个内核子进程）是两个概念，唯一共同点是单元格这一视觉形状。词表见 [GLOSSARY.md](../GLOSSARY.md)，取舍理由见文末 ADR 索引。
>
> **本文的需求编号（N0-P0-1 这样的形式）可以引用；行号只能当线索**。仓库长期有并发改动（写本文时 `git status` 24 项，HEAD `90dba20`），所有行号都在当时复核过，但不保证下次仍对得上；引用前请 grep 锚点文本。

---

## 1. 为什么走这条路

曾经有过另一条路：给笔记本加一个外部 Jupyter SQL kernelspec（`jupyter-duckdb`）。它要求用户自建虚拟环境、装 `jupyter` 元包、再**手动注册 kernelspec**——插件不代为安装任何东西（本仓既定原则），所以这三步全落在用户身上，功能才第一次可见。**这条路已废弃**（§7），理由连同当年取证的结论一起记在 [ADR 0001](./adr/0001-node-sqlite-as-sql-notebook-backend.md)。

本文换成宿主内置 `node:sqlite`。实测（宿主 runtime，见 §3 第一条）它无 flag、无告警、`readOnly` 可用，**零新依赖、零安装步骤**，也不触碰 `ws` / `node-pty` 那条原生模块红线。理由与备选方案记录在 [ADR 0001](./adr/0001-node-sqlite-as-sql-notebook-backend.md)。

随之而来的形状变化：本模块**不是** Jupyter 内核的第三种语言。它复用笔记本的单元格视图，但传输与会话管理另起一组路由，不进内核 registry、不进左栏「内核」面板。见 [ADR 0002](./adr/0002-sql-notebook-reuses-notebook-cells.md)。

---

## 2. 需求分层

### P0 · 一期要交付的最小闭环

- **N0-P0-1** rail 新增一枚图标（插在 `terminal` 与 `kernels` 之间），进入 SQL 笔记侧栏。落点：`src/client/model/workbench-types.ts:8` 的 `SidebarMode` 加 `'sql'`；`src/client/shell/ModeSwitch.tsx:60-66` 的 `items` 加一行；`WorkbenchSidebar.tsx:58-64` 加分派分支；新面板根节点带 `data-dsh-workbench-panel-header`（分隔线布局自动接管）。`tests/mode-switch.spec.tsx:97` 的按钮数断言 **8 改 9**。
- **N0-P0-2** 能选一个库：连接选择器列出工作区里的 `.db` / `.sqlite` / `.sqlite3` 与 `:memory:`（递归扫、带上限与「只显示了前面一部分」提示、拒符号链接）。入口另有两条：文件树新建菜单加「SQL 笔记」条目；双击 `.db` 自动在同目录新建 `query-<n>.sqlnb` 并生成一条 `SELECT ... LIMIT` 首格，不弹命名框。
- **N0-P0-3** 能打开一个 `.sqlnb` 笔记并在中栏标签页里编辑（与既有 6 个富视图同构：状态条 `actions` 插槽切换笔记视图 / 原始视图，默认笔记视图；分屏把手与 localStorage 比例照 `EditorTabBody.tsx` 的 mermaid/csv/json 三份模板）。
- **N0-P0-4** 能连上库、逐格执行、就地看表格结果、SQL 报错就地呈现。执行走宿主 `/sqlnotebook/*` 一组 POST 路由；**必须分块取行并在块间让出事件循环**（§3 的阻塞实测）。
- **N0-P0-5** 只读是默认档。切可写要显式操作并确认；两档都拦 `ATTACH`、扩展加载与一份按名字拒绝的 PRAGMA 名单。见 [ADR 0004](./adr/0004-readonly-default-with-authorizer.md)。
- **N0-P0-6** 侧栏给出 库 → 表/视图 → 列 的浏览树（懒加载，两条路由：tables / columns），双击表/视图在当前笔记生成一格 `SELECT * FROM "t" LIMIT <上限>`。
- **N0-P0-7** 结果呈现正确：行以数组返回、列名与列序取自 `columns()`、大整数与 BLOB 已归一化（见 [ADR 0005](./adr/0005-result-rows-as-arrays.md)），NULL / 空串 / 字符串 `"NULL"` 三者可区分。
- **N0-P0-8** 已知限制要在界面上说实话：不能真中断的（聚合类）就说不支持；不自动重开断掉的连接；`.db` 走笔记入口后不再报「不是可编辑的 UTF-8 文本」。

### P1 · 一期该有、缺了会明显别扭

- **N0-P1-1** 运行全部（按序、遇错即停并明示停在第几格）、清空全部输出与清空当前格（前者在工具栏，后者在行内菜单）。运行全部执行前提示「共 N 格，期间工作台其它功能可能暂时无响应」。
- **N0-P1-2** 取消按钮。它**只对逐行产出的查询有效**，文案必须写准这个局限；取消 = 停当前格 + 清空尚未开始的排队格。
- **N0-P1-3** 每格执行耗时读数，落在结果块外围。
- **N0-P1-4** 断开 / 重连入口。它同时是「切换只读 ↔ 可写」的实现手段（`readOnly` 是构造期选项，改不了，所以切档 = 断开 + 重连），切换前明说会新建连接、临时表与未提交事务会丢。
- **N0-P1-5** 行首状态标记（运行中 / 出错 / 只读档 vs 可写档），SQL 报错除错误块外也要在行首可见。
- **N0-P1-6** 状态条读数：`库名 · 档别 · 当前上限`。**不复用**内核状态 chip（`NotebookKernelStatus.tsx` 讲的是内核 phase，对进程内句柄是误信息）。
- **N0-P1-7** 窄栏快捷条补三个动作：当前连接、刷新 schema、新建笔记。（`WorkbenchRail.tsx` 现在连 `kernels` 都没有分支，本模块不照抄这个缺口。）
- **N0-P1-8** 连接建立 / 重建时在输出区显一句「连接已新建，临时表等中间成果不跨会话」。

### P2 · 二期（本文只定边界，不展开）

分页（每结果块各自一套，只在语句含 `ORDER BY` 时给）、结果下载 `.csv` / `.json`（只导当前页，走 `URL.createObjectURL(new Blob(...))`，客户端已有先例，**不新增宿主写文件路由**）、侧栏活动连接列表（含归属笔记与档别、可就地断开）、以及执行搬到 worker 线程（前置取证见 §6）。

### 明确不做（本期与二期都不做）

跨库查询（`ATTACH` 两档都拦）、`VACUUM`、新建 `.db` 文件、命名参数、输入补全、SQL 格式化、查询历史、把 SQL 或结果插入对话输入框、导出到工作区文件、变量/环境面板。

---

## 3. 承重墙：实测事实

下面每一条都决定一段代码的形状，全部在**宿主 runtime**（Electron 44 内嵌 Node v24.18.1，`ELECTRON_RUN_AS_NODE=1` 直接问那个 exe）上实测得到。它们必须由 §6 的常驻门禁固化成场景，不能只靠本文存在。

| 事实 | 后果 |
| --- | --- |
| `node:sqlite` 在宿主 runtime 上无 flag、stderr 0 字节。开发机 PATH 上的 v24.20.0 **不是**宿主 runtime（曾有一份内核计划把它当成宿主，那份文档已作废，见 §7）。 | 零安装、零新依赖成立 |
| 该 runtime 上 `DatabaseSync.prototype` **没有** `interrupt` / `cancel` / `abort` / `timeout`；`timeout` 构造选项只是等锁上限，实测 3201ms 后报 `database is locked`，对已在自己跑的语句无效。 | 「不能中断」不是实现缺陷，是能力缺失 |
| 一条慢同步查询期间，**同期一条真实宿主路由从 13ms 被拖到 4336ms**（文件保存、Git、内核 poll 一起无响应），`setInterval` 一次都不打点。分块取行 + 块间让出后，同期路由降到 **99ms**。 | N0-P0-4 的分块不是优化，是硬性要求 |
| 聚合类查询的全部时间落在**第一次取值**（实测 8.91ms ≈ `.get()` 8.77ms，首行值即证已扫完全表）；`iterate()` 早停只对逐行产出的查询有效。 | 取消与时长上限都救不了聚合 → N0-P0-8 |
| 行上限**约束不了时长**：无 `GROUP BY` 的 `count`/`sum` 早停也要扫完全表；外层 `LIMIT 1` 兜不住聚合（实测仍 3311ms）。 | 另设执行总时长上限（常量 15s），只在块间检查 |
| 只读档 `{ readOnly: true }` **完整允许**建临时表、写入、与主库 JOIN、`BEGIN`/`COMMIT`/`SAVEPOINT`，临时表跨 `COMMIT` 存活；主库任何写一律被 SQLite 拒绝（`attempt to write a readonly database`）。 | 默认只读不牺牲「试查询」这套核心用法 |
| 只读档**不拦 `ATTACH`**（实测能成功附加别的库文件，只是写被 `readOnly` 传染拒绝）。 | authorizer 必须显式拒 `ATTACH`/`DETACH` |
| `setAuthorizer` 回调**返回布尔会让每一条语句失败**，必须返回整数常量；且动作码与授权码**值域重叠**（`DENY`＝`CREATE_INDEX`＝1、`IGNORE`＝`CREATE_TABLE`＝2、`COPY`＝`OK`＝0）。 | 判定与日志一律用名取值比对，绝不按值反查名字 |
| `loadExtension` **完全不经过 authorizer**（实测回调次数 0），只能靠建库时的 `allowExtension: false`。 | 旧版本文曾写「用 authorizer 拦 loadExtension」，是错的 |
| `PRAGMA query_only=ON` 会让只读连接连 `CREATE TEMP TABLE` 都失败。 | 它必须在拒绝名单里 |
| 未走完的 `iterate()` **持有读事务**；默认 `journal_mode` 实测为 `delete`，此时另一连接写同一文件被阻塞（实测 515ms 后 `database is locked`）。 | 「占用」的定义由此而来：正在分页的连接也挡住可写档 |
| 只读打开 WAL 库，执行**第一条语句**即在工作区生成 `-wal`(0B) / `-shm`(32768B)；**`close()` 不删、反复开关不累积也不消失、进程崩溃同样残留**，只有最后一个连接是可写且正常关闭才清理。`?immutable=1` 虽无残留，但实测少读别人未 checkpoint 的已提交行（`n:3` vs `n:4`）。 | 接受残留 + 在本模块侧栏列表里过滤（文件树照旧可见）；不用 immutable |
| `all()` 的对象行在**重复列名时静默丢值**（`SELECT 1 AS x, 2 AS x` → `{"x":2}`；`SELECT * FROM A, B` 实测 5 个真列只剩 4 个键），而 `columns()` 完整保留每项且执行前可调。 | 行必须走 `setReturnArrays(true)`，见 ADR 0005 |
| `readBigInts: false`（默认）在任何 `|v| > 2^53-1` 上**直接抛**；开 `true` 后**所有整数都变 BigInt**（`42` → `42n`），而 `JSON.stringify(BigInt)` 抛错。BLOB 是 `Uint8Array`，裸进 `sendJson` 会静默变成 `{"0":1,"1":2}`。 | 必须开 `readBigInts` 且逐值判类型；归一化在 `sendJson` 之前完成 |
| `db.limits` 是**只读属性、原型无 setter**（列 2000、变量 32766 无法下调）；`statement.close()` 在本 runtime **不存在**（类型里有）。 | 列数/变量数只能宿主自己预检；不要用 `using` 语法 |
| `worker_threads` 在该 Electron runtime 上可用（require/import 都行），主线程全程正常打点；但 `terminate()` **不是取消**——实测它等 5221ms 才返回 ≈ 查询自己跑完的时间；terminate 之后不留锁、未提交数据消失、`integrity_check ok`。 | 二期 worker 的可行性前提，也是「取消在二期也不会变强」的依据 |
| 客户端这一半从不接触 Jupyter 线协议（ZMTP / 签名密钥 / channel 名只存在于宿主 4 个文件里）；宿主有 `KernelSessionHandle` 接口与 `createSession` 注入缝。 | 复用单元格视图的代价只是三个 Jupyter 专有语义 |
| `sanitizeKernelHtml` 的属性白名单**不含 `class` / `style`**，允许标签**不含 `button` / `input`**。 | 分页、耗时、截断、取消这些控件**一律由客户端渲染在结果块外围**，宿主不得写进结果 HTML |
| 净化器允许标签含 `table/thead/tbody/tr/th/td/caption/small/code/em`，表格样式已在 `notebook.module.css:569-578`。 | ~~结果走 `text/html` 时客户端零新增渲染代码~~ **A3 改为客户端从 `SqlResultBlock` 渲染**：契约里已经带着列标签/真名/声明类型/BLOB 字节数与三个截断计数，宿主再拼一遍等于把归一化规则印第二份，还会让最坏 64MB 一块的载荷翻倍；代价是本文那句「零新增渲染代码」不成立（`sql-result.ts` + `SqlResultBlockView.tsx`） |
| `.db` 第 15 字节必为 NUL，DSH `readText` 采样命中 → 今天打开 `.db` 得到的是 **400 / `FS_NOT_TEXT`**（>2MB 才先撞 413）。 | 旧文案不动，只把入口做对（N0-P0-8） |
| `@codemirror/lang-sql` 已是依赖（`editor-languages.ts:12`），`.sql` 早已识别；识别表里没有 `db`/`sqlite`。 | SQL 高亮零成本；扩展名要新增 |
| `db.function()` 注册的 UDF 里 `throw` **能**中止语句，但它要求 SQL 真去调用你的函数。 | 不做，因为那等于改写用户 SQL |
| `diagnostics_channel` 的 `'sqlite.db.query'` 在本 runtime 没有发布者（订阅 hits=0）。 | 连「观测到语句在跑」都做不到 |

### 被接受的风险（明写，别下次再吵）

- **结果块不加总字节闸门**。行 1000 × 列 64 × 单值 1000 字符，最坏约 **64MB** 一个结果块（纯文本，还没算 JSON 转义，之后还要拼成 HTML 字符串）。这是明确选择，不是遗漏；真出问题就调小 §4 里那几个常量。
- **一期不做输入补全**，尽管侧栏已经拿到全库表名与列名。
- **只读 WAL 库会在用户工作区留下两个文件**，一期清不掉（见上表）。

---

## 4. 设计决定（本文之外的文档已承载）

| 主题 | 决定 | 记在哪 |
| --- | --- | --- |
| 后端选型 | 内置 `node:sqlite`，不引入 kernelspec | ADR 0001 |
| 复用边界 | 复用客户端单元格视图；传输/会话另起一组 `/sqlnotebook` POST | ADR 0002 |
| 执行形态 | 一期主线程分块 + 让出；二期一连接一 worker（前置取证 §6） | ADR 0002 |
| 文件格式 | `.sqlnb` JSON：版号 + 格类型 + 格文本 + 连接配置（库路径与档别）+ 每格结果与 `In[n]`/耗时；**不存格 id**。v1（仅源文本）保持可读可写，首次写入升到 v2 | ADR 0003（格式选择）、ADR 0007（记连接与结果） |
| 写权限 | 默认只读 + 显式切档 + 确认；两档共用一份 authorizer 拒绝集 | ADR 0004 |
| 结果表示 | 行以数组返回，列名与列序取自 `columns()` | ADR 0005 |
| 执行语义 | 连接会话级持久；一格多语句逐条执行、各出结果块、失败停在当前条、**不隐式包事务**；同笔记串行排队；`In[n]` 会话内计数，**且随结果落盘**（ADR 0007） | 本文 |
| 闸门 | 行上限默认 1000（`setting` + 面板临时覆盖、不写回）；列 64 / 单值 1000 字符 / 树表 100 / 连接 16 / 时长 15s 全为常量 | 本文，形状照 `src/index.ts` 的 `gitGraphPageSize` 与 `src/host/git-backend.ts:192-202` 的 `pageSize+1` + `truncated`/`nextOffset` |
| 连接生命周期 | 一笔记一连接，关标签即断（有格在跑时**拦住关闭**）；断开/关标签前自动 `ROLLBACK` 并告知（**实现注**：真正关连接的路径是「断开」按钮，同步在那里报回滚；关标签走 `abandon`、手柄进宽限期，那一刻没有回滚可报，要在这里也告知得先改宽限期的语义）；客户端断开给 **60s 宽限期**，期内接回原句柄，过期须手动重连、**不自动重开**；切工作区释放该工作区全部连接 | 本文 |
| 占用 | 同一库文件只要有任何活动连接（含正在分页、含宽限期内）就**拒绝切可写档**；只读连接不限数量 | `GLOSSARY.md` 的「占用」 |
| 跨页面 | 同一 `.sqlnb` 在两页打开**共用一份连接**（临时表彼此可见）；结果各页各显示，但都从同一份文件记录恢复 | 本文、ADR 0007 |
| 上限实现 | 不改写用户 SQL；靠惰性迭代取 N+1 即停。分页只在语句含 `ORDER BY` 时提供，重跑同一段语句只换 offset（实测：同文本查询同进程/跨连接一致，但那是计划序，换投影列就变序） | 本文 |
| 内存库 | `:memory:` 在选择器里与文件库并列；**无档别概念，一律可写**，UI 不显示只读/可写切换 | 本文 |
| 报错 | 错误块落原结果位置 + 行首红标；原样透出一行 SQLite 消息，另加专用错误码；SQL 原文不进日志与响应 | 本文 |
| 术语 | 「SQL 笔记」与「笔记本」硬切分；连接 / 单元格 / 中间成果 / 占用 / 宽限期 / 列标签 / 活动连接 / 原始视图 / 结果块 | `GLOSSARY.md` |

---

## 5. 开发计划（一期）

| 里程碑 | 内容 | 人日 | 依赖 |
| --- | --- | --- | --- |
| **A0** | 把 §3 的实测事实固化成常驻场景（探针 + spec），改动落地前它们必须为**红**。特别是：分块让出确实把同期路由拉回毫秒级、大整数不归一化就整条请求失败、重复列名不转数组就丢值、authorizer 拒绝集逐条命中 | 0.5–1 | — |
| **A1** | 宿主 `/sqlnotebook/open·execute·close·tables·columns` 一组 POST：连接生命周期（含宽限期、占用判定、上限 16）、`readOnly` + authorizer 拒绝集 + `allowExtension: false`、`readBigInts` + `setReturnArrays`、归一化（大整数→字符串、BLOB→base64+上限、NULL）、`temp_store=2`、分块取行 + 块间让出 + 15s 时长上限。**A3 又加了一条 `/cancel`**（本行原只列五个）：工单要求「取消 = 停当前格」而 A1 没给任何中断手段，于是在行循环已有的块边界检查点上补了一个 per-notebook 取消标记 | 1.5–2 | A0 |
| **A2** | `.sqlnb` 解析与写回（新文件，`parse` **永不抛**、未知格类型降级只读原始格、版号不认识整文件只读、绝不自动重写）+ 扩展名接入（文件树、打开链路、`workbench-types.ts` 的 mode 字段、`EditorTabBody` 分派、`editor-languages` 识别 `sqlnb` 为 SQL）+ 三条入口（新建菜单、双击 `.db` 自动建 `query-<n>.sqlnb`、右键） | 1–1.5 | A1 |
| **A3** | 客户端接线：复用单元格视图跑在 `/sqlnotebook` 上（**不进**内核 registry / SSE）、`In[n]` 会话内计数、运行/清空不标脏、取消（含队列清空）、耗时、错误块 + 行首标记、markdown 格只渲染、快捷键沿用 | 1–1.5 | A1 A2 |
| **A4** | 侧栏面板 + 窄栏快捷条 + 状态条读数 + schema 树（懒加载、上限 100 与截断提示、表名需自己校验后拼进 SQL——实测表值函数不能传参）、`-wal`/`-shm` 在侧栏列表过滤、库文件消失时专用错误码提示重连。**实现注**：内存库「随笔记关闭而消失」做成面板上的常驻行，不是建连接与首次建表各提示一次——这条事实整个会话里都成立，一闪而过的提示容易在它描述的表出现前就消失；自动连接的目标由入口决定（带库的两个入口连那个库，从零建的才接 `:memory:`），因为双击 `.db` 那份的首格就是列这个库的表 | 1–1.5 | A1 |
| **A5** | README 中英同步（只写能力面与「零安装」一句，不写 Node 版本细节）；本文与 5 篇 ADR、`GLOSSARY.md` 的口径核对 | 0.5 | A1–A4 |
| 一期合计 | | **5.5–8** | |

二期（分页、下载、活动连接列表、worker 化）另计 **3–5 人日**，其中 worker 那部分必须先跑完 §6 的前置取证。

PR 切分（顺序不能改，A1 之后可并行）：

```
A0  test(sql): node:sqlite 在宿主 runtime 的行为场景（先红）
A1  feat(sql): /sqlnotebook 后端与连接生命周期
A2  feat(sql): .sqlnb 格式与三条入口
A3  feat(sql): 单元格视图接 /sqlnotebook
A4  feat(sql): 侧栏面板、schema 树、窄栏与状态条
A5  docs: README 中英 + 本模块能力边界（外部内核那条路已废弃，不再修订它）
```

---

## 6. 二期的开工前置（本轮未完成的取证）

一期选的是主线程分块。二期换「一连接一 worker」之前，下列每一项都必须先在宿主 runtime 上实测通过——本轮曾派探针去测，**中途被打断，至今没有结论**：

1. worker 内 `setAuthorizer` 是否与主线程**同样生效**（拒绝集逐条复测）；`constants` 在 worker 里是否完整。
2. `terminate()` 与 worker 内 `db.close()` 的先后语义：不 close 就 terminate 时 `-wal`/`-shm` 是否残留、未提交事务是否消失、`integrity_check` 是否 ok——本文 §4 写的「断开 = worker 内 close 再退出」这条清理路径能不能靠 `terminate()` 兜底。
3. `BigInt` / `Uint8Array` 跨 `postMessage` 的结构化克隆语义（主线程收到的 `typeof`；`Uint8Array` 是否仍是 `Uint8Array` 而非 `ArrayBuffer`；BLOB 走 transfer list 是否更快）。
4. 16 个常驻 worker 的内存与冷启成本 → 用来复核「连接上限 16」该不该下调。
5. 宿主侧 `await` worker 回消息期间，同期路由是否正常应答、`setTimeout` 是否真触发（这是二期还能保留 §4 时长上限的前提）；超时后 worker 迟到的回消息会不会抛或泄漏。
6. 新增一个 tsdown 宿主入口（`platform:'node'`、`target:'es2024'`）与 `package.json` 的 `files` 白名单逐名登记：实测**没有任何现有测试断言 `files` 数组内容**，漏加不会被拦住，所以这条要补一条 spec 断言。

---

## 7. 外部 SQL 内核这条路已废弃

仓库里曾有 `docs/sqlite-kernel-plan.zh.md`，规划给笔记本加一个外部 Jupyter SQL kernelspec（`jupyter-duckdb`）。该文件已从工作树删除，本文不再引用它；它的结论按下面几条处置，其中被否掉的备选与取证过程已收进 [ADR 0001](./adr/0001-node-sqlite-as-sql-notebook-backend.md)，免得下次又有人重新调研一轮。

- **整条路作废**。它要用户自建 venv、装 `jupyter` 元包、再手动注册 kernelspec 才能看见功能；而 §3 已实测宿主 runtime 上 `node:sqlite` 开箱可用。本模块因此与笔记本的内核链路完全无关——它原来担心的关卡 A（`discovery.ts` 只认 `language === 'python'`）与关卡 B（`kernel-session.ts` argv 里没有已知 launcher 时静默换成 ipykernel）**都不必改**，因为没有任何非 ipykernel 的 spec 会进入本模块。这两处代码仍是潜在缺陷，但那是笔记本那条路的债，不排在本文里。
- **它原先设想的「`.db` 文件浏览器」已被本模块吸收**：连接选择器、库→表→列浏览树、双击建格、上限与截断提示，覆盖并超过了那条路。不要再单独开工。
- **它记错过一次 runtime**：曾写「本机 Node v24.20.0 已实测」，那测的是开发机 PATH 上的 node，宿主实际是 Electron 44 内嵌 Node v24.18.1（§3 第一条）。两版结论都是 `node:sqlite` 可用，所以那条废弃路径的判断本身不受影响。
- 它当年排除 `xeus-sqlite` 的理由仍然成立且与本模块无关：官方不发 Windows 包，且本仓的 bridge 必须以 Python 解释器启动。

---

## 8. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 慢查询停摆宿主全部路由（实测 4336ms） | A0 把「分块让出」做成能变红的场景；§3 已证行上限救不了聚合 |
| 大整数 / BLOB 不归一化 → 整条请求 400 或静默出垃圾 | A0 场景 + A1 在 `sendJson` 之前完成归一化 |
| 重复列名静默丢值，用户看不出表少了一列 | ADR 0005：行一律数组；A0 用 `SELECT 1 AS x, 2 AS x` 钉住 |
| `readOnly` 被误当成「只能跑查询」，后来人去加语句白名单 | ADR 0004 与 `GLOSSARY.md` 都写明：只读约束的是本库被改写，跨库面另由 authorizer 拦 |
| authorizer 返回布尔 → 每条语句失败；按值反查名字 → 判定错乱 | §3 两条实测事实 + A0 场景逐条命中拒绝集 |
| WAL 库留下 `-wal`/`-shm`，用户以为本模块改了他的工作区 | 明写进「已知限制」；不用 `?immutable=1`（会静默少读） |
| 未走完的分块扫描持读事务，卡住同文件的写 | 「占用」判定：任何活动连接（含分页、含宽限期）都拒绝切可写档 |
| 取消按钮被理解成「能停任何查询」 | 文案限定为逐行产出的查询；聚合类走 N0-P0-8 的实话 |
| 复用单元格视图时顺手抄进 Jupyter 语义（`installHint` 文案、restart/interrupt、输出写回 draft） | ADR 0002 已列三个门禁；A3 的验收要覆盖「运行不标脏」 |
| 漏加 `files` 白名单导致产物缺文件（二期 worker） | §6 第 6 条：补一条 spec 断言，而不是靠注释「失败可见」 |
| 宿主 Node 升级（Stability 仍 1.2 RC，未来类名改 `Database`） | 集中一处 import + `Database ?? DatabaseSync` 前向别名；新增常驻门禁 `npm run test:sql` |
| `npm run test:bundle` 只验 `lib/client.js`，新宿主文件不在任何端到端门禁内 | `test:sql` 补上这一格 |

---

## 9. 门禁与交付门槛

四条常规全绿（AGENTS.md）：

```sh
npm run typecheck   # 新 spec 必须先加进 tsconfig.test.json 的 files 白名单
npm test
npm run build
npm run test:bundle
```

本模块**不碰 `src/host/kernel/**`**，所以 `test:kernel` / `test:example` / `test:isolation` 三条内核门禁不适用；取而代之新增一条常驻门禁（A0 已交付：`scripts/probe-sql.mjs` + `scripts/probe-sql-scenarios.mjs`，`package.json` 已挂 `test:sql`，README 中英已同步）：

```sh
npm run test:sql              # 全量：事实层 + 全部闸门层
npm run test:sql -- --only A1 # 只看某个里程碑的闸门（--only=A1 同义）
```

它分两层报告，**退出码是契约的一部分**：

| 退出码 | 含义 |
| --- | --- |
| 0 | 事实层全绿，且所选闸门全绿 |
| 1 | 事实层全绿，所选闸门仍未实现（A0 交付时就是这个状态，属预期） |
| 2 | **事实层有断言翻转** —— 宿主 runtime 的行为变了，本功能建立在一条已不成立的结论上；或门禁脚本自身崩溃 |

设计上有两条不能让步：

- **门禁必须跑在宿主 runtime 上**（Electron 内嵌 Node），因为 §3 全部事实都是从那儿量来的。`probe-sql.mjs` 用 `--host <路径>` → `DSH_HOST_EXE` → 定位正在运行的 DSH 进程这三步找到宿主可执行文件，然后以 `ELECTRON_RUN_AS_NODE=1` 重新执行场景包；**找不到就报错退出，绝不退回到 PATH 上的 node 去量一个错的 runtime**。
- **负向断言不许被"端点不存在"满足**。首版有两条门禁用 `error !== undefined` 判"被拒绝"，于是在路由还没实现时就绿了——那正是 AGENTS.md 禁止的 `expect(true).toBe(true)`。所有拒绝类闸门都要求**专门错误码**。

### 门禁定义的错误码契约（A1/A4 必须照此实现）

| 错误码 | 触发 | 里程碑 |
| --- | --- | --- |
| `SQL_WRITE_OCCUPIED` | 同一库文件已有活动连接时再开可写连接（含分页中、含宽限期内的连接） | A1 |
| `SQL_AUTHORIZATION_DENIED` | authorizer 拒绝的语句（`ATTACH`、名单内 PRAGMA、只读档下的主库写） | A1 |
| `SQL_INVALID_TABLE` | schema 路由收到不是普通标识符的表名（含引号、分号、空白） | A4 |

三者都要在 `publicFailureMessage` 里补中英文案分支，且响应与日志里不得出现宿主绝对路径或 SQL 原文。

其余硬约束：新文案同时进 `src/client/core/locales.ts` 中英两本字典并在消费它的 labels 对象补字段；宿主路由只接受官方工作区 id 与工作区相对路径、复用 `workspace-backend.ts` 的 `resolve()` 那道闸（越界与符号链接）、绝对路径只当参数用绝不回传；客户端不得新增运行时依赖；README 两个文件不得出现个人路径、盘符路径或 `localhost`/`127.0.0.1`/`192.168.*` 示例（`tests/package-manifest.spec.ts` 会拦）。

### 必红的核心用例（每条都对应 §3 的一条实测事实）

1. 归一化：结果含 `9007199254740993` → 响应里是字符串、状态 200，且**不是** 400；含 32MB BLOB → 走 base64 且有长度上限。
2. 重复列名：`SELECT 1 AS x, 2 AS x` → 两个值都在、列标签可区分、`columns()` 真名保留。
3. 不阻塞：一条被 15s 上限拦住的慢查询期间，一条真实的既有宿主路由仍在毫秒级应答。
4. authorizer 逐条：`ATTACH` 被拒、`PRAGMA query_only=ON` 被拒、`PRAGMA wal_checkpoint` 被拒、主库 `INSERT`/`CREATE TABLE`/`DROP INDEX` 被拒，而 `CREATE TEMP TABLE` + 写入 + 与主库 JOIN + `BEGIN`/`SAVEPOINT`/`COMMIT` **全部放行**。
5. 只读承诺：只读档跑完整套试查询后，库文件字节哈希不变。
6. 格式健壮：`.sqlnb` 被手改坏、格类型未知、版号不认识 → **不抛、不重写文件**，错误态指出哪一格，未知格降级为只读原始格。
7. 不标脏：运行一格、清空输出，tab 仍是未脏；改格文本才脏。
8. 占用：同一文件已有只读连接时切可写 → 被拒且有专门文案；宽限期内的连接同样被算作占用。
9. rail 计数：`tests/mode-switch.spec.tsx:97` 断言改成 9，且新图标在 `terminal` 与 `kernels` 之间。
10. 文案对等：`sqlnotebook.*` 中英键集合相等、值非空、占位符一致（`tests/locales.spec.ts` 已拦）。

---

## 10. ADR 索引

- [0001 后端用 node:sqlite](./adr/0001-node-sqlite-as-sql-notebook-backend.md)
- [0002 复用单元格视图，不复用会话与传输](./adr/0002-sql-notebook-reuses-notebook-cells.md)
- [0003 `.sqlnb` 文件格式](./adr/0003-sql-notebook-format.md)
- [0004 默认只读 + authorizer 拦跨库](./adr/0004-readonly-default-with-authorizer.md)
- [0005 结果行以数组返回](./adr/0005-result-rows-as-arrays.md)
- 词表：[GLOSSARY.md](../GLOSSARY.md)
