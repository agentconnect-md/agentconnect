import { defineConfig } from 'tsdown'

// The in-sandbox artifacts are built SEPARATELY from the daemon bundle, and that separation is
// the point rather than a convenience. Adding them as entries of the main build makes rolldown
// share chunks between them, so shipping the shim would mean copying the daemon's whole chunk
// graph — its CP client, platform SDKs and credential paths — into the half-trusted runtime
// image. A separate build gives each its own graph with everything inlined, so the image
// carries one file per artifact and nothing else.
//
// They are built in this package so both halves of the channel are versioned, reviewed and
// tested together; they are published as part of the runtime image, not the daemon.
const shared = {
  outDir: 'dist/shim',
  format: ['esm'] as const,
  platform: 'node' as const,
  fixedExtension: false,
  // Inline everything: the runtime image installs no node_modules for these.
  deps: { alwaysBundle: [/.*/], neverBundle: ['bufferutil', 'utf-8-validate'] },
  shims: true,
  dts: false,
  sourcemap: true,
  // No `clean`: this build writes into the same dist/ the daemon bundle owns.
  clean: false
}

// FIVE builds rather than one build with five entries, and the difference is load-bearing: several
// entries in a single build make rolldown hoist anything they share into a chunk, and the image
// copies each artifact as a single file — so that chunk would be a further file nothing copies and
// the helper would fail at startup on a missing module. Independent builds cannot share one. It
// also keeps each graph honest: git spawns the credential helper once per operation, the gh
// wrapper spawns the token entry once per `gh`, the agent's harness spawns the MCP bridge once
// per session, and the shim spawns one merge watcher per armed pull request — none of the four has
// any use for the channel's WebSocket client.
export default defineConfig([
  { ...shared, entry: { index: 'src/shim/index.ts' } },
  { ...shared, entry: { 'git-credential': 'src/shim/git-credential.ts' } },
  { ...shared, entry: { 'gh-token': 'src/shim/gh-token.ts' } },
  { ...shared, entry: { 'mcp-bridge': 'src/shim/mcp-bridge.ts' } },
  { ...shared, entry: { 'auto-merge': 'src/shim/auto-merge.ts' } }
])
