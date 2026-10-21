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

/** The desktop image matching this CP's release, so the console never pairs a CP with a newer or older desktop. */
export function desktopImage(override: string | undefined, release: string | undefined = releaseTag()): string {
  return override ?? `ghcr.io/agentconnect-md/desktop:${release ?? 'latest'}`
}
