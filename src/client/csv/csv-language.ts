/**
 * A lightweight CodeMirror stream grammar that colourises delimited table source
 * (CSV/TSV), so the left-hand editor of the CSV split view is not plain text.
 *
 * Presentational only — CodeMirror still owns the buffer. Token names (`string`,
 * `number`, `operator`) resolve through `StreamLanguage`'s default table and are
 * painted by the workbench's shared syntax-highlighting style, so no new
 * dependency or theme is needed. The parser is quote-stateful across lines, so a
 * quoted field containing a newline colours as one string instead of swallowing
 * the rest, and the delimiter/name vary by extension so `.tsv` colours tabs.
 */

import { StreamLanguage } from '@codemirror/language'
import type { StreamParser, StringStream } from '@codemirror/language'

const NUMERIC = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/u

/** Tracks whether the previous line ended inside an unterminated quoted field. */
interface CsvState {
  quoted: boolean
}

function delimitedParser(delimiter: string, name: string): StreamParser<CsvState> {
  // Consume a quoted field from the current position, honoring doubled quotes and
  // stopping on a lone closing quote; leaves `state.quoted` set when the field is
  // still open at end of line so the next line continues the same string.
  const readQuoted = (stream: StringStream, state: CsvState): void => {
    while (!stream.eol()) {
      const consumed = stream.next()
      if (consumed === '"') {
        if (stream.peek() === '"') stream.next()
        else { state.quoted = false; return }
      }
    }
    state.quoted = true
  }

  return {
    name,
    startState: () => ({ quoted: false }),
    token(stream, state) {
      if (stream.eol()) return null
      if (state.quoted) { readQuoted(stream, state); return 'string' }
      const ch = stream.peek()
      if (ch === delimiter) { stream.next(); return 'operator' }
      if (ch === '"') {
        stream.next()
        readQuoted(stream, state)
        return 'string'
      }
      stream.eatWhile(fieldCh => fieldCh !== delimiter && fieldCh !== '"')
      return NUMERIC.test(stream.current()) ? 'number' : null
    },
  }
}

/** The CSV language extension (comma-delimited), ready for a CodeMirror editor. */
export const csvLanguage = StreamLanguage.define(delimitedParser(',', 'csv'))

/** The TSV language extension (tab-delimited), ready for a CodeMirror editor. */
export const tsvLanguage = StreamLanguage.define(delimitedParser('\t', 'tsv'))
