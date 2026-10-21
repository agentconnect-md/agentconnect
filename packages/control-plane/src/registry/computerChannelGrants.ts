// Computer data-plane credentials (computer-use.md §3.7, §8.2): per-session tokens the desktop verifies; no screen byte reaches the CP.
import { createHash } from 'node:crypto'
import {
  COMPUTER_ICE_SERVERS_MAX,
  COMPUTER_RELAYS_MAX,
  COMPUTER_STUN_URLS_MAX,
  COMPUTER_VIEWER_TOKEN_TTL_MS,
  type ComputerAgentMode,
  type ComputerIceServer,
  readComputerChannelToken,
  signComputerChannelToken,
  verifyComputerChannelToken,
  viewerPeerToPeerAllowed,
  type ComputerChannelGrantResult,
  type ComputerRelayEntry,
  type RcVerifyResult
} from '@agentconnect.md/protocol'
import type { Clock } from '../domain/clock.js'
import { ComputerId, type OrgId } from '../domain/ids.js'
import { computerGrantsAgent, isComputerReachable, presentComputerStatus } from '../domain/computer.js'
import type { ComputerRepo } from '../persistence/ports.js'
import type { ComputerChannelKeys } from './computerChannelKeys.js'
import { turnCredentials, type TurnConfig } from '../computer-viewer/turn.js'

/** An mcp token lives this long, or less when its key runs out first; the agent daemon asks again before it lapses. */
export const COMPUTER_CHANNEL_TOKEN_TTL_MS = 120_000

export interface ComputerChannelGrantOpts {
  /** A live Computer status older than this reads as offline. */
  staleAfterMs: number
  /** The relays desktops dial out to; the agent daemon sends its calls through one of them. */
  relays: () => Promise<ComputerRelayEntry[]>
  tokenTtlMs?: number
  /** Where a browser reaches the desktop's viewer API: the relay pool's public origin first, then each relay. */
  viewerRelays?: () => Promise<string[]>
  /** An external TURN (COMPUTER_TURN_*) for viewer media without a direct UDP path; it takes precedence over the relays' own. */
  turn?: TurnConfig
  /** The relays' own TURN servers (computer-use.md §7.2): each alive relay's URLs, and the secret it checks credentials with. */
  relayTurn?: { secret: string; ttlSec: number; servers: () => Promise<string[][]> }
  /** The relays' STUN addresses, for hole punching viewer media when the Computer's policy allows it. */
  stunUrls?: () => Promise<string[]>
  /** Told of every grant, so a managed computer an agent or a viewer is using does not idle out (§15.1). */
  onUse?: (computerId: string) => void
}

export type ViewerGrantResult =
  | {
      granted: true
      token: string
      expiresAt: string
      expiresInMs: number
      mode: ComputerAgentMode
      relays: string[]
      iceServers: ComputerIceServer[]
      stunUrls: string[]
      directMedia: boolean
    }
  | { granted: false; code: 'unavailable' | 'no_relay'; message: string }

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
    if (!computerGrantsAgent(computer, who.agentId)) return refuse('denied', 'this agent is not granted this computer')
    if (computer.poolSessionId && computer.poolSessionId !== who.sessionId)
      return refuse('denied', 'this computer belongs to another session')
    const now = this.clock.now()
    const status = presentComputerStatus(computer, now, this.opts.staleAfterMs)
    if (!isComputerReachable(status))
      return refuse('unavailable', status === 'sleeping' ? 'this computer is asleep' : 'this computer is offline')
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
    this.opts.onUse?.(computerId)
    return {
      granted: true,
      token,
      expiresAt: new Date(exp).toISOString(),
      mode: computer.policy.agentMode,
      relays,
      // The agent daemon asks for approvals by these (§4.2): the card names the Computer and also goes to its owner.
      name: computer.name,
      ownerUserId: computer.ownerUserId,
      approvals: computer.policy.approvals
    }
  }

  /** A viewer token for one member watching (or taking over) a Computer; the caller has already checked who may. */
  async grantViewer(
    orgId: OrgId,
    computerId: string,
    who: { userId: string; mode: ComputerAgentMode }
  ): Promise<ViewerGrantResult> {
    const refuse = (code: 'unavailable' | 'no_relay', message: string): ViewerGrantResult => ({
      granted: false,
      code,
      message
    })
    const computer = await this.repo.get(orgId, ComputerId(computerId))
    if (!computer || computer.status === 'revoked') return refuse('unavailable', 'this computer was revoked or removed')
    const now = this.clock.now()
    const status = presentComputerStatus(computer, now, this.opts.staleAfterMs)
    if (!isComputerReachable(status))
      return refuse('unavailable', status === 'sleeping' ? 'this computer is asleep' : 'this computer is offline')
    const apiKeyId = await this.repo.liveKeyId(ComputerId(computerId), new Date(now))
    if (!apiKeyId) return refuse('unavailable', 'this computer was revoked or removed')
    const relays = [...new Set(await (this.opts.viewerRelays?.() ?? Promise.resolve([])))].slice(0, COMPUTER_RELAYS_MAX)
    if (relays.length === 0) return refuse('no_relay', 'no relay is configured, so the viewer cannot reach the desktop')
    const credential = this.keys.signing(computerId, apiKeyId, now)
    this.opts.onUse?.(computerId)
    const exp = Math.min(now + COMPUTER_VIEWER_TOKEN_TTL_MS, Date.parse(credential.expiresAt))
    // The desktop and the browser each get their own TURN username, so the TURN server tells them apart.
    const turn = await this.turnServers(computerId)
    // Hole punching shows the viewer the desktop's public IP, so only a policy that allows it, on a desktop that reads it, gets STUN.
    const stun =
      computer.capabilities.viewerStun === true && viewerPeerToPeerAllowed(computer.policy, computer)
        ? [...new Set(await (this.opts.stunUrls?.() ?? Promise.resolve([])))].slice(0, COMPUTER_STUN_URLS_MAX)
        : []
    const token = signComputerChannelToken(
      {
        aud: 'view',
        cmp: computerId,
        kid: credential.keyId,
        iat: now,
        exp,
        usr: who.userId,
        mode: who.mode,
        ...(turn.length > 0
          ? { ice: turn.map((server) => turnCredentials(server, `computer-${computerId}`, now)) }
          : {}),
        ...(stun.length > 0 ? { stun } : {})
      },
      Buffer.from(credential.key, 'base64url')
    )
    return {
      granted: true,
      token,
      expiresAt: new Date(exp).toISOString(),
      expiresInMs: exp - now,
      mode: who.mode,
      relays,
      iceServers: turn.map((server) => turnCredentials(server, `viewer-${who.userId}`, now)),
      stunUrls: stun,
      // A managed computer's pod has no UDP a browser can reach, so its viewer starts at TURN.
      directMedia: computer.kind !== 'managed'
    }
  }

  // External TURN is the operator's explicit choice; otherwise the relays' own, spread per Computer, the same relay first for both peers.
  private async turnServers(computerId: string): Promise<TurnConfig[]> {
    if (this.opts.turn) return [this.opts.turn]
    const relay = this.opts.relayTurn
    if (!relay) return []
    return rendezvous(await relay.servers(), computerId)
      .slice(0, COMPUTER_ICE_SERVERS_MAX)
      .map((urls) => ({ urls, secret: relay.secret, ttlSec: relay.ttlSec }))
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

// Highest-random-weight order of the relays for one Computer: stable per Computer, spread across Computers, little churn as relays come and go.
export function rendezvous(servers: string[][], computerId: string): string[][] {
  const weight = (urls: string[]) =>
    createHash('sha256')
      .update(`${computerId}\n${urls.join(' ')}`)
      .digest('hex')
  return servers
    .map((urls) => ({ urls, weight: weight(urls) }))
    .sort((a, b) => (a.weight < b.weight ? 1 : a.weight > b.weight ? -1 : 0))
    .map(({ urls }) => urls)
}
