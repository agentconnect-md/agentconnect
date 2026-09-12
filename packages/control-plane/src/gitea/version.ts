/**
 * The Gitea instance version floor (gitea-integration.md §3): 1.23, the release whose token model
 * and review-request webhook are both stable. The gate FAILS CLOSED — a string this cannot read is
 * below the floor — and Forgejo's compatibility marker (`…+gitea-1.22.0`) is read in preference
 * to its own leading number, so a fork parses below the floor instead of above it.
 */
import { GITEA_MINIMUM_VERSION } from './config.js'

/** The floor as operators read it, for refusal copy and console rows. */
export const GITEA_MINIMUM_VERSION_LABEL = GITEA_MINIMUM_VERSION

/** The one named reason for a below-floor or unreadable instance (§3). */
export const GITEA_VERSION_UNSUPPORTED_REASON = 'instance_version_unsupported' as const

export interface GiteaInstanceVersion {
  /** Exactly what the instance reported, trimmed; `''` when it reported nothing. */
  raw: string
  /** Null together when the string could not be read as `MAJOR.MINOR`. */
  major: number | null
  minor: number | null
  /** At or above the floor; false for anything unreadable. */
  supported: boolean
}

/** A Gitea compatibility marker wins over the leading number (Forgejo reports `11.0.0+gitea-1.22.0`). */
const COMPATIBILITY_MARKER = /\+gitea-(\d{1,6})\.(\d{1,6})/
/** `MAJOR.MINOR` from the front, an optional `v` tolerated; patch, `+dev` and the rest are ignored. */
const VERSION_HEAD = /^v?(\d{1,6})\.(\d{1,6})(?!\d)/

function headOf(raw: string): { major: number; minor: number } | null {
  const match = COMPATIBILITY_MARKER.exec(raw) ?? VERSION_HEAD.exec(raw)
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : null
}

const FLOOR = headOf(GITEA_MINIMUM_VERSION)!

/** Read a Gitea `version` string. Unreadable ⇒ below the floor, never a guess. */
export function parseGiteaVersion(raw: string | null | undefined): GiteaInstanceVersion {
  const trimmed = (raw ?? '').trim()
  const head = headOf(trimmed)
  if (!head) return { raw: trimmed, major: null, minor: null, supported: false }
  const supported = head.major !== FLOOR.major ? head.major > FLOOR.major : head.minor >= FLOOR.minor
  return { raw: trimmed, major: head.major, minor: head.minor, supported }
}
