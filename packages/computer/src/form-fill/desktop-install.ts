// Form filling on a person's Linux desktop (computer-form-fill-and-vault.md §8, §11 S6): which browsers take the extension, and the install.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Check } from '../setup.js'
import { extensionArtifacts, extensionId, extensionKey, FORM_FILL_POLICY_FILE, type ExtensionBuild } from './package.js'

/** Where a desktop install keeps the CRX and its update manifest: root-owned, so a user process cannot swap them. */
export const DESKTOP_EXTENSION_DIR = '/opt/agentconnect/form-fill'

/** A browser found on this machine, and whether its managed policy reaches it. */
export interface BrowserTarget {
  name: 'Chromium' | 'Google Chrome'
  binary: string
  // The system managed-policy directory the browser reads; absent where it reads none (snap, Flatpak).
  policyDir?: string
  unsupported?: string
}

export interface ProbeFs {
  exists(path: string): boolean
  read(path: string): string | undefined
}

const realFs: ProbeFs = {
  exists: (path) => existsSync(path),
  read: (path) => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return undefined
    }
  }
}

// System packages (deb or rpm) read these directories; Fedora's chromium-browser reads Chromium's.
const CHROMIUM_BINARIES = [
  '/usr/lib/chromium/chromium',
  '/usr/lib64/chromium-browser/chromium-browser',
  '/usr/lib/chromium-browser/chromium-browser'
]
const CHROME_BINARY = '/opt/google/chrome/chrome'
const CHROMIUM_POLICY = '/etc/chromium/policies/managed'
const CHROME_POLICY = '/etc/opt/chrome/policies/managed'

/** The browsers here: system Chromium and Google Chrome take the extension; snap and Flatpak builds are named but unsupported. */
export function detectBrowsers(fs: ProbeFs = realFs): BrowserTarget[] {
  const found: BrowserTarget[] = []
  const chromium = CHROMIUM_BINARIES.find((path) => fs.exists(path))
  if (chromium) found.push({ name: 'Chromium', binary: chromium, policyDir: CHROMIUM_POLICY })
  else {
    // Ubuntu's chromium-browser package only installs the snap, whose confinement does not read /etc/chromium.
    const wrapper = fs.read('/usr/bin/chromium-browser')
    if (fs.exists('/snap/bin/chromium') || wrapper?.includes('/snap/'))
      found.push({
        name: 'Chromium',
        binary: '/snap/bin/chromium',
        unsupported: 'the snap package is not supported yet'
      })
  }
  if (fs.exists(CHROME_BINARY)) found.push({ name: 'Google Chrome', binary: CHROME_BINARY, policyDir: CHROME_POLICY })
  for (const [name, app] of [
    ['Chromium', 'org.chromium.Chromium'],
    ['Google Chrome', 'com.google.Chrome']
  ] as const) {
    const flatpak = ['/var/lib/flatpak/app', join(process.env.HOME ?? '/root', '.local/share/flatpak/app')].some(
      (dir) => fs.exists(join(dir, app))
    )
    if (flatpak && !found.some((browser) => browser.name === name && browser.policyDir))
      found.push({ name, binary: `flatpak:${app}`, unsupported: 'the Flatpak package is not supported yet' })
  }
  return found
}

/** One staged file and where root installs it. */
export interface StagedFile {
  name: string
  content: Buffer | string
  target: string
}

/** What `form-fill install` writes, by final path, and the root commands that put the staged copies there. */
export function desktopInstallPlan(options: {
  build: ExtensionBuild
  port: number
  browsers: BrowserTarget[]
  stageDir: string
}): { id: string; files: StagedFile[]; commands: string[][] } {
  const artifacts = extensionArtifacts({ build: options.build, dir: DESKTOP_EXTENSION_DIR, port: options.port })
  const policyDirs = options.browsers.flatMap((browser) => (browser.policyDir ? [browser.policyDir] : []))
  const files: StagedFile[] = [
    { name: 'form-fill.crx', content: artifacts.crx, target: join(DESKTOP_EXTENSION_DIR, 'form-fill.crx') },
    { name: 'update.xml', content: artifacts.updateXml, target: join(DESKTOP_EXTENSION_DIR, 'update.xml') },
    ...policyDirs.map((dir) => ({
      name: 'policy.json',
      content: artifacts.policy,
      target: join(dir, FORM_FILL_POLICY_FILE)
    }))
  ]
  const commands: string[][] = [
    ['install', '-d', '-m', '0755', DESKTOP_EXTENSION_DIR, ...new Set(policyDirs)],
    ...files.map((file) => ['install', '-m', '0644', join(options.stageDir, file.name), file.target])
  ]
  return { id: artifacts.id, files, commands }
}

/** The root commands that remove what an install wrote. */
export function desktopUninstallCommands(browsers: BrowserTarget[]): string[][] {
  const policies = browsers.flatMap((browser) =>
    browser.policyDir ? [join(browser.policyDir, FORM_FILL_POLICY_FILE)] : []
  )
  return [
    ['rm', '-f', ...policies],
    ['rm', '-rf', DESKTOP_EXTENSION_DIR]
  ]
}

/** The extension id a browser's installed policy force-installs, if any. */
export function installedExtensionId(policyDir: string, fs: ProbeFs = realFs): string | undefined {
  const text = fs.read(join(policyDir, FORM_FILL_POLICY_FILE))
  if (!text) return undefined
  try {
    const entry = (JSON.parse(text) as { ExtensionInstallForcelist?: unknown }).ExtensionInstallForcelist
    const first = Array.isArray(entry) && typeof entry[0] === 'string' ? entry[0] : undefined
    return first?.split(';')[0]
  } catch {
    return undefined
  }
}

/** The port the daemon serves the extension on: its config, else the container's FORM_FILL_PORT its entrypoint passes. */
export function configuredFormFillPort(
  configured: number | undefined,
  env: NodeJS.ProcessEnv = process.env
): number | undefined {
  if (configured !== undefined) return configured
  const port = Number(env.FORM_FILL_PORT)
  return Number.isInteger(port) && port > 0 ? port : undefined
}

/** doctor's `form fill`: installed for this build, an older one, nowhere, or on a browser it cannot reach. */
export function formFillCheck(options: {
  build: ExtensionBuild | undefined
  port: number | undefined
  browsers: BrowserTarget[]
  command: string
  fs?: ProbeFs
}): Check {
  const name = 'form fill'
  const install = `run: ${options.command} form-fill install`
  if (!options.build) return { name, status: 'info', detail: 'this build ships no form-fill extension' }
  const usable = options.browsers.filter((browser) => browser.policyDir)
  if (usable.length === 0) {
    const unsupported = options.browsers.find((browser) => browser.unsupported)
    return unsupported
      ? {
          name,
          status: 'warn',
          detail: `${unsupported.name}: ${unsupported.unsupported}`,
          fix: 'install Chromium or Google Chrome from the distribution or Google'
        }
      : { name, status: 'info', detail: 'no Chromium or Google Chrome found' }
  }
  const expected = extensionId(extensionKey(options.build.buildId))
  const states = usable.map((browser) => ({ browser, id: installedExtensionId(browser.policyDir!, options.fs) }))
  const current = states.filter((state) => state.id === expected).map((state) => state.browser.name)
  const stale = states.filter((state) => state.id && state.id !== expected).map((state) => state.browser.name)
  if (stale.length)
    return {
      name,
      status: 'warn',
      detail: `${stale.join(' and ')} has the extension of another build`,
      fix: `${install}, then restart the browser`
    }
  if (current.length === 0)
    return { name, status: 'info', detail: `not installed for ${usable.map((b) => b.name).join(' or ')}`, fix: install }
  if (options.port === undefined)
    return {
      name,
      status: 'warn',
      detail: 'the extension is installed but this daemon serves no endpoint for it',
      fix: install
    }
  const missing = usable.filter((browser) => !current.includes(browser.name)).map((browser) => browser.name)
  return {
    name,
    status: 'ok',
    detail: `installed for ${current.join(' and ')} on port ${options.port}${missing.length ? `; not for ${missing.join(' and ')}` : ''}`
  }
}
