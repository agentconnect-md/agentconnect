import { defineConfig } from 'tsdown'

// Ship the CLI as a ~self-contained bundle, exactly like the daemon: alwaysBundle
// inlines EVERY import (incl. message through the workspace-only protocol, plus
// connection), and neverBundle keeps ws's OPTIONAL native speedups external
// (loaded via try/catch require — absent at runtime is fine).
// neverBundle wins over alwaysBundle, so the natives stay out. The published
// manifest is stripped to zero runtime deps at release time (see release.config.js).
//
// The shared workspace packages resolve through their package "import" exports
// to ./dist/index.js, so they must be built before this bundle runs. The CLI's
// `build` script guarantees that by building its workspace dependencies first
// (`pnpm --filter '{.}^...' build && tsdown`).
const nativeExternals = ['bufferutil', 'utf-8-validate']

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  // platform:'node' defaults to fixed .mjs/.cjs extensions; keep dist/index.js
  // (the package is type:module) so bin/main/exports paths stay stable.
  fixedExtension: false,
  deps: { alwaysBundle: [/.*/], neverBundle: nativeExternals },
  // createRequire-based `require` + __dirname/__filename so bundled CommonJS deps
  // (commander, ws, …) that call require() work in ESM output.
  shims: true,
  // No .d.ts: the CLI ships as the `agentconnect` bin, not a typed library.
  dts: false,
  sourcemap: true,
  clean: true
})
