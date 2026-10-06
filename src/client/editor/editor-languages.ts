import { cpp } from '@codemirror/lang-cpp'
import { css } from '@codemirror/lang-css'
import { go } from '@codemirror/lang-go'
import { html } from '@codemirror/lang-html'
import { java } from '@codemirror/lang-java'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { php } from '@codemirror/lang-php'
import { python } from '@codemirror/lang-python'
import { rust } from '@codemirror/lang-rust'
import { sql } from '@codemirror/lang-sql'
import { yaml } from '@codemirror/lang-yaml'
import { xml } from '@codemirror/lang-xml'
import { LanguageDescription, StreamLanguage } from '@codemirror/language'
import type { LanguageSupport } from '@codemirror/language'
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile'
import { properties } from '@codemirror/legacy-modes/mode/properties'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import type { Extension } from '@codemirror/state'

/**
 * Resolve a CodeMirror language extension from a workspace file path.
 *
 * The workbench editor only ever knows a file by its path, so the extension is
 * the single source of truth for which grammar to load. Unknown paths return
 * `null`, leaving the buffer as plain text with no syntax highlighting.
 */
export function languageForPath(path: string | undefined): Extension | null {
  const grammar = grammarForPath(path)
  return grammar === null ? null : languageExtension(grammar)
}

/** Human-readable language name for the editor status bar; "Plain Text" when none matches. */
export function languageLabelForPath(path: string | undefined): string {
  const grammar = grammarForPath(path)
  return grammar === null ? 'Plain Text' : LANGUAGE_LABELS[grammar]
}

type Grammar =
  | 'c' | 'cpp' | 'css' | 'dockerfile' | 'go' | 'html' | 'java' | 'javascript'
  | 'json' | 'jsx' | 'markdown' | 'php' | 'properties' | 'python' | 'rust'
  | 'shell' | 'sql' | 'ts' | 'toml' | 'tsx' | 'typescript' | 'xml' | 'yaml'

const EXTENSION_GRAMMARS: Record<string, Grammar> = {
  c: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  cs: 'cpp',
  h: 'c',
  hpp: 'cpp',
  conf: 'properties',
  cfg: 'properties',
  env: 'properties',
  ini: 'properties',
  properties: 'properties',
  css: 'css',
  scss: 'css',
  less: 'css',
  go: 'go',
  htm: 'html',
  html: 'html',
  vue: 'html',
  java: 'java',
  bash: 'shell',
  sh: 'shell',
  zsh: 'shell',
  cjs: 'javascript',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  markdown: 'markdown',
  md: 'markdown',
  mdown: 'markdown',
  mkd: 'markdown',
  mdx: 'markdown',
  php: 'php',
  py: 'python',
  rs: 'rust',
  sql: 'sql',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'tsx',
  xml: 'xml',
  xhtml: 'html',
  yaml: 'yaml',
  yml: 'yaml',
}

// Files matched by their exact (case-insensitive) base name rather than extension.
const SPECIAL_FILE_GRAMMARS: Record<string, Grammar> = {
  dockerfile: 'dockerfile',
  '.dockerfile': 'dockerfile',
  '.env': 'properties',
  '.bashrc': 'shell',
  '.zshrc': 'shell',
  '.profile': 'shell',
}

const LANGUAGE_LABELS: Record<Grammar, string> = {
  c: 'C',
  cpp: 'C++',
  css: 'CSS',
  dockerfile: 'Dockerfile',
  go: 'Go',
  html: 'HTML',
  java: 'Java',
  javascript: 'JavaScript',
  json: 'JSON',
  jsx: 'JavaScript JSX',
  markdown: 'Markdown',
  php: 'PHP',
  properties: 'INI',
  python: 'Python',
  rust: 'Rust',
  shell: 'Shell Script',
  sql: 'SQL',
  ts: 'TypeScript',
  toml: 'TOML',
  tsx: 'TypeScript JSX',
  typescript: 'TypeScript',
  xml: 'XML',
  yaml: 'YAML',
}

function grammarForPath(path: string | undefined): Grammar | null {
  if (path === undefined) return null
  const name = basename(path).toLowerCase()
  if (name in SPECIAL_FILE_GRAMMARS) return SPECIAL_FILE_GRAMMARS[name] ?? null
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return null
  return EXTENSION_GRAMMARS[name.slice(dot + 1)] ?? null
}

function languageExtension(grammar: Grammar): Extension {
  switch (grammar) {
    case 'c':
    case 'cpp': return cpp()
    case 'css': return css()
    case 'dockerfile': return StreamLanguage.define(dockerFile)
    case 'go': return go()
    case 'html': return html()
    case 'java': return java()
    case 'javascript': return javascript()
    case 'jsx': return javascript({ jsx: true })
    case 'json': return json()
    case 'markdown': return markdownSupport()
    case 'php': return php()
    case 'properties': return StreamLanguage.define(properties)
    case 'python': return python()
    case 'rust': return rust()
    case 'shell': return StreamLanguage.define(shell)
    case 'sql': return sql()
    case 'toml': return StreamLanguage.define(toml)
    case 'ts':
    case 'typescript': return javascript({ typescript: true })
    case 'tsx': return javascript({ typescript: true, jsx: true })
    case 'xml': return xml()
    case 'yaml': return yaml()
  }
}

function basename(path: string): string {
  const normalized = path.replace(/\\/gu, '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

/**
 * Markdown grammar aligned with the preview renderer: a GFM base (tables,
 * strikethrough, task lists, autolinks) plus syntax highlighting for fenced
 * code blocks in the languages this workbench can already open. Fences in
 * other languages stay unstyled rather than mis-highlighted.
 */
function markdownSupport(): Extension {
  return markdown({ base: markdownLanguage, codeLanguages: MARKDOWN_CODE_LANGUAGES })
}

function codeLanguage(name: string, alias: readonly string[], support: LanguageSupport): LanguageDescription {
  return LanguageDescription.of({ name, alias, support })
}

const MARKDOWN_CODE_LANGUAGES: readonly LanguageDescription[] = [
  codeLanguage('JavaScript', ['js', 'jsx', 'javascript', 'mjs', 'cjs'], javascript()),
  codeLanguage('TypeScript', ['ts', 'tsx', 'typescript'], javascript({ typescript: true })),
  codeLanguage('JSON', ['json', 'jsonc', 'json5'], json()),
  codeLanguage('Python', ['py', 'python'], python()),
  codeLanguage('CSS', ['css'], css()),
  codeLanguage('HTML', ['html', 'htm'], html()),
  codeLanguage('YAML', ['yaml', 'yml'], yaml()),
  codeLanguage('SQL', ['sql'], sql()),
  codeLanguage('Rust', ['rs', 'rust'], rust()),
  codeLanguage('Java', ['java'], java()),
  codeLanguage('Go', ['go', 'golang'], go()),
  codeLanguage('C++', ['cpp', 'cc', 'cxx', 'hpp'], cpp()),
  codeLanguage('PHP', ['php'], php()),
  codeLanguage('XML', ['xml'], xml()),
]
