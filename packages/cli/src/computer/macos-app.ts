// The macOS app (computer-use.md §3.2.1): a signed Node runtime that holds the TCC grants and runs the store's bundle.
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tarCommand } from '../install.js'
import { versionDir } from '../paths.js'
import { COMPUTER_APP_PKGS, downloadTarball, verifyTarball, type ResolvedTarget } from '../registry.js'
import { COMPUTER_APP, COMPUTER_APP_BINARY, COMPUTER_APP_ID } from './launch.js'

export type AppPackage = (typeof COMPUTER_APP_PKGS)[keyof typeof COMPUTER_APP_PKGS]

export interface AppOps {
  resolve: (name: AppPackage, version: string) => Promise<ResolvedTarget>
  download: (url: string) => Promise<Buffer>
  /** Throws unless the staged app is intact and signed as md.agentconnect.computer. */
  verifySignature: (app: string) => void
  log: (m: string) => void
}

export const appBinary = (app: string): string => join(app, 'Contents', 'MacOS', COMPUTER_APP_BINARY)

export function appPackage(arch: string): AppPackage | undefined {
  return arch === 'arm64' || arch === 'x64' ? COMPUTER_APP_PKGS[arch] : undefined
}

// The app version a computer version pins as an exact optional dependency, read from its installed manifest.
export function pinnedApp(root: string, version: string, name: AppPackage): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(versionDir(root, version), 'package.json'), 'utf8')) as {
      optionalDependencies?: Record<string, string>
    }
    return manifest.optionalDependencies?.[name]
  } catch {
    return undefined
  }
}

// The build writes the package version as CFBundleShortVersionString.
export function appVersion(app: string): string | undefined {
  try {
    const plist = readFileSync(join(app, 'Contents', 'Info.plist'), 'utf8')
    return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1]
  } catch {
    return undefined
  }
}

export function codesignVerify(app: string): void {
  execFileSync('codesign', ['--verify', '--strict', app], { stdio: 'pipe' })
  // `codesign -d` prints its details on stderr.
  const details = spawnSync('codesign', ['-d', '--verbose=2', app], { encoding: 'utf8' })
  if (!`${details.stdout}${details.stderr}`.split('\n').includes(`Identifier=${COMPUTER_APP_ID}`))
    throw new Error(`${app} is not signed as ${COMPUTER_APP_ID}; refusing to install it`)
}

// Puts the pinned app in `<apps>/AgentConnect Computer.app`; an app already at that version stays, so its grants do too.
export async function ensureApp(root: string, version: string, apps: string, arch: string, ops: AppOps): Promise<void> {
  const name = appPackage(arch)
  if (!name) throw new Error(`no AgentConnect Computer app is built for ${arch} Macs`)
  const pinned = pinnedApp(root, version, name)
  if (!pinned) {
    ops.log(
      `computer daemon ${version} pins no macOS app: macOS will grant Accessibility and Screen Recording to your terminal instead`
    )
    return
  }
  const dest = join(apps, COMPUTER_APP)
  if (appVersion(dest) === pinned) return void ops.log(`${COMPUTER_APP} ${pinned} already installed`)

  const target = await ops.resolve(name, pinned)
  ops.log(`downloading ${COMPUTER_APP} ${pinned}…`)
  const buf = await ops.download(target.tarball)
  verifyTarball(buf, target)
  const tmp = join(apps, `.${COMPUTER_APP}.${pinned}.tmp`)
  const old = join(apps, `.${COMPUTER_APP}.old`)
  mkdirSync(apps, { recursive: true })
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  try {
    execFileSync(tarCommand(), ['-xzf', '-', '-C', tmp, '--strip-components=1'], { input: buf })
    const staged = join(tmp, COMPUTER_APP)
    if (!existsSync(appBinary(staged)))
      throw new Error(`${name}@${pinned} has no ${COMPUTER_APP} — refusing to install`)
    chmodSync(appBinary(staged), 0o755)
    ops.verifySignature(staged)
    // A running daemon keeps its open binary; launchd starts the new one at the next restart.
    rmSync(old, { recursive: true, force: true })
    if (existsSync(dest)) renameSync(dest, old)
    renameSync(staged, dest)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
    rmSync(old, { recursive: true, force: true })
  }
  ops.log(`installed ${dest} (${pinned})`)
}

export const realAppOps = (
  log: (m: string) => void,
  resolve: (name: AppPackage, version: string) => Promise<ResolvedTarget>
): AppOps => ({ resolve, download: downloadTarball, verifySignature: codesignVerify, log })

// A LaunchAgent install starts the service only while someone is logged in to the Mac's desktop.
export const macGuiSession = (): boolean =>
  process.platform === 'darwin' && spawnSync('launchctl', ['print', `gui/${process.getuid!()}`]).status === 0

// `--purge` forgets the app's grants too, so a later install asks again instead of reusing a stale entry.
export function resetGrants(log: (m: string) => void): void {
  for (const service of ['Accessibility', 'ScreenCapture']) {
    const result = spawnSync('tccutil', ['reset', service, COMPUTER_APP_ID], { encoding: 'utf8' })
    if (result.status !== 0) log(`could not reset ${service} for ${COMPUTER_APP_ID}: ${(result.stderr ?? '').trim()}`)
  }
  log(`reset the macOS Accessibility and Screen Recording grants of ${COMPUTER_APP_ID}`)
}
