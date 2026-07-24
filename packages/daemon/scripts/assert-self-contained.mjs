// Guardrail: the published daemon is a single self-contained bundle with zero
// runtime deps (tsdown inlines everything; release.config.js strips
// package.json "dependencies" to {} before publish). If tsdown ever fails to
// inline a workspace/runtime import — e.g. @agentconnect.md/protocol when its
// dist/ wasn't built before tsdown ran — rolldown SILENTLY externalizes it
// (it can't resolve a missing file, so it leaves the bare `import`). With deps
// stripped, that bundle then throws ERR_MODULE_NOT_FOUND on first run.
//
// This check turns that silent degradation into a hard build failure. It runs
// after tsdown in the daemon's `build` script; it ships nowhere (files: ["dist"]).
import { readFileSync } from 'node:fs'

const bundlePath = new URL('../dist/index.js', import.meta.url)
const bundle = readFileSync(bundlePath, 'utf8')

// Any static `import ... from '@agentconnect.md/x'` / `export ... from '...'`
// left in the bundle means a workspace package wasn't inlined. These are never
// published as deps, so they are unresolvable at runtime.
const leaked = [...bundle.matchAll(/\bfrom\s*["'](@agentconnect\.md\/[^"']+)["']/g)].map((m) => m[1])

if (leaked.length > 0) {
  const unique = [...new Set(leaked)].sort()
  console.error(
    '✗ daemon bundle is not self-contained — these workspace imports were left external:\n' +
      unique.map((s) => `    ${s}`).join('\n') +
      '\n  tsdown must inline them. Ensure workspace deps are built before tsdown runs\n' +
      "  (the build's `pnpm --filter '{.}^...' build` step needs `dependencies` intact).\n"
  )
  process.exit(1)
}

console.log('✓ daemon bundle is self-contained (no external @agentconnect.md/* imports)')
