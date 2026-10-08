import { describe, expect, it } from 'vitest'
import { jsonPathKey, type JsonDocument, type JsonNode } from '../src/client/json/json-parse.ts'
import {
  isStructuredViewRenderable,
  parseStructuredDocument,
  structuredFormatForPath,
} from '../src/client/json/structured-parse.ts'

/** A structural fingerprint, so the two readers can be compared directly. */
function fingerprint(document: JsonDocument | null): string[] {
  if (document?.root === null || document === null) return []
  const lines: string[] = []
  const visit = (node: JsonNode): void => {
    lines.push(`${jsonPathKey(node.path)} ${node.kind} ${node.keyText ?? ''} ${node.children.length}`)
    for (const child of node.children) visit(child)
  }
  visit(document.root)
  return lines
}

describe('structuredFormatForPath', () => {
  it('picks the reader an extension calls for', () => {
    expect(structuredFormatForPath('package.json')).toBe('json')
    expect(structuredFormatForPath('tsconfig.jsonc')).toBe('json')
    expect(structuredFormatForPath('deploy.yml')).toBe('yaml')
    expect(structuredFormatForPath('charts/Chart.yaml')).toBe('yaml')
    expect(structuredFormatForPath('notes.md')).toBeNull()
    expect(structuredFormatForPath(undefined)).toBeNull()
  })
})

describe('parseStructuredDocument', () => {
  it('produces one node contract for both syntaxes', () => {
    const json = parseStructuredDocument('cfg.json', '{"a": {"b": 1}, "list": [1, 2]}')
    const yaml = parseStructuredDocument('cfg.yaml', 'a:\n  b: 1\nlist:\n  - 1\n  - 2\n')
    expect(json.format).toBe('json')
    expect(yaml.format).toBe('yaml')
    expect(json.renderable).toBe(true)
    expect(fingerprint(yaml.document)).toEqual(fingerprint(json.document))
  })

  it('carries a usable source span for either syntax', () => {
    const jsonSource = '{"a": {"b": 1}}'
    const yamlSource = 'a:\n  b: 1\n'
    const json = parseStructuredDocument('cfg.json', jsonSource)
    const yaml = parseStructuredDocument('cfg.yaml', yamlSource)
    const leaf = (document: JsonDocument) => (document.root?.children[0]?.children[0] as JsonNode)
    expect(jsonSource.slice(leaf(json.document as JsonDocument).start, leaf(json.document as JsonDocument).end)).toBe('1')
    expect(yamlSource.slice(leaf(yaml.document as JsonDocument).start, leaf(yaml.document as JsonDocument).end)).toBe('1')
  })

  it('gates each format on its own size budget', () => {
    expect(isStructuredViewRenderable('yaml', 'a: 1')).toBe(true)
    expect(isStructuredViewRenderable('json', '{"a": 1}')).toBe(true)
    const yaml = parseStructuredDocument('big.yaml', `a: ${'x'.repeat(1024 * 1024 + 8)}`)
    expect(yaml).toEqual({ format: 'yaml', renderable: false, document: null })
    const json = parseStructuredDocument('big.json', `{"a": "${'x'.repeat(2 * 1024 * 1024 + 8)}"}`)
    expect(json.renderable).toBe(false)
  })

  it('reports nothing to draw for a file with no structured view', () => {
    expect(parseStructuredDocument('README.md', '# Title')).toEqual({
      format: null,
      renderable: false,
      document: null,
    })
  })
})
