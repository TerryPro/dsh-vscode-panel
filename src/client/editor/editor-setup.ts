import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { bracketMatching, defaultHighlightStyle, foldGutter, foldKeymap, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { EditorState } from '@codemirror/state'
import { crosshairCursor, drawSelection, dropCursor, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers, rectangularSelection } from '@codemirror/view'
import { lintKeymap } from '@codemirror/lint'
import type { Extension } from '@codemirror/state'

/**
 * CodeMirror's stock fold gutter paints a bare text glyph ("›" / "⌄"), which
 * reads as unpolished next to a modern editor. This renders the same fold
 * affordance as a crisp chevron: pointing right when a block is folded and
 * down when it is open, matching the convention editors like VS Code use.
 */
function foldMarker(open: boolean): HTMLElement {
  const span = document.createElement('span')
  span.setAttribute('aria-hidden', 'true')
  span.dataset.foldOpen = open ? 'true' : 'false'
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.5')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', open ? 'M4 6l4 4 4-4' : 'M6 4l4 4-4 4')
  svg.appendChild(path)
  span.appendChild(svg)
  return span
}

/**
 * A drop-in replacement for `codemirror`'s `basicSetup` (copied per its own
 * docs, which state the preset is not configurable) that swaps the fold
 * gutter's text glyph for {@link foldMarker}. Everything else matches the
 * stock setup so editor behaviour is unchanged.
 */
export const dshEditorSetup: Extension[] = [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  history(),
  foldGutter({ markerDOM: foldMarker }),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  EditorState.tabSize.of(2),
  indentUnit.of('  '),
  indentOnInput(),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  bracketMatching(),
  closeBrackets(),
  autocompletion(),
  rectangularSelection(),
  crosshairCursor(),
  highlightActiveLine(),
  highlightSelectionMatches(),
  keymap.of([
    ...closeBracketsKeymap,
    ...defaultKeymap,
    ...searchKeymap,
    ...historyKeymap,
    ...foldKeymap,
    ...completionKeymap,
    ...lintKeymap,
  ]),
]
