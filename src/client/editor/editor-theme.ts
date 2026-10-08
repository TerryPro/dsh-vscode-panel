import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'

/**
 * The monospace face and metrics every code surface shares. Besides the editor
 * and its autocomplete tooltip, the JSON value cards read these values too
 * (guarded by their spec) so a split view shows a document in one typeface at
 * one size.
 */
export const editorCodeFontFamily = 'ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace'
export const editorCodeFontSize = '13px'
export const editorCodeLineHeight = '1.65'

/**
 * Syntax colours expressed with the DSH static palette so the editor reads
 * like a familiar dark code theme while staying on host design tokens. The
 * mapping follows the conventions of mainstream dark themes: keywords in cool
 * blues, strings and numbers in warm tones, types and control flow in the
 * brand accent, and comments muted.
 */
const syntaxStyle = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--dsw-static-green-500)', fontStyle: 'italic' },

  { tag: [t.keyword, t.definitionKeyword, t.moduleKeyword, t.modifier], color: 'var(--dsw-static-blue-400)' },
  { tag: [t.controlKeyword, t.operatorKeyword, t.definitionKeyword], color: 'var(--dsw-static-deepseek-400)' },

  { tag: [t.typeName, t.className, t.namespace], color: 'var(--dsw-static-blue-500)' },
  { tag: [t.function(t.variableName), t.macroName, t.labelName], color: 'var(--dsw-static-deepseek-450)' },

  { tag: [t.propertyName, t.attributeName, t.variableName], color: 'var(--dsw-static-blue-450)' },
  { tag: [t.definition(t.variableName)], color: 'var(--dsw-alias-label-primary)' },

  { tag: [t.string, t.docString, t.character, t.attributeValue, t.url, t.color], color: 'var(--dsw-static-amber-500)' },
  { tag: [t.regexp, t.escape], color: 'var(--dsw-static-amber-400)' },
  { tag: [t.number, t.integer, t.float], color: 'var(--dsw-static-amber-400)' },
  { tag: [t.bool, t.atom, t.null, t.literal], color: 'var(--dsw-static-blue-400)' },

  { tag: [t.operator, t.derefOperator, t.punctuation, t.separator], color: 'var(--dsw-alias-label-secondary)' },
  { tag: [t.bracket, t.brace, t.paren, t.angleBracket, t.squareBracket], color: 'var(--dsw-alias-label-primary)' },

  { tag: [t.tagName, t.self], color: 'var(--dsw-static-blue-400)' },
  { tag: [t.heading, t.contentSeparator], color: 'var(--dsw-static-deepseek-400)', fontWeight: '600' },
  { tag: [t.link], color: 'var(--dsw-static-blue-450)', textDecoration: 'underline' },
  { tag: [t.quote], color: 'var(--dsw-static-green-500)' },
  { tag: [t.list], color: 'var(--dsw-static-amber-500)' },
  { tag: [t.emphasis], fontStyle: 'italic' },
  { tag: [t.strong], fontWeight: '700' },
  { tag: [t.monospace, t.macroName], color: 'var(--dsw-static-amber-500)' },

  { tag: [t.meta, t.annotation, t.processingInstruction, t.documentMeta], color: 'var(--dsw-static-neutral-400)' },
  { tag: [t.invalid], color: 'var(--dsw-static-red-600)' },
])

/**
 * The token colouring on its own, so surfaces that carry a bespoke base theme
 * (the read-only diff view) still share one syntax palette with the editor.
 */
export const editorSyntaxHighlighting = syntaxHighlighting(syntaxStyle)

/**
 * Centres the SVG fold chevron and gives it a hover affordance. Shared by the
 * editor and the diff view so the fold gutter looks identical everywhere.
 */
export const foldGutterTheme = EditorView.theme({
  '.cm-foldGutter .cm-gutterElement': {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0 3px',
    cursor: 'pointer',
  },
  '.cm-foldGutter svg': { display: 'block' },
  '.cm-foldGutter .cm-gutterElement:hover': { color: 'var(--dsw-alias-label-primary)' },
})

/**
 * Recolours the indentation-guide markers drawn by
 * `@replit/codemirror-indentation-markers`, which read two CSS custom
 * properties. The package sets them under `&dark`/`&light`; overriding all
 * three variants keeps the guides on DSH border tokens whatever the host's
 * theme class ends up being. Shared by the editor and the diff view.
 */
const indentMarkerColors = {
  '--indent-marker-bg-color': 'var(--dsw-alias-border-l1)',
  '--indent-marker-active-bg-color': 'var(--dsw-alias-border-l2)',
}
export const indentMarkersTheme = EditorView.baseTheme({
  '&': indentMarkerColors,
  '&dark': indentMarkerColors,
  '&light': indentMarkerColors,
})

/**
 * Colours the inline change blocks that `@codemirror/merge` renders when the
 * editor shows a Git diff in place: added lines tinted green, removed lines
 * tinted red, mirroring the VS Code inline-diff look.
 */
export const inlineDiffTheme = EditorView.theme({
  '.cm-changedLine': {
    backgroundColor: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 16%, transparent)',
  },
  '.cm-changedText': {
    // Colour the whole changed line via `.cm-changedLine` only; drop the
    // per-character highlight (and merge's bottom-edge gradient underline) so
    // a block reads as one flat colour rather than line + text tinting.
    background: 'transparent !important',
  },
  // `@codemirror/merge` wraps inserted/removed runs in <ins>/<del>, which the
  // browser underlines/strikes by default; the coloured background already
  // conveys the change, so drop the extra text decoration.
  '.cm-insertedLine, .cm-deletedLine': {
    textDecoration: 'none',
  },
  '.cm-deletedChunk': {
    backgroundColor: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 16%, transparent)',
  },
  '.cm-deletedText': {
    background: 'transparent !important',
    textDecoration: 'none !important',
  },
  '.cm-deletedLineGutter': {
    backgroundColor: 'var(--dsw-alias-state-error-primary)',
  },
  '.cm-changedLineGutter': {
    backgroundColor: 'var(--dsw-alias-state-success-primary)',
  },
})

/** Extensions that recolour tokens and the surrounding editor chrome. */
export const editorThemeExtensions = [
  editorSyntaxHighlighting,
  foldGutterTheme,
  indentMarkersTheme,
  EditorView.theme({
    '&': {
      height: '100%',
      backgroundColor: 'var(--dsw-alias-bg-base)',
      color: 'var(--dsw-alias-label-primary)',
      fontSize: editorCodeFontSize,
    },
    '.cm-scroller': {
      fontFamily: editorCodeFontFamily,
      lineHeight: editorCodeLineHeight,
    },
    '.cm-content': { padding: '18px 8px 80px', caretColor: 'var(--dsw-alias-label-primary)' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--dsw-alias-label-primary)' },
    '.cm-gutters': {
      backgroundColor: 'var(--dsw-alias-bg-base)',
      color: 'var(--dsw-alias-label-tertiary)',
      borderRight: '1px solid var(--dsw-alias-border-l1)',
    },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 18px', minWidth: '34px' },
    '.cm-activeLine': { backgroundColor: 'var(--dsw-alias-interactive-bg-hover)' },
    '.cm-activeLineGutter': {
      backgroundColor: 'var(--dsw-alias-interactive-bg-hover)',
      color: 'var(--dsw-alias-label-secondary)',
    },
    '.cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'var(--dsw-alias-interactive-bg-active) !important',
    },
    '&.cm-focused .cm-selectionBackground, .cm-selectionLayer .cm-selectionBackground': {
      backgroundColor: 'var(--dsw-alias-interactive-bg-active) !important',
    },
    '.cm-matchingBracket, .cm-nonmatchingBracket': {
      backgroundColor: 'var(--dsw-alias-interactive-bg-active)',
      borderRadius: '2px',
    },
    '.cm-matchingBracket': { outline: '1px solid var(--dsw-alias-border-l2)' },
    '.cm-nonmatchingBracket': { color: 'var(--dsw-static-red-600)' },
    '.cm-searchMatch': {
      backgroundColor: 'var(--dsw-alias-interactive-bg-active)',
      outline: '1px solid var(--dsw-alias-border-l2)',
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
      backgroundColor: 'var(--dsw-alias-interactive-bg-hover)',
    },
    '.cm-panels': {
      backgroundColor: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
      borderColors: 'var(--dsw-alias-border-l1)',
    },
    '.cm-panel.cm-search': { fontFamily: 'inherit', fontSize: '12px', padding: '6px 8px' },
    '.cm-panel.cm-search input, .cm-panel.cm-search button': {
      backgroundColor: 'var(--dsw-alias-bg-layer-2)',
      color: 'var(--dsw-alias-label-primary)',
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: '4px',
      padding: '2px 6px',
      font: 'inherit',
    },
    '.cm-tooltip': {
      backgroundColor: 'var(--dsw-alias-tooltip-bg)',
      color: 'var(--dsw-alias-label-primary)',
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: '6px',
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul': {
      fontFamily: editorCodeFontFamily,
    },
    '.cm-tooltip-autocomplete ul li[aria-selected]': {
      backgroundColor: 'var(--dsw-alias-interactive-bg-active)',
      color: 'var(--dsw-alias-label-primary)',
    },
    '&.cm-focused': { outline: 'none' },
  }),
]
