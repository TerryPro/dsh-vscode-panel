// @vitest-environment jsdom

import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CodeEditor } from '../src/client/editor/CodeEditor.tsx'

afterEach(() => { cleanup() })

describe('Mermaid source highlighting', () => {
  it('loads the mermaid grammar for a .mmd file and colourises the source', async () => {
    const view = render(
      <CodeEditor
        value={'flowchart TD\n  A[Start] --> B{End}\n  %% a note\n'}
        onChange={() => {}}
        ariaLabel="diagram.mmd"
        path="diagram.mmd"
      />,
    )
    // The stream grammar is attached, so the buffer is no longer plain text.
    expect(view.container.querySelector('.cm-content')?.getAttribute('data-language')).toBe('mermaid')
    await waitFor(() => {
      expect(view.container.querySelectorAll('.cm-line span').length).toBeGreaterThanOrEqual(3)
    })
  })
})
