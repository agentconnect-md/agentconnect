/** The instance version floor (gitea-integration.md §3): Gitea 1.23 or Forgejo 15, read per product; unreadable fails closed. */
import { FORGEJO_MINIMUM_VERSION, GITEA_MINIMUM_VERSION } from './config.js'

/** Both floors as operators read them, for refusal copy. */
export const GITEA_VERSION_REQUIREMENT = `Gitea ${GITEA_MINIMUM_VERSION} or later, or Forgejo ${FORGEJO_MINIMUM_VERSION} or later`

/** The one named reason for a below-floor or unreadable instance (§3). */
export const GITEA_VERSION_UNSUPPORTED_REASON = 'instance_version_unsupported' as const

export type GiteaInstanceProduct = 'gitea' | 'forgejo'

export interface GiteaInstanceVersion {
  /** Exactly what the instance reported, trimmed; `''` when it reported nothing. */
  raw: string
  /** Forgejo when the string carries its `+gitea-` compatibility marker, otherwise Gitea. */
  product: GiteaInstanceProduct
  /** Null together when the string could not be read as `MAJOR.MINOR`. */
  major: number | null
  minor: number | null
  /** The `MAJOR.MINOR` floor of `product`, so the console names the one that applies. */
  floor: string
  /** At or above that floor; false for anything unreadable. */
  supported: boolean
}

/** Forgejo reports `15.0.9+gitea-1.22.0`; the marker names the product, never the version the floor reads. */
const FORGEJO_MARKER = /\+gitea-\d/
/** `MAJOR.MINOR` from the front, an optional `v` tolerated; patch, `+dev` and the rest are ignored. */
const VERSION_HEAD = /^v?(\d{1,6})\.(\d{1,6})(?!\d)/

function headOf(raw: string): { major: number; minor: number } | null {
  const match = VERSION_HEAD.exec(raw)
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : null
}

const FLOORS: Record<GiteaInstanceProduct, { label: string; major: number; minor: number }> = {
  gitea: { label: GITEA_MINIMUM_VERSION, ...headOf(GITEA_MINIMUM_VERSION)! },
  forgejo: { label: FORGEJO_MINIMUM_VERSION, ...headOf(FORGEJO_MINIMUM_VERSION)! }
}

/** Read a Gitea or Forgejo `version` string. Unreadable ⇒ below the floor, never a guess. */
export function parseGiteaVersion(raw: string | null | undefined): GiteaInstanceVersion {
  const trimmed = (raw ?? '').trim()
  const product: GiteaInstanceProduct = FORGEJO_MARKER.test(trimmed) ? 'forgejo' : 'gitea'
  const floor = FLOORS[product]
  const head = headOf(trimmed)
  if (!head) return { raw: trimmed, product, major: null, minor: null, floor: floor.label, supported: false }
  const supported = head.major !== floor.major ? head.major > floor.major : head.minor >= floor.minor
  return { raw: trimmed, product, major: head.major, minor: head.minor, floor: floor.label, supported }
}
