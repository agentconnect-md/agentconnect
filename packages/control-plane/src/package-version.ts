import { readFileSync } from 'node:fs'

/** The control plane's own manifest version, read here so a shared package cannot report its own instead. */
export function readPackageVersion(): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }
    return pkg.version
  } catch {
    return undefined
  }
}

// The release an image was built from, as its tag: CI bakes the effective image tag into the manifest, while a
// checkout keeps the dev version, which names no release.
export function releaseTag(version: string | undefined = readPackageVersion()): string | undefined {
  return version && /^\d+\.\d+\.\d+(-rc\.\d+)?$/.test(version) ? `v${version}` : undefined
}

/** The npm channel of this CP's release (`rc` from a checkout, which runs ahead of stable), so the console's CLI command matches it. */
export function cliChannel(release: string | undefined = releaseTag()): 'stable' | 'rc' {
  return release && !release.includes('-') ? 'stable' : 'rc'
}

/** The computer image matching this CP's release, so the console never pairs a CP with a newer or older computer daemon. */
export function computerImage(override: string | undefined, release: string | undefined = releaseTag()): string {
  return override ?? `ghcr.io/agentconnect-md/computer:${release ?? 'latest'}`
}
