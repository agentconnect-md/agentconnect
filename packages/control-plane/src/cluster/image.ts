/**
 * Pure arithmetic on a daemon image reference and on the versions behind it.
 *
 * A release publishes the npm package and the container image from one version, so the
 * deployment's dist-tag channel already answers which image an envelope should run — but
 * the two spell that version differently. npm reports `1.5.0`; the image is tagged with
 * the GIT tag, `v1.5.0` (`.github/workflows/build.yaml` refuses a version that is not
 * `vX.Y.Z(-rc.N)`, and `docker-bake.hcl` passes it through as `VERSION`). Composing an
 * image reference therefore means translating, not concatenating — see
 * {@link versionImageTag}.
 *
 * What is left is textual: swap the tag while keeping the registry and repository the
 * install configured, and refuse to touch a reference that does not name a version.
 */

/** A tag is everything after the LAST `:` — but only when that colon is in the final
 *  path segment, so `registry.example:5000/daemon` reads as untagged, not as tag `5000/daemon`. */
function tagStart(image: string): number {
  const colon = image.lastIndexOf(':')
  return colon > image.lastIndexOf('/') ? colon : -1
}

/** The reference without its tag; a digest reference keeps the digest and is returned whole. */
export function imageRepository(image: string): string {
  if (image.includes('@')) return image
  const at = tagStart(image)
  return at === -1 ? image : image.slice(0, at)
}

/** The tag, or null for an untagged or digest-pinned reference. */
export function imageTag(image: string): string | null {
  if (image.includes('@')) return null
  const at = tagStart(image)
  return at === -1 ? null : image.slice(at + 1)
}

/** What Docker accepts as a tag, which is also what keeps a substituted tag from
 *  naming a different image: no `/`, `:`, `@`, or whitespace can get through. */
const TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/

export class InvalidImageTagError extends Error {
  constructor(readonly tag: string) {
    super(`"${tag}" is not a usable image tag`)
    this.name = 'InvalidImageTagError'
  }
}

/**
 * The same image at `tag`. A DIGEST reference is returned unchanged: a digest is an
 * exact pin, and rewriting it to a tag would silently discard the pin an operator
 * chose. Callers decide whether that no-op is a reason to skip the write.
 *
 * The tag is validated here rather than trusted from the caller: this is the one place
 * that composes a registry reference, so a value carrying `/` or `:` would repoint an
 * envelope at somebody else's image, and refusing at the seam does not depend on every
 * route remembering to check first.
 */
export function withImageTag(image: string, tag: string): string {
  if (!TAG.test(tag)) throw new InvalidImageTagError(tag)
  if (image.includes('@')) return image
  return `${imageRepository(image)}:${tag}`
}

/** Numeric-then-lexicographic comparison of one dot-separated identifier list. */
function compareParts(a: string[], b: string[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const l = a[i]
    const r = b[i]
    // A shorter prerelease sorts BEFORE a longer one with the same prefix (semver §11):
    // `1.0.0-rc` precedes `1.0.0-rc.1`. For the release triple the parts are equal-length.
    if (l === undefined) return -1
    if (r === undefined) return 1
    const ln = /^\d+$/.test(l)
    const rn = /^\d+$/.test(r)
    // Numeric identifiers always compare lower than alphanumeric ones (semver §11).
    if (ln && rn) {
      if (Number(l) !== Number(r)) return Number(l) < Number(r) ? -1 : 1
    } else if (ln !== rn) {
      return ln ? -1 : 1
    } else if (l !== r) {
      return l < r ? -1 : 1
    }
  }
  return 0
}

/**
 * `x.y.z` with an optional `-prerelease` and an optional `v` prefix; build metadata is out
 * of scope (never published). The prefix is accepted because the two things compared here
 * spell one version two ways: an npm version (`1.5.0`) against an image tag (`v1.5.0`).
 */
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

interface Parsed {
  release: string[]
  prerelease: string[] | null
}

/** Parse a published version, or null for anything that is not one (`latest`, `rc`, a sha). */
export function parseVersion(version: string): Parsed | null {
  const m = SEMVER.exec(version.trim())
  if (!m) return null
  return { release: [m[1]!, m[2]!, m[3]!], prerelease: m[4] ? m[4].split('.') : null }
}

/**
 * The canonical spelling of a published version — the one npm reports and, because the
 * Dockerfile strips the `v` when it stamps `package.json`, the one a pod reports as its
 * `agentVersion`. Null for anything that is not a version at all.
 *
 * Every cluster upgrade target passes through here, and both things it feeds need it. The
 * image tag is composed from it, so an already-prefixed `v1.5.0` would otherwise become
 * `vv1.5.0`; and the lifecycle op settles by comparing the target against what the
 * replacement pod reports, so a target spelled any other way could never settle even if
 * such an image existed. A floating token like `latest` is rejected rather than turned into
 * `vlatest` — the daemon's own npm path can resolve a dist-tag, but an image tag cannot be
 * guessed from one and no pod would ever report it.
 */
export function canonicalVersion(version: string): string | null {
  const trimmed = version.trim()
  return parseVersion(trimmed) ? trimmed.replace(/^v/, '') : null
}

/** How a repository spells a released version, learned from one tag that IS a version. */
export type VersionTagStyle = 'v-prefixed' | 'bare'

/**
 * The convention a tag demonstrates, or null when it demonstrates nothing.
 *
 * Only a tag that already names a version is evidence. A floating tag (`latest`, `rc`) is
 * not: it says which image to run, never how this repository spells a version, and reading
 * a missing `v` off it as "bare" is how an upgrade fabricates `:1.5.0` for a registry that
 * only publishes `:v1.5.0` — a tag that does not exist, and a pod in ImagePullBackOff.
 */
export function versionTagStyle(tag: string | null): VersionTagStyle | null {
  if (!tag || !parseVersion(tag)) return null
  return tag.startsWith('v') ? 'v-prefixed' : 'bare'
}

/** Spell `version` as a tag in the given convention. */
export function versionImageTag(style: VersionTagStyle, version: string): string {
  return style === 'v-prefixed' ? `v${version}` : version
}

/**
 * True when `candidate` is a strictly newer published version than `current`. Null on
 * either side (an unparseable tag) is NOT newer — a floating tag or a digest is a pin
 * somebody chose, and guessing its ordering is how an automated sweep downgrades a fleet.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate)
  const b = parseVersion(current)
  if (!a || !b) return false
  const release = compareParts(a.release, b.release)
  if (release !== 0) return release > 0
  // Same release triple: a release outranks any of its prereleases (semver §11).
  if (!a.prerelease) return b.prerelease !== null
  if (!b.prerelease) return false
  return compareParts(a.prerelease, b.prerelease) > 0
}
