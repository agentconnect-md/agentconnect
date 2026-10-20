// Bundles the daemon into one ESM file plus the installer, so a Windows machine needs only Node.js.
import { chmodSync, copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'bundle')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

await build({
  entryPoints: [join(root, 'src/cli.ts')],
  outfile: join(out, 'agentconnect-desktop.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  legalComments: 'linked',
  banner: {
    js: "import { createRequire as __acCreateRequire } from 'node:module'; const require = __acCreateRequire(import.meta.url);"
  },
  logLevel: 'info'
})
copyFileSync(join(root, 'scripts/install.ps1'), join(out, 'install.ps1'))
copyFileSync(join(root, 'scripts/install.sh'), join(out, 'install.sh'))
chmodSync(join(out, 'install.sh'), 0o755)
copyFileSync(join(root, 'README.md'), join(out, 'README.md'))
console.log(`bundle ready in ${out}`)
