// Provisioning requires service accounts and generally available signed webhooks (§24.2).
export const GITLAB_MINIMUM_VERSION = { major: 19, minor: 1 } as const

/** The floor as operators read it, for refusal copy and console rows. */
export const GITLAB_MINIMUM_VERSION_LABEL = `${GITLAB_MINIMUM_VERSION.major}.${GITLAB_MINIMUM_VERSION.minor}`

/** The one named reason for a below-floor or unreadable instance (§24.2). */
export const INSTANCE_VERSION_UNSUPPORTED_REASON = 'instance_version_unsupported' as const

export interface GitlabInstanceVersion {
  /** Exactly what the instance reported, trimmed; `''` when it reported nothing. */
  raw: string
  /** Null together when the string could not be read as `MAJOR.MINOR`. */
  major: number | null
  minor: number | null
  /** Whether the instance reports Enterprise Edition — the `-ee` build suffix. */
  enterprise: boolean
  /** At or above {@link GITLAB_MINIMUM_VERSION}; false for anything unreadable. */
  supported: boolean
}

/** `MAJOR.MINOR` with anything after it ignored: patch, `-ee`, `-pre`, `-rc42`. */
const VERSION_HEAD = /^(\d{1,6})\.(\d{1,6})(?!\d)/

/** Only the build-edition suffix counts; a `19.1.0-ee-something` fork still reports EE. */
const ENTERPRISE_SUFFIX = /-ee\b/

/** Read GitLab's `version` string. Unreadable ⇒ below the floor, never a guess. */
export function parseGitlabVersion(raw: string | null | undefined): GitlabInstanceVersion {
  const trimmed = (raw ?? '').trim()
  const match = VERSION_HEAD.exec(trimmed)
  const enterprise = ENTERPRISE_SUFFIX.test(trimmed)
  if (!match) return { raw: trimmed, major: null, minor: null, enterprise, supported: false }
  const major = Number(match[1])
  const minor = Number(match[2])
  return { raw: trimmed, major, minor, enterprise, supported: atOrAboveFloor(major, minor) }
}

function atOrAboveFloor(major: number, minor: number): boolean {
  if (major !== GITLAB_MINIMUM_VERSION.major) return major > GITLAB_MINIMUM_VERSION.major
  return minor >= GITLAB_MINIMUM_VERSION.minor
}
