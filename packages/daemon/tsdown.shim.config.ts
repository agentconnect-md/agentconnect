import { defineConfig } from 'tsdown'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const skillsPackageJson = require.resolve('skills/package.json')
const skillsManifest = require(skillsPackageJson) as { version?: unknown }
if (skillsManifest.version !== '1.5.21') throw new Error('shim build requires exact skills@1.5.21')
const skillsCliEntry = join(dirname(skillsPackageJson), 'dist', 'cli.mjs')

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

// Independent builds prevent shared chunks the runtime image does not copy.
export default defineConfig([
  { ...shared, entry: { index: 'src/shim/index.ts' } },
  { ...shared, entry: { 'git-credential': 'src/shim/git-credential.ts' } },
  { ...shared, entry: { 'gh-token': 'src/shim/gh-token.ts' } },
  { ...shared, entry: { 'mcp-bridge': 'src/shim/mcp-bridge.ts' } },
  { ...shared, entry: { 'auto-merge': 'src/shim/auto-merge.ts' } },
  { ...shared, entry: { 'skills/dist/cli': skillsCliEntry } }
])
