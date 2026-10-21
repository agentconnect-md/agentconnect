// Bundles the daemon into one ESM file plus the installer, so a Windows machine needs only Node.js.
import { chmodSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'bundle')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

const result = await build({
  absWorkingDir: root,
  entryPoints: [join(root, 'src/cli.ts')],
  outfile: join(out, 'agentconnect-desktop.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  // Workspace packages (protocol, connection) are bundled from source, so no prior build is needed.
  conditions: ['development'],
  legalComments: 'linked',
  // Every bundled input, for the release license scan (scripts/license-scan.ts).
  metafile: true,
  banner: {
    js: "import { createRequire as __acCreateRequire } from 'node:module'; const require = __acCreateRequire(import.meta.url);"
  },
  logLevel: 'info'
})
mkdirSync(join(out, '.meta'), { recursive: true })
writeFileSync(join(out, '.meta', 'agentconnect-desktop.mjs.json'), JSON.stringify(result.metafile))
copyFileSync(join(root, 'scripts/install.ps1'), join(out, 'install.ps1'))
copyFileSync(join(root, 'scripts/install.sh'), join(out, 'install.sh'))
chmodSync(join(out, 'install.sh'), 0o755)
// The Linux one-line installer; the Control Plane serves it with its URL and this bundle's sha256 filled in.
copyFileSync(join(root, 'scripts/install-linux.sh'), join(out, 'install-linux.sh'))
copyFileSync(join(root, 'README.md'), join(out, 'README.md'))
console.log(`bundle ready in ${out}`)
