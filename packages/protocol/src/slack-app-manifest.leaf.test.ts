import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * `./slack-app-manifest` is the only protocol subpath a *bundler* compiles from
 * source: the web console value-imports it, and in dev the `development` export
 * condition resolves it to `src/slack-app-manifest.ts` instead of `dist/`.
 *
 * Turbopack does not implement TypeScript's `.js` → `.ts` extension substitution,
 * and Next lists its webpack escape hatch (`experimental.extensionAlias`) as
 * Turbopack-unsupported. So a single NodeNext-style `./foo.js` specifier reachable
 * from that entry point breaks `next dev` for every console route — while
 * `pnpm typecheck`, `pnpm test`, and `next build` (which reads `dist/`) all stay
 * green, because none of them run Turbopack against this source.
 *
 * Keeping the entry point free of relative imports is what makes it bundler-safe.
 * If you need to share something with it, define it there and import *from* it.
 */
describe('slack-app-manifest is bundler-safe', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

  it('is still the file the development export condition points at', () => {
    const pkg = JSON.parse(read('../package.json'))
    expect(pkg.exports['./slack-app-manifest'].development).toBe('./src/slack-app-manifest.ts')
  })

  it('has no relative imports for a bundler to resolve', () => {
    // `from './x'` / `from '../x'`, plus dynamic `import('./x')`.
    const source = read('./slack-app-manifest.ts')
    const relative = [...source.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"](\.[^'"]*)['"]/g)].map((m) => m[1])
    expect(relative).toEqual([])
  })
})
