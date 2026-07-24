/** Fixed-policy organization invite-link lifecycle. */
import type { Clock } from '../domain/clock.js'
import type { OrgInviteAcceptResult, OrgInviteLinkRecord, OrgInviteLinkRepo } from '../persistence/ports.js'
import { OrgInviteLinkCodec } from './orgInviteLink.js'

export const ORG_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export type OrgInviteLinkStatus = 'active' | 'expired' | 'revoked'

export interface OrgInviteLinkView {
  id: string
  displayTail: string
  status: OrgInviteLinkStatus
  expiresAt: Date
  revokedAt: Date | null
  createdAt: Date
}

export interface CreatedOrgInviteLink extends OrgInviteLinkView {
  token: string
}

function toView(record: OrgInviteLinkRecord, nowMs: number): OrgInviteLinkView {
  return {
    id: record.id,
    displayTail: record.displayTail,
    status: record.revokedAt ? 'revoked' : record.expiresAt.getTime() <= nowMs ? 'expired' : 'active',
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt,
    createdAt: record.createdAt
  }
}

export class OrgInviteLinkService {
  constructor(
    private readonly codec: OrgInviteLinkCodec,
    private readonly links: OrgInviteLinkRepo,
    private readonly clock: Clock
  ) {}

  async getForOrg(orgId: string): Promise<OrgInviteLinkView | null> {
    const record = await this.links.getForOrg(orgId)
    return record ? toView(record, this.clock.now()) : null
  }

  async create(orgId: string, createdByUserId: string): Promise<CreatedOrgInviteLink | null> {
    const nowMs = this.clock.now()
    const minted = this.codec.mint()
    const record = await this.links.createReplacingInactive(
      {
        orgId,
        tokenHash: minted.hash,
        displayTail: minted.displayTail,
        expiresAt: new Date(nowMs + ORG_INVITE_TTL_MS),
        createdByUserId
      },
      new Date(nowMs)
    )
    return record ? { ...toView(record, nowMs), token: minted.token } : null
  }

  revoke(orgId: string, inviteLinkId: string, actorUserId: string): Promise<boolean> {
    return this.links.revoke(orgId, inviteLinkId, new Date(this.clock.now()), actorUserId)
  }

  accept(token: string, userId: string): Promise<OrgInviteAcceptResult> {
    const hash = this.codec.hash(token)
    return hash
      ? this.links.accept(hash, userId, new Date(this.clock.now()))
      : Promise.resolve({ status: 'unavailable' })
  }
}
