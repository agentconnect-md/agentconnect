import { builtinModules } from 'node:module'
import { readdirSync, readFileSync } from 'node:fs'

const dist = new URL('../dist/', import.meta.url)
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]))
const leaked = []

for (const entry of readdirSync(dist, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.js')) continue
  const bundle = readFileSync(new URL(entry.name, dist), 'utf8')
  // Rolldown's `onlyImport: []` checks static and dynamic ESM imports at build
  // time. Recheck the emitted top-level imports here as a release assertion.
  // (Generated Prisma error/help strings contain indented source examples, so
  // intentionally require column zero rather than regexing arbitrary text.)
  const specifiers = [...bundle.matchAll(/^(?:import|export)\s+(?:[^'"\n]*?\s+from\s+)?["']([^"']+)["']/gm)].map(
    (match) => match[1]
  )

  for (const specifier of specifiers) {
    if (!specifier.startsWith('.') && !specifier.startsWith('/') && !builtins.has(specifier)) {
      leaked.push(specifier)
    }
  }
}

if (leaked.length > 0) {
  console.error(`setup bundle is not self-contained: ${[...new Set(leaked)].join(', ')}`)
  process.exit(1)
}

console.log('setup bundle is self-contained')
