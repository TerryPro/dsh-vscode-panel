/**
 * The one line that says which database a SQL notebook is on, and how it was opened.
 *
 * Two places show it, and they are complementary rather than duplicated (ADR 0008): the notebook's
 * toolbar while the cell surface is on screen, and the editor's status strip in the source view,
 * where there is no toolbar. Each says it from this one function, because a reader who sees
 * `writable` in one and nothing in the other cannot tell which one is stale. The wording is passed in
 * (each surface has its own labels object) and the words for the two tiers come from the dictionary,
 * but the line's shape is derived here once.
 */

import type { SqlAccess } from '../../shared/sql-protocol.ts'

export interface ConnectionReadoutSource {
  path: string
  /** The tier the Host granted, which is not always the one that was asked for. */
  access: SqlAccess
  /**
   * The row cap the Host actually applies. `0` means "the Host has not answered yet": the call
   * site knows the connection only from the file's record (ADR 0007), and printing a fake cap would
   * either be a lie or force every caller to invent a number. The line drops the cap segment in
   * that case, so the reader sees a real path and a real tier while the auto-connect is still on
   * the wire — the Host's answer fills the cap in a moment, and the next paint says the rest.
   */
  rowLimit: number
}

export interface ConnectionReadoutTiers {
  readOnly: string
  writable: string
}

/** `library.db · writable · 1000` when the cap is known, `library.db · writable` while it is not. */
export function connectionReadout(connection: ConnectionReadoutSource, tiers: ConnectionReadoutTiers): string {
  const tier = connection.access === 'writable' ? tiers.writable : tiers.readOnly
  return connection.rowLimit > 0
    ? `${connection.path} · ${tier} · ${connection.rowLimit}`
    : `${connection.path} · ${tier}`
}
