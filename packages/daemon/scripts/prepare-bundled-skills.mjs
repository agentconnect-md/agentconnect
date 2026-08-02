import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The released daemon strips runtime dependencies, so the audited skills CLI
// is bundled under dist/skills. Keep the tiny manifest that its own version
// lookup expects next to that artifact; this is generated output, not another
// dependency resolver.
const manifest = new URL('../dist/skills/package.json', import.meta.url)
mkdirSync(fileURLToPath(new URL('.', manifest)), { recursive: true, mode: 0o755 })
writeFileSync(manifest, `${JSON.stringify({ name: 'skills', version: '1.5.21', type: 'module' }, null, 2)}\n`)

const require = createRequire(import.meta.url)
const packageRoot = dirname(require.resolve('skills/package.json'))
for (const name of ['LICENSE', 'ThirdPartyNoticeText.txt']) {
  copyFileSync(join(packageRoot, name), fileURLToPath(new URL(`../dist/skills/${name}`, import.meta.url)))
}

// @anthropic-ai/sandbox-runtime is inlined into the daemon bundle, but its
// pre-built `apply-seccomp` helper is a native binary, not JS, so tsdown cannot
// inline it. Without it on Linux, SRT cannot apply the Unix-socket seccomp
// filter and silently degrades. SRT resolves the helper at
// `vendor/seccomp/<arch>/apply-seccomp` relative to its (now bundled) module dir
// — i.e. dist/ — so stage both released Linux arches beside the bundle. (macOS
// uses Seatbelt and never reads these; copying the ELF binaries there is harmless.)
const srtRoot = dirname(require.resolve('@anthropic-ai/sandbox-runtime/package.json'))
for (const arch of ['x64', 'arm64']) {
  const src = join(srtRoot, 'vendor', 'seccomp', arch, 'apply-seccomp')
  const dest = fileURLToPath(new URL(`../dist/vendor/seccomp/${arch}/apply-seccomp`, import.meta.url))
  mkdirSync(dirname(dest), { recursive: true, mode: 0o755 })
  copyFileSync(src, dest)
  chmodSync(dest, 0o755)
}
