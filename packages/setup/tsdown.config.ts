import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  fixedExtension: false,
  // The setup release strips runtime dependencies and Docker copies only dist,
  // so even the narrow CP deployment-config facade + Prisma runtime must be in
  // this one self-contained artifact.
  deps: {
    alwaysBundle: [/.*/],
    onlyBundle: false,
    // The release manifest intentionally has no runtime dependencies.
    // Reject any emitted package import; Node built-ins remain allowed.
    onlyImport: []
  },
  shims: true,
  dts: false,
  sourcemap: true,
  clean: true
})
