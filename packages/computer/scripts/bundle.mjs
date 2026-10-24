// Bundles the daemon into one ESM file: `bundle/` with the macOS/Windows installers, or with --dist the npm package's `dist/`.
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { build } from 'esbuild'

const { values } = parseArgs({ options: { dist: { type: 'boolean' } } })
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, values.dist ? 'dist' : 'bundle')
// The release flow writes the release version into package.json before building, as for the agent daemon.
const version =
  process.env.AGENTCONNECT_RELEASE_VERSION || JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

const result = await build({
  absWorkingDir: root,
  entryPoints: [join(root, 'src/cli.ts')],
  outfile: join(out, 'agentconnect-computer.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  // Workspace packages (protocol, connection) are bundled from source, so no prior build is needed.
  conditions: ['development'],
  define: { __AGENTCONNECT_COMPUTER_VERSION__: JSON.stringify(version) },
  legalComments: 'linked',
  // Every bundled input, for the release license scan (scripts/license-scan.ts).
  metafile: true,
  banner: {
    js: "import { createRequire as __acCreateRequire } from 'node:module'; const require = __acCreateRequire(import.meta.url);"
  },
  logLevel: 'info'
})
mkdirSync(join(out, '.meta'), { recursive: true })
writeFileSync(join(out, '.meta', 'agentconnect-computer.mjs.json'), JSON.stringify(result.metafile))
chmodSync(join(out, 'agentconnect-computer.mjs'), 0o755)
if (!values.dist) {
  copyFileSync(join(root, 'scripts/install.ps1'), join(out, 'install.ps1'))
  copyFileSync(join(root, 'scripts/install.sh'), join(out, 'install.sh'))
  chmodSync(join(out, 'install.sh'), 0o755)
  copyFileSync(join(root, 'README.md'), join(out, 'README.md'))
}
console.log(`agentconnect-computer ${version} bundled in ${out}`)
