import { defineConfig } from 'tsdown'

// The in-sandbox shim is built SEPARATELY from the daemon bundle, and that separation is
// the point rather than a convenience. Adding it as another entry of the main build makes
// rolldown share chunks between them, so shipping the shim would mean copying the daemon's
// whole chunk graph — its CP client, platform SDKs and credential paths — into the
// half-trusted runtime image. A separate build gives the shim its own graph with
// everything inlined, so the image carries one file and nothing else.
//
// It is built in this package so both halves of the channel are versioned, reviewed and
// tested together; it is published as part of the runtime image, not the daemon.
export default defineConfig({
  entry: { index: 'src/shim/index.ts' },
  outDir: 'dist/shim',
  format: ['esm'],
  platform: 'node',
  fixedExtension: false,
  // Inline everything: the runtime image installs no node_modules for the shim.
  deps: { alwaysBundle: [/.*/], neverBundle: ['bufferutil', 'utf-8-validate'] },
  shims: true,
  dts: false,
  sourcemap: true,
  // No `clean`: this build writes into the same dist/ the daemon bundle owns.
  clean: false
})
