// Whether this desktop may act right now (computer-use.md §8.2): only while a CP-renewed channel key is live, never after a revoke.
import {
  signComputerChannelToken,
  verifyComputerChannelToken,
  type ComputerChannelCredential,
  type ComputerChannelTokenAudience,
  type ComputerChannelTokenClaims
} from '@agentconnect.md/protocol/computer'

/** How long a relay-audience token the desktop signs for `cr/hello` lives. */
const RELAY_TOKEN_TTL_MS = 60_000

export type AuthorityState =
  // Not registered with a Control Plane: the prototype's local client tokens are the only authority.
  | { kind: 'local' }
  | { kind: 'active'; expiresAt: number }
  // Registered, but no live key: not connected yet, or cut off from the CP longer than a key lives.
  | { kind: 'lapsed'; reason: string }
  | { kind: 'revoked'; reason: string }

interface HeldKey {
  keyId: string
  key: Buffer
  expiresAt: number
}

export interface AuthorityOptions {
  registered: boolean
  revokedReason?: string
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  // Fires when the desktop loses its authority: stop input, drop leases, close viewers.
  onLost?: (state: AuthorityState) => void
  log?: (line: string) => void
}

export class ChannelAuthority {
  private keys: HeldKey[] = []
  private revoked: string | undefined
  private timer: unknown
  // Local clock minus CP clock, measured at each auth, so a skewed desktop clock does not stretch a key.
  private skewMs = 0
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(private readonly options: AuthorityOptions) {
    this.revoked = options.revokedReason
    this.now = options.now ?? Date.now
    this.setTimer =
      options.setTimer ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms)
        handle.unref()
        return handle
      })
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout))
  }

  state(): AuthorityState {
    if (!this.options.registered) return { kind: 'local' }
    if (this.revoked) return { kind: 'revoked', reason: this.revoked }
    const expiresAt = this.latestExpiry()
    return expiresAt > this.now()
      ? { kind: 'active', expiresAt }
      : { kind: 'lapsed', reason: 'not connected to the Control Plane' }
  }

  /** Why this desktop must refuse input, screenshots and viewers right now, or undefined when it may act. */
  refusal(): string | undefined {
    const state = this.state()
    if (state.kind === 'revoked') return `this computer was revoked (${state.reason}); register it again`
    if (state.kind === 'lapsed') return `${state.reason}; agent and viewer access resumes once it reconnects`
    return undefined
  }

  /** Record the CP clock at auth; credentials are then read against it. */
  syncClock(serverTime: string): void {
    const server = Date.parse(serverTime)
    if (Number.isFinite(server)) this.skewMs = this.now() - server
  }

  /** Accept a key the CP issued or renewed; ignored once revoked. */
  accept(credential: ComputerChannelCredential): void {
    if (this.revoked || !this.options.registered) return
    const expiresAt = Date.parse(credential.expiresAt) + this.skewMs
    if (!(expiresAt > this.now())) return
    this.keys = this.live().filter((held) => held.keyId !== credential.keyId)
    this.keys.push({ keyId: credential.keyId, key: Buffer.from(credential.key, 'base64url'), expiresAt })
    this.arm()
  }

  /** A live key by id, for verifying a channel token locally (the data plane, #3189). */
  key(keyId: string): Buffer | undefined {
    if (this.revoked) return undefined
    return this.live().find((held) => held.keyId === keyId)?.key
  }

  /** Verify a channel token the CP issued for this Computer; undefined for any token that does not hold. */
  verify(token: string, aud: ComputerChannelTokenAudience, computerId: string): ComputerChannelTokenClaims | undefined {
    if (this.revoked || !this.options.registered) return undefined
    const claims = verifyComputerChannelToken(token, {
      aud,
      computerId,
      key: (kid) => this.key(kid),
      now: this.serverNow()
    })
    return claims ?? undefined
  }

  /** A relay-audience token signed with the newest live key, proving to a relay (through the CP) that this desktop holds it. */
  relayToken(computerId: string): string | undefined {
    if (this.revoked || !this.options.registered) return undefined
    const newest = this.live().reduce<HeldKey | undefined>(
      (best, held) => (!best || held.expiresAt > best.expiresAt ? held : best),
      undefined
    )
    if (!newest) return undefined
    const iat = this.serverNow()
    const exp = Math.min(iat + RELAY_TOKEN_TTL_MS, newest.expiresAt - this.skewMs)
    if (!(exp > iat)) return undefined
    return signComputerChannelToken({ aud: 'relay', cmp: computerId, kid: newest.keyId, iat, exp }, newest.key)
  }

  // The CP's clock, as measured at the last auth.
  private serverNow(): number {
    return this.now() - this.skewMs
  }

  /** The CP revoked this Computer: drop every key at once and stay refused. */
  revoke(reason: string): void {
    if (this.revoked) return
    this.revoked = reason
    this.drop()
    this.options.log?.(`computer revoked (${reason}): input, screenshots and viewers are refused`)
    this.options.onLost?.(this.state())
  }

  close(): void {
    if (this.timer !== undefined) this.clearTimer(this.timer)
    this.timer = undefined
  }

  private live(): HeldKey[] {
    const now = this.now()
    return this.keys.filter((held) => held.expiresAt > now)
  }

  private latestExpiry(): number {
    return this.live().reduce((max, held) => Math.max(max, held.expiresAt), 0)
  }

  private drop(): void {
    for (const held of this.keys) held.key.fill(0)
    this.keys = []
    this.close()
  }

  // One timer at the latest expiry: renewals push it out, silence lets it fire.
  private arm(): void {
    this.close()
    const expiresAt = this.latestExpiry()
    if (expiresAt === 0) return
    this.timer = this.setTimer(
      () => {
        this.timer = undefined
        if (this.latestExpiry() > this.now()) return this.arm()
        this.drop()
        this.options.log?.('channel key expired without renewal: input, screenshots and viewers are refused')
        this.options.onLost?.(this.state())
      },
      Math.max(0, expiresAt - this.now())
    )
  }
}
