import { defineConfig } from 'tsdown'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const skillsPackageJson = require.resolve('skills/package.json')
const skillsManifest = require(skillsPackageJson) as { version?: unknown }
if (skillsManifest.version !== '1.5.21') {
  throw new Error(`build requires exact skills@1.5.21, found ${String(skillsManifest.version)}`)
}
const skillsCliEntry = join(dirname(skillsPackageJson), 'dist', 'cli.mjs')

// Modules that cannot be bundled — kept external:
// - bufferutil / utf-8-validate: ws's OPTIONAL native speedups, loaded via
//   try/catch require — absent at runtime is fine.
// SQLite needs no entry here: the daemon uses the built-in node:sqlite, which
// (like every node: builtin) rolldown externalizes automatically.
const nativeExternals = ['bufferutil', 'utf-8-validate']

// Ship the daemon as a ~self-contained bundle: alwaysBundle inlines EVERY import
// (incl. deps kept in package.json "dependencies" and the workspace-only
// @agentconnect.md/message + protocol), and neverBundle keeps the native modules
// external.
// neverBundle wins over alwaysBundle, so the natives stay out. The published
// manifest is then stripped to zero runtime deps at release time
// (see release.config.js); the optional ws natives are never direct deps.
//
// @agentconnect.md/message and protocol resolve through their package "import"
// exports to ./dist/index.js, so they must be built before this bundle runs.
// The daemon's `build` script guarantees that by building its workspace
// dependencies first (`pnpm --filter '{.}^...' build && tsdown`), so the bundle
// always inlines fresh shared packages without reaching into their source trees.
export default defineConfig({
  // `skills` must be a separate executable because the daemon invokes it in a
  // private child-process cell. A dynamic package lookup would work in the
  // monorepo but fail after release strips runtime dependencies, so bundle the
  // audited entry as a second published artifact.
  // Preserve the upstream package-relative layout for the bundled executable.
  // skills@1.5.21 reads ../package.json relative to its CLI module for its
  // version/telemetry identity, so emitting it beside index.js would make it
  // accidentally read the daemon manifest instead.
  entry: {
    index: 'src/index.ts',
    'postgres-store-worker': 'src/store/postgres-store-worker.js',
    'skills/dist/cli': skillsCliEntry,
    'skills/workspace-mutation': 'src/skills/skill-workspace-mutation-cli.ts'
  },
  format: ['esm'],
  platform: 'node',
  // platform:'node' defaults to fixed .mjs/.cjs extensions; keep dist/index.js
  // (the package is type:module) so bin/main/exports paths stay stable.
  fixedExtension: false,
  deps: { alwaysBundle: [/.*/], neverBundle: nativeExternals },
  // createRequire-based `require` + __dirname/__filename so bundled CommonJS deps
  // (commander, ws, @slack/bolt, …) that call require() work in ESM output.
  shims: true,
  // No .d.ts: the daemon ships as the `agentconnect` CLI bin, not a typed library.
  dts: false,
  sourcemap: true,
  clean: true
})
