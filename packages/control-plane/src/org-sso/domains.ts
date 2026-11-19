/** Domains an organization proves it controls before its SSO connection may assert them (organization-sso.md §3, §4.1). */
import { randomBytes } from 'node:crypto'
import type { Clock } from '../domain/clock.js'
import { SsoDomainSchema } from '../persistence/deployment-config.js'
import type { OrgDomainRecord, OrgDomainRepo, OrgMemberSource } from '../persistence/ports.js'
import type { TxtLookup } from './txt-lookup.js'

export const ORG_DOMAIN_CHALLENGE_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const ORG_DOMAIN_RECHECK_MS = 24 * 60 * 60 * 1000
export const MAX_DOMAINS_PER_ORG = 20
const RECHECK_BATCH = 50

export const challengeRecordName = (domain: string): string => `_agentconnect-challenge.${domain}`

/** `ok`: the record carries the challenge. `mismatch`: TXT values exist, none is the challenge. `lookup_failed`: no answer from DNS. */
export type OrgDomainCheck = 'ok' | 'not_found' | 'mismatch' | 'lookup_failed'

export interface OrgDomainView {
  id: string
  domain: string
  status: 'pending' | 'verified'
  /** The TXT record to publish; it must stay in place after verification, since it is checked again daily. */
  record: { name: string; value: string }
  /** When a pending claim lapses; null once verified. */
  challengeExpiresAt: Date | null
  verifiedAt: Date | null
  lastCheckedAt: Date | null
  lastCheckOk: boolean | null
}

function toView(record: OrgDomainRecord): OrgDomainView {
  return {
    id: record.id,
    domain: record.domain,
    status: record.verifiedAt ? 'verified' : 'pending',
    record: { name: challengeRecordName(record.domain), value: record.challenge },
    challengeExpiresAt: record.verifiedAt ? null : record.challengeExpiresAt,
    verifiedAt: record.verifiedAt,
    lastCheckedAt: record.lastCheckedAt,
    lastCheckOk: record.lastCheckOk
  }
}

export class OrgSsoDomainService {
  constructor(
    private readonly domains: OrgDomainRepo,
    private readonly lookup: TxtLookup,
    private readonly clock: Clock,
    private readonly log?: { warn(obj: object, msg: string): void }
  ) {}

  async list(orgId: string): Promise<OrgDomainView[]> {
    return (await this.domains.listForOrg(orgId, new Date(this.clock.now()))).map(toView)
  }

  async add(
    orgId: string,
    input: string,
    actorUserId: string
  ): Promise<{ domain: OrgDomainView; created: boolean } | 'invalid' | 'taken' | 'limit'> {
    const parsed = SsoDomainSchema.safeParse(input)
    if (!parsed.success) return 'invalid'
    const now = this.clock.now()
    const result = await this.domains.claim(
      {
        orgId,
        domain: parsed.data,
        challenge: `agentconnect-verification=${randomBytes(24).toString('base64url')}`,
        challengeExpiresAt: new Date(now + ORG_DOMAIN_CHALLENGE_TTL_MS),
        maxPerOrg: MAX_DOMAINS_PER_ORG
      },
      new Date(now),
      actorUserId
    )
    return typeof result === 'string' ? result : { domain: toView(result.record), created: result.created }
  }

  /** Resolve the record now. A verified domain is checked again and keeps its status whatever the answer. */
  async verify(
    orgId: string,
    id: string,
    actorUserId: string
  ): Promise<{ domain: OrgDomainView; check: OrgDomainCheck } | 'taken' | null> {
    const record = await this.domains.get(orgId, id, new Date(this.clock.now()))
    if (!record) return null
    const check = await this.check(record)
    const at = new Date(this.clock.now())
    if (record.verifiedAt || check !== 'ok') {
      const ok = check === 'lookup_failed' ? null : check === 'ok'
      await this.domains.recordCheck(record.id, at, ok)
      return {
        domain: toView({ ...record, lastCheckedAt: at, lastCheckOk: ok ?? record.lastCheckOk }),
        check
      }
    }
    const verified = await this.domains.markVerified(orgId, id, at, actorUserId)
    if (verified === null || verified === 'taken') return verified
    return { domain: toView(verified), check }
  }

  release(orgId: string, id: string, actorUserId: string): Promise<boolean> {
    return this.domains.release(orgId, id, actorUserId)
  }

  memberSource(orgId: string): Promise<OrgMemberSource> {
    return this.domains.memberSource(orgId)
  }

  /** `no_domain`: joining by domain needs a verified domain. */
  setMemberSource(orgId: string, source: OrgMemberSource, actorUserId: string): Promise<OrgMemberSource | 'no_domain'> {
    return this.domains.setMemberSource(orgId, source, actorUserId)
  }

  /** The organization that takes an address on this domain as a member, or null. */
  joinableOrg(domain: string): Promise<string | null> {
    return this.domains.findJoinableOrg(domain)
  }

  /** The domains the organization holds now; the list its connection may be bound to. */
  async verifiedDomains(orgId: string): Promise<string[]> {
    const rows = await this.domains.listForOrg(orgId, new Date(this.clock.now()))
    return rows.filter((row) => row.verifiedAt !== null).map((row) => row.domain)
  }

  /** Resolve every verified domain's record now, as activation requires (§4.1). */
  async recheckVerified(orgId: string): Promise<{ domain: string; check: OrgDomainCheck }[]> {
    const rows = await this.domains.listForOrg(orgId, new Date(this.clock.now()))
    const results: { domain: string; check: OrgDomainCheck }[] = []
    for (const record of rows.filter((row) => row.verifiedAt !== null)) {
      const check = await this.check(record)
      await this.domains.recordCheck(
        record.id,
        new Date(this.clock.now()),
        check === 'lookup_failed' ? null : check === 'ok'
      )
      results.push({ domain: record.domain, check })
    }
    return results
  }

  /** Whether the organization's row is verified; null when it has no such live row. */
  async isVerified(orgId: string, id: string): Promise<boolean | null> {
    const record = await this.domains.get(orgId, id, new Date(this.clock.now()))
    return record ? record.verifiedAt !== null : null
  }

  /** A row by id whatever its organization, for a deployment administrator's release. */
  findAny(id: string): Promise<OrgDomainRecord | null> {
    return this.domains.getAny(id)
  }

  /** The background pass: re-check verified domains once a day and drop lapsed claims. A failing check only marks the row (§8). */
  async sweep(): Promise<void> {
    const due = await this.domains.listDueForRecheck(new Date(this.clock.now() - ORG_DOMAIN_RECHECK_MS), RECHECK_BATCH)
    for (const record of due) {
      const check = await this.check(record)
      await this.domains.recordCheck(
        record.id,
        new Date(this.clock.now()),
        check === 'lookup_failed' ? null : check === 'ok'
      )
    }
    await this.domains.deleteExpiredPending(new Date(this.clock.now()))
  }

  private async check(record: OrgDomainRecord): Promise<OrgDomainCheck> {
    let values: string[]
    try {
      values = await this.lookup(challengeRecordName(record.domain))
    } catch (err) {
      this.log?.warn({ err, domainId: record.id }, 'org sso: TXT lookup failed')
      return 'lookup_failed'
    }
    if (values.length === 0) return 'not_found'
    return values.some((value) => value.trim() === record.challenge) ? 'ok' : 'mismatch'
  }
}
