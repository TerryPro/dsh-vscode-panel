import { describe, expect, it } from 'vitest'
import { parseJsonDocument, type JsonNode } from '../src/client/json/json-parse.ts'
import {
  allContainerKeys,
  collapsedPreview,
  flattenVisibleJson,
  isContainer,
  JSON_ARRAY_PAGE,
  memberLabel,
  shortenJsonValue,
  walk,
  type JsonRow,
} from '../src/client/json/json-tree-view.ts'

const SOURCE = '{\n  "name": "w",\n  "items": [1, 2, 3],\n  "meta": { "deep": { "deeper": { "deepest": 1 } } }\n}'

function rootOf(text: string): JsonNode {
  const parsed = parseJsonDocument(text)
  if (parsed.root === null) throw new Error(`no root for ${JSON.stringify(text)}`)
  return parsed.root
}

function keys(rows: readonly JsonRow[]): string[] {
  return rows.filter(row => row.kind === 'node').map(row => row.key)
}

describe('flattenVisibleJson', () => {
  const root = rootOf(SOURCE)

  it('lists nodes in source order with the container opened', () => {
    const { rows } = flattenVisibleJson(root)
    expect(keys(rows)).toEqual(['$', '$.name', '$.items', '$.items[0]', '$.items[1]', '$.items[2]', '$.meta', '$.meta.deep', '$.meta.deep.deeper', '$.meta.deep.deeper.deepest'])
  })

  it('hides a folded branch and marks it on the row', () => {
    const { rows } = flattenVisibleJson(root, { collapsed: new Set(['$.meta']) })
    expect(keys(rows)).toEqual(['$', '$.name', '$.items', '$.items[0]', '$.items[1]', '$.items[2]', '$.meta'])
    const metaRow = rows.find(row => row.key === '$.meta')
    expect(metaRow?.kind === 'node' && metaRow.collapsed).toBe(true)
  })

  it('leaves a scalar row unmarked and reports nesting', () => {
    const { rows } = flattenVisibleJson(root)
    const nested = rows.find(row => row.key === '$.meta.deep.deeper.deepest')
    expect(nested?.kind === 'node' && isContainer(nested.node)).toBe(false)
    expect(nested?.depth).toBe(4)
  })

  it('pages a long array and reveals more on request', () => {
    const big = rootOf(`[${Array.from({ length: JSON_ARRAY_PAGE + 50 }, (_, index) => index).join(',')}]`)
    const first = flattenVisibleJson(big)
    expect(first.rows.filter(row => row.kind === 'node')).toHaveLength(JSON_ARRAY_PAGE + 1)
    const cursor = first.rows.find(row => row.kind === 'more')
    if (cursor?.kind !== 'more') throw new Error('expected a “show more” cursor')
    expect(cursor.hidden).toBe(50)
    const second = flattenVisibleJson(big, { revealed: new Map([[cursor.parentKey, 1]]) })
    expect(second.rows.some(row => row.kind === 'more')).toBe(false)
    expect(second.rows.filter(row => row.kind === 'node')).toHaveLength(JSON_ARRAY_PAGE + 50 + 1)
  })

  it('produces nothing for an empty document', () => {
    expect(flattenVisibleJson(null).rows).toEqual([])
  })
})

describe('flattenVisibleJson closers', () => {
  const root = rootOf('{ "a": [1, 2], "b": {}, "c": { "d": 1 } }')

  it('gives every opened container its own closing row', () => {
    const closers = flattenVisibleJson(root).rows.filter(row => row.kind === 'close')
    expect(closers.map(row => row.kind === 'close' && row.owner)).toEqual(['$.a', '$.c', '$'])
    expect(closers.map(row => row.kind === 'close' && row.depth)).toEqual([1, 1, 0])
  })

  it('closes a container after its “show more” cursor', () => {
    const big = rootOf(`[${Array.from({ length: JSON_ARRAY_PAGE + 5 }, (_, index) => index).join(',')}]`)
    const kinds = flattenVisibleJson(big, { arrayPage: 2 }).rows.map(row => row.kind)
    expect(kinds.slice(-3)).toEqual(['node', 'more', 'close'])
  })

  it('drops the closing row of a folded branch, and never invents one for `{}`', () => {
    const folded = flattenVisibleJson(root, { collapsed: new Set(['$.c']) }).rows
    expect(folded.filter(row => row.kind === 'close').map(row => row.kind === 'close' && row.owner)).toEqual(['$.a', '$'])
    expect(rootOf('{}').children).toHaveLength(0)
    expect(flattenVisibleJson(rootOf('{}')).rows.filter(row => row.kind === 'close')).toEqual([])
  })
})

describe('collapsedPreview', () => {
  it('previews the first members and counts what it left out', () => {
    const node = rootOf('{ "one": { "a": 1, "b": 2, "c": 3 } }').children[0] as JsonNode
    expect(collapsedPreview(node)).toEqual({ text: '"a": 1, "b": 2', hidden: 1 })
  })

  it('labels array elements by index and nests containers as ellipses', () => {
    const node = rootOf('{ "list": [1, "two", { "x": 1 }, [2]] }').children[0] as JsonNode
    expect(collapsedPreview(node).text).toBe('[0]: 1, [1]: "two"')
    expect(collapsedPreview(node, 4).text).toBe('[0]: 1, [1]: "two", [2]: {…}, [3]: […]')
  })

  it('keeps a long value short enough to scan', () => {
    const node = rootOf(`{ "e": { "note": "${'z'.repeat(60)}" } }`).children[0] as JsonNode
    expect(collapsedPreview(node).text).toBe(`"note": ${'"'}${'z'.repeat(23)}…`)
  })

  it('previews nothing for a scalar or an empty container', () => {
    expect(collapsedPreview(rootOf('1'))).toEqual({ text: '', hidden: 0 })
    expect(collapsedPreview(rootOf('[]'))).toEqual({ text: '', hidden: 0 })
  })

  it('names a member the way the tree shows it', () => {
    const root = rootOf('{ "a": [1] }')
    expect(memberLabel(root)).toBe('$')
    expect(memberLabel(root.children[0] as JsonNode)).toBe('"a"')
    expect(memberLabel((root.children[0] as JsonNode).children[0] as JsonNode)).toBe('[0]')
  })
})

describe('flattenVisibleJson search', () => {
  const root = rootOf(SOURCE)

  it('keeps a hit with its ancestor chain and reports the count', () => {
    const { rows, matches } = flattenVisibleJson(root, { search: 'deepest' })
    expect(matches).toBe(1)
    expect(keys(rows)).toEqual(['$', '$.meta', '$.meta.deep', '$.meta.deep.deeper', '$.meta.deep.deeper.deepest'])
  })

  it('matches values as well as keys, ignoring case', () => {
    expect(keys(flattenVisibleJson(root, { search: 'W' }).rows)).toContain('$.name')
    expect(keys(flattenVisibleJson(root, { search: '2' }).rows)).toContain('$.items[1]')
  })

  it('shows matched branches open even when folded', () => {
    const { rows } = flattenVisibleJson(root, { collapsed: new Set(['$.meta']), search: 'deep' })
    expect(keys(rows)).toContain('$.meta.deep.deeper.deepest')
  })

  it('yields no rows when nothing matches', () => {
    const { rows, matches } = flattenVisibleJson(root, { search: 'absent' })
    expect(rows).toEqual([])
    expect(matches).toBe(0)
  })

  it('treats a whitespace-only query as no filter', () => {
    expect(flattenVisibleJson(root, { search: '   ' }).matches).toBe(0)
    expect(keys(flattenVisibleJson(root, { search: '   ' }).rows)).toContain('$.items[0]')
  })
})

describe('allContainerKeys', () => {
  const root = rootOf(SOURCE)

  it('folds containers at or below the requested depth', () => {
    expect(allContainerKeys(root, 1)).toEqual(new Set(['$.items', '$.meta', '$.meta.deep', '$.meta.deep.deeper']))
    expect(allContainerKeys(root, 2)).toEqual(new Set(['$.meta.deep', '$.meta.deep.deeper']))
    expect(allContainerKeys(root, 0).has('$')).toBe(true)
  })

  it('returns nothing for an empty document', () => {
    expect(allContainerKeys(null)).toEqual(new Set())
  })
})

describe('walk and shortenJsonValue', () => {
  it('visits every node depth-first in source order', () => {
    const visited = [...walk(rootOf('{"a": [1, {"b": 2}], "c": 3}'))].map(node => node.kind)
    expect(visited).toEqual(['object', 'array', 'number', 'object', 'number', 'number'])
  })

  it('truncates long values with an ellipsis', () => {
    expect(shortenJsonValue('abc', 10)).toBe('abc')
    expect(shortenJsonValue('abcdef', 3)).toBe('abc…')
  })
})
