/**
 * The Mermaid runtime entry, bundled by tsdown into `lib/mermaid-runtime.js`
 * (a separate config in `tsdown.config.ts`) and served by the Host at
 * `MERMAID_RUNTIME_PATH`. The browser half imports that served URL lazily — see
 * `mermaid-loader.ts` — so the multi-megabyte library (Mermaid pulls in d3 and
 * every diagram parser) never lands in the eagerly-loaded client bundle and the
 * diagram panel renders fully offline against a pinned version.
 *
 * This module is deliberately NOT imported by anything in the client graph; it
 * exists only as the standalone bundle's entry point.
 */
import mermaid from 'mermaid'

export default mermaid
