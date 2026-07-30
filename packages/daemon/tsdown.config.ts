import { defineConfig } from 'tsdown'

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
  entry: ['src/index.ts'],
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
