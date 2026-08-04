import { readFileSync } from 'node:fs'

const bundle = readFileSync(new URL('../dist/index.js', import.meta.url), 'utf8')
const leaked = bundle
  .split('\n')
  .map((line) => line.match(/^import\s.+\sfrom\s["'](commander|yaml|zod)["'];?$/)?.[1])
  .filter(Boolean)

if (leaked.length > 0) {
  console.error(`setup bundle is not self-contained: ${[...new Set(leaked)].join(', ')}`)
  process.exit(1)
}

console.log('setup bundle is self-contained')
