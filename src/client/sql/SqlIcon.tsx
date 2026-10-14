/** 与 DSH 线性图标体系一致的 SQL 笔记入口图标：圆柱体，一眼是数据库而不是文档。 */

export function IconSqlOutline16({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <ellipse cx="8" cy="3.6" rx="4.6" ry="1.9" stroke="currentColor" strokeWidth="1.25" />
      {/* 柱身与中间那道堆叠线：两笔合起来才是「一叠数据」，只画椭圆会像图钉。 */}
      <path d="M3.4 3.6v8.8c0 1.05 2.06 1.9 4.6 1.9s4.6-.85 4.6-1.9V3.6" stroke="currentColor" strokeWidth="1.25" />
      <path d="M3.4 8c0 1.05 2.06 1.9 4.6 1.9S12.6 9.05 12.6 8" stroke="currentColor" strokeWidth="1.25" />
    </svg>
  )
}

/** 数据库表：圆柱体底部加一条短横，表示「结构」而非「连接」。 */
export function IconTable16({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <ellipse cx="8" cy="3.5" rx="4.5" ry="1.9" />
      <path d="M3.5 3.5v8.8c0 1.05 2.01 1.9 4.5 1.9s4.5-.85 4.5-1.9V3.5" />
      <path d="M3.5 7.7c0 1.05 2.01 1.9 4.5 1.9s4.5-.85 4.5-1.9" />
      <path d="M3.5 12v1.3" />
      <path d="M12.5 12v1.3" />
    </svg>
  )
}

/** 视图：两个重叠的矩形，表示「只读结构」。 */
export function IconView16({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="2" width="9" height="12" rx="1.5" />
      <rect x="5" y="2" width="9" height="12" rx="1.5" fill="var(--dsw-alias-bg-layer-1)" stroke="var(--dsw-alias-border-l1)" />
    </svg>
  )
}

/**
 * Primary key: a small key glyph. Drawn with stroke-only, no fill, so it sits next to the
 * table / view cylinder in the same linear family — a coloured fill here would fight the
 * `IconTable16` outline.
 */
export function IconPrimaryKey16({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="5" cy="11" r="2.5" />
      <path d="M6.7 9.3l5.6-5.6" />
      <path d="M10.5 5.5l1.5 1.5" />
      <path d="M12.5 3.5l1 1" />
    </svg>
  )
}

/**
 * Unique: a small diamond on a baseline, the classic index mark. Drawn stroke-only for the same
 * reason as `IconPrimaryKey16`: it lives next to the cylinder icon in a row, and a filled
 * diamond would be the loudest thing on the line.
 */
export function IconUnique16({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2.5L13.5 8 8 13.5 2.5 8z" />
    </svg>
  )
}

/**
 * Foreign key: a chain link. Pairs of arcs are the standard "linked" mark, and the stroke
 * width matches the rest of the linear family so the four column icons (key / diamond / chain
 * / NN pill) read as the same set of glyphs.
 */
export function IconForeignKey16({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6.5 5.5h-1.2a3 3 0 0 0 0 5h1.2" />
      <path d="M9.5 10.5h1.2a3 3 0 0 0 0-5h-1.2" />
      <path d="M7 8h2" />
    </svg>
  )
}

/**
 * Database root: a stack of three discs. Drawn bigger than the table cylinder on purpose, so
 * the panel's *one* root node reads as the database itself, not as another table. The same
 * shape is used for the in-memory database; the panel picks the root label (file name vs
 * ":memory:") based on `SqlTablesResult.databaseKind`.
 */
export function IconDatabaseRoot16({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <ellipse cx="8" cy="3.2" rx="5.5" ry="1.9" />
      <path d="M2.5 3.2v9.6c0 1.05 2.46 1.9 5.5 1.9s5.5-.85 5.5-1.9V3.2" />
      <path d="M2.5 7.6c0 1.05 2.46 1.9 5.5 1.9s5.5-.85 5.5-1.9" />
      <path d="M2.5 12c0 1.05 2.46 1.9 5.5 1.9s5.5-.85 5.5-1.9" />
    </svg>
  )
}

/**
 * Category node: a small open box. Used for the "字段 / 索引 / 外键 / 触发器" parent rows
 * the panel renders under every table — a closed lid reads as "container of N items", which
 * is the right mental model for a category that opens to its members.
 */
export function IconCategory16({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 4.5h4l1.5 1.5h5.5v7.5h-11z" />
    </svg>
  )
}

/**
 * Index glyph: a list of three short rules, the conventional "index page" mark. Drawn
 * stroke-only to match the rest of the linear family.
 */
export function IconIndex16({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 4.5h8" />
      <path d="M4 8h8" />
      <path d="M4 11.5h5" />
    </svg>
  )
}

/**
 * Trigger glyph: a lightning bolt, the conventional "trigger" mark. Drawn single-stroke so it
 * sits next to the other category icons without shouting.
 */
export function IconTrigger16({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 2L4 9h3l-1 5 5-7h-3z" />
    </svg>
  )
}

/**
 * The category-level "字段" node uses the same key glyph as the column-level primary-key
 * icon. The visual link tells a reader that "open 字段 to see the columns" is the same
 * kind of thing as "look for the key glyph in a column row". The icon is just re-exported
 * under a category-flavoured name so the panel says "I am the fields category" at the call
 * site, rather than re-using the column-side name by coincidence.
 */
export const IconFieldsCategory16 = IconPrimaryKey16
