// A key server's standing answer set by the test, recording which orgs were asked.
import type { OrgStanding, OrgStandingVerdict } from '../../src/key-server/org-standing.js'

export const SUSPENDED_MESSAGE =
  'This organization is out of credit. Add credit at https://console.example.test/billing.'

export const SUSPENDED: OrgStandingVerdict = {
  allowed: false,
  reason: 'suspended',
  status: 402,
  message: SUSPENDED_MESSAGE
}
export const UNAVAILABLE: OrgStandingVerdict = { allowed: false, reason: 'unavailable', message: 'fetch failed' }

export class FakeOrgStanding implements OrgStanding {
  readonly asked: string[] = []
  constructor(public verdict: OrgStandingVerdict = { allowed: true }) {}

  async check(orgId: string): Promise<OrgStandingVerdict> {
    this.asked.push(orgId)
    return this.verdict
  }
}
