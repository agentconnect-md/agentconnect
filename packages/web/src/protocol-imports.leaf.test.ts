import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PACKAGE = '@agentconnect.md/protocol'
const WEB_SRC = fileURLToPath(new URL('.', import.meta.url))
const PROTOCOL_DIR = fileURLToPath(new URL('../../protocol/', import.meta.url))

// `next dev` compiles protocol FROM SOURCE — the subpath's `development` export condition points into `src/`.
const exportsMap: Record<string, { development?: string }> = JSON.parse(
  readFileSync(join(PROTOCOL_DIR, 'package.json'), 'utf8')
).exports

/** Every file Turbopack can reach. Tests are excluded: they run through Vite, which DOES substitute `.ts` for `.js`. */
function bundledSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return bundledSources(path)
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return []
    return [path]
  })
}

/** Protocol specifiers a file pulls a VALUE from — an `import type` / `export type` clause never reaches a bundler. */
function protocolValueImports(source: string): string[] {
  // Comments go first, so prose quoting an import does not read as one.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  const found = new Set<string>()
  // Quotes and parens are barred from the clause, so a match can never span the statement in front of it.
  for (const match of code.matchAll(/\b(?:import|export)\b([^'"()]*?)from\s*['"]([^'"]+)['"]/g)) {
    if (match[2]!.startsWith(PACKAGE) && !/^\s*type\b/.test(match[1]!)) found.add(match[2]!)
  }
  // Side-effect `import 'x'` and dynamic `import('x')`, neither of which has a `from` clause.
  for (const match of code.matchAll(/\bimport\s*(?:\(\s*)?['"]([^'"]+)['"]/g)) {
    if (match[1]!.startsWith(PACKAGE)) found.add(match[1]!)
  }
  return [...found]
}

/** `from './x'` / `from '../x'`, plus dynamic `import('./x')` — the specifiers a bundler has to resolve itself. */
function relativeImportsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8')
  return [...source.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"](\.[^'"]*)['"]/g)].map((match) => match[1]!)
}

describe('the console value-imports only bundler-safe protocol modules', () => {
  const importers = bundledSources(WEB_SRC).flatMap((file) =>
    protocolValueImports(readFileSync(file, 'utf8')).map((specifier) => ({ file, specifier }))
  )

  it('reads value imports and skips type-only ones', () => {
    const read = protocolValueImports
    expect(read(`import { HOOK_KINDS } from '${PACKAGE}'`)).toEqual([PACKAGE])
    expect(read(`import { a, type B } from '${PACKAGE}/code-host'`)).toEqual([`${PACKAGE}/code-host`])
    expect(read(`export { sumAmounts } from '${PACKAGE}/decimal-amount'`)).toEqual([`${PACKAGE}/decimal-amount`])
    expect(read(`const m = await import('${PACKAGE}')`)).toEqual([PACKAGE])
    expect(read(`import type { HookKind } from '${PACKAGE}'`)).toEqual([])
    expect(read(`export type { HookKind } from '${PACKAGE}'`)).toEqual([])
    expect(read(`// see \`import { x } from '${PACKAGE}'\``)).toEqual([])
    expect(read(`import { x } from './data'\nimport type { HookKind } from '${PACKAGE}'`)).toEqual([])
  })

  // Without this the scan could go blind — a broken matcher would find nothing and pass the leaf check vacuously.
  it('still finds the console files that value-import protocol', () => {
    expect(importers.length).toBeGreaterThan(0)
  })

  // Turbopack does not implement TypeScript's `.js` -> `.ts` substitution, and Next lists its webpack escape hatch
  // (`experimental.extensionAlias`) as Turbopack-unsupported, so one relative import here 500s every console route
  // while typecheck, Vitest, and `next build` (which reads `dist/`) all stay green. A leaf is what stays safe.
  it('resolves every one to a leaf module', () => {
    const violations = importers.flatMap(({ file, specifier }) => {
      const where = `${relative(WEB_SRC, file)} imports '${specifier}'`
      const target = exportsMap[specifier === PACKAGE ? '.' : `.${specifier.slice(PACKAGE.length)}`]?.development
      if (!target) return [`${where} — protocol declares no such subpath export`]
      const relatives = relativeImportsOf(join(PROTOCOL_DIR, target))
      if (!relatives.length) return []
      // Import a leaf subpath instead of the barrel; if it needs something shared, define that IN the leaf.
      return [`${where} -> ${target}: ${relatives.length} relative imports, e.g. ${relatives.slice(0, 3).join(', ')}`]
    })
    expect(violations).toEqual([])
  })
})
