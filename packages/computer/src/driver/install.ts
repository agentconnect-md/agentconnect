import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Pinned Cua Driver (MIT) release; hashes come from the release's SHA256SUMS and are checked before extraction.
export const CUA_DRIVER_VERSION = '0.35.2'
const RELEASE_BASE = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${CUA_DRIVER_VERSION}`
const ARCHIVES: Record<string, { file: string; sha256: string }> = {
  'win32-x64': {
    file: `cua-driver-rs-${CUA_DRIVER_VERSION}-windows-x86_64.zip`,
    sha256: 'a0c44e5acf94e92609c3ed3788c73def97a1cc85ab7d000e85493662560d2bb9'
  },
  'win32-arm64': {
    file: `cua-driver-rs-${CUA_DRIVER_VERSION}-windows-arm64.zip`,
    sha256: '093abd053155323e8a2603f6b24a07c008dea670d1ea67970cce3ce68175e287'
  },
  'darwin-arm64': {
    file: `cua-driver-rs-${CUA_DRIVER_VERSION}-darwin-arm64.tar.gz`,
    sha256: '4922ddd042d3b2197a9c034926472c1d6e0c3daa55fff7f146beb720948cbdd7'
  },
  'darwin-x64': {
    file: `cua-driver-rs-${CUA_DRIVER_VERSION}-darwin-x86_64.tar.gz`,
    sha256: '5ad51a148f3c81c6bd98050b5b5adf2c329db23c13e5ce92774e02e63291bc79'
  },
  'linux-x64': {
    file: `cua-driver-rs-${CUA_DRIVER_VERSION}-linux-x86_64.tar.gz`,
    sha256: '029fd6fd6f43a5b22c4e4b612e7879e181c0461840e7a974736104f660165569'
  },
  'linux-arm64': {
    file: `cua-driver-rs-${CUA_DRIVER_VERSION}-linux-arm64.tar.gz`,
    sha256: '5fb476fddd5a09021be57522b9138737839a1e72236488a4ae02742967841795'
  }
}

const binaryName = (): string => (process.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver')

export const installedDriverDir = (dataDir: string): string => join(dataDir, 'cua-driver', CUA_DRIVER_VERSION)

export function installedDriverPath(dataDir: string): string {
  return join(installedDriverDir(dataDir), binaryName())
}

// Explicit path, then the pinned install, then whatever `cua-driver` resolves to on PATH.
export function resolveDriverPath(dataDir: string, explicit?: string): string {
  if (explicit) return explicit
  const installed = installedDriverPath(dataDir)
  return existsSync(installed) ? installed : binaryName()
}

export async function installDriver(dataDir: string, log: (line: string) => void = console.log): Promise<string> {
  const target = installedDriverPath(dataDir)
  if (existsSync(target)) {
    log(`Cua Driver ${CUA_DRIVER_VERSION} already installed at ${target}`)
    return target
  }
  const archive = ARCHIVES[`${process.platform}-${process.arch}`]
  if (!archive) throw new Error(`no pinned Cua Driver build for ${process.platform}-${process.arch}`)
  const url = `${RELEASE_BASE}/${archive.file}`
  log(`Downloading ${url}`)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== archive.sha256) throw new Error(`checksum mismatch for ${archive.file}: ${digest}`)

  const parent = join(dataDir, 'cua-driver')
  mkdirSync(parent, { recursive: true })
  const staging = mkdtempSync(join(parent, '.staging-'))
  try {
    const archivePath = join(staging, archive.file)
    writeFileSync(archivePath, bytes)
    // Windows' own bsdtar reads zip; a Git-for-Windows GNU tar earlier on PATH would not.
    const tarCommand =
      process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
    const tar = spawnSync(tarCommand, ['-xf', archivePath, '-C', staging], { stdio: 'inherit', windowsHide: true })
    if (tar.status !== 0) throw new Error(`tar failed to extract ${archive.file}`)
    const extracted = join(staging, archive.file.replace(/\.(zip|tar\.gz)$/, ''))
    if (!existsSync(join(extracted, binaryName()))) throw new Error(`archive has no ${binaryName()}`)
    rmSync(installedDriverDir(dataDir), { recursive: true, force: true })
    renameSync(extracted, installedDriverDir(dataDir))
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
  log(`Installed Cua Driver ${CUA_DRIVER_VERSION} at ${target}`)
  return target
}
