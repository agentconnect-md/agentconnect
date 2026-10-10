import { readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The codec WebAssembly the released daemon stages under dist/wasm, since release strips every runtime dependency.
export const IMAGE_WASM_ASSETS = {
  resvg: { file: 'resvg.wasm', specifier: '@resvg/resvg-wasm/index_bg.wasm' },
  webpDecoder: { file: 'webp_dec.wasm', specifier: '@jsquash/webp/codec/dec/webp_dec.wasm' }
} as const

export type ImageWasmAsset = keyof typeof IMAGE_WASM_ASSETS

const moduleDir = dirname(fileURLToPath(import.meta.url))

/** The daemon-owned asset path: beside the bundle, then the built dist from source, then the dependency in dev. */
export function imageWasmPath(asset: ImageWasmAsset): string {
  const { file, specifier } = IMAGE_WASM_ASSETS[asset]
  const candidates = [join(moduleDir, 'wasm', file), join(moduleDir, '..', '..', 'dist', 'wasm', file)]
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // Try the next fixed layout.
    }
  }
  return createRequire(import.meta.url).resolve(specifier)
}

// The daemon's lib config omits the DOM, which is where the WebAssembly value is typed.
const wasm = (globalThis as unknown as { WebAssembly: { compile(bytes: Uint8Array): Promise<WebAssembly.Module> } })
  .WebAssembly

const compiled = new Map<ImageWasmAsset, Promise<WebAssembly.Module>>()

/** Compile one codec once per thread, and only when a job first needs it. */
export function imageWasmModule(asset: ImageWasmAsset): Promise<WebAssembly.Module> {
  const cached = compiled.get(asset)
  if (cached) return cached
  const module = wasm.compile(readFileSync(imageWasmPath(asset)))
  compiled.set(asset, module)
  module.catch(() => compiled.delete(asset))
  return module
}
