/**
 * The `.sqlnb` cell surface: one row per cell, drawn over the file tab's draft text.
 *
 * Like `NotebookSurface` and `CsvTable`, this component renders the draft and writes its
 * edits back as file text — it never touches the Host, and saving, dirty tracking and the
 * external-change prompt stay in the shared file-tab machinery.
 *
 * What it adds is ADR 0003's "never auto-repair" rule made visible. A file this build
 * cannot fully read is shown as read-only text with the reason named and a pointer at the
 * raw view; no control here rewrites a document the parser does not understand, because
 * re-serializing whatever happened to parse would discard the fields only a newer format
 * carries.
 *
 * Running a cell is deliberately absent. Results never enter the file, so the run, cancel
 * and result-block controls belong to the `/sqlnotebook` wiring (A3); nothing in this file
 * needs a database connection.
 */

import { useCallback, useMemo, useState } from 'react'
import type { SqlCellKind } from '../../shared/sql-protocol.ts'
import { CodeEditor } from '../editor/CodeEditor.tsx'
import {
  IconAddCode16,
  IconAddMarkdown16,
  IconDeleteCell16,
  IconMoveDown16,
  IconMoveUp16,
  IconSave16,
} from '../notebook/NotebookIcons.tsx'
import css from './sql-notebook.module.css'
import {
  applySqlNotebookEdit,
  parseSqlNotebook,
  SqlNotebookEditError,
  type SqlNotebookCellKind,
  type SqlNotebookCellModel,
  type SqlNotebookDocument,
  type SqlNotebookEdit,
} from './sql-notebook-document.ts'

export interface SqlNotebookLabels {
  save: string
  saveDirty: string
  saveClean: string
  saving: string
  addSqlCell: string
  addMarkdownCell: string
  insertSqlBelow: string
  insertMarkdownBelow: string
  deleteCell: string
  moveUp: string
  moveDown: string
  changeKind: string
  sqlCell: string
  markdownCell: string
  rawCell: string
  /** Shown on the row whose stored kind this build does not know. */
  degradedCell: string
  /** Shown above the cells when at least one row is degraded, or the file is not writable. */
  degradedNotice: string
  blankNotebook: string
  emptyNotebook: string
  invalidJson: string
  missingCells: string
  unsupportedVersion: string
  addFirstCell: string
}

interface SqlNotebookSurfaceProps {
  path: string
  draft: string
  /** Editing is refused while an external change is unresolved, as in the text editor. */
  editable: boolean
  dirty: boolean
  saving: boolean
  onEdit: (text: string) => void
  onSave: () => void
  labels: SqlNotebookLabels
}

export function SqlNotebookSurface({
  path,
  draft,
  editable,
  dirty,
  saving,
  onEdit,
  onSave,
  labels,
}: SqlNotebookSurfaceProps) {
  const document = useMemo(() => parseSqlNotebook(draft), [draft])
  // Why the last click did nothing. Kept here rather than on the tab because it is a
  // property of one surface's render, not of the file: switching to the raw view and back
  // is allowed to forget a message the reader can no longer act on.
  const [refusal, setRefusal] = useState<string | null>(null)

  /**
   * Apply one edit to the file text, or refuse it out loud.
   *
   * `applySqlNotebookEdit` throws instead of rewriting a document this build does not
   * understand, and every call here comes from a click. The refusal keeps the reader's
   * bytes: the draft is untouched, and the reason is shown above the cells.
   *
   * The wording comes from the locale dictionary, not from the error's own message: that
   * message is written for whoever reads the throw site, and putting it on screen would
   * hand an English panel a sentence in one language only.
   */
  const applyEdit = useCallback((edit: SqlNotebookEdit): void => {
    try {
      const next = applySqlNotebookEdit(draft, edit)
      setRefusal(null)
      onEdit(next)
    } catch (error) {
      setRefusal(error instanceof SqlNotebookEditError ? refusalMessage(error.code, labels) : labels.invalidJson)
    }
  }, [draft, labels, onEdit])

  // A file that parses but carries a version this build does not know is still shown cell
  // by cell — see `parseSqlNotebook`. `readOnly` is the one flag that says "no write may
  // leave this surface", so the controls key off it rather than off each warning.
  const documentWritable = !document.readOnly
  // Structure is gated more tightly than typing: adding, deleting, moving or re-typing a
  // cell rewrites the whole document, so it waits until an unresolved external change is
  // settled. Editing a cell's text is left open on purpose — the plain text editor allows
  // exactly that in the same state, and a surface that swallowed keystrokes would leave
  // the reader hunting for a control that is not disabled.
  const canStructure = editable && documentWritable
  const appendIndex = document.cells.length - 1

  return (
    <div className={css.root}>
      <div className={css.toolbar}>
        <button
          type="button"
          className={dirty ? `${css.toolbarAction} ${css.toolbarActionActive}` : css.toolbarAction}
          aria-label={labels.save}
          title={saving ? labels.saving : dirty ? labels.saveDirty : labels.saveClean}
          disabled={saving}
          onClick={onSave}
        >
          <IconSave16 />
        </button>
        <span className={css.toolbarDivider} aria-hidden="true" />
        <button
          type="button"
          className={css.toolbarAction}
          aria-label={labels.addSqlCell}
          title={labels.addSqlCell}
          disabled={!canStructure}
          onClick={() => { applyEdit({ type: 'insertAfter', index: appendIndex, kind: 'sql' }) }}
        >
          <IconAddCode16 />
        </button>
        <button
          type="button"
          className={css.toolbarAction}
          aria-label={labels.addMarkdownCell}
          title={labels.addMarkdownCell}
          disabled={!canStructure}
          onClick={() => { applyEdit({ type: 'insertAfter', index: appendIndex, kind: 'markdown' }) }}
        >
          <IconAddMarkdown16 />
        </button>
      </div>
      <div className={css.cells}>
        {refusal !== null && <div className={css.noticeError} role="alert">{refusal}</div>}
        {document.readOnly && document.warning !== null && (
          <div className={css.notice} role="status">{warningMessage(document, labels)}</div>
        )}
        {!document.readOnly && document.degradedIndexes.length > 0 && (
          <div className={css.notice} role="status">{labels.degradedNotice}</div>
        )}
        {document.cells.map((cell, index) => (
          <SqlNotebookCell
            key={`${cell.id}:${cell.kind}`}
            path={path}
            cell={cell}
            index={index}
            first={index === 0}
            last={index === document.cells.length - 1}
            documentWritable={documentWritable}
            canStructure={canStructure}
            onEdit={applyEdit}
            labels={labels}
          />
        ))}
        {document.cells.length === 0 && (
          <div className={css.empty}>
            <span className={css.emptyText}>{emptyMessage(document, labels)}</span>
            {canStructure && (
              <button type="button" className={css.emptyAction} onClick={() => { applyEdit({ type: 'insertAfter', index: appendIndex, kind: 'sql' }) }}>
                {labels.addFirstCell}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * One cell row.
 *
 * A degraded cell gets no editor and no kind picker but keeps its structural controls: the
 * node it stands for is copied through the tree edit untouched, so moving or deleting it
 * cannot lose content the parser did not read. Retyping it, though, would hand text the
 * author never meant as SQL to the run that follows — so `source` writes stop at the row.
 */
function SqlNotebookCell({
  path,
  cell,
  index,
  first,
  last,
  documentWritable,
  canStructure,
  onEdit,
  labels,
}: {
  path: string
  cell: SqlNotebookCellModel
  index: number
  first: boolean
  last: boolean
  documentWritable: boolean
  canStructure: boolean
  onEdit: (edit: SqlNotebookEdit) => void
  labels: SqlNotebookLabels
}) {
  const editableCell = documentWritable && !cell.degraded
  return (
    <div className={css.cell} data-degraded={cell.degraded || undefined} data-cell-id={cell.id}>
      <div className={css.cellHeader}>
        <span className={css.cellIndex}>{index + 1}</span>
        {editableCell ? (
          <label className={css.cellKindSelect}>
            <span className={css.visuallyHidden}>{labels.changeKind}</span>
            <select
              aria-label={labels.changeKind}
              value={cell.kind}
              onChange={event => {
                const kind = asCellKind(event.target.value)
                if (kind !== null) onEdit({ type: 'kind', index, kind })
              }}
            >
              <option value="sql">{labels.sqlCell}</option>
              <option value="markdown">{labels.markdownCell}</option>
              {cell.kind === 'raw' && <option value="raw">{labels.rawCell}</option>}
            </select>
          </label>
        ) : (
          <span className={css.cellKind}>{kindLabel(cell.kind, labels)}</span>
        )}
        {cell.degraded && <span className={css.cellBadge}>{labels.degradedCell}</span>}
        <span className={css.cellActions}>
          <button type="button" className={css.cellAction} aria-label={labels.insertSqlBelow} title={labels.insertSqlBelow} disabled={!canStructure} onClick={() => { onEdit({ type: 'insertAfter', index, kind: 'sql' }) }}>
            <IconAddCode16 />
          </button>
          <button type="button" className={css.cellAction} aria-label={labels.insertMarkdownBelow} title={labels.insertMarkdownBelow} disabled={!canStructure} onClick={() => { onEdit({ type: 'insertAfter', index, kind: 'markdown' }) }}>
            <IconAddMarkdown16 />
          </button>
          <button type="button" className={css.cellAction} aria-label={labels.moveUp} title={labels.moveUp} disabled={!canStructure || first} onClick={() => { onEdit({ type: 'move', from: index, to: index - 1 }) }}>
            <IconMoveUp16 />
          </button>
          <button type="button" className={css.cellAction} aria-label={labels.moveDown} title={labels.moveDown} disabled={!canStructure || last} onClick={() => { onEdit({ type: 'move', from: index, to: index + 1 }) }}>
            <IconMoveDown16 />
          </button>
          <button type="button" className={css.cellAction} aria-label={labels.deleteCell} title={labels.deleteCell} disabled={!canStructure} onClick={() => { onEdit({ type: 'remove', index }) }}>
            <IconDeleteCell16 />
          </button>
        </span>
      </div>
      <div className={css.cellBody}>
        {editableCell ? (
          <CodeEditor
            key={`${cell.id}:${cell.kind}:${grammarPath(path, cell.kind)}`}
            value={cell.source}
            ariaLabel={`${cell.id} ${cell.kind}`}
            path={grammarPath(path, cell.kind)}
            wrap
            cell
            onChange={source => { onEdit({ type: 'source', index, source }) }}
          />
        ) : (
          <pre className={css.cellText}>{cell.source}</pre>
        )}
      </div>
    </div>
  )
}

/**
 * The path the cell's grammar is resolved from.
 *
 * A SQL cell is highlighted by the notebook's own path — which is exactly why
 * `editor-languages.ts` maps `sqlnb` to SQL. A Markdown cell cannot take that path (it
 * would be coloured as SQL), so it borrows the `.md` extension the text editor already
 * knows, the same way a Jupyter cell borrows the kernel's language.
 */
function grammarPath(path: string, kind: SqlNotebookCellKind): string {
  return kind === 'markdown' ? `${path}.md` : path
}

function kindLabel(kind: SqlNotebookCellKind, labels: SqlNotebookLabels): string {
  if (kind === 'sql') return labels.sqlCell
  return kind === 'markdown' ? labels.markdownCell : labels.rawCell
}

/**
 * Narrow a `<select>` value back to a stored kind.
 *
 * The picker only ever offers the three names below, so this cannot refuse a real choice —
 * it exists so the write is typed by proof rather than by an assertion that would keep
 * compiling if the options and the union ever drifted apart.
 */
function asCellKind(value: string): SqlCellKind | null {
  return value === 'sql' || value === 'markdown' || value === 'raw' ? value : null
}

/**
 * Why there are no cells to show.
 *
 * A blank file is a notebook the user has just created and gets an invitation to add a
 * cell; an unreadable file is a different problem and says which one, because "no cells
 * yet" would send the reader looking for a button when the fix is in the raw view.
 */
function emptyMessage(document: SqlNotebookDocument, labels: SqlNotebookLabels): string {
  if (document.blank) return labels.blankNotebook
  if (document.warning === 'unsupported-version') return labels.unsupportedVersion
  if (document.warning === 'missing-cells') return labels.missingCells
  if (document.warning === 'invalid-json' || document.warning === 'not-an-object') return labels.invalidJson
  return labels.emptyNotebook
}

/** The banner above a file the surface shows but will not rewrite. */
function warningMessage(document: SqlNotebookDocument, labels: SqlNotebookLabels): string {
  if (document.warning === 'unsupported-version') return labels.unsupportedVersion
  if (document.warning === 'missing-cells') return labels.missingCells
  return labels.invalidJson
}

/** The sentence for a write that was refused, keyed off the throw site's error code. */
function refusalMessage(code: string, labels: SqlNotebookLabels): string {
  if (code === 'SQLNB_UNSUPPORTED_VERSION') return labels.unsupportedVersion
  if (code === 'SQLNB_MISSING_CELLS') return labels.missingCells
  return labels.invalidJson
}
