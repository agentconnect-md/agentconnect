import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appBinary, appPackage, appVersion, ensureApp, pinnedApp, type AppOps } from '../src/computer/macos-app.js'
import { versionDir } from '../src/paths.js'
import { COMPUTER_APP_PKGS } from '../src/registry.js'

const APP = 'AgentConnect Computer.app'
const dirs: string[] = []
const tmp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// A computer version whose manifest pins the arm64 app, as the release writes it.
function installVersion(root: string, version: string, app?: string): void {
  mkdirSync(versionDir(root, version), { recursive: true })
  writeFileSync(
    join(versionDir(root, version), 'package.json'),
    JSON.stringify({ version, ...(app ? { optionalDependencies: { [COMPUTER_APP_PKGS.arm64]: app } } : {}) })
  )
}

// The app package packed like `npm pack`: `package/AgentConnect Computer.app/...`, executable bits dropped.
function packApp(version: string): Buffer {
  const dir = tmp('ac-app-pkg-')
  const contents = join(dir, 'package', APP, 'Contents')
  mkdirSync(join(contents, 'MacOS'), { recursive: true })
  writeFileSync(join(contents, 'MacOS', 'agentconnect-computer'), 'node')
  writeFileSync(
    join(contents, 'Info.plist'),
    `<plist><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`
  )
  return execFileSync('tar', ['-czf', '-', '-C', dir, 'package'])
}

function ops(packages: Record<string, Buffer>, over: Partial<AppOps> = {}) {
  const resolved: string[] = []
  const lines: string[] = []
  const app: AppOps = {
    resolve: async (name, version) => {
      resolved.push(`${name}@${version}`)
      const buf = packages[version]!
      return { version, tarball: version, integrity: `sha512-${createHash('sha512').update(buf).digest('base64')}` }
    },
    download: async (url) => packages[url]!,
    verifySignature: () => {},
    log: (m) => void lines.push(m),
    ...over
  }
  return { app, resolved, lines }
}

describe('the macOS app', () => {
  it('names one fixed package per supported architecture', () => {
    expect(appPackage('arm64')).toBe('@agentconnect.md/computer-darwin-arm64')
    expect(appPackage('x64')).toBe('@agentconnect.md/computer-darwin-x64')
    expect(appPackage('ia32')).toBeUndefined()
  })

  it('installs the pinned app executable into the apps folder, then leaves it alone at the same version', async () => {
    const root = tmp('ac-computer-')
    const apps = tmp('ac-apps-')
    installVersion(root, '2.7.0', '2.7.0')
    const { app, resolved } = ops({ '2.7.0': packApp('2.7.0') })
    await ensureApp(root, '2.7.0', apps, 'arm64', app)
    expect(appVersion(join(apps, APP))).toBe('2.7.0')
    expect(readdirSync(apps)).toEqual([APP])

    installVersion(root, '2.8.0', '2.7.0')
    await ensureApp(root, '2.8.0', apps, 'arm64', app)
    expect(resolved).toEqual(['@agentconnect.md/computer-darwin-arm64@2.7.0'])
  })

  // npm pack drops the executable bit; Windows chmod sets no POSIX execute bits to check.
  it.skipIf(process.platform === 'win32')('restores the executable bit the package lost', async () => {
    const root = tmp('ac-computer-')
    const apps = tmp('ac-apps-')
    installVersion(root, '2.7.0', '2.7.0')
    await ensureApp(root, '2.7.0', apps, 'arm64', ops({ '2.7.0': packApp('2.7.0') }).app)
    expect(statSync(appBinary(join(apps, APP))).mode & 0o111).toBe(0o111)
  })

  it('replaces an app the new version pins differently', async () => {
    const root = tmp('ac-computer-')
    const apps = tmp('ac-apps-')
    installVersion(root, '2.7.0', '2.7.0')
    installVersion(root, '2.9.0', '2.9.0')
    const { app } = ops({ '2.7.0': packApp('2.7.0'), '2.9.0': packApp('2.9.0') })
    await ensureApp(root, '2.7.0', apps, 'arm64', app)
    await ensureApp(root, '2.9.0', apps, 'arm64', app)
    expect(appVersion(join(apps, APP))).toBe('2.9.0')
    expect(readdirSync(apps)).toEqual([APP])
  })

  it('keeps the installed app when the new one is not signed as md.agentconnect.computer or fails integrity', async () => {
    const root = tmp('ac-computer-')
    const apps = tmp('ac-apps-')
    installVersion(root, '2.7.0', '2.7.0')
    installVersion(root, '2.9.0', '2.9.0')
    await ensureApp(root, '2.7.0', apps, 'arm64', ops({ '2.7.0': packApp('2.7.0') }).app)
    const unsigned = ops(
      { '2.9.0': packApp('2.9.0') },
      {
        verifySignature: () => {
          throw new Error('not signed as md.agentconnect.computer')
        }
      }
    )
    await expect(ensureApp(root, '2.9.0', apps, 'arm64', unsigned.app)).rejects.toThrow(/not signed/)
    const corrupt = ops({ '2.9.0': packApp('2.9.0') }, { download: async () => Buffer.from('other bytes') })
    await expect(ensureApp(root, '2.9.0', apps, 'arm64', corrupt.app)).rejects.toThrow(/integrity check failed/)
    expect(appVersion(join(apps, APP))).toBe('2.7.0')
    expect(readdirSync(apps)).toEqual([APP])
  })

  it('says where the grants go when a version pins no app', async () => {
    const root = tmp('ac-computer-')
    const apps = join(tmp('ac-apps-'), 'Applications')
    installVersion(root, '2.6.0')
    const { app, lines } = ops({})
    await ensureApp(root, '2.6.0', apps, 'arm64', app)
    expect(pinnedApp(root, '2.6.0', COMPUTER_APP_PKGS.arm64)).toBeUndefined()
    expect(lines[0]).toMatch(/pins no macOS app: .* to your terminal instead/)
    expect(existsSync(apps)).toBe(false)
    await expect(ensureApp(root, '2.6.0', apps, 'ia32', app)).rejects.toThrow(/no AgentConnect Computer app/)
  })

  it('reads the version the build wrote into Info.plist', () => {
    const apps = tmp('ac-apps-')
    mkdirSync(join(apps, APP, 'Contents'), { recursive: true })
    writeFileSync(
      join(apps, APP, 'Contents', 'Info.plist'),
      readFileSync(new URL('../../computer/scripts/build-macos-app.mjs', import.meta.url), 'utf8')
        .split('`')
        .find((part) => part.includes('<key>CFBundleShortVersionString</key>'))!
        .replaceAll('${version}', '3.1.0')
    )
    expect(appVersion(join(apps, APP))).toBe('3.1.0')
    expect(appVersion(join(apps, 'missing.app'))).toBeUndefined()
  })
})
