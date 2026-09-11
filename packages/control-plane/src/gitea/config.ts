/**
 * Gitea instance identity (gitea-integration.md §3, §12).
 *
 * Gitea has no OAuth application and nothing deployment-wide but the instance address, so this
 * module is one axis and no credential pair: absent means gitea.com, the default value of the
 * axis and never a separate mode. An organization's bot token is per-organization state the
 * Control Plane holds (§4.1), not deployment configuration, so nothing here is a secret.
 */
import { GITEA_DEFAULT_BASE_URL } from '@agentconnect.md/protocol'
import { normalizeCodeHostBaseUrl } from '../codehost/base-url.js'
import type { AppConfig } from '../config/env.js'

// The default value of the host axis: an unset base URL means gitea.com (§3). It is the
// protocol's, not this module's — the same absence means gitea.com on the wire.
export { GITEA_DEFAULT_BASE_URL }

/** The shared instance-axis normalization (§3 defers to GitLab's rules verbatim). */
export function normalizeGiteaBaseUrl(raw: string): string {
  return normalizeCodeHostBaseUrl(raw, 'gitea')
}

/** The release whose token model and review-request webhook are both stable (§3). */
export const GITEA_MINIMUM_VERSION = '1.23'

export interface GiteaInstanceConfig {
  /** Normalized instance base URL; `GITEA_DEFAULT_BASE_URL` when the axis is unset. */
  baseUrl: string
}

type GiteaEnvSlice = Pick<AppConfig, 'GITEA_BASE_URL'>

/**
 * The instance this deployment addresses. Unlike GitLab's resolver there is no client pair to
 * be partial about, so this never throws and never answers undefined: with no address configured
 * the deployment addresses gitea.com. Whether an ORGANIZATION has connected a bot is separate
 * state the connection routes own (§4.1), which is what G2 adds.
 */
export function resolveGiteaInstanceConfig(config: GiteaEnvSlice): GiteaInstanceConfig {
  const raw = config.GITEA_BASE_URL?.trim()
  return { baseUrl: raw ? normalizeGiteaBaseUrl(raw) : GITEA_DEFAULT_BASE_URL }
}
