/**
 * Zero-dependency, position-preserving parser for JSON and JSONC documents.
 *
 * The structured views need more than a JavaScript value: every node must remember the
 * exact source span it was read from, so a row can reveal its own text in the
 * editor and so a later structural edit could patch the document without
 * reformatting the rest of it — the same "keep the file as written" rule the CSV
 * grid follows. The API is deliberately shaped like VS Code's `jsonc-parser`
 * (`parseTree` plus a `getLocation`-style offset lookup), so the hand-written
 * scanner below can be swapped for that library without touching a caller.
 *
 * Unlike `JSON.parse` it tolerates comments, trailing commas and half-typed
 * values, because it is fed the live editor draft rather than a published file.
 * Offsets are reported against the text exactly as stored, byte-order mark
 * included, so they stay valid for `EditorView` selection ranges.
 */

/** How many nodes the views parse before truncating to protect the UI. */
export const JSON_RENDER_MAX_NODES = 20000

/** Documents whose UTF-8 size exceeds this stay in the source view; parsing them would block the main thread. */
export const JSON_VIEW_MAX_BYTES = 2 * 1024 * 1024

/** Nesting levels accepted before the parser gives up, keeping its recursion bounded. */
export const JSON_MAX_DEPTH = 256

export type JsonNodeKind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null' | 'unknown'

/** One parsed value, with the source span and document path it came from. */
export interface JsonNode {
  readonly kind: JsonNodeKind
  /** Nesting level of this node; the document root is 0. */
  readonly depth: number
  /** Property names and array indices leading here from the root. */
  readonly path: readonly (string | number)[]
  /** First character of this value in the document. */
  readonly start: number
  /** One past the last character of this value. */
  readonly end: number
  /** Decoded property name; `undefined` for the root and for array elements. */
  readonly keyText?: string
  /** Span of the key token as written, quotes included. */
  readonly keyStart?: number
  readonly keyEnd?: number
  /** Parsed children in source order — key order is part of the document. */
  readonly children: readonly JsonNode[]
  /** Text to show for the value: decoded for strings, verbatim for other scalars. */
  readonly display: string
  /** Diagnostic code recorded where the scanner gave up, for `kind: 'unknown'` nodes. */
  readonly error?: JsonParseErrorCode
}

/**
 * Stable diagnostic codes for a document the grammar could not read. The parser
 * deliberately carries no prose: the views localize these, so a Chinese or
 * English UI reads the same code.
 */
export type JsonParseErrorCode =
  | 'trailing-content'
  | 'unterminated-comment'
  | 'unterminated-object'
  | 'unterminated-array'
  | 'unterminated-string'
  | 'unterminated-key'
  | 'unquoted-key'
  | 'missing-colon'
  | 'missing-value'
  | 'invalid-number'
  | 'unexpected-value'
  | 'too-deep'

/** One syntax problem, positioned so a view can point at it. */
export interface JsonParseError {
  readonly offset: number
  readonly code: JsonParseErrorCode
}

/** One skipped comment, kept so callers can count them without rescanning. */
export interface JsonComment {
  readonly start: number
  readonly end: number
  readonly block: boolean
}

export interface JsonDocument {
  /** Parsed root value, or `null` when the document is empty or unreadable. */
  readonly root: JsonNode | null
  /** Nodes produced before the render cap. */
  readonly totalNodes: number
  /** Whether {@link root} was cut short by the render cap. */
  readonly truncated: boolean
  readonly errors: readonly JsonParseError[]
  readonly comments: readonly JsonComment[]
}

export interface ParseJsonOptions {
  /** Override the node cap; defaults to {@link JSON_RENDER_MAX_NODES}. */
  maxNodes?: number | undefined
}

interface Parser {
  text: string
  pos: number
  nodes: number
  maxNodes: number
  truncated: boolean
  errors: JsonParseError[]
  comments: JsonComment[]
}

/** UTF-8 size of a string, counted without allocating an encoded buffer. */
export function jsonUtf8Length(text: string): number {
  let bytes = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x80) {
      bytes += 1
    } else if (code < 0x800) {
      bytes += 2
    } else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4
      index += 1
    } else {
      bytes += 3
    }
  }
  return bytes
}

/** True when a document is small enough that parsing it for a view cannot stall the UI. */
export function isJsonViewRenderable(text: string): boolean {
  return jsonUtf8Length(text) <= JSON_VIEW_MAX_BYTES
}

/** Parse a JSON/JSONC document into a tree whose nodes carry their source spans. */
export function parseJsonDocument(text: string, options: ParseJsonOptions = {}): JsonDocument {
  const parser: Parser = {
    text,
    pos: 0,
    nodes: 0,
    maxNodes: options.maxNodes ?? JSON_RENDER_MAX_NODES,
    truncated: false,
    errors: [],
    comments: [],
  }
  const root = parseValue(parser, 0, [])
  // Trailing trivia is still part of the file the user is typing; read it so
  // stray comments after the root value are reported rather than ignored.
  skipTrivia(parser)
  if (parser.pos < text.length && !parser.truncated) {
    fail(parser, parser.pos, 'trailing-content')
  }
  return {
    root,
    totalNodes: parser.nodes,
    truncated: parser.truncated,
    errors: parser.errors,
    comments: parser.comments,
  }
}

/**
 * The document path of the value or key covering `offset` — the equivalent of
 * `jsonc-parser`'s `getLocation`, and the hook a later editor→canvas reveal
 * would use. Returns `null` for offsets outside any parsed value.
 */
export function jsonPathAtOffset(document: JsonDocument, offset: number): readonly (string | number)[] | null {
  const node = jsonNodeAtOffset(document, offset)
  return node === null ? null : node.path
}

/** The innermost parsed node covering `offset`, or `null` outside every value. */
export function jsonNodeAtOffset(document: JsonDocument, offset: number): JsonNode | null {
  let current = document.root
  let found: JsonNode | null = null
  while (current !== null) {
    if (!coversOffset(current, offset)) return found
    found = current
    if (current.kind !== 'object' && current.kind !== 'array') return current
    const child = current.children.find(candidate => coversOffset(candidate, offset))
    if (child === undefined) return current
    current = child
  }
  return found
}

/** A member is addressed by its key span as well as by its value span. */
function coversOffset(node: JsonNode, offset: number): boolean {
  if (offset >= node.start && offset < node.end) return true
  return node.keyStart !== undefined && node.keyEnd !== undefined && offset >= node.keyStart && offset < node.keyEnd
}

/** Zero-based line holding `offset`, for scrolling an editor to a parsed value. */
export function jsonLineOfOffset(text: string, offset: number): number {
  const limit = Math.max(0, Math.min(offset, text.length))
  let line = 0
  for (let index = 0; index < limit; index += 1) {
    if (text[index] === '\n') line += 1
  }
  return line
}

/** Encoded path of one node, used as a stable identity across re-parses. */
export function jsonPathKey(path: readonly (string | number)[]): string {
  let key = '$'
  for (const segment of path) {
    if (typeof segment === 'number') {
      key += `[${segment}]`
    } else if (/^[A-Za-z_$][\w$]*$/u.test(segment)) {
      key += `.${segment}`
    } else {
      key += `[${JSON.stringify(segment)}]`
    }
  }
  return key
}

function fail(parser: Parser, offset: number, code: JsonParseErrorCode): void {
  parser.errors.push({ offset, code })
}

/** Advance over whitespace, the leading byte-order mark and both comment forms. */
function skipTrivia(parser: Parser): void {
  for (;;) {
    const char = parser.text[parser.pos]
    if (char === undefined) return
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\uFEFF') {
      parser.pos += 1
      continue
    }
    if (char !== '/') return
    const next = parser.text[parser.pos + 1]
    if (next === '/') {
      const start = parser.pos
      while (parser.pos < parser.text.length && parser.text[parser.pos] !== '\n') parser.pos += 1
      parser.comments.push({ start, end: parser.pos, block: false })
      continue
    }
    if (next === '*') {
      const start = parser.pos
      const closing = parser.text.indexOf('*/', start + 2)
      parser.pos = closing === -1 ? parser.text.length : closing + 2
      parser.comments.push({ start, end: parser.pos, block: true })
      if (closing === -1) fail(parser, start, 'unterminated-comment')
      continue
    }
    return
  }
}

/** Claim a node slot, or report the render cap and stop descending. */
function takeNode(parser: Parser): boolean {
  if (parser.nodes >= parser.maxNodes) {
    parser.truncated = true
    return false
  }
  parser.nodes += 1
  return true
}

function parseValue(parser: Parser, depth: number, path: readonly (string | number)[]): JsonNode | null {
  skipTrivia(parser)
  if (depth > JSON_MAX_DEPTH) {
    const start = parser.pos
    fail(parser, start, 'too-deep')
    skipToMember(parser)
    return nodeOf({ kind: 'unknown', depth, path, start, end: parser.pos, display: parser.text.slice(start, parser.pos), error: 'too-deep' })
  }
  if (!takeNode(parser)) return null
  const char = parser.text[parser.pos]
  if (char === undefined) {
    parser.nodes -= 1
    return null
  }
  if (char === '{') return parseObject(parser, depth, path)
  if (char === '[') return parseArray(parser, depth, path)
  if (char === '"') return parseString(parser, depth, path)
  if (char === '-' || (char >= '0' && char <= '9')) return parseNumber(parser, depth, path)
  if (char === 't' || char === 'f' || char === 'n') return parseLiteral(parser, depth, path)
  return parseUnreadable(parser, depth, path)
}

function parseObject(parser: Parser, depth: number, path: readonly (string | number)[]): JsonNode {
  const start = parser.pos
  parser.pos += 1
  const children: JsonNode[] = []
  for (;;) {
    skipTrivia(parser)
    const char = parser.text[parser.pos]
    if (char === undefined) {
      fail(parser, start, 'unterminated-object')
      break
    }
    if (char === '}') {
      parser.pos += 1
      break
    }
    // A comma before '}' is legal here only because the view follows a live draft.
    if (char === ',') {
      parser.pos += 1
      continue
    }
    if (char !== '"') {
      fail(parser, parser.pos, 'unquoted-key')
      skipToMember(parser)
      continue
    }
    const keyStart = parser.pos
    const key = readStringLiteral(parser)
    const keyEnd = parser.pos
    if (key === null) {
      fail(parser, keyStart, 'unterminated-key')
      skipToMember(parser)
      continue
    }
    skipTrivia(parser)
    if (parser.text[parser.pos] !== ':') {
      fail(parser, parser.pos, 'missing-colon')
    } else {
      parser.pos += 1
    }
    const childPath = [...path, key]
    const childDepth = depth + 1
    const valueStart = parser.pos
    skipTrivia(parser)
    const next = parser.text[parser.pos]
    if (next === undefined || next === '}' || next === ']' || next === ',') {
      // An omitted value keeps the key visible as an empty member, and leaves the
      // terminator for the loop below so the object still closes cleanly.
      fail(parser, parser.pos, 'missing-value')
      children.push(nodeOf({ kind: 'unknown', depth: childDepth, path: childPath, start: valueStart, end: parser.pos, error: 'missing-value', keyText: key, keyStart, keyEnd }))
      continue
    }
    const value = parseValue(parser, childDepth, childPath)
    if (value === null) {
      if (parser.truncated) break
      children.push(nodeOf({ kind: 'unknown', depth: childDepth, path: childPath, start: valueStart, end: parser.pos, error: 'missing-value', keyText: key, keyStart, keyEnd }))
      continue
    }
    children.push(withKey(value, key, keyStart, keyEnd))
  }
  return nodeOf({ kind: 'object', depth, path, start, end: Math.max(parser.pos, start + 1), children })
}

function parseArray(parser: Parser, depth: number, path: readonly (string | number)[]): JsonNode {
  const start = parser.pos
  parser.pos += 1
  const children: JsonNode[] = []
  let index = 0
  for (;;) {
    skipTrivia(parser)
    const char = parser.text[parser.pos]
    if (char === undefined) {
      fail(parser, start, 'unterminated-array')
      break
    }
    if (char === ']') {
      parser.pos += 1
      break
    }
    if (char === ',') {
      parser.pos += 1
      continue
    }
    const childPath = [...path, index]
    index += 1
    const value = parseValue(parser, depth + 1, childPath)
    if (value === null) break
    children.push(value)
  }
  return nodeOf({ kind: 'array', depth, path, start, end: Math.max(parser.pos, start + 1), children })
}

function parseString(parser: Parser, depth: number, path: readonly (string | number)[]): JsonNode {
  const start = parser.pos
  const text = parser.text
  const value = readStringLiteral(parser)
  if (value === null) {
    fail(parser, start, 'unterminated-string')
    return nodeOf({ kind: 'unknown', depth, path, start, end: parser.pos, display: text.slice(start, parser.pos), error: 'unterminated-string' })
  }
  return nodeOf({ kind: 'string', depth, path, start, end: parser.pos, display: value })
}

/** Read a `"..."` token, decoding escapes; `null` when it is unterminated. */
function readStringLiteral(parser: Parser): string | null {
  const text = parser.text
  let index = parser.pos + 1
  let value = ''
  for (;;) {
    if (index >= text.length) return null
    const char = text[index]
    if (char === '"') {
      parser.pos = index + 1
      return value
    }
    if (char === '\n' || char === '\r') return null
    if (char !== '\\') {
      value += char
      index += 1
      continue
    }
    const escaped = text[index + 1]
    if (escaped === undefined) return null
    if (escaped === 'u') {
      const code = Number.parseInt(text.slice(index + 2, index + 6), 16)
      if (Number.isNaN(code)) {
        value += escaped
        index += 2
        continue
      }
      value += String.fromCharCode(code)
      index += 6
      continue
    }
    value += escapeChar(escaped)
    index += 2
  }
}

function escapeChar(escaped: string): string {
  switch (escaped) {
    case 'n': return '\n'
    case 'r': return '\r'
    case 't': return '\t'
    case 'b': return '\b'
    case 'f': return '\f'
    case 'v': return '\v'
    default: return escaped
  }
}

function parseNumber(parser: Parser, depth: number, path: readonly (string | number)[]): JsonNode {
  const start = parser.pos
  const text = parser.text
  let index = start
  if (text[index] === '-' || text[index] === '+') index += 1
  while (index < text.length && isDigit(text[index])) index += 1
  if (text[index] === '.') {
    index += 1
    while (index < text.length && isDigit(text[index])) index += 1
  }
  if (text[index] === 'e' || text[index] === 'E') {
    const exponent = index + 1
    let next = exponent
    if (text[next] === '+' || text[next] === '-') next += 1
    while (next < text.length && isDigit(text[next])) next += 1
    index = next > exponent ? next : index
  }
  const raw = text.slice(start, index)
  parser.pos = index
  const numeric = Number(raw)
  if (raw === '' || raw === '-' || Number.isNaN(numeric)) {
    fail(parser, start, 'invalid-number')
    return nodeOf({ kind: 'unknown', depth, path, start, end: index, display: raw, error: 'invalid-number' })
  }
  return nodeOf({ kind: 'number', depth, path, start, end: index, display: raw })
}

const LITERALS: readonly (readonly [string, JsonNodeKind, string])[] = [
  ['true', 'boolean', 'true'],
  ['false', 'boolean', 'false'],
  ['null', 'null', 'null'],
]

function parseLiteral(parser: Parser, depth: number, path: readonly (string | number)[]): JsonNode {
  for (const [word, kind, display] of LITERALS) {
    if (!parser.text.startsWith(word, parser.pos)) continue
    const start = parser.pos
    parser.pos += word.length
    return nodeOf({ kind, depth, path, start, end: parser.pos, display })
  }
  return parseUnreadable(parser, depth, path)
}

/**
 * Recover from a value the grammar cannot read: swallow the run up to the next
 * member boundary and surface it as an `unknown` node, so the rest of the
 * document still parses and the typo stays visible (as the CSV grid does with a
 * ragged row).
 */
function parseUnreadable(parser: Parser, depth: number, path: readonly (string | number)[]): JsonNode {
  const start = parser.pos
  fail(parser, start, 'unexpected-value')
  skipToMember(parser)
  return nodeOf({ kind: 'unknown', depth, path, start, end: parser.pos, display: parser.text.slice(start, parser.pos), error: 'unexpected-value' })
}

/**
 * Advance to the next `,`, `}` or `]`, treating strings as opaque. Always makes
 * progress so a malformed member cannot spin the enclosing loop.
 */
function skipToMember(parser: Parser): void {
  const start = parser.pos
  const text = parser.text
  while (parser.pos < text.length) {
    const char = text[parser.pos]
    if (char === ',' || char === '}' || char === ']') break
    if (char === '"') {
      if (readStringLiteral(parser) === null) break
      continue
    }
    parser.pos += 1
  }
  if (parser.pos === start) parser.pos += 1
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9'
}

/** Assemble one node, keeping the optional key and error fields absent rather than null. */
function nodeOf(init: NodeInit): JsonNode {
  return {
    kind: init.kind,
    depth: init.depth,
    path: init.path,
    start: init.start,
    end: init.end,
    children: init.children ?? [],
    display: init.display ?? '',
    ...(init.error === undefined ? {} : { error: init.error }),
    ...(init.keyText === undefined || init.keyStart === undefined || init.keyEnd === undefined
      ? {}
      : { keyText: init.keyText, keyStart: init.keyStart, keyEnd: init.keyEnd }),
  }
}

interface NodeInit {
  kind: JsonNodeKind
  depth: number
  path: readonly (string | number)[]
  start: number
  end: number
  children?: readonly JsonNode[] | undefined
  display?: string | undefined
  error?: JsonParseErrorCode | undefined
  keyText?: string | undefined
  keyStart?: number | undefined
  keyEnd?: number | undefined
}

/** Attach a freshly read key to an already parsed value without re-deriving its span. */
function withKey(value: JsonNode, keyText: string, keyStart: number, keyEnd: number): JsonNode {
  return { ...value, keyText, keyStart, keyEnd }
}
