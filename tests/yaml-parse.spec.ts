import { describe, expect, it } from 'vitest'
import { jsonPathKey, type JsonDocument, type JsonNode } from '../src/client/json/json-parse.ts'
import { isYamlViewRenderable, parseYamlDocument, YAML_VIEW_MAX_BYTES } from '../src/client/yaml/yaml-parse.ts'
import { isYamlPath } from '../src/client/yaml/yaml-path.ts'

const SAMPLE = `# leading comment
name: demo
items:
  - 1
  - two
  - k: v
script: |
  line1
  line2
base: &b
  x: 1
copy: *b
`

function documentOf(text: string): JsonDocument {
  return parseYamlDocument(text)
}

function rootOf(text: string): JsonNode {
  const document = documentOf(text)
  if (document.root === null) throw new Error(`no root for ${JSON.stringify(text)}`)
  return document.root
}

function nodeAt(document: JsonDocument, key: string): JsonNode | undefined {
  let found: JsonNode | undefined
  const visit = (node: JsonNode): void => {
    if (jsonPathKey(node.path) === key) found = node
    for (const child of node.children) visit(child)
  }
  if (document.root !== null) visit(document.root)
  return found
}

/** Every node must point at its own text, so a card row can reveal it later. */
function expectFaithfulSpans(text: string, document: JsonDocument): void {
  const offenders: string[] = []
  const visit = (node: JsonNode): void => {
    const slice = text.slice(node.start, node.end)
    // A `key:` with no value is the one node with no text of its own.
    if (slice === '' && !(node.kind === 'null' && node.start === node.end)) {
      offenders.push(`${jsonPathKey(node.path)} → ${JSON.stringify(slice)}`)
    }
    for (const child of node.children) visit(child)
  }
  if (document.root !== null) visit(document.root)
  expect(offenders).toEqual([])
}

describe('isYamlPath', () => {
  it('recognises the YAML family and nothing else', () => {
    expect(isYamlPath('deploy.yaml')).toBe(true)
    expect(isYamlPath('charts/kube/Chart.YML')).toBe(true)
    expect(isYamlPath('package.json')).toBe(false)
    expect(isYamlPath('notes.md')).toBe(false)
    expect(isYamlPath(undefined)).toBe(false)
    expect(isYamlPath('yaml')).toBe(false)
  })
})

describe('parseYamlDocument structure', () => {
  const document = documentOf(SAMPLE)
  const text = SAMPLE

  it('maps block collections onto the same node shape as JSON', () => {
    expect(document.root?.kind).toBe('object')
    expect(document.root?.children.map(child => child.keyText)).toEqual(['name', 'items', 'script', 'base', 'copy'])
    expect(nodeAt(document, '$.items')?.kind).toBe('array')
    expect(nodeAt(document, '$.items[2]')?.kind).toBe('object')
    expect(nodeAt(document, '$.items[2].k')?.display).toBe('v')
    expect(document.errors).toEqual([])
  })

  it('numbers sequence members', () => {
    expect(nodeAt(document, '$.items[0]')?.path).toEqual(['items', 0])
    expect(jsonPathKey(nodeAt(document, '$.items[1]')?.path as never)).toBe('$.items[1]')
  })

  it('keeps spans faithful to the source text', () => {
    expectFaithfulSpans(text, document)
    expect(text.slice(nodeAt(document, '$.name')?.start as number, nodeAt(document, '$.name')?.end as number)).toBe('demo')
    expect(text.slice(nodeAt(document, '$.items[2]')?.start as number, nodeAt(document, '$.items[2]')?.end as number)).toBe('k: v')
  })

  it('reads quoted keys and values back as names', () => {
    const quoted = documentOf('"a b": "c d"')
    expect(nodeAt(quoted, '$["a b"]')?.keyText).toBe('a b')
    expect(nodeAt(quoted, '$["a b"]')?.display).toBe('c d')
  })

  it('parses flow collections', () => {
    const flow = documentOf('point: { x: 1, y: [2, 3] }\n')
    expect(nodeAt(flow, '$.point')?.kind).toBe('object')
    expect(nodeAt(flow, '$.point.y')?.children).toHaveLength(2)
  })
})

describe('parseYamlDocument scalars', () => {
  it('infers types from the YAML 1.2 core schema', () => {
    const document = documentOf('num: 42\nexp: -1.5e3\nflag: yes\nnil: ~\nempty:\ntext: "1"\n')
    expect(nodeAt(document, '$.num')?.kind).toBe('number')
    expect(nodeAt(document, '$.num')?.display).toBe('42')
    expect(nodeAt(document, '$.exp')?.display).toBe('-1.5e3')
    expect(nodeAt(document, '$.flag')?.kind).toBe('string')
    expect(nodeAt(document, '$.nil')?.kind).toBe('null')
    expect(nodeAt(document, '$.nil')?.display).toBe('~')
    expect(nodeAt(document, '$.empty')?.kind).toBe('null')
    expect(nodeAt(document, '$.text')?.kind).toBe('string')
    expect(nodeAt(document, '$.text')?.display).toBe('1')
  })

  it('marks block scalars and keeps their lines for the details panel', () => {
    const document = documentOf('script: |\n  a\n  b\nnote: >-\n  c\n  d\n')
    const literal = nodeAt(document, '$.script')
    const folded = nodeAt(document, '$.note')
    expect(literal?.blockStyle).toBe('literal')
    expect(literal?.display).toBe('a\nb\n')
    expect(folded?.blockStyle).toBe('folded')
    expect(folded?.display).toBe('c d')
    // The span starts at the `|` indicator, so revealing it lands on the block header.
    expect(SAMPLE.slice((nodeAt(documentOf(SAMPLE), '$.script')?.start as number))
      .slice(0, 1)).toBe('|')
  })

  it('records an explicit tag in short form', () => {
    const document = documentOf('version: !!str 7\n')
    expect(nodeAt(document, '$.version')?.tag).toBe('str')
    expect(nodeAt(document, '$.version')?.display).toBe('7')
  })
})

describe('parseYamlDocument anchors and aliases', () => {
  const document = documentOf(SAMPLE)

  it('keeps the anchor as a badge on its node', () => {
    expect(nodeAt(document, '$.base')?.anchor).toBe('b')
  })

  it('resolves an alias to the path of the anchored node without expanding it', () => {
    const alias = nodeAt(document, '$.copy')
    expect(alias?.display).toBe('*b')
    expect(alias?.aliasTarget).toBe('$.base')
    expect(alias?.children).toEqual([])
    expect(alias?.kind).toBe('string')
  })
})

describe('parseYamlDocument documents', () => {
  it('reads a single document without a wrapper', () => {
    expect(rootOf('a: 1\n').kind).toBe('object')
  })

  it('presents a stream as one array of documents', () => {
    const document = documentOf('a: 1\n---\nb: 2\n---\nc: 3\n')
    expect(document.root?.kind).toBe('array')
    expect(document.root?.children.map(child => child.keyText)).toEqual(['document 1', 'document 2', 'document 3'])
    expect(document.root?.children.map(child => jsonPathKey(child.path))).toEqual(['$[0]', '$[1]', '$[2]'])
    expect(nodeAt(document, '$[1].b')?.display).toBe('2')
    expectFaithfulSpans('a: 1\n---\nb: 2\n---\nc: 3\n', document)
  })

  it('returns nothing for an empty or comment-only file', () => {
    expect(documentOf('').root).toBeNull()
    expect(documentOf('# just a note\n').root).toBeNull()
    expect(documentOf('# just a note\n').errors).toEqual([])
  })
})

describe('parseYamlDocument recovery', () => {
  it('reports a problem and still returns the part it understood', () => {
    const document = documentOf('a: 1\n b: 2\n')
    expect(document.errors.length).toBeGreaterThan(0)
    // The wording comes from the YAML library and is not localised, so the view
    // never shows it; the adapter only has to carry it for diagnostics.
    expect(typeof document.errors[0]?.detail).toBe('string')
    expect(document.errors[0]?.code).toBe('unexpected-value')
    expect(document.root?.kind).toBe('object')
  })

  it('stops at the node cap and says so', () => {
    const document = parseYamlDocument('a: 1\nb: 2\nc: 3\n', { maxNodes: 2 })
    expect(document.truncated).toBe(true)
    expect(document.root?.children).toHaveLength(1)
  })
})

describe('isYamlViewRenderable', () => {
  it('gates on the UTF-8 size of the document', () => {
    expect(isYamlViewRenderable('a: 1')).toBe(true)
    expect(isYamlViewRenderable(`a: ${'x'.repeat(YAML_VIEW_MAX_BYTES + 1)}`)).toBe(false)
  })
})
