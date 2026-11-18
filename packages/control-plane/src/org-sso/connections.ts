/** An organization's SSO connection: configure, test, activate (organization-sso.md §3, §4.1). The row is the desired state; the identity service follows it. */
import { createHash, randomBytes } from 'node:crypto'
import type { Clock } from '../domain/clock.js'
import { LogtoApiError } from '../github/logto-identity.js'
import type { OrgSsoConnectionRecord, OrgSsoConnectionRepo, OrgSsoProtocol } from '../persistence/ports.js'
import type { OrgSsoDomainService, OrgDomainCheck, OrgDomainView } from './domains.js'
import { orgConnectorName, type OrgSsoIdp } from './idp.js'

export const ORG_SSO_TEST_TTL_MS = 10 * 60 * 1000

export type OrgSsoConnectionInput =
  | { protocol: 'oidc'; name: string; issuer: string; clientId: string; clientSecret: string; scope?: string }
  | {
      protocol: 'saml'
      name: string
      metadataUrl?: string
      metadata?: string
      attributeMapping?: Record<string, string>
    }

/** What the owner enters at the identity provider. */
export type OrgSsoServiceProvider = { redirectUri: string } | { assertionConsumerServiceUrl: string; entityId: string }

export interface OrgSsoConnectionView {
  id: string
  protocol: OrgSsoProtocol
  name: string
  /** `active` enforces single sign-on for the organization's domains whether or not the current settings were tested. */
  status: 'draft' | 'tested' | 'active'
  /** A sign-in through the connection has succeeded since its settings last changed. */
  tested: boolean
  testedAt: Date | null
  activatedAt: Date | null
  configChangedAt: Date
  serviceProvider: OrgSsoServiceProvider
}

/** `none`: no connection. `needs_configuration`: its connector is gone from the identity service. */
export type OrgSsoConnectionProblem = 'none' | 'needs_configuration'

const isTested = (row: OrgSsoConnectionRecord): boolean =>
  row.testedAt !== null && row.testedAt.getTime() > row.configChangedAt.getTime()

const hashNonce = (nonce: string): string => createHash('sha256').update(nonce).digest('hex')

// An organization-owned connection never trusts an unverified address (§4.1).
function connectorConfig(input: OrgSsoConnectionInput): Record<string, unknown> {
  if (input.protocol === 'oidc') {
    const { issuer, clientId, clientSecret, scope } = input
    return { issuer, clientId, clientSecret, ...(scope ? { scope } : {}), trustUnverifiedEmail: false }
  }
  const { metadataUrl, metadata, attributeMapping } = input
  return {
    ...(metadataUrl ? { metadataUrl } : { metadata }),
    ...(attributeMapping && Object.keys(attributeMapping).length > 0 ? { attributeMapping } : {})
  }
}

export class OrgSsoConnectionService {
  constructor(
    private readonly deps: {
      connections: OrgSsoConnectionRepo
      domains: OrgSsoDomainService
      idp: OrgSsoIdp
      clock: Clock
      /** The identity service's public origin, where an identity provider sends people back. */
      idpOrigin: string
      log?: { warn(obj: object, msg: string): void }
    }
  ) {}

  async get(orgId: string): Promise<OrgSsoConnectionView | null> {
    const row = await this.deps.connections.getForOrg(orgId)
    return row ? this.view(row) : null
  }

  /** Create or change the settings. Throws `OrgSsoIdpRejected` with the identity service's reason. */
  async save(orgId: string, input: OrgSsoConnectionInput, actorUserId: string): Promise<OrgSsoConnectionView> {
    const { idp, connections, clock } = this.deps
    const connectorId = await idp.ensureConnector({
      connectorName: orgConnectorName(orgId),
      protocol: input.protocol,
      displayName: input.name
    })
    // The row changes before the settings are tried, so new settings can never stand behind an older test.
    const row = await connections.save(
      { orgId, logtoConnectorId: connectorId, protocol: input.protocol, name: input.name },
      new Date(clock.now()),
      actorUserId
    )
    const configured = await idp.configure(connectorId, { displayName: input.name, config: connectorConfig(input) })
    if (configured === 'missing') throw new LogtoApiError('the sso connector disappeared while it was saved', 0, true)
    await this.sync(row)
    return this.view(row)
  }

  /** Open a ten-minute test window and mint the nonce the landing page presents (§4.1). */
  async startTest(
    orgId: string
  ): Promise<{ nonce: string; connectorId: string; expiresAt: Date } | OrgSsoConnectionProblem | 'no_domain'> {
    const { connections, domains, clock } = this.deps
    if (!(await connections.getForOrg(orgId))) return 'none'
    if ((await domains.verifiedDomains(orgId)).length === 0) return 'no_domain'
    const nonce = randomBytes(32).toString('base64url')
    const expiresAt = new Date(clock.now() + ORG_SSO_TEST_TTL_MS)
    const row = await connections.startTest(orgId, hashNonce(nonce), expiresAt)
    if (!row) return 'none'
    // An existing account links only through a connector that lists its domain, so the window binds them.
    if ((await this.sync(row)) === 'missing') return 'needs_configuration'
    return { nonce, connectorId: row.logtoConnectorId, expiresAt }
  }

  /** The account that landed presents the nonce; the connection is tested when that account holds an identity on it. */
  async completeTest(nonce: string, subject: string, actorUserId: string): Promise<boolean> {
    const { connections, idp, clock } = this.deps
    const nonceHash = hashNonce(nonce)
    const live = await connections.findLiveTest(nonceHash, new Date(clock.now()))
    if (!live) return false
    const account = await idp.account(subject)
    if (!account?.connectorIds.includes(live.logtoConnectorId)) return false
    const row = await connections.completeTest(live.id, nonceHash, new Date(clock.now()), actorUserId)
    if (!row) return false
    await this.closeTestWindow(row)
    return true
  }

  async activate(
    orgId: string,
    actorUserId: string
  ): Promise<
    | OrgSsoConnectionView
    | OrgSsoConnectionProblem
    | 'untested'
    | 'no_domain'
    | { failed: { domain: string; check: OrgDomainCheck }[] }
  > {
    const { connections, domains, clock } = this.deps
    const current = await connections.getForOrg(orgId)
    if (!current) return 'none'
    if (!isTested(current)) return 'untested'
    const checks = await domains.recheckVerified(orgId)
    if (checks.length === 0) return 'no_domain'
    const failed = checks.filter((entry) => entry.check !== 'ok')
    if (failed.length > 0) return { failed }
    const row = await connections.setActive(orgId, new Date(clock.now()), actorUserId)
    if (!row) return 'none'
    if ((await this.sync(row)) === 'missing') {
      await connections.setActive(orgId, null, actorUserId)
      return 'needs_configuration'
    }
    return this.view(row)
  }

  /** Lifts the restriction on the organization's domains; people already linked can still sign in through the connection. */
  async deactivate(orgId: string, actorUserId: string): Promise<OrgSsoConnectionView | null> {
    const row = await this.deps.connections.setActive(orgId, null, actorUserId)
    if (!row) return null
    await this.sync(row)
    return this.view(row)
  }

  /** Delete the connector, and with it every identity it established, then the row. */
  async remove(orgId: string, actorUserId: string): Promise<boolean> {
    const { connections, idp } = this.deps
    const current = await connections.getForOrg(orgId)
    if (!current) return false
    await idp.deleteConnector(current.logtoConnectorId)
    await connections.remove(orgId, actorUserId)
    return true
  }

  async verifyDomain(
    orgId: string,
    id: string,
    actorUserId: string
  ): Promise<{ domain: OrgDomainView; check: OrgDomainCheck } | 'taken' | null> {
    const result = await this.deps.domains.verify(orgId, id, actorUserId)
    // A domain verified while the connection is active is bound when it is verified (§4.1).
    if (result !== null && result !== 'taken' && result.domain.status === 'verified') await this.syncOrg(orgId)
    return result
  }

  /** An owner keeps a verified domain while a connection exists: its identities were established on that domain's word. */
  async releaseDomain(orgId: string, id: string, actorUserId: string): Promise<boolean | 'in_use'> {
    const { connections, domains } = this.deps
    const verified = await domains.isVerified(orgId, id)
    if (verified === null) return false
    if (verified && (await connections.getForOrg(orgId))) return 'in_use'
    return domains.release(orgId, id, actorUserId)
  }

  /** A deployment administrator's release, for a domain its owner has lost (§8): the connection goes with it. */
  async adminReleaseDomain(id: string, actorUserId: string): Promise<boolean> {
    const record = await this.deps.domains.findAny(id)
    if (!record) return false
    if (record.verifiedAt !== null) await this.remove(record.orgId, actorUserId)
    return this.deps.domains.release(record.orgId, id, actorUserId)
  }

  /** The background pass: close test windows past their expiry and unbind what they bound. */
  async sweep(): Promise<void> {
    const { connections, clock, log } = this.deps
    for (const row of await connections.listEndedTests(new Date(clock.now()))) {
      await this.closeTestWindow(row).catch((err: unknown) =>
        log?.warn({ err, connectionId: row.id }, 'org sso: could not close a test window')
      )
    }
  }

  private async closeTestWindow(row: OrgSsoConnectionRecord): Promise<void> {
    await this.sync(row)
    await this.deps.connections.closeTest(row.id, new Date(this.deps.clock.now()))
  }

  private async syncOrg(orgId: string): Promise<void> {
    const row = await this.deps.connections.getForOrg(orgId)
    if (row) await this.sync(row)
  }

  /** Write the whole domain list the row calls for: the verified domains while active or in a test window, none otherwise. */
  private async sync(row: OrgSsoConnectionRecord): Promise<'ok' | 'missing'> {
    const { domains, idp, clock } = this.deps
    const bound = row.activatedAt !== null || (row.testExpiresAt !== null && row.testExpiresAt.getTime() > clock.now())
    return idp.setDomains(row.logtoConnectorId, bound ? await domains.verifiedDomains(row.orgId) : [])
  }

  private view(row: OrgSsoConnectionRecord): OrgSsoConnectionView {
    const id = encodeURIComponent(row.logtoConnectorId)
    const origin = this.deps.idpOrigin
    const tested = isTested(row)
    return {
      id: row.id,
      protocol: row.protocol,
      name: row.name,
      status: row.activatedAt ? 'active' : tested ? 'tested' : 'draft',
      tested,
      testedAt: row.testedAt,
      activatedAt: row.activatedAt,
      configChangedAt: row.configChangedAt,
      serviceProvider:
        row.protocol === 'oidc'
          ? { redirectUri: `${origin}/callback/${id}` }
          : {
              assertionConsumerServiceUrl: `${origin}/api/authn/single-sign-on/saml/${id}`,
              entityId: `${origin}/enterprise-sso/${id}`
            }
    }
  }
}
