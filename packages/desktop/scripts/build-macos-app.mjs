// Builds "AgentConnect Desktop.app": the daemon as a Node single executable, ad-hoc signed, so macOS grants go to the app.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

// Official Node.js build (no Homebrew dylibs), pinned; the SEA blob must be produced by this same binary.
const NODE_VERSION = 'v24.22.0'
const BUNDLE_ID = 'md.agentconnect.desktop'
const APP_NAME = 'AgentConnect Desktop'
const EXECUTABLE = 'agentconnect-desktop'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const arch = process.env.TARGET_ARCH ?? process.arch
const work = join(root, 'bundle', '.macos-build')
const out = join(root, 'bundle')
// Baked in like scripts/bundle.mjs: the CommonJS SEA has no import.meta.url to read package.json from.
const version =
  process.env.AGENTCONNECT_RELEASE_VERSION || JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...options })

async function officialNode() {
  const name = `node-${NODE_VERSION}-darwin-${arch}`
  const cache = join(root, 'node_modules', '.cache', 'agentconnect-desktop')
  const binary = join(cache, name, 'bin', 'node')
  if (existsSync(binary)) return binary
  mkdirSync(cache, { recursive: true })
  const base = `https://nodejs.org/dist/${NODE_VERSION}`
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text()
  const expected = sums
    .split('\n')
    .find((line) => line.endsWith(` ${name}.tar.gz`))
    ?.split(/\s+/)[0]
  const archive = Buffer.from(await (await fetch(`${base}/${name}.tar.gz`)).arrayBuffer())
  const digest = createHash('sha256').update(archive).digest('hex')
  if (!expected || digest !== expected) throw new Error(`checksum mismatch for ${name}: ${digest}`)
  const tarball = join(cache, `${name}.tar.gz`)
  writeFileSync(tarball, archive)
  run('tar', ['-xzf', tarball, '-C', cache])
  return binary
}

rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const node = await officialNode()

// SEA runs CommonJS only.
const bundled = await build({
  absWorkingDir: root,
  entryPoints: [join(root, 'src/cli.ts')],
  outfile: join(work, 'main.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  // Workspace packages (protocol, connection) are bundled from source, so no prior build is needed.
  conditions: ['development'],
  define: { __AGENTCONNECT_DESKTOP_VERSION__: JSON.stringify(version) },
  legalComments: 'linked',
  // Every bundled input, for the release license scan (scripts/license-scan.ts).
  metafile: true,
  logLevel: 'warning'
})
mkdirSync(join(out, '.meta'), { recursive: true })
writeFileSync(join(out, '.meta', 'macos-main.cjs.json'), JSON.stringify(bundled.metafile))
writeFileSync(
  join(work, 'sea-config.json'),
  JSON.stringify({
    main: 'main.cjs',
    output: 'sea-prep.blob',
    disableExperimentalSEAWarning: true,
    useCodeCache: false
  })
)
run(node, ['--experimental-sea-config', 'sea-config.json'], { cwd: work })

const app = join(work, `${APP_NAME}.app`)
const macos = join(app, 'Contents', 'MacOS')
mkdirSync(macos, { recursive: true })
const binary = join(macos, EXECUTABLE)
cpSync(node, binary)
chmodSync(binary, 0o755)
run('codesign', ['--remove-signature', binary])
run(join(root, 'node_modules', '.bin', 'postject'), [
  binary,
  'NODE_SEA_BLOB',
  join(work, 'sea-prep.blob'),
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  '--macho-segment-name',
  'NODE_SEA'
])
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
writeFileSync(
  join(app, 'Contents', 'Info.plist'),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleExecutable</key><string>${EXECUTABLE}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSScreenCaptureUsageDescription</key><string>AgentConnect Desktop shows this screen to the agents and people you authorize.</string>
  <key>NSAppleEventsUsageDescription</key><string>AgentConnect Desktop controls apps on behalf of the agents you authorize.</string>
</dict>
</plist>
`
)
// Ad-hoc: grants are tied to this exact build's hash; a Developer ID signature keeps them across updates.
run('codesign', ['--force', '--sign', process.env.CODESIGN_IDENTITY ?? '-', '--identifier', BUNDLE_ID, app])
run('codesign', ['--verify', '--verbose', app])

const zip = join(out, `AgentConnect-Desktop-macos-${arch}.zip`)
rmSync(zip, { force: true })
run('ditto', ['-c', '-k', '--keepParent', app, zip])
rmSync(join(out, `${APP_NAME}.app`), { recursive: true, force: true })
run('ditto', [app, join(out, `${APP_NAME}.app`)])
console.log(`built ${join(out, `${APP_NAME}.app`)} and ${zip}`)
