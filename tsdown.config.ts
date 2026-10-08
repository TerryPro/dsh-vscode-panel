import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, resolve as resolvePath, sep } from 'node:path'
import { defineConfig } from 'tsdown'
import { transform } from 'lightningcss'

const PLUGIN_ID = '@lsq64737/dsh-workbench-layout'
const CSS_VIRTUAL_PREFIX = '\0dsh-workbench-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'
const CSS_SOURCES = new Map<string, string>()
const CSS_VIRTUAL_IDS = new Map<string, string>()
const requireFromConfig = createRequire(import.meta.url)

/**
 * The browser entry of `yaml`. Its package exports map prefers a Node build that
 * pulls in `buffer` and `process`, neither of which the Host's web runtime has,
 * so the client bundle resolves the path directly instead.
 */
const YAML_BROWSER_ENTRY = resolvePath('node_modules/yaml/browser/index.js')

const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-slots',
] as const

export default defineConfig([
  {
    name: PLUGIN_ID,
    entry: { index: 'lib/types/index.js' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    name: `${PLUGIN_ID}/client`,
    entry: { client: 'lib/types/client/index.js' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      neverBundle: [...CLIENT_EXTERNALS],
      alwaysBundle: (id: string) => CLIENT_EXTERNALS.includes(id as typeof CLIENT_EXTERNALS[number]) ? undefined : true,
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    plugins: [{
      name: 'dsh-workbench-css-inline',
      resolveId(source: string, importer: string | undefined) {
        if (source === 'yaml') return YAML_BROWSER_ENTRY
        if (!source.endsWith('.css')) return null
        const absolute = source.startsWith('.')
          ? importer === undefined ? source : sourceAssetPath(source, importer)
          : requireFromConfig.resolve(source)
        const existing = CSS_VIRTUAL_IDS.get(absolute)
        if (existing !== undefined) return existing
        const virtual = CSS_VIRTUAL_PREFIX + CSS_VIRTUAL_IDS.size + '-' + basename(absolute) + CSS_VIRTUAL_SUFFIX
        CSS_VIRTUAL_IDS.set(absolute, virtual)
        CSS_SOURCES.set(virtual, absolute)
        return virtual
      },
      async load(id: string) {
        if (!id.startsWith(CSS_VIRTUAL_PREFIX)) return null
        const file = CSS_SOURCES.get(id)
        if (file === undefined) throw new Error(`missing CSS source for ${id}`)
        this.addWatchFile(file)
        const source = await readFile(file)
        const modules = file.endsWith('.module.css')
        const result = transform({
          filename: file,
          code: source,
          ...(modules ? { cssModules: { pattern: '[hash]_[local]' } } : {}),
          minify: true,
        })
        const classMap: Record<string, string> = {}
        if (modules) {
          for (const [local, value] of Object.entries(result.exports ?? {})) classMap[local] = value.name
        }
        const tagId = `${PLUGIN_ID}/${basename(file)}`
        return [
          `const css = ${JSON.stringify(result.code.toString())};`,
          `const tagId = ${JSON.stringify(tagId)};`,
          "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {",
          "  const tag = document.createElement('style');",
          `  tag.dataset.plugin = ${JSON.stringify(PLUGIN_ID)};`,
          '  tag.dataset.pluginCss = tagId;',
          '  tag.textContent = css;',
          '  document.head.appendChild(tag);',
          '}',
          `export default ${JSON.stringify(classMap)};`,
        ].join('\n')
      },
    }],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
  {
    // The Mermaid runtime: a self-contained ESM bundle of the `mermaid` library
    // (d3 + every diagram parser, ~3.4 MB) the Host serves at MERMAID_RUNTIME_PATH
    // and the browser half imports lazily. Kept out of client.js so the eagerly
    // loaded bundle stays small and the diagram library only downloads on demand.
    name: `${PLUGIN_ID}/mermaid-runtime`,
    entry: { 'mermaid-runtime': 'lib/types/client/mermaid/mermaid-runtime.js' },
    outDir: 'lib',
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    minify: true,
    clean: false,
    // Mermaid lazily imports each diagram parser; inline them all so the Host can
    // serve one self-contained file (no sibling chunks it does not know to route).
    outputOptions: {
      inlineDynamicImports: true,
    },
  },
])

function sourceAssetPath(source: string, importer: string): string {
  const emitted = resolvePath(dirname(importer), source)
  if (existsSync(emitted)) return emitted
  const marker = `${sep}lib${sep}types${sep}`
  const boundary = emitted.indexOf(marker)
  if (boundary < 0) return emitted
  return resolvePath(emitted.slice(0, boundary), 'src', emitted.slice(boundary + marker.length))
}
