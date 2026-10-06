import { buildGitHunkDiff, type GitHunkDiffRow } from './git-hunk-diff.ts'
import { GIT_LINE_NUMBER_WIDTH_PROPERTY } from './git-line-decorations-theme.ts'
import type { GitLineDecorationLabels } from './git-line-decorations.ts'

export function peekButton(action: 'previous' | 'next' | 'revert' | 'close', label: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.dataset.gitPeekAction = action
  button.textContent = label
  return button
}

export function gitHunkDiffDom(
  diff: ReturnType<typeof buildGitHunkDiff>,
  labels: GitLineDecorationLabels,
): HTMLElement {
  const body = document.createElement('div')
  body.className = 'cm-gitChangePeekBody'
  body.dataset.gitLocalDiff = ''
  const largestLineNumber = diff.rows.reduce((largest, row) => (
    Math.max(largest, row.oldLine ?? 0, row.newLine ?? 0)
  ), 0)
  body.style.setProperty(GIT_LINE_NUMBER_WIDTH_PROPERTY, `${Math.max(4, String(largestLineNumber).length + 1)}ch`)
  const metadata = document.createElement('div')
  metadata.className = 'cm-gitChangePeekHunkHeader'
  const sides = document.createElement('span')
  sides.textContent = `${labels.before} ↔ ${labels.current}`
  const header = document.createElement('code')
  header.textContent = diff.header
  metadata.append(sides, header)
  const rows = document.createElement('div')
  rows.className = 'cm-gitChangePeekRows'
  rows.setAttribute('role', 'list')
  rows.setAttribute('aria-label', `${labels.before} / ${labels.current}`)
  for (const row of diff.rows) rows.append(gitHunkDiffRowDom(row, labels))
  body.append(metadata, rows)
  return body
}

function gitHunkDiffRowDom(row: GitHunkDiffRow, labels: GitLineDecorationLabels): HTMLElement {
  const element = document.createElement('div')
  element.className = 'cm-gitChangePeekRow'
  element.dataset.diffKind = row.kind
  element.setAttribute('role', 'listitem')
  element.setAttribute('aria-label', diffRowLabel(row, labels))
  const oldLine = document.createElement('span')
  oldLine.className = 'cm-gitChangePeekLineNumber'
  oldLine.dataset.side = 'old'
  oldLine.textContent = row.oldLine?.toString() ?? ''
  const newLine = document.createElement('span')
  newLine.className = 'cm-gitChangePeekLineNumber'
  newLine.dataset.side = 'new'
  newLine.textContent = row.newLine?.toString() ?? ''
  const prefix = document.createElement('span')
  prefix.className = 'cm-gitChangePeekPrefix'
  prefix.setAttribute('aria-hidden', 'true')
  prefix.textContent = row.kind === 'removed' ? '-' : row.kind === 'added' ? '+' : ' '
  const content = document.createElement('code')
  content.className = 'cm-gitChangePeekCode'
  for (const segment of row.segments) {
    const span = document.createElement('span')
    span.dataset.diffSegment = segment.kind
    span.textContent = segment.text
    content.append(span)
  }
  element.append(oldLine, newLine, prefix, content)
  return element
}

function diffRowLabel(row: GitHunkDiffRow, labels: GitLineDecorationLabels): string {
  switch (row.kind) {
    case 'removed': return `${labels.before} ${row.oldLine ?? ''}: ${row.text}`
    case 'added': return `${labels.current} ${row.newLine ?? ''}: ${row.text}`
    case 'context': return `${labels.before} ${row.oldLine ?? ''}, ${labels.current} ${row.newLine ?? ''}: ${row.text}`
  }
}
