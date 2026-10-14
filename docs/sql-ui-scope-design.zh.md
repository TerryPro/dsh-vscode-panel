# SQL 界面职责划分 · 逐条改动设计稿

> **这份文件的用法**：它是本仓库既有的 `docs/` 设计稿形状（对照 [notebook-change-design.zh.md](./notebook-change-design.zh.md)），可以原样作为 GitHub issue 发布：
> `gh issue edit <n> --body-file docs/sql-ui-scope-design.zh.md`，或 `gh issue create --title "SQL 界面职责划分：连接面在中栏，结构面在侧栏" --label ready-for-agent --body-file ...`。
> 本仓的工单按 [docs/agents/issue-tracker.md](./agents/issue-tracker.md) 落在 GitHub Issues 上，本文是它的文件形态。

**一句话**：`.sqlnb` 的连接控件在**中栏工具条**与**侧栏面板**各画了一套（数据库下拉、档别下拉、扫描、连接/断开、连接状态读数），两处都自称是同一份运行时的视图，于是读者不知道哪套是正牌，每条新规则（内存库无档别、连接后锁定、截断提示）都要在两边各写一遍。本稿把**连接面收归中栏工具条**、**结构面收归侧栏面板**、**状态条只报别人没说的事**，并据此清掉重复的控件、提示与死代码。

约定：

- 每条编号 `S<n>`，按落地顺序排列。
- 「落点」写到文件:行级；**行号是写本文时（HEAD `2c6b25d`）的值，动手前先 grep 锚点文本**——本仓长期有并发改动，行号只能当线索。
- 「测试」写清断言落在哪个真实输出面上（AGENTS.md 的交付门槛要求）。
- 本稿**不新增任何宿主路由、不新增客户端依赖、不改 `.sqlnb` 格式**，因此标注 `🔗` 的条目一条都没有。

---

## 0. 收敛后的分工

| 界面 | 负责 | 不再负责 |
| --- | --- | --- |
| **中栏 `.sqlnb` 工具条** | 运行/清空/取消/增删格等单元格动作；**连接的全部**：选库、选档、扫描、连接、断开、连接读数、连接被拒的原因、连接域提示 | — |
| **侧栏 SQL 面板** | **只做结构**：库 → 表/视图 → 列的浏览树、展开列、双击插 `SELECT *`、表行右键菜单、刷新结构 | 选库、选档、扫描工作区、连接、断开、状态读数、连接域提示 |
| **编辑器状态条** | 源码视图下的连接读数整句（工具条不在场）；单元格视图下只报**工具条不会说的事**（库文件失联需重连） | 单元格视图下重复库名与档别 |

三个决定背后是同一条既有判据，来自 `ca2296c` 的提交正文：**提示留在离它解释的东西近的那一处**，远的那份是噪音。（那次它删掉了中栏两条横幅、保留侧栏那两份，正是因为侧栏那份紧贴着它解释的库文件列表。这次库文件列表搬到中栏，那份提示跟着搬。）

### 与既成记录的偏离（必须一起改，不能让它悄悄不一致）

1. **反转 [#16](https://github.com/TerryPro/dsh-vscode-panel/issues/16) 票面**。该票「做什么」原文写的是「**侧栏放连接选择器** + schema 树；状态条给连接读数」。本稿把连接选择器移到中栏工具条。7 篇 ADR 里**没有任何一篇**对「面板 vs 工具条」的界面归属做过决定（ADR 0002/0007 的归属决定只有一条：「连接归笔记」，指的是连接的生命周期而不是控件的位置），所以这次不推翻 ADR，但推翻票面，需在提交正文点名。
2. **改写需求文档 N0-P1-8 的替代说明**（[sqlite-workbench-requirements.zh.md:43](./sqlite-workbench-requirements.zh.md)）。该行现写「它原本要防的误解……现在**只在侧栏面板的『断开』按钮上说明**……中栏工具栏的断开按钮没有这层提示」。S5 把 `disconnectHint` 挂到中栏断开按钮之后，这句必须跟着改，否则文档反过来指错地方。
3. **重写 `SqlPanel.tsx` 的头注释**（第 9–11 行）。现文写「every button here is one the surface also offers, so the two can never disagree about what is connected」——那是**靠共用运行时保证不矛盾**，本稿改成**靠不重复来保证**，这段自陈失效。同时改 `SqlPanel.tsx:2-7` 的「Which notebook it describes」段（它仍成立，只是描述对象从「连接」变成「结构」）。

---

## S1 面板收缩为纯结构树

**落点**

- [src/client/sql/SqlPanel.tsx](../src/client/sql/SqlPanel.tsx)：删第 39–40 行的 `pickPath` / `pickAccess`、第 67–73 行的 `listDirectory` + `useDatabaseScan`、第 97–101 行的「用文件记录回填选择器」effect、第 213–228 行的 `chosenTarget` / `memoryPicked` / `connectAccess` / `canConnect` / `problem` / `readout`、第 234–269 行的两个 `<label className={css.field}>`（库下拉与档别下拉）、第 270–291 行的连接/断开按钮、第 292 行的 `.readout`、第 293–297 行的 `.problem`、第 298–300 行 `.memoryNote`、第 306–308 行 `walSidecarNotice`、第 309 行 `scanTruncated`。
- 随之失效的 import：`parseSqlNotebook`（与 `appendSqlCell` 同在第 20 行，**只去掉前者**——后者是 `insertSelect` 的写盘路径，必须留）、`connectionReadout`（第 22 行整行删）、`SQL_MEMORY_TARGET` 与 `SqlAccess`（第 16 行，同行的 `SqlColumnEntry` / `SqlTablesResult` 留下）、`useDatabaseScan`（第 24 行整行删）。`messageOf` 仍留（第 18 行，`loadSchema` / `toggleTable` / `insertSelect` / S8 的复制失败都要用）。
- [src/client/sql/sql-panel.module.css](../src/client/sql/sql-panel.module.css)：删 `.field`（第 85 行起，只被那两个 label 用）、`.select`（第 97 行起）、`.primaryButton`（第 109 行起，含 `:hover` / `:disabled` 三条）、`.readout`（第 130 行起）、`.memoryNote`（第 146 行起）。**留** `.fieldLabel`（第 92 行，结构区仍在用）、`.problem`（第 136 行，`schemaProblem` 仍在用）、`.muted`（第 151 行，`schemaLoading` / `schemaEmpty` / `schemaTruncated` 仍在用）。`.schemaHeader`（第 170 行）本步**不删**，它是 S2 与 S3 合起来才腾空的，见 S9。

**保留不变**（逐条核对过，它们是面板存在的理由）：`notebookLine`（第 233 行）、`loadSchema`（第 109–116 行）、连接变更清空 + 重读（第 118–125 行）、执行签名变化自动重读（第 127–142 行）、`sql.refreshSchema` 的消费（第 146–154 行）、`toggleTable`（第 156–167 行）、`insertSelect`（第 175–186 行）、结构区（第 316–373 行）。

**取舍**

- 面板**仍需** `bind` + `autoConnect`（第 45–52 行）：面板要显示结构，就得先有一条连接；而编辑器可能正显示一个 `.ts`，此时面板是唯一在场的 SQL 界面，由它恢复连接是对的。第 48–51 行那段注释仍成立。
- 面板**不再需要** `listDirectory`，`workspaceId` 仍需要（`sqlTables` / `sqlColumns` 要它）。
- **`connectionProblem` 不再在面板显示**。它在面板里唯一的作用是解释「为什么树是空的」，而这件事由 S4 的「未连接 + 指路」承担；原因本身是**要采取行动的事**，归工具条（`SqlNotebookSurface.tsx:592-594` 已经在显示它）。代价如实说：编辑器显示别的文件时，读者在面板里只看到「未连接」，要看到原因得切到笔记——「指路」文案正是为此而加。

---

## S2 面板只留一枚按钮，且它是「刷新结构」

**落点**

- [src/client/sql/SqlPanel.tsx](../src/client/sql/SqlPanel.tsx)：第 191–200 行头部那枚 `⟳` 的 `aria-label` / `title` 从 `sqlnotebook.rescan` 改成 `sqlnotebook.refreshSchema`，`onClick` 从 `rescan` 改成 `loadSchema`，`disabled={scanning}` 改成 `disabled={connectedPath === null}`；第 320–328 行结构区小标题里那枚 `⟳` **整个撤掉**（连同 `.schemaHeader` 里它的包裹）。

**为什么**：头部那枚现在是「重新扫描工作区」，它存在的唯一理由是喂面板里的库下拉（第 191–200 行）——下拉一走，它重扫的结果在面板里无处可显，而工具条自己有重扫按钮（`SqlNotebookSurface.tsx:543-545`）。同时真正的「刷新结构」现在缩在结构区小标题里，位置比它该在的地方低一级。两枚合一，面板只剩一个刷新动作。

**取舍**：面板从此**不扫描工作区**，`useDatabaseScan` 的唯一消费方变成 `SqlNotebookSurface`（S9 里改它的头注释）。这是净简化：面板从 377 行降到约 210 行。

---

## S3 面板标题改为「结构」，撤掉结构区小标题

**落点**

- [src/client/sql/SqlPanel.tsx](../src/client/sql/SqlPanel.tsx) 第 190 行：`t('sqlnotebook.panelTitle')` → `t('sqlnotebook.schema')`。
- 同文件第 318–319 行的 `.schemaHeader` 里那句 `<span className={css.fieldLabel}>{t('sqlnotebook.schema')}</span>` 撤掉（S2 已撤掉同一行的按钮，这一行整体消失）。

**理由**：面板现在只装一棵表结构树，标题叫「SQL 连接」与内容不符；而标题既然叫「结构」，结构区再画一个小标题就是同一句话在同一面板里说两遍——沿用本仓既有规则（[#5](https://github.com/TerryPro/dsh-vscode-panel/issues/5)「两个面板不重复报告同一事实」、`NotebookKernelStatus` 的 `hideChip`）。

**文案连带**：`sqlnotebook.panelTitle` 失去消费方 → 删（S9）。

---

## S4 未连接时的面板：说「未连接」并指路

**落点**

- [src/client/sql/SqlPanel.tsx](../src/client/sql/SqlPanel.tsx)：结构区现在整块挂在 `connection !== null` 后面（第 316 行）。改成：`connection === null` 时渲染一行 `t('sqlnotebook.notConnected')` 加一行新文案 `t('sqlnotebook.connectInToolbar')`。
- [src/client/core/locales.ts](../src/client/core/locales.ts)：新增 `sqlnotebook.connectInToolbar`，中英各一条。

**文案（建议值）**

| key | zh | en |
| --- | --- | --- |
| `sqlnotebook.connectInToolbar` | `在笔记工具栏里选择数据库并连接` | `Pick a database and connect from the notebook toolbar` |

**理由**：面板不再持有任何连接控件，一个空的「结构」面板会让读者不知道下一步去哪。不写这句的话，「连接入口在哪」这件事在整个侧栏里没有任何交代。

**已知取舍**：未连接时结构树不渲染，所以「双击表名插查询」这个手势在未连接时没有入口。**接受**——`insertSelect` 开头就是 `if (connection === null) return`（第 176 行），未连接时它本来也是空操作，所以不会出现「点了没反应」。

---

## S5 工具条承接连接域提示（title）

**落点**：[src/client/sql/SqlNotebookSurface.tsx](../src/client/sql/SqlNotebookSurface.tsx)

- 数据库 `<select>`（第 515–527 行）**目前没有 title**。给它一条合成 title：`scan?.truncated === true` 时拼上 `labels.scanTruncated`，已连接时带上完整读数（`connectionReadout(connection, ...)`）。**两个事实共用这一条 title 是刻意的**：`.pickerSelect` 有 `max-width: 220px`（[sql-notebook.module.css:333-343](../src/client/sql/sql-notebook.module.css)），长库名会被省略号截断，而读者唯一能看全它的地方就是这个悬停位；把截断说明与完整读数放同一条，读者一次悬停就同时得到「我看的是哪个库」与「这个列表不全」。
- 断开按钮（第 563–578 行）加 `title={labels.disconnectHint}`。**它现在没有 title**——`ca2296c` 的提交正文亲手记下了这个缺口：「中栏工具栏的断开按钮其实没有提示（只有侧栏面板那个有 `disconnectHint`）」，并写明「本轮一度想把提示加到中栏按钮上，那是超出『删除』这个要求的改动，已撤销」。**本条就是那次被推迟的改动**，不是新发明。
- `SqlNotebookLabels`（第 58–140 行）新增四个字段：`scanTruncated`、`disconnectHint`、`memoryNotice`、`walSidecarNotice`。前两个由本节消费，后两个见 S6。注意 `scanTruncated` 是**回加**：`ca2296c` 从 labels 里删过它，因为当时侧栏是直接 `t()` 取的、不走 labels；现在消费方在组件里，必须走 labels。
- [src/client/editor/EditorTabBody.tsx](../src/client/editor/EditorTabBody.tsx) 的 `sqlNotebookLabels`（第 261–322 行，连接相关的字段在 305–315 行）补上这四个 key。

**为什么这两条用 title 而不是可见行**：它们都是**条件性事实**（工作区截断只在库多时成立；断开前警告只在有连接时才有意义），而且都只与一枚具体控件绑定。常驻显示会让工具条长期挂着一条与当前动作无关的话——那正是 `ca2296c` 删两条横幅时用的理由。

---

## S6 工具条承接连接域常驻提示（提示区两行）

**落点**：[src/client/sql/SqlNotebookSurface.tsx](../src/client/sql/SqlNotebookSurface.tsx) 第 589–594 行那条**已经存在**的提示区（`news` 用 `.notice`、`connectionProblem` 用 `.noticeError`，都在这里）。在它里面追加两条常驻行：

- `connection?.path === SQL_MEMORY_TARGET` 时显示 `labels.memoryNotice`（现于 `SqlPanel.tsx:298-300`）。
- `connection?.walSidecarExpected === true` 时显示 `labels.walSidecarNotice`（现于 `SqlPanel.tsx:306-308`）。

**为什么与 S5 分开**：这两条是**当前连接一直成立**的常驻事实（连着 `:memory:` 就一直该说「里面的表不会留在磁盘上」），只在悬停 tooltip 里说等于把它藏起来。而 `[#16](https://github.com/TerryPro/dsh-vscode-panel/issues/16)` 评论里「内存库提示做成常驻行、不是一闪而过」那条**已验收的实现注**（需求 §5 A4 行原文）也必须保住。

**澄清一处措辞**：前几轮讨论里说的「工具条不变」指的是**工具条那一行的控件集合不变**（不新增/不删减按钮，两个下拉仍在那里）。本节与 S5 给工具条**加了 title、给工具条下方那条提示区加了两行**，这不违背那句话，但必须在提交正文里说清，避免读成「工具条一个字节没动」。

---

## S6b 工具栏库下拉与档别下拉的锁定不对称（**本轮不做，另开票**）

核实工单时发现的一处既有缺陷，先记在这里，**不并入本轮改动**——理由见本节末。

**事实**（同一个工具条内的两条规则不一致）：

| | value | disabled |
| --- | --- | --- |
| 工具栏**库**下拉 | `pickPath`（文件记录的库）—— [SqlNotebookSurface.tsx:518](../src/client/sql/SqlNotebookSurface.tsx) | `!canConnect` —— **连接后仍可改**（第 519 行） |
| 工具栏**档别**下拉 | `pickAccess` | `!canConnect \|\| connection !== null` —— 连接后锁（第 536 行） |
| 侧栏库下拉（将被撤） | `connection?.path ?? pickPath`（实际连上的库） | `connection !== null \|\| !canConnect`（第 243 行）—— 锁 |

**后果**：连接打开时读者能改工具栏的库下拉，但那个位置此刻是「断开」按钮，没有任何动作会应用这个新值——读数照旧说旧的库。于是**同一个工具条可以同时显示两个库**：下拉显示刚改的，读数显示宿主实际连上的。ADR 0007 只在「主动连接成功」时把授予值写回记录，所以上面两种情形（改了没应用、连接被拒）它会一直不一致。这条 `9eca09c` 的 commit 正文其实点名过同类问题（「三处一致才看得出哪处在说谎」）。

**为什么不在本轮修**：修法是把侧栏那两条更严的规则搬到工具栏（`value` 改 `connection?.path ?? pickPath`、`disabled` 加 `connection !== null`），逻辑上正是「工具栏成了唯一连接面」的应有之义。但它在**行为**上动了工具栏，而本轮的边界是「只动面板与状态条」。这是一个独立的缺陷，有独立的验收，混进来会让这次改动既难评审也难回滚。

→ **另开一张 issue**：`工具栏库下拉在连接后可改且无动作应用它（与读数说两个库）`，`needs-triage`。

---

## S7 状态条读数让位

**落点**

- [src/client/sql/SqlConnectionStatus.tsx](../src/client/sql/SqlConnectionStatus.tsx) 第 19–27 行加一个 `hideReadout?: boolean`（照 [`NotebookKernelStatus.tsx:35`](../src/client/notebook/NotebookKernelStatus.tsx) 的 `hideChip` 先例命名与写法）；`text` 的推导（第 35–41 行）在 `hideReadout === true` 时**不再回落到 `connectionReadout(...)`**，只保留 `lostFile`（第 34 行）那一支：库文件失联时必须照旧说 `sqlnotebook.reconnectHint`，因为那是工具条不会说的事（工具条上的读数会照旧显示旧库名，直到读者点断开）。
- [src/client/editor/EditorTabBody.tsx](../src/client/editor/EditorTabBody.tsx) 第 466 行：`<SqlConnectionStatus ... hideReadout={sqlNotebookMode === 'notebook'} />`。

**理由**：单元格视图下工具条的读数胶囊与状态条说的是同一件事，两处各说一遍；源码视图下工具条不在场，读数整句接管。这正是 `NotebookKernelStatus` 的 `hideChip` 已经写下的规矩（「状态条只说别的界面没说的事」），照抄而不是新发明。

**与 README 的关系**：README 两处（zh:121 / en:120）承诺「单元格视图和源码视图都报」，S10 要把它改准——源码视图整句、单元格视图只报失联。**不是撤回承诺，是把承诺说准。**

---

## S8 表行右键菜单

**落点**

- 新建 [src/client/sql/SqlTableContextMenu.tsx](../src/client/sql/SqlTableContextMenu.tsx)，形状照 [CsvContextMenu.tsx](../src/client/csv/CsvContextMenu.tsx)：`Menu` + `getAnchorRect` + `portal` + `dense` + `compact`，`items` 由 target 决定，`onSelect` 走一个 `isSqlTableMenuAction` 窄化（同文件第 136–138 行的写法）。
- [src/client/sql/SqlPanel.tsx](../src/client/sql/SqlPanel.tsx) 第 342–352 行的表行 `<button>` 加 `onContextMenu`：`event.preventDefault()` 后存 `{ name: entry.name, rect: event.currentTarget.getBoundingClientRect() }`；双击插查询的手势（第 348 行）**原样保留**。

**四项**（全部落在已有能力上，不新增宿主路由）：

| 菜单项 | 实现 |
| --- | --- |
| 插入 `SELECT *` | `appendSqlCell(notebook.draft, selectAllFrom(name, connection.rowLimit))` + `controller.setDraft(..., 'input', tabId)`——即现在双击走的那条路径（第 175–186 行） |
| 插入表名 | 同一函数，源文本换成 `quotedSqlIdentifier(name)`（[sql-schema-tree.ts:13](../src/client/sql/sql-schema-tree.ts) 已有） |
| 复制表名 | `copyTextToClipboard(name)`（[core/clipboard.ts:2](../src/client/core/clipboard.ts) 已有） |
| 复制列名 | `copyTextToClipboard((columns[name] ?? []).map(c => c.name).join('\n'))`；该表的列**没读过就先读一次**（复用 `toggleTable` 里那条 `sqlColumns` 调用，抽成一个 `loadColumns(name)` 供两处用），读到空列表时菜单项 `disabled` |

**取舍**

- 不做「预览前 100 行」：那会在面板里再开一块结果区，与「面板只读结构」冲突，而且中栏双击一下就能看。
- 复制**成功不给反馈**（照 `EditorTabContextMenu` 的「复制路径」，仓里既有手势就没有成功提示，不发明新反馈）；**失败要给**——`copyTextToClipboard` 在无剪贴板权限时**会抛**（第 15 行），落进结构区已有的 `schemaProblem` 那一行（复用现有通道，不新增 UI），文案用新增的 `sqlnotebook.copyFailed`。

**新增文案**（中英各一条）：`sqlnotebook.insertSelect` / `sqlnotebook.insertTableName` / `sqlnotebook.copyTableName` / `sqlnotebook.copyColumnNames` / `sqlnotebook.copyFailed`。

---

## S9 死代码与文案清理

按本仓「没有消费方的东西要删掉」的约定（`ca2296c` 提交正文原话），随本轮连带清理：

| 项 | 位置 | 处置 |
| --- | --- | --- |
| `sqlnotebook.tier` | [locales.ts:468 / 1079](../src/client/core/locales.ts) | 删（唯一消费方是面板那个档别 label，第 256 行） |
| `sqlnotebook.panelTitle` | [locales.ts:465 / 1076](../src/client/core/locales.ts) | 删（S3 改用 `sqlnotebook.schema`） |
| `.field` / `.select` / `.primaryButton` / `.readout` / `.memoryNote` | sql-panel.module.css | 删（S1 已列） |
| `.schemaHeader` | sql-panel.module.css 第 170 行 | S2 撤掉它的按钮、S3 撤掉它的标题后，这一行整条腾空 → 删 |
| `.fieldLabel` | sql-panel.module.css 第 92 行 | 三个消费方（第 235、256、319 行）分别由 S1 与 S3 撤掉 → 全仓无消费方，删。**注意**：S1 单看时它还活着，别在那一步误删 |
| `.headerAction` | sql-panel.module.css 第 41 行 | **留**（S2 后它服务的是面板头部那枚刷新按钮，只是 `onClick` 换了） |
| `useDatabaseScan` 的头注释 | [use-database-scan.ts:1-10](../src/client/sql/use-database-scan.ts) | 改：不再是「两个表面问同一件事」，只剩工具条一个消费方 |
| `SqlPanel.tsx` 两段头注释 | 第 2–11 行 | 重写（见 §0 偏离第 3 条） |

**核对过的「看起来像死代码但仍在用」**，不要误删：`sqlnotebook.rescan`（工具条重扫按钮 + rail 的 title 仍用）、`sqlnotebook.tierLocked`（工具条档别下拉的 title 仍用）、`sqlnotebook.notConnected`（S4 与工具条读数都用）、`sqlnotebook.schema`（S3 后同时是面板标题）、`.problem` / `.muted`（`schemaProblem` 与三个 schema 状态行仍用）、`.headerAction`（面板头那枚刷新按钮仍用）。

---

## S10 文档留痕

- **新增 [ADR 0008「SQL 界面职责划分：连接面在中栏，结构面在侧栏，状态条只报别人没说的事」](./adr/0008-sql-ui-scope-split.md)**（承接 [0007](./adr/0007-sqlnb-records-connection-and-results.md) 的编号）。写清了：三条界面各自的职责、被反转的是 [#16](https://github.com/TerryPro/dsh-vscode-panel/issues/16) 票面（不是任何一篇 ADR）、那条判据来自 `ca2296c`（提示留在离它解释的东西近的一处），以及三条被否的备选。需求文档 §10 的 ADR 索引同时补上了此前漏收的 0006 与 0007。
- **[README.zh.md](../README.zh.md) 三处 + [README.md](../README.md) 三处**（中英必须对等）：
  - zh:119 / en:118「连接归笔记所有」段：现在把侧栏写成「列出工作区里的库……双击一张表就会把它的 `SELECT *` 写进一个新格」。改成：侧栏只列**已连接那个库**的表/视图/列（工作区库文件列表在中栏工具条），并把表行右键菜单的四项写上。
  - zh:121 / en:120「状态条会报」段：按 S7 改成「源码视图整句、单元格视图只报库文件失联」。
  - zh:187 / en:186「使用左栏模式切换会话、文件、Git、终端和内核」：**补上 SQL（与内核）**——活动栏实际是 9 枚按钮，这句只列了 5 个模式，是既有滞后，顺带修。
  - 另外 zh:28 / en:28 的左栏区域表也没列 SQL 面板与内核面板，同批补齐。
- **[GLOSSARY.md](../GLOSSARY.md) 第 43–45 行「活动连接」加注**：该词条写「列在 SQL 笔记侧栏自己的区域里」，而那块区域**至今不存在**（需求文档 §2 P2 把它列在二期）。加一句「该区域属二期；一期由中栏工具条的连接读数承担」，免得下一轮读者照词条去侧栏找它。
- **[sqlite-workbench-requirements.zh.md:43](./sqlite-workbench-requirements.zh.md)**：按 §0 偏离第 2 条改写 N0-P1-8 的替代说明。
- 本仓工作项按 [docs/agents/issue-tracker.md](./agents/issue-tracker.md) 落在 GitHub Issues：把本文发布为一张新 issue，并在 [#16](https://github.com/TerryPro/dsh-vscode-panel/issues/16) 上留一条评论指向它（该票已 closed，不改历史票正文）。

---

## 测试改动清单

### 要改的既有用例

**`tests/sql-panel.spec.tsx`（现有 15 例 / 2 个 describe）**

- `SqlPanel — 连接` 整个 describe（第 337–417 行，6 例）**删掉或改写**：它断言的全是面板里的连接控件（`getByLabelText(sqlnotebook.database)` 第 350/363/380/397 行、连接按钮第 370/383/400 行、`memoryNotice` 第 388 行、`disconnectHint` 第 390 行、档别第 368 行）。其中两例的价值要**搬到 `tests/sql-notebook-surface.spec.tsx`**（见下）：
  - 「lists the workspace databases, leaving the WAL sidecars out」（第 346–357 行）——断言的是扫描结果，那属于工具条。
  - 「shows why a connect was refused instead of looking unconnected」（第 393–404 行）——断言的是工具条那条 `role="alert"`。
- `panelNoNotebook`（第 342 行）、`panelNotebook`（第 415 行）、`walSidecarNotice`（第 325 行）、`memoryNotice`（第 388 行）四条断言换落点：前两条留在面板，后两条搬到 surface spec。
- 夹具里的 `api.listDirectory` mock（第 155–158 行）随 `useDatabaseScan` 一起删；`connect()` 辅助函数（第 189–196 行）改成直接驱动 `runtime.connect(...)`，不再点面板按钮。

**`tests/sql-notebook-surface.spec.tsx`（现有 51 例 / 4 个 describe）**

- 第 466–527 行那批连接用例的**断言不变**（它们找的本来就是工具条控件：第 479 行 `combobox` + `labels.database`、第 491 行 `labels.connect`、第 516 行 `labels.disconnect`、第 523 行档别）。**只有第 484 行的 `picker`** 会受 S5 影响，补一条 title 断言。
- 新增：`disconnectHint` 挂上断开按钮（回加 `labels.scanTruncated` / `disconnectHint` / `memoryNotice` / `walSidecarNotice` 四个字段后，第 64–137 行的 labels 构造对象要同步，否则 typecheck 直接红）。

**`tests/sql-connection-status.spec.tsx`（现有 4 例）**

- 补 `hideReadout` 两个方向：`true` 时不再输出 `connectionReadout` 那行；`true` 且库文件失联时仍输出 `reconnectHint`（第 98 行那例要继续绿）。

### 要新增的用例

1. **S1/S2/S3**：面板在已连接时**不含任何**连接控件——`queryByLabelText(sqlnotebook.database)` / `sqlnotebook.tier` 为 null、`queryByRole('button', { name: sqlnotebook.connect })` 为 null；头部那枚按钮的 `aria-label` 是 `sqlnotebook.refreshSchema` 且点击触发 `sqlTables` 再次调用（现有「re-reads the schema when the collapsed rail asks for it」第 297 行的孪生）。
2. **S3**：面板里 `sqlnotebook.schema` 这句**只出现一次**（标题是它，结构区不再画小标题）——用 `getAllByText(...)` 断言长度为 1。
3. **S4**：未连接时面板显示 `sqlnotebook.notConnected` + `sqlnotebook.connectInToolbar`，且不渲染任何表行。
4. **S6**：连 `:memory:` 后**中栏**出现 `memoryNotice`（从 surface 侧断言，不是面板侧）；只读开 WAL 库后出现 `walSidecarNotice`。
5. **S7**：单元格视图下状态条**不含** `库名 · 档别 · 上限` 那行，且工具条仍含；切到源码视图后状态条含它。（这条要挂在 `EditorTabBody` 而不是 `SqlConnectionStatus` 上，因为 `hideReadout` 的传参发生在那里。）
6. **S8**：表行右键弹出菜单且四项齐全；「插入表名」写进 draft 的是 `"city"`（带引号，断言原文而非断言「调用过」）；「复制列名」把列按行拼好传给剪贴板（`navigator.clipboard.writeText` 的 spy 参数）；剪贴板拒绝时走 `schemaProblem` 那一行而不是静默；未读到列时该项 `disabled`。

---

## 门禁与验收

四条必须全绿（AGENTS.md 的交付门槛）：

```sh
npm run typecheck     # 新增 locale key 与 labels 字段不同步会直接在这里红
npm test
npm run build
npm run test:bundle
```

**三条端到端探针（`test:kernel` / `test:example` / `test:isolation`）本次不跑**：本稿不碰内核链路（无 `src/host/kernel/` 改动、无 `.ipynb` 改动、无协议改动）。按 AGENTS.md 的要求，这条要在提交正文里**如实写明**「本次未触及内核链路，故三条端到端门禁未重跑」，而不是默默省略。

**改动量估算**：`SqlPanel.tsx` 377 → 约 210 行；新增一个菜单组件（约 90 行）与一个 ADR；locales 增 6 键删 2 键（中英各一份）；测试侧改 15 例、新增约 8 例。**不碰** `src/host/`、`src/shared/`、`.sqlnb` 格式、连接语义（工具条仍是「先断开才能换库换档」，`SQL_RECONNECT_REQUIRED` 那条闸门保持不变）。

> **估算修正（实施后回填）**：面板最终 377 → **329 行**，不是 210。删掉的连接层确实少了约 150 行，但工单 S8 要求把 `toggleTable` 里的列读取抽成 `readColumns` 供两处复用，加上 `copyOut` 的失败通道与右键菜单接线，净回收只有 48 行。**行数不是这轮的成果**，成果是"连接规则只剩一处可写"；按行数估工把这处算小了。「不碰 `src/host/`、`src/shared/`」这句也没有完全守住，见下面「实施记录」第 1 条。

---

## 风险

| 风险 | 缓解 |
| --- | --- |
| **反转票面带来的可追溯性断裂**：下一轮读者读 [#16](https://github.com/TerryPro/dsh-vscode-panel/issues/16) 会以为连接控件该在侧栏 | S10 的新 issue + #16 评论 + ADR 0008 三处互指；提交正文点名 |
| `tests/sql-panel.spec.tsx` 的连接 describe 被删后，**WAL 扫描过滤**与**连接被拒原因**两条覆盖丢失 | 已列进「新增/搬迁」清单（第 2、4 项），不是删掉了事 |
| 面板不再做工作区扫描后，**「库文件列表」只剩工具条一处**，窄栏收起时看不到 | 窄栏三枚按钮不变（`sql.refreshSchema` 的消费方仍是面板，请求仍成立）；库文件列表本来就是中栏的职责 |
| 状态条让位后，单元格视图下**长库名被工具条截断**（`.pickerSelect` `max-width: 220px`）时无处看全 | 接受；工具条那枚下拉的 `title` 已经是 S5 的落点，可在同一 title 里带完整读数 |
| 读者在面板里找不到连接入口 | S4 的指路文案；`insertSelect` 未连接时本就是空操作，不会出现「点了没反应」 |

---

## 实施记录（本轮落地时偏离本稿之处）

**1. 动了 `src/host/` 与 `src/shared/`，而本稿「门禁与验收」写的是不碰它们。**

不是扩范围，是本轮改动自己造出的一个事实错误：Host 的 `SQL_NOT_CONNECTED` 把 message **原样送到读者眼前**（`http.ts` 的 `errorResponse` 对 `WorkbenchHttpError` 透传 message），而那句写的是「请先在**侧栏**选择一个库」——侧栏的库选择器正是本轮删掉的东西。留着的后果是：读者被指向一个不再存在的入口。

改了 1 句字符串（`sql-backend.ts` 的 `mustFind`），并加了一条断言把这句话钉住（`tests/sql-backend.spec.ts`，`SQL_NOT_CONNECTED` 那条用例现在同时断言 code 与 message 含「笔记工具栏」）。**没有动任何路由、错误码、协议字段或行为**。另有 4 处注释（`sql-protocol.ts`、`sql-guards.ts`、`sql-runtime.ts` ×2、`sql-connection-readout.ts`）原本断言"连接读数/警告由侧栏负责"，随本轮改成陈述现状；泛指客户端渲染层的 "panel" 措辞未动。

**2. `-wal`/`-shm` 不进库列表这条覆盖，原来真的只靠面板那句断言活着。**

本稿「风险」表把它列为"要搬过去别丢"，落地时核实：`isDatabasePath` 是按**扩展名**匹配的，`demo.db-wal` 落网纯属后缀不匹配的副产物，`tests/sql-backend.spec.ts` 的 `isDatabasePath` 那组用例和 `sql-database-scan.spec.ts` 都没有钉住它。所以补了一条 `scanDatabases` 用例（列出的只有 `demo.db`），而不是搬到 surface spec 去断言一个 UI 文案。

**3. S6b 的缺陷在本轮**没有**被顺手修**，与工单一致**。** 工具栏库下拉连接后仍可改、且与读数可以同时说两个库——这条留着另开票，因为修它要在行为上动工具栏。

**4. 门禁实际结果**：typecheck 绿；`npm test` **1395 passed（108 文件）全绿**；build 绿；test:bundle 绿。三条端到端探针（`test:kernel`/`test:example`/`test:isolation`）**未跑**：本轮未触及内核链路。

用例数逐文件核对（本轮净增 15 条，不是"删了 6 条连接用例"）：

| spec | 落地前 | 落地后 |
| --- | --- | --- |
| `sql-panel.spec.tsx` | 15 | 19（结构 8 + 归属围栏 6 + 右键菜单 5） |
| `sql-notebook-surface.spec.tsx` | 51 | 57（+断开 title、内存库常驻、WAL 常驻、扫描截断 title、无截断时不带 title、连接被拒原因） |
| `sql-connection-status.spec.tsx` | 4 | 6（+`hideReadout` 两个方向） |
| `sql-database-scan.spec.ts` | 8 | 9（+`-wal`/`-shm` 不进列表） |
| `workbench-editor.spec.tsx` | 46 | 48（+状态条两种视图的归属） |

原面板 `SqlPanel — 连接` 那 6 条里，5 条断言的控件已迁到工具条、由 surface spec 的既有用例覆盖（选库列表、`:memory:` 无档别、连接后锁定、被拒原因），1 条（WAL 扫描过滤）不是 UI 断言，按上面第 2 条补成了扫描层用例。**没有任何一条覆盖是被删掉的**。

---

## 待确认（本稿已按推荐值写入，实施前请点头或推翻）

前四项是 agent 的建议，尚未逐条得到确认：

1. **三条端到端门禁不跑**，在提交正文里如实说明理由（见「门禁与验收」）。
2. **未连接时面板不渲染结构树**，双击插查询在该状态下没有入口——接受，因为 `insertSelect` 本就是空操作。
3. **窄栏（`WorkbenchRail.tsx:117-152`）三枚按钮一枚都不改**：`sql.refreshSchema` 的请求与消费方都没变；「新建笔记」建的笔记会自动连上（`controller.connectNewSqlNotebook`），连接控件在中栏还是侧栏对它没有影响。
4. **复制失败走结构区已有的 `schemaProblem` 行**报错，成功不给提示（照 `EditorTabContextMenu` 的「复制路径」）。
