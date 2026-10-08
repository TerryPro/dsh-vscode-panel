import { describe, expect, it } from 'vitest'
import {
  isJsonViewRenderable,
  jsonLineOfOffset,
  jsonNodeAtOffset,
  jsonPathAtOffset,
  jsonPathKey,
  jsonUtf8Length,
  parseJsonDocument,
  type JsonDocument,
  type JsonNode,
} from '../src/client/json/json-parse.ts'

/** Look a node up by its `$.a[0]` style path key. */
function nodeAt(document: JsonDocument, key: string): JsonNode | undefined {
  let found: JsonNode | undefined
  const visit = (node: JsonNode): void => {
    if (jsonPathKey(node.path) === key) found = node
    for (const child of node.children) visit(child)
  }
  if (document.root !== null) visit(document.root)
  return found
}

describe('parseJsonDocument structure', () => {
  const text = '{\n  "name": "workbench",\n  "count": 3,\n  "tags": ["a", "b"],\n  "ok": true,\n  "missing": null\n}'
  const document = parseJsonDocument(text)

  it('types every value and keeps source order', () => {
    expect(document.root?.kind).toBe('object')
    expect(document.root?.children.map(child => child.keyText)).toEqual(['name', 'count', 'tags', 'ok', 'missing'])
    expect(nodeAt(document, '$.name')?.kind).toBe('string')
    expect(nodeAt(document, '$.count')?.kind).toBe('number')
    expect(nodeAt(document, '$.tags')?.kind).toBe('array')
    expect(nodeAt(document, '$.ok')?.kind).toBe('boolean')
    expect(nodeAt(document, '$.missing')?.kind).toBe('null')
  })

  it('tracks depth and path per node', () => {
    expect(nodeAt(document, '$')?.depth).toBe(0)
    expect(nodeAt(document, '$.tags[1]')?.depth).toBe(2)
    expect(nodeAt(document, '$.tags[1]')?.path).toEqual(['tags', 1])
  })

  it('decodes string values but leaves numbers verbatim', () => {
    expect(nodeAt(parseJsonDocument('{"v": "a\\u0041\\n\\"b\\""}'), '$.v')?.display).toBe('aA\n"b"')
    expect(nodeAt(parseJsonDocument('{"v": -0.5e3}'), '$.v')?.display).toBe('-0.5e3')
    expect(nodeAt(parseJsonDocument('{"v": 1e2}'), '$.v')?.display).toBe('1e2')
  })

  it('reports spans that slice back to the source text', () => {
    for (const key of ['$.name', '$.count', '$.tags', '$.tags[0]', '$.ok']) {
      const node = nodeAt(document, key)
      expect(node, key).toBeDefined()
      expect(text.slice(node?.start as number, node?.end as number), key).not.toBe('')
    }
    expect(text.slice(nodeAt(document, '$.name')?.start as number, nodeAt(document, '$.name')?.end as number)).toBe('"workbench"')
    expect(text.slice(nodeAt(document, '$.tags')?.start as number, nodeAt(document, '$.tags')?.end as number)).toBe('["a", "b"]')
  })

  it('spans the key token including its quotes', () => {
    const node = nodeAt(document, '$.count')
    expect(node?.keyText).toBe('count')
    expect(text.slice(node?.keyStart as number, node?.keyEnd as number)).toBe('"count"')
  })

  it('parses without errors a document that is well formed', () => {
    expect(document.errors).toEqual([])
    expect(document.truncated).toBe(false)
    expect(document.totalNodes).toBe(8)
  })
})

describe('parseJsonDocument trivia', () => {
  it('skips line and block comments', () => {
    const document = parseJsonDocument('{\n  // which version\n  "a": 1, /* inline */ "b": 2\n}')
    expect(document.root?.children.map(child => child.keyText)).toEqual(['a', 'b'])
    expect(document.errors).toEqual([])
    expect(document.comments).toHaveLength(2)
    expect(document.comments[0]?.block).toBe(false)
    expect(document.comments[1]?.block).toBe(true)
  })

  it('reports an unterminated block comment', () => {
    const document = parseJsonDocument('{\n  /* never closed\n  "a": 1\n}')
    expect(document.errors.map(error => error.code)).toContain('unterminated-comment')
  })

  it('counts a byte-order mark in the offsets', () => {
    const text = '\uFEFF{"a": 1}'
    const document = parseJsonDocument(text)
    expect(document.root?.start).toBe(1)
    expect(text.slice(document.root?.start as number, document.root?.end as number)).toBe('{"a": 1}')
    expect(document.errors).toEqual([])
  })

  it('tolerates CRLF line endings', () => {
    const document = parseJsonDocument('{\r\n  "a": 1,\r\n  "b": 2\r\n}')
    expect(document.root?.children.map(child => child.keyText)).toEqual(['a', 'b'])
    expect(document.errors).toEqual([])
  })

  it('accepts a trailing comma', () => {
    const document = parseJsonDocument('{"a": 1, "b": [1, 2,],}')
    expect(document.errors).toEqual([])
    expect(document.root?.children).toHaveLength(2)
    expect(nodeAt(document, '$.b')?.children).toHaveLength(2)
  })

  it('returns nothing for an empty or whitespace-only document', () => {
    expect(parseJsonDocument('').root).toBeNull()
    expect(parseJsonDocument('  \n\t ').root).toBeNull()
    expect(parseJsonDocument('   ').errors).toEqual([])
  })
})

describe('parseJsonDocument recovery', () => {
  it('keeps a value-less key visible instead of dropping it', () => {
    const document = parseJsonDocument('{"a": }')
    expect(document.errors.length).toBeGreaterThan(0)
    expect(document.root?.children).toHaveLength(1)
    expect(document.root?.children[0]?.kind).toBe('unknown')
    expect(document.root?.children[0]?.keyText).toBe('a')
  })

  it('surfaces an unreadable value with its source text', () => {
    const document = parseJsonDocument('{"a": tru, "b": 1}')
    expect(nodeAt(document, '$.a')?.kind).toBe('unknown')
    expect(nodeAt(document, '$.a')?.display).toBe('tru')
    expect(nodeAt(document, '$.a')?.error).toBe('unexpected-value')
    expect(nodeAt(document, '$.b')?.kind).toBe('number')
  })

  it('reports a missing colon but still reads the member', () => {
    const document = parseJsonDocument('{"a" 1}')
    expect(document.errors.map(error => error.code)).toContain('missing-colon')
    expect(nodeAt(document, '$.a')?.kind).toBe('number')
  })

  it('reports an unquoted key and continues', () => {
    const document = parseJsonDocument('{ a: 1, "b": 2 }')
    expect(document.errors.map(error => error.code)).toContain('unquoted-key')
    expect(nodeAt(document, '$.b')?.kind).toBe('number')
  })

  it('marks an unterminated string as invalid', () => {
    const document = parseJsonDocument('{"a": "oops')
    expect(nodeAt(document, '$.a')?.kind).toBe('unknown')
    expect(document.errors.map(error => error.code)).toContain('unterminated-string')
  })

  it('flags content after the root value', () => {
    const document = parseJsonDocument('{"a": 1} trailing')
    expect(document.errors.map(error => error.code)).toContain('trailing-content')
  })

  it('bounds recursion on a deeply nested document', () => {
    const text = `${'['.repeat(400)}${']'.repeat(400)}`
    expect(() => { parseJsonDocument(text) }).not.toThrow()
    const document = parseJsonDocument(text)
    expect(document.errors.length).toBeGreaterThan(0)
    expect(document.root?.kind).toBe('array')
  })

  it('stops at the node cap and says so', () => {
    const document = parseJsonDocument('{"a": 1, "b": 2, "c": 3, "d": 4}', { maxNodes: 3 })
    expect(document.truncated).toBe(true)
    expect(document.root?.children).toHaveLength(2)
    expect(document.totalNodes).toBe(3)
  })
})

describe('jsonPathAtOffset and helpers', () => {
  const text = '{\n  "a": [1, 2],\n  "b": "x"\n}'
  const document = parseJsonDocument(text)

  it('locates the innermost value at an offset', () => {
    expect(jsonPathAtOffset(document, text.indexOf('1'))).toEqual(['a', 0])
    expect(jsonPathAtOffset(document, text.indexOf('2'))).toEqual(['a', 1])
    expect(jsonPathAtOffset(document, text.indexOf('"x"'))).toEqual(['b'])
    expect(jsonPathAtOffset(document, text.indexOf('['))).toEqual(['a'])
    expect(jsonPathAtOffset(document, 0)).toEqual([])
  })

  it('locates a key span as its own member', () => {
    expect(jsonPathAtOffset(document, text.indexOf('"b"'))).toEqual(['b'])
  })

  it('returns null outside every value', () => {
    const text = '{"a": 1}\nzzz'
    expect(jsonPathAtOffset(parseJsonDocument(text), text.length - 1)).toBeNull()
  })

  it('exposes the node behind a path', () => {
    expect(jsonNodeAtOffset(document, text.indexOf('1'))?.kind).toBe('number')
  })

  it('counts the line holding an offset', () => {
    expect(jsonLineOfOffset(text, 0)).toBe(0)
    expect(jsonLineOfOffset(text, text.indexOf('"b"'))).toBe(2)
    expect(jsonLineOfOffset(text, text.length + 10)).toBe(3)
  })

  it('formats path keys for bracketed and dotted segments', () => {
    expect(jsonPathKey([])).toBe('$')
    expect(jsonPathKey(['items', 3, 'id'])).toBe('$.items[3].id')
    expect(jsonPathKey(['a b'])).toBe('$["a b"]')
  })
})

describe('jsonUtf8Length and size gate', () => {
  it('counts UTF-8 bytes without encoding', () => {
    expect(jsonUtf8Length('abc')).toBe(3)
    expect(jsonUtf8Length('中文')).toBe(6)
    expect(jsonUtf8Length('😀')).toBe(4)
    expect(jsonUtf8Length('a\u00e9')).toBe(3)
  })

  it('refuses to parse a document past the view budget', () => {
    expect(isJsonViewRenderable('{"a": 1}')).toBe(true)
    expect(isJsonViewRenderable(`"${'x'.repeat(2 * 1024 * 1024 + 1)}"`)).toBe(false)
  })
})
