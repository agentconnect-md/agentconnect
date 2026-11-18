/** An organization's SSO connection: configure, test, activate (organization-sso.md §3, §4.1). The row is the desired state; the identity service follows it. */
import { createHash, randomBytes } from 'node:crypto'
import type { Clock } from '../domain/clock.js'
import { LogtoApiError } from '../github/logto-identity.js'
import type { OrgSsoConnectionRecord, OrgSsoConnectionRepo, OrgSsoProtocol } from '../persistence/ports.js'
import type { OrgSsoDomainService, OrgDomainCheck, OrgDomainView } from './domains.js'
import { orgConnectorName, type OrgSsoIdp } from './idp.js'

export const ORG_SSO_TEST_TTL_MS = 10 * 60 * 1000

export type OrgSsoConnectionInput =
  | { protocol: 'oidc'; name: string; issuer: string; clientId: string; clientSecret?: string; scope?: string }
  | {
      protocol: 'saml'
      name: string
      metadataUrl?: string
      metadata?: string
      attributeMapping?: Record<string, string>
    }

/** What the owner enters at the identity provider. */
export type OrgSsoServiceProvider = { redirectUri: string } | { assertionConsumerServiceUrl: string; entityId: string }

/** The saved settings as the identity service holds them; the client secret is reported only by its presence. */
export type OrgSsoSettings =
  | { issuer: string; clientId: string; scope: string; hasClientSecret: boolean }
  | {
      metadataUrl: string | null
      metadata: string | null
      attributeMapping: { id?: string; email?: string; name?: string }
    }

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
  /** Set while members inside the verified domains must reach the organization from a session signed in through the connection (§4.5). */
  enforcedAt: Date | null
  configChangedAt: Date
  serviceProvider: OrgSsoServiceProvider
  /** Read from the identity service only for an owner's `get`; null otherwise and when the connector is gone. */
  settings: OrgSsoSettings | null
  /** The connector is gone from the identity service; set only where `settings` was read. */
  needsConfiguration: boolean
}

/** `none`: no connection. `needs_configuration`: its connector is gone from the identity service. */
export type OrgSsoConnectionProblem = 'none' | 'needs_configuration'

const isTested = (row: OrgSsoConnectionRecord): boolean =>
  row.testedAt !== null && row.testedAt.getTime() > row.configChangedAt.getTime()

const hashNonce = (nonce: string): string => createHash('sha256').update(nonce).digest('hex')

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)

function settingsOf(protocol: OrgSsoProtocol, config: Record<string, unknown>): OrgSsoSettings {
  if (protocol === 'oidc') {
    return {
      issuer: str(config.issuer) ?? '',
      clientId: str(config.clientId) ?? '',
      scope: str(config.scope) ?? '',
      hasClientSecret: Boolean(str(config.clientSecret))
    }
  }
  const mapping =
    config.attributeMapping && typeof config.attributeMapping === 'object'
      ? (config.attributeMapping as Record<string, unknown>)
      : {}
  const attributeMapping: { id?: string; email?: string; name?: string } = {}
  for (const key of ['id', 'email', 'name'] as const) {
    const value = str(mapping[key])
    if (value) attributeMapping[key] = value
  }
  return { metadataUrl: str(config.metadataUrl), metadata: str(config.metadata), attributeMapping }
}

// The address is taken as the provider sends it, marked verified or not: the verified domains bound what it may be (§4.1).
function connectorConfig(input: OrgSsoConnectionInput, clientSecret?: string): Record<string, unknown> {
  if (input.protocol === 'oidc') {
    const { issuer, clientId, scope } = input
    return { issuer, clientId, clientSecret, ...(scope ? { scope } : {}), trustUnverifiedEmail: true }
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

  /** The name each organization gave the connection behind these connectors, keyed by connector id. */
  async namesByConnector(connectorIds: readonly string[]): Promise<Map<string, string>> {
    const rows = await this.deps.connections.findByConnectorIds(connectorIds)
    return new Map(rows.map((row) => [row.logtoConnectorId, row.name]))
  }

  /** `withSettings` reads the saved settings back from the identity service. */
  async get(orgId: string, options: { withSettings?: boolean } = {}): Promise<OrgSsoConnectionView | null> {
    const row = await this.deps.connections.getForOrg(orgId)
    if (!row) return null
    if (!options.withSettings) return this.view(row)
    const stored = await this.deps.idp.connector(row.logtoConnectorId)
    return this.view(row, stored === 'missing' ? 'missing' : settingsOf(row.protocol, stored.config))
  }

  /** Create the connector ahead of the first save so the owner can register the service-provider values first; nothing else changes. */
  async prepare(orgId: string, protocol: OrgSsoProtocol): Promise<OrgSsoServiceProvider | 'protocol_mismatch'> {
    const row = await this.deps.connections.getForOrg(orgId)
    // A protocol change would delete the connection's connector, so it waits for an explicit removal.
    if (row && row.protocol !== protocol) return 'protocol_mismatch'
    const connectorId = await this.deps.idp.ensureConnector({
      connectorName: orgConnectorName(orgId),
      protocol,
      displayName: row?.name ?? 'SSO'
    })
    return this.serviceProvider(protocol, connectorId)
  }

  /** Create or change the settings. Throws `OrgSsoIdpRejected` with the identity service's reason. */
  async save(
    orgId: string,
    input: OrgSsoConnectionInput,
    actorUserId: string
  ): Promise<OrgSsoConnectionView | 'secret_required'> {
    const { idp, connections, clock } = this.deps
    let clientSecret = input.protocol === 'oidc' ? input.clientSecret : undefined
    if (input.protocol === 'oidc' && !clientSecret) {
      clientSecret = await this.keptSecret(orgId, input.issuer)
      if (!clientSecret) return 'secret_required'
    }
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
    const configured = await idp.configure(connectorId, {
      displayName: input.name,
      config: connectorConfig(input, clientSecret)
    })
    if (configured === 'missing') throw new LogtoApiError('the sso connector disappeared while it was saved', 0, true)
    await this.settle(row)
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
    const row = await connections.activate(orgId, new Date(clock.now()), actorUserId)
    if (!row) return 'none'
    if ((await this.sync(row)) === 'missing') {
      await connections.deactivate(orgId, new Date(clock.now()), actorUserId)
      return 'needs_configuration'
    }
    return this.view(row)
  }

  /** Enforce an active connection per session (§4.5): an owner inside the domains, signed in through it now, shows an owner can get in under the rule. */
  async enforce(
    orgId: string,
    actorUserId: string,
    actor: { subject: string | null; signInConnectorId: string | null }
  ): Promise<OrgSsoConnectionView | 'none' | 'inactive' | 'outside_domains' | 'sign_in_required'> {
    const { connections, domains, idp, clock } = this.deps
    const current = await connections.getForOrg(orgId)
    if (!current) return 'none'
    if (current.activatedAt === null) return 'inactive'
    const email = actor.subject === null ? null : ((await idp.account(actor.subject))?.primaryEmail ?? null)
    const domain = email === null ? null : email.slice(email.lastIndexOf('@') + 1).toLowerCase()
    if (domain === null || !(await domains.verifiedDomains(orgId)).includes(domain)) return 'outside_domains'
    if (actor.signInConnectorId !== current.logtoConnectorId) return 'sign_in_required'
    const row = await connections.enforce(orgId, new Date(clock.now()), actorUserId)
    return row ? this.view(row) : 'inactive'
  }

  async stopEnforcing(orgId: string, actorUserId: string): Promise<OrgSsoConnectionView | null> {
    const row = await this.deps.connections.stopEnforcing(orgId, actorUserId)
    return row ? this.view(row) : null
  }

  /** Lifts the restriction on the organization's domains, an open test window's and the enforcement included; people already linked can still sign in through the connection. */
  async deactivate(orgId: string, actorUserId: string): Promise<OrgSsoConnectionView | null> {
    const { connections, clock } = this.deps
    const row = await connections.deactivate(orgId, new Date(clock.now()), actorUserId)
    if (!row) return null
    await this.settle(row)
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

  /** The background pass: close test windows that ended, by time or by a change whose unbinding did not complete, and unbind what they bound. */
  async sweep(): Promise<void> {
    const { connections, clock, log } = this.deps
    for (const row of await connections.listEndedTests(new Date(clock.now()))) {
      await this.closeTestWindow(row).catch((err: unknown) =>
        log?.warn({ err, connectionId: row.id }, 'org sso: could not close a test window')
      )
    }
  }

  /** The stored secret, when it may carry over to a save that leaves it out. */
  private async keptSecret(orgId: string, issuer: string): Promise<string | undefined> {
    const row = await this.deps.connections.getForOrg(orgId)
    if (row?.protocol !== 'oidc') return undefined
    const stored = await this.deps.idp.connector(row.logtoConnectorId)
    if (stored === 'missing') return undefined
    const secret = str(stored.config.clientSecret)
    // The identity service sends the secret to the issuer's token endpoint, so a kept secret must not follow a changed issuer.
    if (!secret || str(stored.config.issuer) !== issuer) return undefined
    return secret
  }

  /** Bring the connector's domains in line with the row, closing a test window the row has ended. */
  private async settle(row: OrgSsoConnectionRecord): Promise<void> {
    if (row.testExpiresAt !== null && row.testExpiresAt.getTime() <= this.deps.clock.now()) {
      await this.closeTestWindow(row)
    } else {
      await this.sync(row)
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

  private serviceProvider(protocol: OrgSsoProtocol, connectorId: string): OrgSsoServiceProvider {
    const id = encodeURIComponent(connectorId)
    const origin = this.deps.idpOrigin
    return protocol === 'oidc'
      ? { redirectUri: `${origin}/callback/${id}` }
      : {
          assertionConsumerServiceUrl: `${origin}/api/authn/single-sign-on/saml/${id}`,
          entityId: `${origin}/enterprise-sso/${id}`
        }
  }

  private view(row: OrgSsoConnectionRecord, settings: OrgSsoSettings | 'missing' | null = null): OrgSsoConnectionView {
    const tested = isTested(row)
    return {
      id: row.id,
      protocol: row.protocol,
      name: row.name,
      status: row.activatedAt ? 'active' : tested ? 'tested' : 'draft',
      tested,
      testedAt: row.testedAt,
      activatedAt: row.activatedAt,
      enforcedAt: row.enforcedAt,
      configChangedAt: row.configChangedAt,
      serviceProvider: this.serviceProvider(row.protocol, row.logtoConnectorId),
      settings: settings === 'missing' ? null : settings,
      needsConfiguration: settings === 'missing'
    }
  }
}
