/** Closed-beta admission service (waitlist-and-login.md §5-§6) — the CP-side surface.
 *  Thin: owns the join-token codec and stamps the clock; all state lives in the repo. */
import type { Clock } from '../domain/clock.js'
import type {
  WaitlistAccessState,
  WaitlistEntryStatus,
  WaitlistRedeemResult,
  WaitlistRepo
} from '../persistence/ports.js'
import { WaitlistJoinTokenCodec } from './waitlistJoinToken.js'

/** The derived admission status surfaced by `GET /me/access` (§5). `active` = may
 *  enter the app (formal user OR an org member); the rest route to `/waitlist`. */
export type WaitlistAccessStatus = 'active' | 'approved' | 'pending' | 'none'

/** Self-submitted intake stored as a note on the waitlist entry (§5). All fields
 *  are required except the use-case — mirrors the console form + the API contract. */
export interface WaitlistIntake {
  name: string
  company: string
  platform: ('slack' | 'telegram' | 'discord')[]
  teamSize: string
  useCase?: string
}

export interface WaitlistAccess extends WaitlistAccessState {
  status: WaitlistAccessStatus
}

/** Pure derivation of the admission status from raw state (§5): a formal user or any
 *  org member is `active`; otherwise mirror the entry (`approved`/`pending`); a
 *  `rejected` or missing entry collapses to the neutral `none`. */
export function deriveAccessStatus(s: WaitlistAccessState): WaitlistAccessStatus {
  if (s.activated || s.orgCount > 0) return 'active'
  if (s.entryStatus === 'approved') return 'approved'
  if (s.entryStatus === 'pending') return 'pending'
  return 'none'
}

export class WaitlistService {
  private readonly codec: WaitlistJoinTokenCodec

  constructor(
    pepper: string,
    private readonly repo: WaitlistRepo,
    private readonly clock: Clock
  ) {
    this.codec = new WaitlistJoinTokenCodec(pepper)
  }

  /** Full admission state + derived status for the signed-in user. */
  async access(userId: string): Promise<WaitlistAccess> {
    const state = await this.repo.accessState(userId)
    return { ...state, status: deriveAccessStatus(state) }
  }

  /** Add the caller's own verified email as a pending entry (idempotent). The
   *  `intake` (name/company/platform/team-size/use-case) is validated at the API
   *  edge and stored as a JSON note on the CREATE path — applicant context for the
   *  admin app; the email is never taken from it. */
  addSelf(email: string, intake: WaitlistIntake): Promise<WaitlistEntryStatus> {
    return this.repo.addSelf(email, JSON.stringify(intake), intake.name)
  }

  /** Redeem a join link for the signed-in user. A token failing codec validation
   *  (malformed / wrong version) is `invalid` without touching the DB. */
  redeem(token: string, userId: string, verifiedEmail: string): Promise<WaitlistRedeemResult> {
    const hash = this.codec.hash(token)
    if (!hash) return Promise.resolve({ status: 'invalid' })
    return this.repo.redeem(hash, userId, verifiedEmail, new Date(this.clock.now()))
  }
}
