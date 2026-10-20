// Computer data-plane credentials (computer-use.md §3.7, §8.2): per-session tokens the desktop verifies; no screen byte reaches the CP.
import {
  COMPUTER_RELAYS_MAX,
  readComputerChannelToken,
  signComputerChannelToken,
  verifyComputerChannelToken,
  type ComputerChannelGrantResult,
  type ComputerRelayEntry,
  type RcVerifyResult
} from '@agentconnect.md/protocol'
import type { Clock } from '../domain/clock.js'
import { ComputerId, type OrgId } from '../domain/ids.js'
import { presentComputerStatus } from '../domain/computer.js'
import type { ComputerRepo } from '../persistence/ports.js'
import type { ComputerChannelKeys } from './computerChannelKeys.js'

/** An mcp token lives this long, or less when its key runs out first; the agent daemon asks again before it lapses. */
export const COMPUTER_CHANNEL_TOKEN_TTL_MS = 120_000

export interface ComputerChannelGrantOpts {
  /** A live Computer status older than this reads as offline. */
  staleAfterMs: number
  /** The relays desktops dial out to; the agent daemon sends its calls through one of them. */
  relays: () => Promise<ComputerRelayEntry[]>
  tokenTtlMs?: number
}

export interface GrantRequester {
  agentId: string
  sessionId: string
  daemonId: string
}

export class ComputerChannelGrants {
  constructor(
    private readonly repo: Pick<ComputerRepo, 'get' | 'getUnscoped' | 'liveKeyId'>,
    private readonly keys: ComputerChannelKeys,
    private readonly clock: Clock,
    private readonly opts: ComputerChannelGrantOpts
  ) {}

  /** A token for one agent session's calls to a Computer's `/mcp`; the caller has already checked the daemon serves the agent. */
  async grant(orgId: OrgId, computerId: string, who: GrantRequester): Promise<ComputerChannelGrantResult> {
    const refuse = (code: 'denied' | 'unavailable', message: string): ComputerChannelGrantResult => ({
      granted: false,
      code,
      message
    })
    const computer = await this.repo.get(orgId, ComputerId(computerId))
    if (!computer || computer.status === 'revoked') return refuse('unavailable', 'this computer was revoked or removed')
    if (!computer.policy.allowedAgents.includes(who.agentId))
      return refuse('denied', 'this agent is not granted this computer')
    const now = this.clock.now()
    if (presentComputerStatus(computer, now, this.opts.staleAfterMs) === 'offline')
      return refuse('unavailable', 'this computer is offline')
    const apiKeyId = await this.repo.liveKeyId(ComputerId(computerId), new Date(now))
    if (!apiKeyId) return refuse('unavailable', 'this computer was revoked or removed')
    // A key every live desktop holds: just after a window opens the newest may not have reached it yet.
    const credential = this.keys.signing(computerId, apiKeyId, now)
    const exp = Math.min(
      now + (this.opts.tokenTtlMs ?? COMPUTER_CHANNEL_TOKEN_TTL_MS),
      Date.parse(credential.expiresAt)
    )
    const token = signComputerChannelToken(
      {
        aud: 'mcp',
        cmp: computerId,
        kid: credential.keyId,
        iat: now,
        exp,
        ses: who.sessionId,
        agt: who.agentId,
        dmn: who.daemonId,
        mode: computer.policy.agentMode
      },
      Buffer.from(credential.key, 'base64url')
    )
    const relays = (await this.opts.relays()).slice(0, COMPUTER_RELAYS_MAX)
    return { granted: true, token, expiresAt: new Date(exp).toISOString(), mode: computer.policy.agentMode, relays }
  }

  /** A relay's `rc/verify` of a desktop's `cr/hello`: the token must be signed with that Computer's live channel key. */
  async verifyRelayToken(credential: string, computerId: string): Promise<RcVerifyResult> {
    const refused: RcVerifyResult = { ok: false, reason: 'invalid credential' }
    const claimed = readComputerChannelToken(credential)
    if (!claimed || claimed.cmp !== computerId) return refused
    const computer = await this.repo.getUnscoped(ComputerId(computerId))
    if (!computer || computer.status === 'revoked') return refused
    const now = this.clock.now()
    const apiKeyId = await this.repo.liveKeyId(ComputerId(computerId), new Date(now))
    if (!apiKeyId) return refused
    const verified = verifyComputerChannelToken(credential, {
      aud: 'relay',
      computerId,
      key: (kid) => this.keys.keyFor(computerId, apiKeyId, kid, now) ?? undefined,
      now
    })
    return verified ? { ok: true, computerId, orgId: computer.orgId } : refused
  }
}
