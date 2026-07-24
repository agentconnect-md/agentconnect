/**
 * npm registry client for daemon version resolution + download (cli-daemon-split.md
 * §5.1, §9). Security boundary: the CLI only ever fetches the ONE fixed package
 * name from its configured registry — never a CP-supplied URL/name/tarball. The
 * registry base is CLI-local config (`AGENTCONNECT_NPM_REGISTRY`), defaulting to
 * npmjs.org; it is deliberately NOT sourced from the Control Plane.
 */
import { createHash } from 'node:crypto'
import type { Channel } from './version-store.js'

export const DAEMON_PKG = '@agentconnect.md/daemon'

interface DistInfo {
  tarball: string
  integrity?: string
  shasum?: string
}
interface PackumentVersion {
  version: string
  dist: DistInfo
  engines?: { node?: string }
}
interface Packument {
  'dist-tags'?: Record<string, string>
  versions?: Record<string, PackumentVersion>
}

export interface ResolvedTarget {
  version: string
  tarball: string
  integrity?: string
  shasum?: string
  enginesNode?: string
}

function registryBase(): string {
  return (process.env.AGENTCONNECT_NPM_REGISTRY ?? 'https://registry.npmjs.org').replace(/\/+$/, '')
}

async function fetchPackument(pkg: string): Promise<Packument> {
  // Scoped name: the `/` is percent-encoded (`@scope%2Fname`), per the registry API.
  const url = `${registryBase()}/${pkg.replace('/', '%2F')}`
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  if (!res.ok) {
    throw new Error(`registry lookup failed for ${pkg}: HTTP ${res.status} ${res.statusText} (${url})`)
  }
  return (await res.json()) as Packument
}

/**
 * Resolve which daemon version to install: an explicit `--to <version>` (must
 * exist), otherwise the channel's dist-tag (stable → `latest`, rc → `rc`).
 */
export async function resolveDaemonTarget(opts: { to?: string; channel: Channel }): Promise<ResolvedTarget> {
  const pkg = await fetchPackument(DAEMON_PKG)
  const versions = pkg.versions ?? {}

  let version: string
  if (opts.to) {
    if (!versions[opts.to]) {
      throw new Error(`${DAEMON_PKG}@${opts.to} does not exist in the registry`)
    }
    version = opts.to
  } else {
    const tag = opts.channel === 'rc' ? 'rc' : 'latest'
    const tagged = pkg['dist-tags']?.[tag]
    if (!tagged) throw new Error(`${DAEMON_PKG} has no '${tag}' dist-tag in the registry`)
    version = tagged
  }

  const entry = versions[version]
  if (!entry?.dist?.tarball) throw new Error(`${DAEMON_PKG}@${version} has no downloadable tarball`)
  return {
    version,
    tarball: entry.dist.tarball,
    integrity: entry.dist.integrity,
    shasum: entry.dist.shasum,
    enginesNode: entry.engines?.node
  }
}

export async function downloadTarball(url: string): Promise<Buffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`tarball download failed: HTTP ${res.status} ${res.statusText} (${url})`)
  return Buffer.from(await res.arrayBuffer())
}

/**
 * Verify a downloaded tarball against the registry's `dist.integrity` (SSRI,
 * `sha512-<base64>`), falling back to the legacy `dist.shasum` (sha1 hex). Throws
 * on mismatch or when neither is available (never install unverified bytes).
 */
export function verifyTarball(buf: Buffer, target: Pick<ResolvedTarget, 'integrity' | 'shasum'>): void {
  if (target.integrity) {
    const [algo, expected] = target.integrity.split('-', 2)
    if (!algo || !expected) throw new Error(`malformed integrity string: ${target.integrity}`)
    const actual = createHash(algo).update(buf).digest('base64')
    if (actual !== expected) {
      throw new Error(`integrity check failed (${algo}): expected ${expected}, got ${actual}`)
    }
    return
  }
  if (target.shasum) {
    const actual = createHash('sha1').update(buf).digest('hex')
    if (actual !== target.shasum) {
      throw new Error(`shasum check failed: expected ${target.shasum}, got ${actual}`)
    }
    return
  }
  throw new Error('registry entry has neither integrity nor shasum — refusing to install unverified bytes')
}
