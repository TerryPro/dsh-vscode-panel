# 语句边界用 SQLite 自己报的已消费前缀，不自己写词法器

一格可以写多条语句（需求 Q7c），而实测 `prepare()` 只编译第一条、后面的**静默丢弃**（三条 `INSERT` 只插了一行），且 `StatementSync` 没有暴露未消费余长的指针。所以逐条执行必须由宿主自己推进。

决定：循环用 `prepare(剩余文本)` → 读 `statement.sourceSQL` → 它是原文的**逐字前缀**，`剩余 = 剩余.slice(sourceSQL.length)`，直到 `trim()` 为空。边界判定完全交给 SQLite 的解析器，宿主不认引号、不认注释、不认 `BEGIN…END`。

理由：手写顶层分号切分器在实测里就切坏了正确的输入——`CREATE TRIGGER … BEGIN UPDATE …; END` 被切成两半，前半直接报错（`naive split count => 2`、`fragment FAILS`）。而 `sourceSQL` 实测跨大小写、空白、字符串字面量、块注释都保持逐字前缀，触发器体被整条消费且只触发一次。本仓已多次声明"不解析 SQL"（不注入 `LIMIT`、不定位出错列位），这条决定正是守住那句话：能拿到边界，就不要去猜边界。

## Consequences

- 空文本、纯注释、单独一个 `;` 的余段：`prepare()` 可能成功，但一读 `sourceSQL` 或调 `all()` 就抛 `ERR_INVALID_STATE`（"statement has been finalized"）。循环必须把它当作**本格到此没有可执行语句**，不能当作用户的 SQL 错误上报。
- 某条语句报错时停在本条（Q34 同构）：已经执行成功的前几条照常出结果块，**不会回滚**——`DatabaseSync` 没有事务包装器（无 `db.tx()`），撤销只能靠用户自己写的 `BEGIN`。
- 别把这段循环当冗余代码"优化"掉：一旦改成整格一次 `prepare()`，就会回到静默丢语句的行为。
