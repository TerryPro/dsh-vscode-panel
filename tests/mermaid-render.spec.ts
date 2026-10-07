import { describe, expect, it } from 'vitest'
import {
  clampZoom,
  createRenderGuard,
  diagramTypeOf,
  extractErrorLine,
  fitScale,
  resolveMermaidTheme,
  svgNaturalSize,
} from '../src/client/mermaid/mermaid-render.ts'
import { isMermaidPath, MERMAID_EXTENSIONS } from '../src/client/mermaid/mermaid-path.ts'

describe('isMermaidPath', () => {
  it('recognizes Mermaid extensions case-insensitively and from nested/Windows paths', () => {
    expect(isMermaidPath('diagram.mmd')).toBe(true)
    expect(isMermaidPath('docs/Graph.MERMAID')).toBe(true)
    expect(isMermaidPath('src\\win\\flow.mmd')).toBe(true)
    expect(MERMAID_EXTENSIONS).toEqual(['mmd', 'mermaid'])
  })

  it('rejects non-Mermaid files, dotfiles and missing paths', () => {
    expect(isMermaidPath('README.md')).toBe(false)
    expect(isMermaidPath('index.html')).toBe(false)
    expect(isMermaidPath('mmd')).toBe(false)
    expect(isMermaidPath('.mmd')).toBe(false)
    expect(isMermaidPath(undefined)).toBe(false)
  })
})

describe('resolveMermaidTheme', () => {
  it('follows the shell appearance', () => {
    expect(resolveMermaidTheme(true)).toBe('dark')
    expect(resolveMermaidTheme(false)).toBe('default')
  })
})

describe('createRenderGuard', () => {
  it('makes only the newest token current', () => {
    const guard = createRenderGuard()
    const first = guard.begin()
    const second = guard.begin()
    expect(guard.isCurrent(first)).toBe(false)
    expect(guard.isCurrent(second)).toBe(true)
  })
})

describe('diagramTypeOf', () => {
  it('reads the first content keyword, skipping blanks and comments', () => {
    expect(diagramTypeOf('flowchart TD\n  A-->B')).toBe('flowchart')
    expect(diagramTypeOf('%% a comment\n\nsequenceDiagram')).toBe('sequenceDiagram')
    expect(diagramTypeOf('%%{init: {}}%%\npie title Pets')).toBe('pie')
  })

  it('skips a leading YAML front-matter block', () => {
    expect(diagramTypeOf('---\ntitle: x\n---\ngraph TD')).toBe('graph')
  })

  it('returns empty for unrecognised or blank source', () => {
    expect(diagramTypeOf('just some text')).toBe('')
    expect(diagramTypeOf('')).toBe('')
  })
})

describe('extractErrorLine', () => {
  it('pulls a line number from either error phrasing', () => {
    expect(extractErrorLine('Parse error on line 4: unexpected token')).toBe(4)
    expect(extractErrorLine('gotcha at L12')).toBe(12)
  })

  it('returns null when the message names no line', () => {
    expect(extractErrorLine('something went wrong')).toBeNull()
  })
})

describe('clampZoom', () => {
  it('clamps to the usable band and rounds to two decimals', () => {
    expect(clampZoom(1)).toBe(1)
    expect(clampZoom(0.1)).toBe(0.25)
    expect(clampZoom(10)).toBe(6)
    expect(clampZoom(1.234)).toBe(1.23)
  })

  it('falls back to 1 for a non-finite value', () => {
    expect(clampZoom(Number.NaN)).toBe(1)
  })
})

describe('svgNaturalSize', () => {
  it('prefers the viewBox and falls back to width/height', () => {
    expect(svgNaturalSize('0 0 120 60', null, null)).toEqual({ width: 120, height: 60 })
    expect(svgNaturalSize('', '200', '80')).toEqual({ width: 200, height: 80 })
    expect(svgNaturalSize('0 0 0 0', '10', '10')).toEqual({ width: 10, height: 10 })
  })

  it('reports zero when nothing is measurable', () => {
    expect(svgNaturalSize(null, null, null)).toEqual({ width: 0, height: 0 })
  })
})

describe('fitScale', () => {
  it('contains the diagram within the padded box', () => {
    expect(fitScale(220, 120, 100, 50, 20)).toBe(2)
  })

  it('falls back to 1 when an extent is unmeasurable or the box is too small', () => {
    expect(fitScale(200, 200, 0, 0, 0)).toBe(1)
    expect(fitScale(100, 100, 50, 50, 200)).toBe(1)
  })
})
