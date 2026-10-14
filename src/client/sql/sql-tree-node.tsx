/**
 * The unified schema-tree node, used at every level of the panel.
 *
 * The tree is recursive: a "字段" category node's children are the columns of one table; a
 * table node's children are the categories (字段 / 索引 / 外键 / 触发器); the database root
 * node's children are the tables and views. The same component renders every level, and the
 * only thing that changes between levels is what `kind` says about the data and which icon
 * the row picks. This mirrors `FileTreeLevel`: one recursive component, one render path.
 *
 * Lazy reads: a column row's data is read the first time the "字段" category opens, the
 * same way `FileTreeLevel` reads a directory the first time a folder opens. The reader sees
 * the children, not the read; the read is internal.
 *
 * Why plain data, not a generic `entries: Array<...>` tree: the panel knows the shape of
 * each kind, and a `kind` discriminator with a narrow union is what the type system can
 * actually check. A generic tree would either re-implement that union or push it to
 * `unknown` at the call site.
 */

import type { SqlColumnEntry, SqlTreeEntry } from '../../shared/sql-protocol.ts'
import { HighlightedText } from './HighlightedText.tsx'
import { columnLeadingIcons } from './sql-column-icons.tsx'
import {
  IconCategory16,
  IconDatabaseRoot16,
  IconFieldsCategory16,
  IconForeignKey16,
  IconIndex16,
  IconTable16,
  IconTrigger16,
  IconView16,
} from './SqlIcon.tsx'
import css from './sql-panel.module.css'

/**
 * A node in the panel's tree, by its own *kind*. The same shape works for the database
 * root, the categories, the tables / views, and the columns. The panel renders each kind
 * with its own icon and, where it has meaning, with a count.
 */
export type SqlSchemaNode =
  | SqlSchemaDatabaseNode
  | SqlSchemaCategoryNode
  | SqlSchemaTableNode
  | SqlSchemaColumnNode

/**
 * The topmost node: the database itself. Its children are tables and views, which the
 * panel already has in `SqlTablesResult`.
 */
export interface SqlSchemaDatabaseNode {
  kind: 'database'
  /** Workspace-relative path of the file, or `:memory:`. */
  path: string
  /** `file` reads as the file name; `memory` reads as ":memory:". */
  databaseKind: 'file' | 'memory'
  /** Children are the tables and views, already shaped as `table` / `view` nodes. */
  tables: SqlTreeEntry[]
  /** True when the host truncated the table list. */
  truncated: boolean
}

/** A category under one table: 字段 / 索引 / 外键 / 触发器. */
export interface SqlSchemaCategoryNode {
  kind: 'category'
  /** Which category, in panel vocabulary. The host does not see this. */
  category: 'columns' | 'indexes' | 'foreignKeys' | 'triggers'
  /** Display name, already translated. */
  label: string
  /** Children are columns, indexes, foreign keys, or triggers. `columns` is the only one
   *  the panel renders today; the others render as their counts in `(N)` form. */
  count: number
  /** The owning table's name, used as the cache key for the column read. */
  ownerTable: string
}

/** A table or view, direct child of the database root. */
export interface SqlSchemaTableNode {
  kind: 'table'
  name: string
  /** `view` and `table` differ only by icon, view-badge, and the `SELECT *` semantics the
   *  double-click handler already encodes. */
  tableKind: 'table' | 'view'
  /** Per-section counts from the host. Missing counts render as `?` so the tree's shape
   *  does not change when the host has not filled the field yet. */
  sections?: { indexes?: number; foreignKeys?: number; triggers?: number }
}

/** A column, child of the "字段" category. */
export interface SqlSchemaColumnNode {
  kind: 'column'
  column: SqlColumnEntry
  /** The owning table, used for the right-click "copy columns" gesture. */
  ownerTable: string
}

interface SqlTreeNodeProps {
  node: SqlSchemaNode
  depth: number
  /** All expanded paths in the tree. A path is the slash-joined chain of `node.label`
   *  strings from the root, matching `FileTree`'s convention. */
  expanded: Set<string>
  /** Active search query, for the `<mark>` highlight. */
  filterQuery: string
  /** The slash-joined path of the *parent* of this node. `undefined` for the root. The
   *  recursion is what threads this; callers that mount the tree itself pass `undefined`
   *  for the root and the recursive children fill it in. */
  parentPath?: string
  /** Toggle a node open. */
  onToggle: (path: string) => void
  /** Ask the host for the columns of one table. No-op when the columns are already in. */
  onRequestColumns: (table: string) => void
  /** Insert a `SELECT * FROM table` into the active notebook cell. */
  onInsertSelect: (table: string) => void
  /** Open the right-click menu for a table row. */
  onTableContextMenu: (event: React.MouseEvent<HTMLButtonElement>, table: string) => void
  /** Read the cached column list for one table. Returns `undefined` when the host has
   *  not been asked yet, so the category node can render its "loading" placeholder.
   *  Pulled out of the `node` payload so re-renders with new state land on the same
   *  `node` object instead of having to recreate it on every read. */
  columnsFor: (table: string) => SqlColumnEntry[] | undefined
  /** Localized labels, one set for the kinds the tree can render. */
  labels: SqlTreeNodeLabels
}

export interface SqlTreeNodeLabels {
  databaseRoot: string
  databaseMemory: string
  categoryColumns: string
  categoryIndexes: string
  categoryForeignKeys: string
  categoryTriggers: string
  viewBadge: string
  columnNotNull: string
  columnNullable: string
  openTable: string
  noColumns: string
  loading: string
}

/**
 * Render one node, and recursively its children if the path is in `expanded`.
 *
 * The "open state" is keyed by a path string, the same way the file tree keys directory
 * expansion. A flat `Set<string>` of expanded paths is what every level reads, so a click
 * on a deeply-nested column toggles *that* row alone without disturbing its parents.
 */
export function SqlTreeNode(props: SqlTreeNodeProps): React.ReactNode {
  const { node, depth } = props
  const path = pathOf(node, depth === 0 ? '' : props.parentPath ?? '')
  // Each kind has its own row + children, so the dispatch is a switch instead of a config
  // table — the latter would be one more place to teach what an inline `kind` switch already
  // gets right.
  switch (node.kind) {
    case 'database':
      return <DatabaseNode {...props} path={path} />
    case 'category':
      return <CategoryNode {...props} path={path} />
    case 'table':
      return <TableNode {...props} path={path} />
    case 'column':
      return <ColumnNode {...props} path={path} />
  }
}
/* The four row renderers are split out so each one is short and self-contained. The
 * common bits (the chevron, the indent) are in the small helpers below. */

function DatabaseNode(props: SqlTreeNodeProps & { path: string }): React.ReactNode {
  const { node, depth, expanded, filterQuery, onToggle, labels } = props
  if (node.kind !== 'database') return null
  const open = expanded.has(props.path)
  const label = node.databaseKind === 'memory' ? labels.databaseMemory : node.path
  return (
    <div className={css.treeNode}>
      <Row
        depth={depth}
        open={open}
        icon={<IconDatabaseRoot16 size={14} />}
        label={label}
        filterQuery={filterQuery}
        title={label}
        onToggle={() => { onToggle(props.path) }}
        onActivate={undefined}
        onContextMenu={undefined}
        badge={node.tables.length === 0 ? undefined : `(${node.tables.length})`}
        badgeTitle={undefined}
      />
      {open && (
        <div className={css.treeChildren} role="group">
          {node.tables.map(table => (
            <SqlTreeNode
              key={table.name}
              node={{
                kind: 'table',
                name: table.name,
                tableKind: table.kind,
                ...(table.sections === undefined ? {} : { sections: table.sections }),
              }}
              depth={depth + 1}
              expanded={expanded}
              filterQuery={filterQuery}
              onToggle={props.onToggle}
              onRequestColumns={props.onRequestColumns}
              onInsertSelect={props.onInsertSelect}
              onTableContextMenu={props.onTableContextMenu}
              columnsFor={props.columnsFor}
              labels={labels}
              parentPath={props.path}
            />
          ))}
          {node.truncated && <div className={css.muted}>{labels.noColumns}</div>}
        </div>
      )}
    </div>
  )
}

function TableNode(props: SqlTreeNodeProps & { path: string }): React.ReactNode {
  const { node, depth, expanded, filterQuery, onToggle, onInsertSelect, onTableContextMenu, labels } = props
  if (node.kind !== 'table') return null
  const open = expanded.has(props.path)
  const isView = node.tableKind === 'view'
  // The category list is built panel-side: a view has no indexes, foreign keys, or
  // triggers to offer, so the categories under a view are a single "字段" node. The other
  // categories still render, with `(0)`, so a reader who knows views cannot have indexes is
  // not surprised by an empty list — they see the same shape as a table and the count
  // tells them which sections are empty.
  const categories = isView ? categoriesForView(props.path ?? '', node.name) : categoriesForTable(node, props.path ?? '')
  return (
    <div className={css.treeNode}>
      <Row
        depth={depth}
        open={open}
        icon={isView ? <IconView16 size={14} /> : <IconTable16 size={14} />}
        label={node.name}
        filterQuery={filterQuery}
        title={labels.openTable}
        onToggle={() => { onToggle(props.path) }}
        onActivate={() => { onInsertSelect(node.name) }}
        onContextMenu={event => { onTableContextMenu(event, node.name) }}
        badge={isView ? labels.viewBadge : undefined}
        badgeTitle={undefined}
      />
      {open && (
        <div className={css.treeChildren} role="group">
          {categories.map(category => (
            <SqlTreeNode
              key={category.key}
              node={category.node}
              depth={depth + 1}
              expanded={expanded}
              filterQuery={filterQuery}
              onToggle={props.onToggle}
              onRequestColumns={props.onRequestColumns}
              onInsertSelect={props.onInsertSelect}
              onTableContextMenu={props.onTableContextMenu}
              columnsFor={props.columnsFor}
              labels={labels}
              parentPath={props.path}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function CategoryNode(props: SqlTreeNodeProps & { path: string }): React.ReactNode {
  const { node, depth, expanded, filterQuery, onToggle, onRequestColumns, columnsFor, labels } = props
  if (node.kind !== 'category') return null
  const open = expanded.has(props.path)
  const icon = iconForCategory(node.category)
  // Only "字段" is a real expandable category in this revision: the others render as a
  // single row with `(N)` and a chevron that does nothing on click. A reader who opens an
  // empty category is told the section is empty rather than seeing nothing happen.
  const expandable = node.category === 'columns'
  // The columns are read once and cached by the panel; the category node asks the panel
  // whether the cache has them yet. `undefined` means "not yet read" — the same shape
  // the protocol uses for "missing" — and the panel renders the loading line for it.
  const cachedColumns = expandable ? columnsFor(node.ownerTable) : undefined
  return (
    <div className={css.treeNode}>
      <Row
        depth={depth}
        open={open}
        icon={icon}
        label={node.label}
        filterQuery={filterQuery}
        title={expandable ? node.label : undefined}
        onToggle={expandable ? () => {
          onToggle(props.path)
          // The first open is the only place the host read happens: lazy load, once, on
          // user intent, never on schema re-read.
          if (cachedColumns === undefined) onRequestColumns(node.ownerTable)
        } : undefined}
        onActivate={undefined}
        onContextMenu={undefined}
        badge={`(${node.count})`}
        badgeTitle={undefined}
      />
      {open && expandable && (
        <div className={css.treeChildren} role="group">
          {cachedColumns === undefined
            ? <div className={css.muted}>{labels.loading}</div>
            : cachedColumns.length === 0
              ? <div className={css.muted}>{labels.noColumns}</div>
              : cachedColumns.map(column => (
                <SqlTreeNode
                  key={column.name}
                  node={{ kind: 'column', column, ownerTable: node.ownerTable }}
                  depth={depth + 1}
                  expanded={expanded}
                  filterQuery={filterQuery}
                  onToggle={props.onToggle}
                  onRequestColumns={props.onRequestColumns}
                  onInsertSelect={props.onInsertSelect}
                  onTableContextMenu={props.onTableContextMenu}
                  columnsFor={props.columnsFor}
                  labels={labels}
                  parentPath={props.path}
                />
              ))}
        </div>
      )}
    </div>
  )
}

function ColumnNode(props: SqlTreeNodeProps & { path: string }): React.ReactNode {
  const { node, depth, filterQuery, labels } = props
  if (node.kind !== 'column') return null
  const column = node.column
  return (
    <div className={css.treeNode} role="treeitem" aria-level={depth + 1}>
      <div className={css.columnRow} style={{ paddingInlineStart: depth * 14 }}>
        <span className={css.columnLeading} aria-hidden="true">
          {columnLeadingIcons(column)}
        </span>
        <span className={css.columnLeft}>
          <span className={css.columnName}>
            {filterQuery === ''
              ? column.name
              : <HighlightedText text={column.name} query={filterQuery} />}
          </span>
          {column.type !== undefined && column.type !== '' && (
            <span className={css.columnType}>{column.type}</span>
          )}
        </span>
        {column.stats?.approxRows !== undefined && (
          <span className={css.columnStat} title={labels.columnNotNull}>
            ~{formatStat(column.stats.approxRows)}
          </span>
        )}
        <span className={css.columnNotNull}>
          {column.notNull ? labels.columnNotNull : labels.columnNullable}
        </span>
      </div>
    </div>
  )
}

/* ── helpers ─────────────────────────────────────────────────────────── */

interface RowProps {
  depth: number
  open: boolean
  icon: React.ReactNode
  label: string
  filterQuery: string
  title: string | undefined
  onToggle: (() => void) | undefined
  onActivate: (() => void) | undefined
  onContextMenu: ((event: React.MouseEvent<HTMLButtonElement>) => void) | undefined
  badge: string | undefined
  badgeTitle: string | undefined
}

function Row(props: RowProps): React.ReactNode {
  const { depth, open, icon, label, filterQuery, title, onToggle, onActivate, onContextMenu, badge, badgeTitle } = props
  const isClickable = onToggle !== undefined
  return (
    <div
      className={css.treeRow}
      style={{ paddingInlineStart: depth * 14 }}
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={isClickable ? open : undefined}
    >
      <button
        type="button"
        className={css.treeRowButton}
        title={title ?? ''}
        onClick={onToggle ?? undefined}
        onDoubleClick={onActivate}
        onContextMenu={onContextMenu}
        disabled={!isClickable && onActivate === undefined}
      >
        <span className={css.treeChevron} aria-hidden="true">{isClickable ? (open ? '▾' : '▸') : ' '}</span>
        <span className={css.treeIcon} aria-hidden="true">{icon}</span>
        <span className={css.treeLabel}>
          {filterQuery === '' ? label : <HighlightedText text={label} query={filterQuery} />}
        </span>
        {badge !== undefined && (
          <span className={css.treeBadge} title={badgeTitle ?? ''}>{badge}</span>
        )}
      </button>
    </div>
  )
}

/* ── tree builders ────────────────────────────────────────────────────── */

function categoriesForTable(node: SqlSchemaTableNode, parentPath: string): Array<{ key: string; node: SqlSchemaCategoryNode }> {
  const sections = node.sections ?? {}
  return [
    {
      key: `${parentPath}/columns`,
      node: { kind: 'category', category: 'columns', label: '字段', count: 0, ownerTable: node.name },
    },
    {
      key: `${parentPath}/indexes`,
      node: {
        kind: 'category', category: 'indexes', label: '索引',
        count: sections.indexes ?? 0, ownerTable: node.name,
      },
    },
    {
      key: `${parentPath}/foreignKeys`,
      node: {
        kind: 'category', category: 'foreignKeys', label: '外键',
        count: sections.foreignKeys ?? 0, ownerTable: node.name,
      },
    },
    {
      key: `${parentPath}/triggers`,
      node: {
        kind: 'category', category: 'triggers', label: '触发器',
        count: sections.triggers ?? 0, ownerTable: node.name,
      },
    },
  ]
}

function categoriesForView(parentPath: string, viewName: string): Array<{ key: string; node: SqlSchemaCategoryNode }> {
  return [
    {
      key: `${parentPath}/${viewName}/columns`,
      node: { kind: 'category', category: 'columns', label: '字段', count: 0, ownerTable: viewName },
    },
  ]
}

function iconForCategory(category: 'columns' | 'indexes' | 'foreignKeys' | 'triggers'): React.ReactNode {
  switch (category) {
    case 'columns': return <IconFieldsCategory16 size={12} />
    case 'indexes': return <IconIndex16 size={12} />
    case 'foreignKeys': return <IconForeignKey16 size={12} />
    case 'triggers': return <IconTrigger16 size={12} />
  }
}

/**
 * Build the path of one node for the expansion `Set`. The path is the dot-joined chain of
 * labels from the root, so two tables called `city` under different schemas never collide
 * on the same `Set` key.
 */
function pathOf(node: SqlSchemaNode, parentPath: string): string {
  switch (node.kind) {
    case 'database': return parentPath === '' ? 'database' : parentPath
    case 'table': return `${parentPath}/${node.name}`
    case 'category': return `${parentPath}/${node.category}`
    case 'column': return `${parentPath}/${node.column.name}`
  }
}

/** Compact a large row count to a reader-friendly form. */
function formatStat(value: number): string {
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}K`
  if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`
  return `${(value / 1_000_000_000).toFixed(1)}G`
}
