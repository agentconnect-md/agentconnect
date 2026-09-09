import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { guest: 'src/microsandbox/guest-cli.ts' },
  outDir: 'dist/microsandbox',
  format: ['esm'],
  platform: 'node',
  fixedExtension: false,
  deps: { alwaysBundle: [/.*/] },
  shims: true,
  dts: false,
  sourcemap: true,
  clean: false
})
