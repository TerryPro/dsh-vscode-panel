/**
 * A lightweight CodeMirror stream grammar that colourises Mermaid diagram
 * source, so the left-hand editor of the mermaid split view is not plain text.
 *
 * It is presentational only — CodeMirror still owns the buffer. The token names
 * (`comment`, `keyword`, `string`, `number`, `operator`, `bracket`) resolve to
 * highlight tags through `StreamLanguage`'s default table and are painted by the
 * workbench's shared `editorSyntaxHighlighting` style, so no new dependency or
 * theme is needed.
 */

import { StreamLanguage } from '@codemirror/language'
import type { StreamParser } from '@codemirror/language'

/** Diagram types plus structural/statement keywords, coloured as keywords. */
const KEYWORDS = new Set([
  'flowchart', 'graph', 'sequenceDiagram', 'classDiagram', 'stateDiagram', 'stateDiagram-v2',
  'erDiagram', 'journey', 'gantt', 'pie', 'quadrantChart', 'xyChart', 'sankey', 'mindmap',
  'timeline', 'packet', 'architecture', 'gitGraph', 'requirementDiagram', 'C4Context',
  'subgraph', 'end', 'participant', 'actor', 'create', 'destroy', 'note', 'Note', 'link',
  'click', 'class', 'cssClass', 'style', 'title',
])

const mermaidParser: StreamParser<null> = {
  name: 'mermaid',
  startState: () => null,
  token(stream) {
    if (stream.eatSpace()) return null
    // `%%` runs (including `%%{init}%%` directives) comment out the rest of the line.
    if (stream.eat(/%/u)) { stream.skipToEnd(); return 'comment' }
    const quote = stream.peek()
    if (quote === '"' || quote === "'") {
      stream.next()
      while (!stream.eol() && stream.peek() !== quote) stream.next()
      if (stream.peek() === quote) stream.next()
      return 'string'
    }
    if (stream.eat(/[A-Za-z_]/u)) {
      stream.eatWhile(/[\w-]/u)
      return KEYWORDS.has(stream.current()) ? 'keyword' : null
    }
    if (stream.eat(/\d/u)) { stream.eatWhile(/[\d.]/u); return 'number' }
    if (stream.eat(/[-=><]/u)) { stream.eatWhile(/[-=><|.]/u); return 'operator' }
    if (stream.eat(/[[\]{}()]/u)) return 'bracket'
    stream.next()
    return null
  },
}

/** The Mermaid language extension, ready to drop into a CodeMirror editor. */
export const mermaidLanguage = StreamLanguage.define(mermaidParser)
