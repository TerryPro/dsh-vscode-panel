# 连接默认只读，且两种档都用 authorizer 拦住跨库与扩展加载

需求：SQL 笔记要能连工作区里用户自己的 `.db` 文件，也要允许建临时表做试查询。备选是白名单语句（只放 `SELECT`/`WITH`/`EXPLAIN`）、一律可写、以及只靠 SQLite 的 `readOnly` 选项。

决定：连接默认只读，切到可写要显式操作并确认；只读与可写两档都禁止 `ATTACH` 与写类 PRAGMA，扩展加载则由建库时的构造选项关闭，其余语句不加白名单。理由：实测证明 `readOnly: true` 不阻止 `ATTACH`——只读连接上附加别的库文件**会成功**，写被 `readOnly` 传染而拒绝，但"读工作区外任意 `.db`"这条路是通的，所以只靠这个选项挡不住跨库读；用户自带的库文件是不可信输入面。而白名单会砍掉"建临时表算一下"这一核心用法，等于废掉笔记形态。

## Considered Options

- 白名单语句（只放 `SELECT`/`WITH`/`EXPLAIN`）：被否，因为建临时表是这套用法的地基。
- 只靠 `readOnly` 选项：被否，实测拦不住 `ATTACH`。
- 用 `PRAGMA query_only` 表达只读：被否，实测它会让只读连接连 `CREATE TEMP TABLE` 都失败，等于自己摧毁地基。

## Consequences

- 只读不等于"只能跑查询"：它约束的是这个库文件不被改写，跨库面则由 authorizer 单独拦。词汇表里这条要写清，免得后来人把"只读"理解成"只许 SELECT"再去加白名单。
- 只读的"试查询"能力实测完整：临时表、`BEGIN`/`COMMIT`/`ROLLBACK`/`SAVEPOINT`、临时表与主库 JOIN 都可用，临时表跨 `COMMIT` 存活。主库的写一律由 SQLite 原生拒绝。
- `loadExtension` 完全不经过 authorizer，只能在打开时就不给这条路。
- 拦 `ATTACH` 会连带拦掉 `VACUUM`（实测两者走同一个动作码）。
- 一个库文件同时只允许一个可写连接；只读连接不限数量。
- authorizer 的返回值必须是整数常量：返回布尔会让每一条语句失败。而动作码与授权码值域重叠（`DENY`＝`CREATE_INDEX`＝1、`IGNORE`＝`CREATE_TABLE`＝2、`COPY`＝`OK`＝0），所以判定与日志一律用名取值比对，绝不按值反查名字。
