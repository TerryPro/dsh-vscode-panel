import { describe, expect, it } from 'vitest'
import { languageForPath, languageLabelForPath } from '../src/client/editor-languages.ts'

describe('languageForPath', () => {
  it.each([
    'src/a.ts',
    'src/a.tsx',
    'src/a.js',
    'src/a.jsx',
    'src/a.mjs',
    'package.json',
    'index.html',
    'styles.css',
    'README.md',
    'page.mdx',
    'notes.mdown',
    'main.py',
    'config.yaml',
    'App.java',
    'main.cpp',
    'lib.rs',
    'server.go',
    'query.sql',
    'index.php',
    'data.xml',
    'deploy.sh',
    'Cargo.toml',
    'settings.ini',
    'Dockerfile',
    'app/.dockerfile',
  ])('resolves a grammar for %s', path => {
    expect(languageForPath(path)).not.toBeNull()
  })

  it('handles Windows separators, dotfiles, and mixed case', () => {
    expect(languageForPath('src\\module\\a.TS')).not.toBeNull()
    expect(languageForPath('notes.markdown')).not.toBeNull()
    expect(languageForPath('old.MKD')).not.toBeNull()
    expect(languageForPath('.env')).not.toBeNull()
    expect(languageForPath('.bashrc')).not.toBeNull()
  })

  it('leaves unknown or extension-less paths as plain text', () => {
    expect(languageForPath('LICENSE')).toBeNull()
    expect(languageForPath('data.unknownext')).toBeNull()
    expect(languageForPath('.gitignore')).toBeNull()
    expect(languageForPath(undefined)).toBeNull()
  })
})

describe('languageLabelForPath', () => {
  it('names recognised grammars', () => {
    expect(languageLabelForPath('src/a.ts')).toBe('TypeScript')
    expect(languageLabelForPath('src/a.tsx')).toBe('TypeScript JSX')
    expect(languageLabelForPath('package.json')).toBe('JSON')
    expect(languageLabelForPath('deploy.sh')).toBe('Shell Script')
    expect(languageLabelForPath('Cargo.toml')).toBe('TOML')
    expect(languageLabelForPath('Dockerfile')).toBe('Dockerfile')
  })

  it('falls back to Plain Text for unrecognised paths', () => {
    expect(languageLabelForPath('LICENSE')).toBe('Plain Text')
    expect(languageLabelForPath(undefined)).toBe('Plain Text')
  })
})
