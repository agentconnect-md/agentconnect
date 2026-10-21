import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertInstallerBaseUrl,
  DESKTOP_BUNDLE_FILE,
  DESKTOP_LEGAL_FILE,
  DESKTOP_LINUX_INSTALLER_FILE,
  defaultDesktopBundleDir,
  loadDesktopDistribution
} from './desktop-distribution.js'

const TEMPLATE = "#!/bin/sh\nCP_URL='@CP_URL@'\nBUNDLE_SHA256='@BUNDLE_SHA256@'\n"

function bundleDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-dist-'))
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  return dir
}

describe('desktop distribution', () => {
  it('is absent when the bundle or the installer is missing', () => {
    expect(loadDesktopDistribution(bundleDir({}))).toBeUndefined()
    expect(loadDesktopDistribution(bundleDir({ [DESKTOP_BUNDLE_FILE]: 'x' }))).toBeUndefined()
    expect(loadDesktopDistribution(bundleDir({ [DESKTOP_LINUX_INSTALLER_FILE]: TEMPLATE }))).toBeUndefined()
  })

  it('fills the installer with the base URL and the bundle checksum', () => {
    const dist = loadDesktopDistribution(
      bundleDir({
        [DESKTOP_BUNDLE_FILE]: 'bundle',
        [DESKTOP_LINUX_INSTALLER_FILE]: TEMPLATE,
        [DESKTOP_LEGAL_FILE]: 'MIT'
      })
    )!
    const sha = createHash('sha256').update('bundle').digest('hex')
    expect(dist.sha256).toBe(sha)
    expect(dist.legal?.toString()).toBe('MIT')
    expect(dist.linuxInstaller('https://cp.example.com/cp/')).toBe(
      `#!/bin/sh\nCP_URL='https://cp.example.com/cp'\nBUNDLE_SHA256='${sha}'\n`
    )
  })

  it('refuses a template without its placeholders', () => {
    const dir = bundleDir({ [DESKTOP_BUNDLE_FILE]: 'b', [DESKTOP_LINUX_INSTALLER_FILE]: '#!/bin/sh\n' })
    expect(() => loadDesktopDistribution(dir)).toThrow(/placeholders/)
  })

  it('never puts a quote or shell syntax from a Host header into the script', () => {
    expect(assertInstallerBaseUrl('http://192.168.64.1:8080')).toBe('http://192.168.64.1:8080')
    expect(assertInstallerBaseUrl('http://[::1]:8080/')).toBe('http://[::1]:8080')
    for (const bad of ["http://x';reboot;'", 'http://x$(id)', 'ftp://x', 'http://x/a b', 'http://x`id`']) {
      expect(() => assertInstallerBaseUrl(bad)).toThrow(/unsafe/)
    }
  })

  it('defaults to the desktop package bundle directory beside this package', () => {
    expect(defaultDesktopBundleDir()).toMatch(/packages[/\\]desktop[/\\]bundle[/\\]?$/)
  })

  it('ships placeholders in the real installer template', () => {
    const template = join(defaultDesktopBundleDir(), '..', 'scripts', DESKTOP_LINUX_INSTALLER_FILE)
    expect(existsSync(template)).toBe(true)
    const body = readFileSync(template, 'utf8')
    expect(body).toContain("CP_URL='@CP_URL@'")
    expect(body).toContain("BUNDLE_SHA256='@BUNDLE_SHA256@'")
  })
})
