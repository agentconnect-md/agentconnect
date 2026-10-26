// Builds "AgentConnect Computer.app", the signed Node runtime that holds the macOS grants, as the computer-darwin-<arch> npm package.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Official Node.js build (no Homebrew dylibs), pinned; changing it changes the app and, unsigned, costs every grant.
const NODE_VERSION = 'v24.22.0'
const BUNDLE_ID = 'md.agentconnect.computer'
const APP_NAME = 'AgentConnect Computer'
const EXECUTABLE = 'agentconnect-computer'
// The menu bar indicator (#3403); src/self.ts finds it by this name beside the runtime.
const MENU_BAR_HELPER = 'agentconnect-computer-menubar'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const arch = process.env.TARGET_ARCH ?? process.arch
const version =
  process.env.AGENTCONNECT_RELEASE_VERSION || JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
// A Developer ID keeps grants across app updates and allows notarization; ad-hoc ties them to this build's hash.
const identity = process.env.CODESIGN_IDENTITY || '-'
const out = join(root, 'bundle', `computer-darwin-${arch}`)
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...options })

async function officialNode() {
  const name = `node-${NODE_VERSION}-darwin-${arch}`
  const cache = join(root, 'node_modules', '.cache', 'agentconnect-computer')
  const dir = join(cache, name)
  if (existsSync(join(dir, 'bin', 'node'))) return dir
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
  return dir
}

rmSync(out, { recursive: true, force: true })
const app = join(out, `${APP_NAME}.app`)
const contents = join(app, 'Contents')
mkdirSync(join(contents, 'MacOS'), { recursive: true })
mkdirSync(join(contents, 'Resources'), { recursive: true })
const node = await officialNode()
const binary = join(contents, 'MacOS', EXECUTABLE)
cpSync(join(node, 'bin', 'node'), binary)
chmodSync(binary, 0o755)
cpSync(join(node, 'LICENSE'), join(contents, 'Resources', 'LICENSE-node.txt'))
const timestamp = identity === '-' ? '--timestamp=none' : '--timestamp'
// Nested code is signed before the bundle, whose seal then covers it.
const helper = join(contents, 'MacOS', MENU_BAR_HELPER)
run('swiftc', [
  '-O',
  '-swift-version',
  '5',
  '-target',
  `${arch === 'x64' ? 'x86_64' : 'arm64'}-apple-macos13.5`,
  '-o',
  helper,
  join(root, 'macos', 'menubar.swift')
])
run('codesign', [
  '--force',
  '--sign',
  identity,
  '--identifier',
  `${BUNDLE_ID}.menubar`,
  '--options',
  'runtime',
  timestamp,
  helper
])
writeFileSync(
  join(contents, 'Info.plist'),
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
  <key>LSMinimumSystemVersion</key><string>13.5</string>
  <key>LSUIElement</key><true/>
  <key>NSScreenCaptureUsageDescription</key><string>AgentConnect Computer shows this screen to the agents and people you authorize.</string>
  <key>NSAppleEventsUsageDescription</key><string>AgentConnect Computer controls apps on behalf of the agents you authorize.</string>
</dict>
</plist>
`
)
// V8 needs JIT pages; library validation and DYLD_* stay locked, so nothing loads foreign code into the granted process.
const entitlements = join(root, 'bundle', `entitlements-${arch}.plist`)
writeFileSync(
  entitlements,
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
</dict>
</plist>
`
)
run('codesign', [
  '--force',
  '--sign',
  identity,
  '--identifier',
  BUNDLE_ID,
  '--options',
  'runtime',
  '--entitlements',
  entitlements,
  timestamp,
  app
])
run('codesign', ['--verify', '--strict', '--verbose', app])

// Notarized when a notarytool keychain profile is configured; npm downloads carry no quarantine, a browser download does.
if (process.env.NOTARY_KEYCHAIN_PROFILE) {
  const zip = join(root, 'bundle', `notarize-${arch}.zip`)
  run('ditto', ['-c', '-k', '--keepParent', app, zip])
  run('xcrun', ['notarytool', 'submit', zip, '--keychain-profile', process.env.NOTARY_KEYCHAIN_PROFILE, '--wait'])
  run('xcrun', ['stapler', 'staple', app])
  rmSync(zip, { force: true })
}

writeFileSync(
  join(out, 'package.json'),
  `${JSON.stringify(
    {
      name: `@agentconnect.md/computer-darwin-${arch}`,
      version,
      description: `AgentConnect Computer.app for ${arch} Macs: the signed Node.js runtime that holds the computer daemon's macOS permissions`,
      license: 'MIT',
      repository: {
        type: 'git',
        url: 'git+https://github.com/agentconnect-md/agentconnect.git',
        directory: 'packages/computer'
      },
      os: ['darwin'],
      cpu: [arch],
      files: [`${APP_NAME}.app`],
      publishConfig: { access: 'public' }
    },
    null,
    2
  )}\n`
)
console.log(`built ${app} (${identity === '-' ? 'ad-hoc' : identity}) in ${out}`)
