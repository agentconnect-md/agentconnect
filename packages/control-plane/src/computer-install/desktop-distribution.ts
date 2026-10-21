// The desktop daemon this CP hands out (computer-use.md §3.5, §3.6): its bundle, license notices and the Linux installer.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DESKTOP_BUNDLE_FILE = 'agentconnect-desktop.mjs'
export const DESKTOP_LEGAL_FILE = `${DESKTOP_BUNDLE_FILE}.LEGAL.txt`
export const DESKTOP_LINUX_INSTALLER_FILE = 'install-linux.sh'

export interface DesktopDistribution {
  bundle: Buffer
  legal?: Buffer
  /** Hex sha256 of the bundle, which the installer checks before running it. */
  sha256: string
  /** The Linux installer with this CP's public base URL and the bundle checksum filled in. */
  linuxInstaller(cpBaseUrl: string): string
}

// The desktop package's `bundle/` beside this package: both the checkout and the image (`/app/packages/*`) lay it out so.
export const defaultDesktopBundleDir = (): string => fileURLToPath(new URL('../../../desktop/bundle/', import.meta.url))

// The base URL lands inside a single-quoted shell string, so only URL characters that cannot end it pass.
const SAFE_URL = /^https?:\/\/[A-Za-z0-9.:[\]@%_~+-]+(\/[A-Za-z0-9._~%+/-]*)?$/

export function assertInstallerBaseUrl(url: string): string {
  const trimmed = url.replace(/\/+$/, '')
  if (!SAFE_URL.test(trimmed)) throw new Error(`unsafe Control Plane URL for the installer: ${JSON.stringify(url)}`)
  return trimmed
}

function readOptional(path: string): Buffer | undefined {
  try {
    return readFileSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Loads the built desktop bundle and installer from `dir`, or undefined when this deployment ships none. */
export function loadDesktopDistribution(dir: string): DesktopDistribution | undefined {
  const bundle = readOptional(join(dir, DESKTOP_BUNDLE_FILE))
  const template = readOptional(join(dir, DESKTOP_LINUX_INSTALLER_FILE))?.toString('utf8')
  if (!bundle || template === undefined) return undefined
  if (!template.includes('@CP_URL@') || !template.includes('@BUNDLE_SHA256@')) {
    throw new Error(`${join(dir, DESKTOP_LINUX_INSTALLER_FILE)} lacks its @CP_URL@ / @BUNDLE_SHA256@ placeholders`)
  }
  const legal = readOptional(join(dir, DESKTOP_LEGAL_FILE))
  const sha256 = createHash('sha256').update(bundle).digest('hex')
  return {
    bundle,
    ...(legal ? { legal } : {}),
    sha256,
    linuxInstaller: (cpBaseUrl) =>
      template.replaceAll('@CP_URL@', assertInstallerBaseUrl(cpBaseUrl)).replaceAll('@BUNDLE_SHA256@', sha256)
  }
}
