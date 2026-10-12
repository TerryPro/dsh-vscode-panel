# SQL 笔记的执行后端用宿主内置 node:sqlite

需求：SQL 笔记要能查工作区里的 SQLite 文件。

决定用宿主内置的 `node:sqlite`（`DatabaseSync`）。理由：它是唯一让用户开箱就用的选项——实测在宿主 runtime 上无 flag、无告警、`readOnly` 可用，零新依赖，也不触碰 `ws` / `node-pty` 那条原生模块红线；而外部内核要用户自建虚拟环境、装包、再手动注册 kernelspec 才看得见功能，这三步插件都不能代做（本仓既定原则）。代价是这条路不是 Jupyter 协议：分页让出、值归一化、权限拦截都得自己实现，笔记本那一套会话机器一样都复用不上（见 ADR 0002）。

## Considered Options

- `jupyter-duckdb` kernelspec：真 SQL 内核、协议层能复用 ipykernel，但它拖 `jupyter` 元包（notebook、jupyterlab、nbconvert 一整套）、把 `duckdb==1.5.5` 写死成硬依赖，且默认后端是 DuckDB 而非 SQLite——读 `.db` 要靠它自己的 sqlite scanner。更麻烦的是安装是两步：`pip install` 之后还要手动 `jupyter kernelspec install`，pip 不会自动注册。该路线曾在仓库里写过一份完整计划（`docs/sqlite-kernel-plan.zh.md`，已删除），它担心的两个关卡——`discovery.ts` 只认 `language === 'python'`、`kernel-session.ts` 在 argv 里没有已知 launcher 时静默换成 ipykernel——本模块都不必碰，因为没有非 ipykernel 的 spec 会进来。
- `ipython-sql` 的 `%sql` magic：不是内核，是 Python 内核里的 magic。零宿主改动，但单元格语言仍是 python，没有 SQL 高亮也没有 `sql` kernelspec，"SQL 笔记"名不副实。
- `xeus-sqlite`：官方不发 Windows 包（conda-forge 只有 linux/osx，PyPI 无此包），且本仓的 bridge 必须以 Python 解释器启动，而它的 `JPY_INTERRUPT_EVENT` / `JPY_PARENT_PID` 机制对一个原生 C++ 可执行文件完全无效。
- `sqlkernel` / `jupyter-sql` / `db-sql-kernel`：PyPI 上不存在，或停在 2016 年的一次 alpha。

## Consequences

- `node:sqlite` 的 Stability 至今是 1.2 Release candidate，且未来主类名会从 `DatabaseSync` 换成 `Database`（`DatabaseSync` 将成为 DEP0210 的别名）。宿主侧集中一处 import 并做 `Database ?? DatabaseSync` 的前向别名；这条由新增的常驻门禁 `npm run test:sql` 看着，因为没有任何现有测试覆盖宿主 runtime 上的 sqlite 行为。
- 执行不能占住宿主主线程，见 ADR 0002。
