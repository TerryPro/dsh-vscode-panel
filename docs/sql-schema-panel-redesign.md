# SQL 结构面板重新设计

需求：当前面板只有表名列表 + 展开后列名/类型/主键三件事，参照 DataGrip / TablePlus / VS Code SQL 扩展补齐标准 Schema 面板该有的内容。

## 现状

`SqlColumnEntry`（`src/shared/sql-protocol.ts`）已有：
```typescript
export interface SqlColumnEntry {
  name: string
  type?: string
  notNull: boolean   // ← 面板完全没用
  primaryKey: boolean // ← 面板只画了标签
}
```

`SqlTablesResult`（同文件）已有：
```typescript
export interface SqlTablesResult {
  path: string
  tables: SqlTreeEntry[] // SqlTreeEntry { name, kind: 'table' | 'view' }
  truncated: boolean
}
```

`SqlConnectionRecord`（`sql-notebook-document.ts`）有 path + access，工具条和状态条已用，但面板头没有。

## 改动清单（全部在客户端，不动宿主）

### C1 面板连接头区（Connection Header）

面板顶部的连接信息条，ADR 0008 的"面板只说工具条不说的事"在这里**只说**：

**连接文件路径** + **档位徽章**（只读/可写）+ **WAL 提示**（当 `walSidecarExpected` 时）

不重复工具条已有的"连接状态"，只说文件名和档位。结构：`<div className={css.connHeader}>`。

文案：
- `sqlnotebook.connFile`：`库文件`
- `sqlnotebook.connRowCount`：`{tables} 张表，{views} 个视图`
- `sqlnotebook.connNoTables`：`无表或视图`

### C2 列详情增强（Column Detail）

展开的列现在显示：

| 信息 | 字段来源 | 显示位置 |
|---|---|---|
| 列名 | `column.name` | 左 |
| 类型 | `column.type` | 中（次级色） |
| NOT NULL | `column.notNull` | 右，徽章 |
| 主键 | `column.primaryKey` | 右，徽章 |

`notNull` 用 `NOT NULL` 徽章；`primaryKey` 用 `PK` 徽章；两者同时成立时并排两个徽章，不合并成一个。布局改为左（列名 + 类型）+ 右（徽章区）。

### C3 表/视图图标（Table vs View Icon）

表用圆柱体图标（`SqlIcon.tsx` 里那张），视图用分栏图标（`<svg viewBox="0 0 16 16">` 里两条短横）。

在 `sql-schema-tree.ts` 里新增 `viewIcon()`，从 `SqlIcon.tsx` 导出给面板用。

### C4 搜索过滤（Search Filter）

在连接头下方加一枚 `<input>`：占位符 `sqlnotebook.searchPlaceholder`（zh：`搜索表或视图` / en：`Search tables and views`）；筛掉不匹配的行（表名 / 列名都算匹配）；清空按钮（×）。

筛掉之后剩余数量：`sqlnotebook.searchNoResults`（zh：`无匹配项` / en：`No matches`）。

CSS：`filterInput`、`filterClear`、`.searchNoResults`。

### C5 搜索高亮（Search Highlight）

筛到的表/视图行里，匹配的字符串加 `<mark>` 高亮。匹配规则：大小写不敏感子串。高亮样式：`background: var(--dsh-alias-state-selection-bg)` + `border-radius: 2px`。

### C6 列的展开行为

展开不变化：展开动作不变、懒加载列数据的逻辑不变、缓存不变。只是展开后每列多显示 `NOT NULL` / `PK` 徽章。

### C7 右键菜单

表行右键菜单（`SqlTableContextMenu.tsx`）不改动，已完整。

### C8 列名字段（已有，未用）

`column.name`（真列名）vs `SqlColumn.label`（展示名，同名列加区分后缀）。展示时用 `label`，tooltip 用 `name`。

---

## 不在本次范围

- **行数**：需要新宿主路由对每张表跑 `SELECT COUNT(*)`，在有几百张表的库上代价高。P2 里单独开票做，用 `sqlite_master` 里没有的 `stat` 表或按需懒加载。
- **列默认值**：`PRAGMA table_info` 不返回默认值；需要 `PRAGMA table_xinfo`（SQLite 3.26+），需要先验证宿主 runtime 支持。

---

## 新增文案（locales.ts，中英各一条）

| key | zh | en |
|---|---|---|
| `sqlnotebook.searchPlaceholder` | `搜索表或视图` | `Search tables and views` |
| `sqlnotebook.searchNoResults` | `无匹配项` | `No matches` |
| `sqlnotebook.connFile` | `库文件` | `Database file` |
| `sqlnotebook.connRowCount` | `{tables} 张表，{views} 个视图` | `{tables} tables, {views} views` |
| `sqlnotebook.connNoTables` | `无表或视图` | `No tables or views` |

---

## 测试

`tests/sql-panel.spec.tsx` 新增用例：
1. 连接后显示连接头（库文件路径 + 档位）
2. `walSidecarExpected` 时显示 WAL 提示行
3. 列展开后显示 NOT NULL 徽章（notNull === true 时）
4. 列展开后显示 PK 徽章（primaryKey === true 时）
5. 搜索过滤：输入匹配串后不匹配的表行消失
6. 搜索清空后恢复全量
7. 无匹配时显示 `searchNoResults`
8. 视图图标与表图标不同

---

## 交付门禁

```
npm run typecheck
npm test -- tests/sql-panel.spec.tsx
npm run build
npm run test:bundle
```
