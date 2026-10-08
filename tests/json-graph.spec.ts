import { describe, expect, it } from 'vitest'
import { parseJsonDocument, type JsonNode } from '../src/client/json/json-parse.ts'
import {
  allContainerKeys,
  buildGraphLayout,
  clampGraphScale,
  fitTransform,
  matchingCardIds,
  zoomAround,
  GRAPH_CARD_MAX_WIDTH,
  GRAPH_DEFAULT_EXPAND_DEPTH,
  GRAPH_GAP_X,
  GRAPH_MARGIN,
  GRAPH_PAGE_SIZE,
  GRAPH_ROW_HEIGHT,
  GRAPH_SCALE_MAX,
  GRAPH_SCALE_MIN,
  type GraphLayout,
} from '../src/client/json/json-graph.ts'

function rootOf(text: string): JsonNode {
  const parsed = parseJsonDocument(text)
  if (parsed.root === null) throw new Error(`no root for ${JSON.stringify(text)}`)
  return parsed.root
}

function layoutOf(text: string, options = {}): GraphLayout {
  return buildGraphLayout(rootOf(text), options)
}

function card(layout: GraphLayout, id: string) {
  const found = layout.cards.find(candidate => candidate.id === id)
  if (found === undefined) throw new Error(`no card ${id}`)
  return found
}

describe('buildGraphLayout cards', () => {
  const layout = layoutOf('{"name": "w", "deps": {"a": 1, "b": {"c": 2}}, "list": [1, 2]}')

  it('gives every object and array its own card, one row per member', () => {
    expect(layout.cards.map(c => c.id)).toEqual(['$', '$.deps', '$.deps.b', '$.list'])
    expect(card(layout, '$').rows.map(row => row.key)).toEqual(['name', 'deps', 'list'])
    expect(card(layout, '$.deps').rows.map(row => `${row.key}: ${row.text}`)).toEqual(['a: 1', 'b: {1}'])
    expect(card(layout, '$.list').rows.map(row => `${row.key}: ${row.text}`)).toEqual(['[0]: 1', '[1]: 2'])
  })

  it('marks the rows that point at another card', () => {
    const rows = card(layout, '$').rows
    expect(rows[0]).toMatchObject({ childId: null, collapsible: false })
    expect(rows[1]).toMatchObject({ childId: '$.deps', collapsible: true, collapsed: false })
    expect(rows[2]).toMatchObject({ childId: '$.list', collapsible: true })
  })

  it('sizes a card from its rows', () => {
    expect(card(layout, '$').height).toBe(3 * GRAPH_ROW_HEIGHT + 2)
    expect(card(layout, '$.deps.b').height).toBe(GRAPH_ROW_HEIGHT + 2)
    expect(card(layout, '$').width).toBeGreaterThan(0)
    expect(card(layout, '$').width).toBeLessThanOrEqual(GRAPH_CARD_MAX_WIDTH)
  })

  it('places each depth in its own column, clear of the one before it', () => {
    const root = card(layout, '$')
    const deps = card(layout, '$.deps')
    expect(root.x).toBe(GRAPH_MARGIN)
    expect(deps.x).toBe(GRAPH_MARGIN + root.width + GRAPH_GAP_X)
    expect(card(layout, '$.deps.b').x).toBeGreaterThan(deps.x + deps.width)
  })

  it('stacks sibling cards without overlapping them', () => {
    const byDepth = new Map<number, typeof layout.cards>()
    for (const entry of layout.cards) {
      byDepth.set(entry.depth, [...(byDepth.get(entry.depth) ?? []), entry])
    }
    for (const [depth, cards] of byDepth) {
      const sorted = [...cards].sort((a, b) => a.y - b.y)
      for (let index = 1; index < sorted.length; index += 1) {
        const previous = sorted[index - 1]
        const current = sorted[index]
        if (previous === undefined || current === undefined) continue
        expect(current.y, `depth ${depth}`).toBeGreaterThanOrEqual(previous.y + previous.height)
      }
    }
    // The parent sits inside the span its children gathered, not above both.
    const deps = card(layout, '$.deps')
    const leaf = card(layout, '$.deps.b')
    expect(deps.y).toBeLessThanOrEqual(leaf.y + leaf.height)
  })

  it('reports the extent of the drawn content', () => {
    expect(layout.width).toBeGreaterThan(card(layout, '$.deps.b').x)
    expect(layout.height).toBeGreaterThan(card(layout, '$.list').y + card(layout, '$.list').height)
  })
})

describe('buildGraphLayout edges', () => {
  const layout = layoutOf('{"name": "w", "deps": {"a": 1, "b": {"c": 2}}, "list": [1, 2]}')

  it('wires a card row to the card it points at, labelled with the key', () => {
    expect(layout.edges.map(edge => `${edge.from}->${edge.to}`)).toEqual([
      '$->$.deps',
      '$.deps->$.deps.b',
      '$->$.list',
    ])
  })

  it('anchors an edge at its row and at the child card centre', () => {
    const root = card(layout, '$')
    const edge = layout.edges.find(candidate => candidate.to === '$.deps')
    const child = card(layout, '$.deps')
    expect(edge?.x1).toBe(root.x + root.width)
    expect(edge?.y1).toBe(root.y + 1 * GRAPH_ROW_HEIGHT + GRAPH_ROW_HEIGHT / 2)
    expect(edge?.x2).toBe(child.x)
    expect(edge?.y2).toBe(child.y + child.height / 2)
    expect(edge?.label).toBe('deps')
  })
})

describe('buildGraphLayout folding', () => {
  const text = '{"deps": {"a": 1}, "list": [1, 2]}'

  it('drops a folded branch and keeps its row as the handle', () => {
    const layout = buildGraphLayout(rootOf(text), { collapsed: new Set(['$.deps']) })
    expect(layout.cards.map(c => c.id)).toEqual(['$', '$.list'])
    expect(layout.edges.map(edge => edge.to)).toEqual(['$.list'])
    expect(card(layout, '$').rows[0]).toMatchObject({ childId: '$.deps', collapsed: true })
  })

  it('keeps the folded row pointing at its card so it can reopen', () => {
    const folded = buildGraphLayout(rootOf(text), { collapsed: new Set(['$.deps']) })
    const opened = buildGraphLayout(rootOf(text), { collapsed: new Set() })
    expect(card(folded, '$').rows[0]?.childId).toBe(card(opened, '$').rows[0]?.childId)
  })
})

describe('buildGraphLayout shapes', () => {
  it('counts an empty container instead of drawing a card for it', () => {
    const layout = layoutOf('{"deps": {}, "list": []}')
    expect(card(layout, '$').rows.map(row => `${row.key}: ${row.text}`)).toEqual(['deps: {0}', 'list: [0]'])
    expect(card(layout, '$').rows.every(row => !row.collapsible)).toBe(true)
  })

  it('draws a scalar document as a single card', () => {
    const layout = layoutOf('42')
    expect(layout.cards).toHaveLength(1)
    expect(card(layout, '$').rows[0]).toMatchObject({ key: null, text: '42', kind: 'number' })
  })

  it('hangs array elements off the array card', () => {
    const layout = layoutOf('[1, {"a": 1}]')
    expect(card(layout, '$').rows.map(row => row.key)).toEqual(['[0]', '[1]'])
    expect(layout.cards.map(c => c.id)).toEqual(['$', '$[1]'])
    expect(card(layout, '$[1]').rows.map(row => `${row.key}: ${row.text}`)).toEqual(['a: 1'])
  })

  it('shortens a long value instead of widening the card', () => {
    const layout = layoutOf(`{"note": "${'z'.repeat(200)}"}`)
    const row = card(layout, '$').rows[0]
    expect(row?.text.endsWith('…')).toBe(true)
    expect(row?.display).toHaveLength(200)
    expect(card(layout, '$').width).toBeLessThanOrEqual(GRAPH_CARD_MAX_WIDTH)
  })

  it('pages a long array and reveals more on request', () => {
    const text = `[${Array.from({ length: GRAPH_PAGE_SIZE + 7 }, (_, index) => index).join(',')}]`
    const first = layoutOf(text)
    expect(card(first, '$').rows).toHaveLength(GRAPH_PAGE_SIZE + 1)
    expect(card(first, '$').hasMore).toBe(true)
    expect(card(first, '$').rows[GRAPH_PAGE_SIZE]).toMatchObject({ moreFor: '$', hidden: 7 })
    const second = buildGraphLayout(rootOf(text), { revealed: new Map([['$', 1]]) })
    expect(card(second, '$').rows).toHaveLength(GRAPH_PAGE_SIZE + 7)
    expect(card(second, '$').hasMore).toBe(false)
  })

  it('produces nothing for an absent document', () => {
    expect(buildGraphLayout(null)).toEqual({ cards: [], edges: [], width: 0, height: 0 })
  })
})

describe('matchingCardIds', () => {
  const layout = layoutOf('{"deps": {"mermaid": "11.17.0"}}')

  it('matches keys, values and paths, case-insensitively', () => {
    expect(matchingCardIds(layout, 'DEPS')).toEqual(['$', '$.deps'])
    expect(matchingCardIds(layout, '11.17')).toEqual(['$.deps'])
    expect(matchingCardIds(layout, 'nope')).toEqual([])
    expect(matchingCardIds(layout, '   ')).toEqual([])
  })
})

describe('allContainerKeys', () => {
  const root = rootOf('{"a": [1, {"b": 1}], "c": {"d": {"e": {"f": 1}}}}')

  it('collects containers at or below the requested depth', () => {
    expect(allContainerKeys(root, 3)).toEqual(new Set(['$.c.d.e']))
    expect(allContainerKeys(root, 2)).toEqual(new Set(['$.a[1]', '$.c.d', '$.c.d.e']))
    expect(allContainerKeys(root, 0).has('$')).toBe(true)
  })

  it('defaults to the expand depth the canvas opens a document at', () => {
    expect(allContainerKeys(root)).toEqual(allContainerKeys(root, GRAPH_DEFAULT_EXPAND_DEPTH))
  })

  it('returns nothing for an absent document', () => {
    expect(allContainerKeys(null)).toEqual(new Set())
  })

  it('folds exactly the branches the preset names', () => {
    const layout = buildGraphLayout(root, { collapsed: allContainerKeys(root) })
    expect(layout.cards.map(card => card.id)).toEqual(['$', '$.a', '$.a[1]', '$.c', '$.c.d'])
  })
})

describe('canvas transforms', () => {
  const layout: GraphLayout = { cards: [], edges: [], width: 1000, height: 800 }

  it('fits a layout inside the viewport and centres it', () => {
    expect(fitTransform(layout, { width: 500, height: 400 }, 20)).toEqual({ x: 25, y: 20, scale: 0.45 })
  })

  it('never scales past 100% when fitting', () => {
    expect(fitTransform(layout, { width: 4000, height: 4000 }, 20).scale).toBe(1)
  })

  it('falls back to 100% without a measured viewport', () => {
    expect(fitTransform(layout, { width: 0, height: 0 })).toEqual({ x: 24, y: 24, scale: 1 })
    expect(fitTransform({ cards: [], edges: [], width: 0, height: 0 }, { width: 400, height: 300 })).toEqual({ x: 24, y: 24, scale: 1 })
  })

  it('zooms around a point so the document under it stays put', () => {
    expect(zoomAround({ x: 0, y: 0, scale: 1 }, { x: 100, y: 100 }, 2)).toEqual({ x: -100, y: -100, scale: 2 })
  })

  it('clamps zoom into the usable band', () => {
    expect(clampGraphScale(0)).toBe(GRAPH_SCALE_MIN)
    expect(clampGraphScale(99)).toBe(GRAPH_SCALE_MAX)
    expect(clampGraphScale(Number.NaN)).toBe(1)
  })
})
