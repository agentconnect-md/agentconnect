import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  fixedExtension: false,
  deps: { alwaysBundle: [/.*/] },
  shims: true,
  dts: false,
  sourcemap: true,
  clean: true
})
