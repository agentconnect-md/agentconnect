// Computer channel tokens (computer-use.md §3.7, §8.2): short-lived, signed with the Computer's CP-renewed channel key.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import {
  COMPUTER_ICE_SERVERS_MAX,
  COMPUTER_STUN_URLS_MAX,
  ComputerIceServer,
  ComputerStunUrl
} from './computer-viewer.js'
import { COMPUTER_FILES_MODES, COMPUTER_SHELL_MODES } from './computer-command-line.js'

/** The token's version prefix; a token without it is never a channel token. */
export const COMPUTER_CHANNEL_TOKEN_PREFIX = 'actk1'

/** `mcp` admits an agent session's calls to `/mcp`, `relay` a desktop's link to a relay, `view` a console viewer. */
export const COMPUTER_CHANNEL_TOKEN_AUDIENCES = ['mcp', 'relay', 'view'] as const
export type ComputerChannelTokenAudience = (typeof COMPUTER_CHANNEL_TOKEN_AUDIENCES)[number]

/** No token outlives this, whatever its key's lifetime. */
export const COMPUTER_CHANNEL_TOKEN_MAX_TTL_MS = 5 * 60_000

export const COMPUTER_AGENT_MODES = ['view', 'control'] as const
export type ComputerAgentMode = (typeof COMPUTER_AGENT_MODES)[number]

export const ComputerChannelTokenClaims = z
  .object({
    aud: z.enum(COMPUTER_CHANNEL_TOKEN_AUDIENCES),
    // The Computer the token is for, and the id of the channel key that signed it.
    cmp: z.string().uuid(),
    kid: z.string().min(1).max(64),
    // Issue and expiry times, epoch milliseconds on the issuer's clock.
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
    // `mcp` only: the agent session the calls belong to, its agent and daemon, and what the policy lets it do.
    ses: z.string().min(1).max(256).optional(),
    agt: z.string().uuid().optional(),
    dmn: z.string().uuid().optional(),
    mode: z.enum(COMPUTER_AGENT_MODES).optional(),
    // `mcp` only: the command-line tier the policy allows (§5.7); absent, as from an older CP, means none.
    sh: z.enum(COMPUTER_SHELL_MODES).optional(),
    fs: z.enum(COMPUTER_FILES_MODES).optional(),
    // `view` only: the member watching, the TURN servers the desktop may relay media through, and the STUN servers it may punch with.
    usr: z.string().min(1).max(128).optional(),
    ice: z.array(ComputerIceServer).max(COMPUTER_ICE_SERVERS_MAX).optional(),
    stun: z.array(ComputerStunUrl).max(COMPUTER_STUN_URLS_MAX).optional()
  })
  // Unknown claims are stripped, not refused, so a later additive claim does not lock out older desktops.
  .strip()
  .refine((c) => c.aud !== 'mcp' || (c.ses !== undefined && c.agt !== undefined && c.mode !== undefined), {
    message: 'an mcp token names its session, agent and mode'
  })
  .refine((c) => c.aud !== 'view' || (c.usr !== undefined && c.mode !== undefined), {
    message: 'a view token names its member and mode'
  })
  .refine((c) => c.exp > c.iat && c.exp - c.iat <= COMPUTER_CHANNEL_TOKEN_MAX_TTL_MS, {
    message: 'token lifetime out of range'
  })
export type ComputerChannelTokenClaims = z.infer<typeof ComputerChannelTokenClaims>

const MAC_DOMAIN = 'agentconnect/computer-channel-token/v1\n'
// A view token carries TURN credentials, so tokens may run past the 2 KiB an mcp token needs.
const MAX_TOKEN_CHARS = 4096

function mac(key: Buffer, signed: string): Buffer {
  return createHmac('sha256', key)
    .update(MAC_DOMAIN + signed)
    .digest()
}

/** Sign claims with a channel key; the key is secret material and the token is a bearer credential, never logged. */
export function signComputerChannelToken(claims: ComputerChannelTokenClaims, key: Buffer): string {
  const parsed = ComputerChannelTokenClaims.parse(claims)
  const signed = `${COMPUTER_CHANNEL_TOKEN_PREFIX}.${Buffer.from(JSON.stringify(parsed)).toString('base64url')}`
  return `${signed}.${mac(key, signed).toString('base64url')}`
}

/** The claims a token states, unverified, so a verifier can find the key it names; null when it is not a channel token. */
export function readComputerChannelToken(token: string): ComputerChannelTokenClaims | null {
  if (token.length > MAX_TOKEN_CHARS) return null
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== COMPUTER_CHANNEL_TOKEN_PREFIX) return null
  try {
    const parsed = ComputerChannelTokenClaims.safeParse(JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export interface VerifyComputerChannelTokenOpts {
  aud: ComputerChannelTokenAudience
  /** The verifier's own Computer; a token for another is refused. */
  computerId: string
  /** The live key with this id, or undefined when it expired or was never issued. */
  key: (kid: string) => Buffer | undefined
  /** Now, epoch milliseconds on the issuer's clock. */
  now: number
}

/** The verified claims, or null for a forged, foreign, expired or wrong-audience token. */
export function verifyComputerChannelToken(
  token: string,
  opts: VerifyComputerChannelTokenOpts
): ComputerChannelTokenClaims | null {
  const claims = readComputerChannelToken(token)
  if (!claims || claims.aud !== opts.aud || claims.cmp !== opts.computerId) return null
  if (!(claims.exp > opts.now)) return null
  const key = opts.key(claims.kid)
  if (!key) return null
  const at = token.lastIndexOf('.')
  const presented = Buffer.from(token.slice(at + 1), 'base64url')
  const expected = mac(key, token.slice(0, at))
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null
  return claims
}
