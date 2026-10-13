/**
 * The two things a double-click on a table has to get right: the SQL text, and the name inside it.
 *
 * Both are pure and separate from the panel because both are easy to get subtly wrong. A table name
 * is data, not syntax — a name that contains a quote, a space or a SQL keyword is exactly what a
 * database is allowed to have — and the only safe way to put it in a statement is to quote it as an
 * *identifier* rather than to sanitize it. Measured reason the name cannot be a bound parameter
 * instead: a table-valued function takes no parameters (`SELECT * FROM pragma_table_info(?)` fails
 * with `Unknown named parameter '0'`), so the name has to be text in the statement.
 */

/** A SQL identifier, quoted so any name a database accepts can be used verbatim. */
export function quotedSqlIdentifier(name: string): string {
  // The one thing that has to be escaped inside a `"…"` identifier is the quote itself, doubled.
  return `"${name.replace(/"/gu, '""')}"`
}

/**
 * The query a table or view opens with.
 *
 * `LIMIT` is the connection's own row cap rather than a number of its own: the cell would be
 * truncated at that cap anyway, so asking for more would only make the host fetch rows it will
 * throw away. It is deliberately not `LIMIT` + `OFFSET` — paging needs an `ORDER BY` to mean
 * anything, and the statement the reader sees should stay one they could have typed.
 */
export function selectAllFrom(table: string, rowLimit: number): string {
  return `SELECT * FROM ${quotedSqlIdentifier(table)} LIMIT ${rowLimit}`
}
