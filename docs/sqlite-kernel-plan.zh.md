# 笔记本 SQL / SQLite 内核：技术方案与开发计划

一句话：给笔记本加一个 SQL 内核，单元格写 SQL、查数据库，结果渲染成表格。

> **开工前先读这条**。2026-10 复核过一版，改了四处：关卡 B 要排在关卡 A 前面（§3）、内核安装是两步不是一步（§3-D 与 S0）、§1 第三条的交付方式写死了（靠内核自己的 magic，不做选库界面）、估时从 2.5–3.5 人日改成 **3–4.5 人日**。如果你真正想要的是「打开 `.db` 文件看表和数据」，那是 §7，它应该先做。

---

## 1. 需求

- 内核选择器里出现一个 SQL 内核，可选中并启动。
- 单元格以 SQL 语法高亮，执行后返回结果表格；SQL 报错以错误形式呈现。
- 能查工作区里已有的 `.db` / `.sqlite` 文件，也可用内存库。挂库靠这个内核自己的 magic（`%LOAD <文件>`、`%CREATE <库> OF <脚本>`），由用户在单元格里写；**本计划不做「选库」界面**。这是 §1 里唯一一条只做到「能用」、没做到「好找」的需求，得在文档里明说。
- 与现有 Python 内核共存：同一插件、同一套会话管理、同一套 SSE/轮询与回收规则。
- 边界：只做「查询-展示」；不做变量查看器、不做 ipywidgets、不做导出。

---

## 2. 技术方案

**走外部 Python SQL kernelspec（Jupyter 协议），选 `jupyter-duckdb`。**

理由：它的内核是 `class DuckDBKernel(ipykernel.kernelbase.Kernel)`，`language_info.name = 'sql'`，argv 是 `python -m duckdb_kernel -f {connection_file}`。协议层复用 ipykernel，本仓现有的 ZMTP + HMAC 宿主、bridge、中断、回收全部照常可用，只需放宽发现与启动两处判定。这三条形状是整份方案的承重墙，本仓代码里核不了，**必须靠 S0 先取证**。

默认后端是 DuckDB（`duckdb==1.5.5` 是它的硬依赖）。SQLite 实现确实在包里（`db/implementation/sqlite/`），但官方那个 `SQLITE=1 pip install …` 开关只管源码构建；从 PyPI 装 wheel 时 `duckdb` 照样会被装上。所以这条路的实际形状是「DuckDB 内核去读 SQLite 文件」，`%LOAD` 一个 `.db` 是否依赖联网拉扩展，同样列进 S0 取证。

选型（标「已核」的这次对着源文件验过，标「待取证」的等 S0 取证）：

| 候选 | 结论 |
| --- | --- |
| `jupyter-duckdb` 1.5.500 | ✅ 采用。当前最新版（已核 PyPI），纯 Python wheel（`py3-none-any`），自带 `db/implementation/sqlite/`。**已核 `requires_dist`**：`["jupyter", "graphviz==0.21", "checkmarkandcross", "duckdb==1.5.5"]`——它拖的是 `jupyter` 元包（notebook、jupyterlab、nbconvert 一整套），安装成本比「装一个内核」听起来重得多。`duckdb` 是 PyPI 预编译 wheel，不触碰 npm 原生模块红线。 |
| `xeus-sqlite` 0.10.0 | ❌ 排除。**官方不发 Windows 包**（README 原文 + conda-forge 只有 linux/osx，搜 `win-64` 零命中；PyPI 无此包），本机也没有 conda/mamba。即使换到 Linux 也更贵：它是原生 C++ 可执行文件，而 bridge 必须以 Python 解释器启动（[kernel-session.ts:998](../src/host/kernel/kernel-session.ts#L998)），且 `JPY_INTERRUPT_EVENT` / `JPY_PARENT_PID` 这两个 ipykernel 私有机制对它完全无效。 |
| `ipython-sql` 0.5.0 | 备选。不是内核，是 Python 内核里的 `%sql` magic。零宿主改动，但单元格语言仍是 `python`，没有 SQL 高亮与 `sql` kernelspec。 |
| `sqlkernel` / `jupyter-sql` / `db-sql-kernel` | ❌ PyPI 上不存在或 2016 年单次 alpha。 |

---

## 3. 必须改的四处（**按这个顺序做**）

| # | 位置 | 问题 | 改法 |
| --- | --- | --- | --- |
| B | [kernel-session.ts:978](../src/host/kernel/kernel-session.ts#L978) | **静默降级**：argv 不含 `ipykernel` 就 `return canonical`，即换成 `python -m ipykernel_launcher`。后果是界面显示 SQL、实际跑 Python，用户得到莫名其妙的语法错误 | 不含已知 launcher 模块 → **拒绝启动并报错**，绝不换内核。宁可报错，不可误导。 |
| A | [discovery.ts:514-523](../src/host/kernel/discovery.ts#L514-L523) | 显式拒绝非 ipykernel 的 kernelspec（reason 文案就是 “this workbench launches Python kernels only”）。且该 spec 没有 `language` 字段时，被 [:356](../src/host/kernel/discovery.ts#L356) 兜底猜成 `python` | 判定改为「协议可驱动」：`language` 属于已知集合 **且** argv 是本宿主能重定位的形状。缺 `language` 时保留 `undefined`，不猜。 |
| C | 本机环境 | PATH 上的 Python 无 `pip` 也无 `ipykernel`；`uv` 默认缓存目录不可写 | 三条内核门禁现在一条都跑不了，先建 `.venv`；装包统一用 `uv pip install --python …`，并设 `UV_CACHE_DIR` 到可写目录。 |
| D | 安装步骤本身 | 官方 README 的安装是两步：`pip install jupyter-duckdb` 之后还要手动 `jupyter kernelspec install <site-packages>/duckdb_kernel`。pip **不会**自动注册 kernelspec | 插件不代为安装任何东西（README 既定原则），所以这一步写成给用户的操作说明，并保证 kernelspec 落进会被扫的目录：venv 自己的 `share/jupyter/kernels`，或 Windows 的 `%APPDATA%\jupyter\kernels`（两处都在 [discovery.ts:297-322](../src/host/kernel/discovery.ts#L297-L322) 的候选目录里，已核）。 |

**为何 B 要先于 A**：B 此刻够不着——[kernel-backend.ts:614-615](../src/host/kernel/kernel-backend.ts#L614-L615) 只允许 `available` 的 choice 启动，而关卡 A 之前所有非 ipykernel 的 spec 都是 `available: false`。所以 B 是潜在缺陷，不是现行故障。但 A 一落地它就变成真故障：两个 PR 之间只要发过一版，用户就能选到 SQL 内核并拿到 Python 语法错误。B 单独成立、纯改进、不会让任何现有行为变差，所以先走。

## 4. 现成不用改

会话/流式/中断/回收（`KernelBackend` 全套）、SQL 语法高亮（`@codemirror/lang-sql` 已是依赖，[editor-languages.ts:173](../src/client/editor/editor-languages.ts#L173)）、按内核语言切换单元格语法（[NotebookSurface.tsx:222-233](../src/client/notebook/NotebookSurface.tsx#L222-L233) 与 [`kernelFileExtension()`](../src/client/notebook/NotebookSurface.tsx#L1448-L1451)）、`text/html` 表格渲染、`language !== 'python'` 时的 kernelspec 命名（[`createNotebookSkeleton()`](../src/client/notebook/notebook-document.ts#L316-L320)）。

> 上一版在这里引错了两个行号：`NotebookSurface.tsx:173-185` 那段是 `CellView` 接口，`notebook-document.ts:308` 是一段注释。已按真实位置改写。

**默认内核不会被抢走**（已核，不是猜想）：[`defaultKernelChoice()`](../src/host/kernel/discovery.ts#L578-L585) 取第一个 `available`，而环境派生的 `python3` 条目先入列（[:489-497](../src/host/kernel/discovery.ts#L489-L497)），kernelspec 后入列。关卡 A 落地后，打开笔记本的自动连接仍然选中 Python。这一点要留一条回归用例，因为它靠入列顺序成立，不靠任何显式约束。

安全提示：该内核 `rows_table()` 自己**不转义**值，净化器会由「最后一道」变成「第一道」防线，所以 §5 的 S3 要带注入用例。

---

## 5. 开发计划

| 里程碑 | 内容 | 人日 | 依赖 |
| --- | --- | --- | --- |
| **S0** | 建 `.venv`；装 `ipykernel` 与 `jupyter-duckdb`（**并手动注册 kernelspec**，§3-D）；写只读探针取证四条事实：① `kernel.json` 的 `language_info.name` 确实是 `sql`；② 关卡 A 确实把它拦在门外；③ 关卡 B 确实会降级；④ 默认 DuckDB 后端能不能不联网 `%LOAD` 一个 `.db`。四条都要固化成 `probe-scenarios.mjs` 里的场景，并在改动落地前为**红**（② ③ 是负向取证，① ④ 是事实取证，后两条不成立则整条路要换 §7 的兜底） | 1 | — |
| **S1** | 改关卡 B：消除静默降级，argv 里没有已知 launcher 就报错。单独一个 PR，先于关卡 A | 0.5 | S0 |
| **S2** | 改关卡 A：允许可驱动的非 ipykernel spec；`language` 缺失不再兜底猜 python；客户端语言链路（`kernelFileExtension` → `.sql`）与 kernelspec 写回；不可用原因的文案按语言分支，并把「装了包但未注册 kernelspec」这一情形指到正确命令（中英同改） | 0.5–1 | S1 |
| **S3** | 输出与净化：SQL 结果的显示形式策略；表格渲染 | 0.5–1 | S2 |
| **S4** | 端到端场景（建表→查询→报错→中断，并实测 wrapper kernel 的中断语义是否成立）；README 中英同步「只启动 Python 内核」这条限制，并新增一段内核安装两步说明 | 0.5–1 | S1–S3 |
| 合计 | | **3–4.5** | |

> 上一版写的是 2.5–3.5，那时没算 kernelspec 注册这一整步、也没算 S0 要取证到第四条（离线能不能读 `.db`）。S0 按 1 人日估：卡在一个装不上的环境里耗的是等待时间，不是打字时间。若还要交付「选库入口」（从文件树选一个 `.db` 交给内核），另计 **2 人日**，不在本表内。

PR 切分（顺序不能改）：

```
S0  test(kernel): SQL kernelspec 取证场景（先红）
S1  fix(kernel): kernelCommandForPlan 不再静默降级
S2  feat(kernel): 允许可驱动的非 ipykernel Python kernelspec + SQL 语言链路
S3  fix(notebook): SQL 结果渲染的净化策略
S4  docs: README 中英同步内核语言限制与两步安装说明
```

必红的核心用例：

1. 负向（整条链路的哨兵）：对 `language=sql` 的 plan 调 `kernelCommandForPlan` → argv **含 `-m duckdb_kernel`**、**不含 `ipykernel_launcher`**。
2. 真实 `kernel.json` 形状做 fixture → `available === true`、`language === 'sql'`。
3. 端到端：`info.language.name === 'sql'`（真回复，不是拼的假帧）。
4. 注入：结果值里放 `<img src=x onerror=…>` → DOM 无该节点、无 `onerror` 属性。
5. 单元格 path 以 `.sql` 结尾；写出的 `.ipynb` 里 `metadata.kernelspec.language === 'sql'`。
6. 默认选择回归护栏：列表里同时有环境派生的 `python3` 与可用的 `duckdb_kernel` 时，`defaultKernelChoice()` 仍返 `python3`。
7. 关卡 B 单独成立：一个 `available` 但不含已知 launcher 的 plan 走启动路径 → 报 `KERNEL_UNAVAILABLE` 类的错，**不拉起 ipykernel**。

用例 1 和 7 必须在关卡 A 之前就能跑绿：它们只依赖 S1，不依赖列表里能不能选到 SQL 内核。这也是 S1 先于 S2 的理由。

门禁：

```sh
npm run typecheck && npm test && npm run build && npm run test:bundle
npm run test:kernel && npm run test:example && npm run test:isolation   # 改了 src/host/kernel/**
```

新 spec 记得进 `tsconfig.test.json` 的 `files` 白名单。插件**不代为安装任何内核或环境**，只负责发现、启动、说明缺什么。

---

## 6. 风险

| 风险 | 缓解 |
| --- | --- |
| **关卡 A 先于 B 合入，留下真故障窗口** | 本文 §3 已把顺序改成 B 先走；S1 单独一个 PR，用例 1、7 常驻 |
| **装了包但没注册 kernelspec，SQL 内核根本不出现**（pip 不会自动注册） | S0 就把这一步跑通；S2 给选择器添一条能指向正确命令的 reason；S4 文档写清两步 |
| **DuckDB 后端读 `.db` 需要联网拉 `sqlite_scanner` 扩展** | S0 取证第四条；离线不行就改成引导用户走内存库 + `%CREATE ... OF <脚本>.sql`，并在文档里明说 |
| `jupyter` 元包拖进 notebook/jupyterlab 一整套，环境庞大或装不上 | 发现阶段报 reason，不猜；文档只写需要哪些包，不代安装 |
| 关卡 B 的静默降级没修干净 | S1 单独 commit + 用例 1 常驻 |
| wrapper kernel 不支持中断（`JPY_INTERRUPT_EVENT` 是 ipykernel 行为） | S4 实测；不成立就在 UI 明说该内核不支持中断，不照抄 README 卖点 |
| 内核输出未转义 HTML | S3 的注入用例；默认走结构化显示形式 |
| `duckdb==1.5.5` 是写死版本的依赖，装不上则内核不可用 | 发现阶段报 reason，不猜 |
| `%CREATE` / `%LOAD` 是该内核自定义 magic，非标准 SQL，写出来的笔记本跳到别的 SQL 内核就失效 | UI 文案保持中性；§1 第三条已明说靠 magic、不做选库界面，不在文档里把它描成标准 SQL |

---

## 7. 建议先做：`.db` 文件浏览器（与上面的内核是两个需求）

若真正想要的是「打开 `.db` 文件浏览表和数据」，那和本文不是一件事：它是结构化查看器的同族功能，与笔记本内核无关。

两案摆在一起看，**建议先做这一案**：

| | 本文（SQL 内核） | §7（`.db` 浏览器） |
| --- | --- | --- |
| 开箱可用 | 否——要用户自己建 venv、装包、手动注册 kernelspec | 是——宿主自带 |
| 依赖 | `jupyter` 元包 + 写死版本的 `duckdb` | 零新依赖 |
| 估时 | 3–4.5 人日 | 1.5–2 人日 |
| 仍得做的收尾 | 选择器文案、文档两步说明、中断实测 | 只读 SQL 输入框 + `LIMIT` 保护 |

宿主内置 `node:sqlite`（本机 Node v24.20.0 已实测：无 flag、无 ExperimentalWarning、`DatabaseSync` 建表查表正常），表格网格复用 CsvTable 的现成机器。

---

## 8. 本轮复核记录（2026-10）

改本文前逐条核过，记在这里免得下次重核：

| 事实 | 怎么核的 | 结果 |
| --- | --- | --- |
| 关卡 A 拒绝非 ipykernel spec、缺 `language` 兜底猜 python | 读 `discovery.ts:356`、`:514-523` | ✅ 与本文一致 |
| 关卡 B 确实静默降级 | 读 `kernel-session.ts:973-987` | ✅ 与本文一致 |
| B 在 A 之前够不着 | 读 `kernel-backend.ts:614-615` | ✅ 新发现，已归入 §3 |
| 默认内核仍选 python3 | 读 `discovery.ts:489-497`、`:578-585` | ✅ 安全，已归入 §4 与用例 6 |
| kernelspec 候选目录含 venv prefix 与 `%APPDATA%` | 读 `discovery.ts:297-322` | ✅ 成立 |
| `jupyter-duckdb` 1.5.500 为最新版、纯 Python wheel、`requires_dist` 含 `jupyter` 与写死版本的 `duckdb==1.5.5` | PyPI 元数据 | ✅ 已核 |
| 安装需要手动 `jupyter kernelspec install`；`SQLITE=1` 开关只管源码构建；magic 为 `%LOAD` / `%CREATE` | PyPI 上包的 README 原文 | ✅ 已核，归入 §3-D 与 §1 |
| xeus-sqlite 不发 Windows 包 | 官方 README 原文 | ✅ 已核 |
| `node:sqlite` 在本机可用 | `node -v` + 实跑 `DatabaseSync` | ✅ v24.20.0，无告警 |
| `language_info.name=sql`、`class DuckDBKernel(ipykernel.kernelbase.Kernel)`、argv 形状、`rows_table()` 不转义 | 未复核（需读包内源码） | ⚠ 靠 S0 取证 |

---

## 9. 兜底路径

若 S0 取证发现协议层不兼容（`language_info.name` 不是 `sql`，或 argv 形状与本仓的重定位逻辑对不上），兜底是 `ipython-sql` 的 `%%sql sqlite:///…`：零宿主改动、当天可交付，代价是没有 SQL 高亮与 `sql` kernelspec，§1 前两条需求只能算部分满足。
