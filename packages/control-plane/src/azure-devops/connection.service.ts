// An organization's Azure DevOps connections (azure-devops-integration.md §3.2-§3.5): verify, connect, replace a secret, mint tokens, and move binding states.
import { createHmac } from 'node:crypto'
import type { Clock } from '../domain/clock.js'
import { OrgId } from '../domain/ids.js'
import { AzureDevOpsOrganizationTaken } from '../persistence/errors.js'
import type {
  AzureDevOpsConnectionRecord,
  AzureDevOpsConnectionRepo,
  AzureDevOpsConnectionSecretStore,
  AzureDevOpsCredentialSource,
  AzureDevOpsDegradedReason,
  AzureDevOpsRepositoryBindingRepo,
  AzureDevOpsVerifiedIdentity
} from '../persistence/ports.js'
import type { SecretCipher } from '../secrets/cipher.js'
import { orgScope } from '../secrets/scope.js'
import {
  AzureDevOpsApiError,
  listRepositories,
  readConnectionData,
  requestAccessToken,
  type AzureDevOpsApiClient,
  type AzureDevOpsRepository
} from './api.js'
import type { AzureDevOpsTokenCache, CachedAzureDevOpsToken } from './token-cache.js'

/** The deployment's Microsoft application (§3.1), the one Setup configures; its home tenant is not needed here. */
export interface AzureDevOpsDeploymentApplication {
  clientId: string
  /** Secret material, never logged or returned. */
  clientSecret: string
}

/** HMAC-SHA256 of the deployment secret under a key derived from the pepper for this purpose alone; never reversible to the secret. */
export function azureDevOpsSecretFingerprint(pepper: string): (secret: string) => string {
  const key = createHmac('sha256', pepper).update('azure-devops-deployment-secret-fingerprint-v1').digest()
  return (secret) => createHmac('sha256', key).update(secret).digest('base64url')
}

/** A refusal the routes answer with its status; `code` is the machine-readable reason. */
export class AzureDevOpsConnectDenied extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 429 | 502,
    readonly code: string
  ) {
    super(message)
    this.name = 'AzureDevOpsConnectDenied'
  }
}

/** What a connect or a replacement proved (§3.2 steps 5 and 6). */
export interface AzureDevOpsVerification {
  identity: AzureDevOpsVerifiedIdentity
  repositories: AzureDevOpsRepository[]
}

export interface AzureDevOpsConnectionServiceDeps {
  connections: AzureDevOpsConnectionRepo
  secrets: AzureDevOpsConnectionSecretStore
  bindings: Pick<AzureDevOpsRepositoryBindingRepo, 'setStateForConnection'>
  cipher: SecretCipher
  clock: Clock
  api: AzureDevOpsApiClient
  tokens: AzureDevOpsTokenCache
  /** Absent ⇒ the deployment has no Microsoft application: only an own application connects. */
  deploymentApplication?: AzureDevOpsDeploymentApplication
  /** After an epoch advanced: re-project every consumer so daemon caches purge (§3.5). */
  onCredentialEpochChanged?: (orgId: string, connection: AzureDevOpsConnectionRecord) => Promise<void> | void
  /** The keyed fingerprint a `deployment` connection keeps instead of the deployment secret (§3.5). */
  secretFingerprint: (secret: string) => string
  log?: { warn(obj: object, msg: string): void; info?(obj: object, msg: string): void }
}

/** The reasons a connection-level verdict leaves; a repository-level one is the binding's own. */
const CONNECTION_REASONS: readonly AzureDevOpsDegradedReason[] = ['secret_rejected', 'access_revoked']

function sameGuid(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase()
}

/** A verification failure as the connect and replace routes answer it. */
function verificationDenied(e: unknown, organization: string): never {
  if (!(e instanceof AzureDevOpsApiError)) throw e
  switch (e.code) {
    case 'SECRET_REJECTED':
      throw new AzureDevOpsConnectDenied(
        'Microsoft rejected the client secret — check the client ID and that the secret has not expired',
        400,
        'secret_rejected'
      )
    case 'ACCESS_REVOKED':
      throw new AzureDevOpsConnectDenied(
        e.status === 401
          ? `the application's service principal is not a member of ${organization} — add it to the organization with the Basic access level`
          : 'the application has no service principal in that tenant — an administrator must consent to it there first',
        409,
        'access_revoked'
      )
    case 'NOT_FOUND':
      throw new AzureDevOpsConnectDenied(
        `no Azure DevOps organization named ${organization}`,
        404,
        'organization_not_found'
      )
    case 'RATE_LIMITED':
      throw new AzureDevOpsConnectDenied(`azure devops: ${e.message}`, 429, 'rate_limited')
    case 'INVALID_REQUEST':
    case 'FORBIDDEN':
      throw new AzureDevOpsConnectDenied(`azure devops: ${e.message}`, 400, 'invalid_request')
    default:
      throw new AzureDevOpsConnectDenied(`azure devops: ${e.message}`, 502, 'azure_devops_unavailable')
  }
}

export class AzureDevOpsConnectionService {
  constructor(private readonly deps: AzureDevOpsConnectionServiceDeps) {}

  /** The deployment application's client ID, which an own-application connect may not reuse (§3.2). */
  get deploymentClientId(): string | undefined {
    return this.deps.deploymentApplication?.clientId
  }

  /** §3.2 steps 5 and 6 without storing: a token at the tenant, connectionData, and a repository list that proves Azure Repos access. */
  async verify(input: {
    organization: string
    tenantId: string
    clientId: string
    clientSecret: string
  }): Promise<AzureDevOpsVerification> {
    const { api } = this.deps
    try {
      const { accessToken } = await requestAccessToken(api, input)
      const data = await readConnectionData(api, accessToken, input.organization)
      const repositories = await listRepositories(api, accessToken, input.organization)
      if (repositories.length === 0) {
        throw new AzureDevOpsConnectDenied(
          `the application's service principal sees no repository in ${input.organization} — give it the Basic access level (Stakeholder reaches no repository) and add it to the Readers or Contributors group of each project agents use`,
          409,
          'no_repository_access'
        )
      }
      return {
        identity: {
          organization: input.organization,
          organizationInstanceId: data.instanceId,
          identityId: data.identityId,
          identityName: data.identityName,
          verifiedAt: new Date(this.deps.clock.now())
        },
        repositories
      }
    } catch (e) {
      if (e instanceof AzureDevOpsConnectDenied) throw e
      return verificationDenied(e, input.organization)
    }
  }

  /** §3.2 "Use your own application instead": verify, refuse a taken organization, seal the secret, store the row. */
  async connectOwnApplication(
    orgId: string,
    input: { organization: string; tenantId: string; clientId: string; clientSecret: string },
    actorUserId?: string
  ): Promise<AzureDevOpsConnectionRecord> {
    if (sameGuid(input.clientId, this.deps.deploymentApplication?.clientId)) {
      throw new AzureDevOpsConnectDenied(
        'that is the deployment’s own Microsoft application — connect with Microsoft instead, or enter an application registered in your tenant',
        400,
        'deployment_application'
      )
    }
    return this.connect(orgId, 'own', input, actorUserId)
  }

  /** The deployment-application connection the Microsoft sign-in flow ends in (§3.2 steps 5 and 6). */
  async connectDeploymentApplication(
    orgId: string,
    input: { organization: string; tenantId: string },
    actorUserId?: string
  ): Promise<AzureDevOpsConnectionRecord> {
    const app = this.deps.deploymentApplication
    if (!app) {
      throw new AzureDevOpsConnectDenied(
        'this deployment has no Microsoft application — use your own application instead',
        409,
        'deployment_application_missing'
      )
    }
    return this.connect(
      orgId,
      'deployment',
      { ...input, clientId: app.clientId, clientSecret: app.clientSecret },
      actorUserId
    )
  }

  /** Manage project access ends here: steps 5 and 6 for an existing `deployment` connection, same identity required, its state recovered. */
  async reverifyDeploymentConnection(orgId: string, connectionId: string): Promise<AzureDevOpsConnectionRecord> {
    const existing = await this.deps.connections.get(orgId, connectionId)
    if (!existing) throw missing()
    const app = this.deps.deploymentApplication
    if (existing.credentialSource !== 'deployment' || !app) {
      throw new AzureDevOpsConnectDenied(
        'this connection does not use the deployment’s Microsoft application',
        409,
        'connection_not_deployment'
      )
    }
    const { identity } = await this.verify({
      organization: existing.organization,
      tenantId: existing.tenantId,
      clientId: app.clientId,
      clientSecret: app.clientSecret
    })
    if (
      !sameGuid(identity.identityId, existing.identityId) ||
      !sameGuid(identity.organizationInstanceId, existing.organizationInstanceId)
    ) {
      throw new AzureDevOpsConnectDenied(
        'the organization now answers with a different identity — disconnect and connect again',
        409,
        'identity_mismatch'
      )
    }
    if (existing.state === 'connected') return existing
    this.deps.tokens.purge(existing.id)
    await this.recover(existing, CONNECTION_REASONS)
    return (await this.deps.connections.get(orgId, connectionId)) ?? existing
  }

  private async connect(
    orgId: string,
    source: AzureDevOpsCredentialSource,
    input: { organization: string; tenantId: string; clientId: string; clientSecret: string },
    actorUserId?: string
  ): Promise<AzureDevOpsConnectionRecord> {
    const { identity } = await this.verify(input)
    const holder = await this.deps.connections.holderOfInstance(identity.organizationInstanceId)
    if (holder !== null && holder !== orgId) throw taken()
    // An own secret is sealed; a deployment connection keeps only a fingerprint, which is how a rotation is recognized (§3.5).
    const credential =
      source === 'own'
        ? { sealedSecret: await this.deps.cipher.seal(input.clientSecret, orgScope(OrgId(orgId))) }
        : { secretFingerprint: this.deps.secretFingerprint(input.clientSecret) }
    try {
      return await this.deps.connections.create({
        orgId,
        ...(actorUserId !== undefined ? { createdByUserId: actorUserId } : {}),
        tenantId: input.tenantId.toLowerCase(),
        credentialSource: source,
        clientId: source === 'own' ? input.clientId.toLowerCase() : null,
        identity,
        credential
      })
    } catch (e) {
      if (e instanceof AzureDevOpsOrganizationTaken) throw taken()
      if (isUniqueViolation(e)) {
        throw new AzureDevOpsConnectDenied(
          'this organization already has a connection with that identity',
          409,
          'connection_exists'
        )
      }
      throw e
    }
  }

  /** §3.5: an own application's new secret must reach the same tenant, client ID and identity; the epoch advances. */
  async replaceOwnSecret(
    orgId: string,
    connectionId: string,
    clientSecret: string
  ): Promise<AzureDevOpsConnectionRecord> {
    const existing = await this.deps.connections.get(orgId, connectionId)
    if (!existing) throw missing()
    if (existing.credentialSource !== 'own' || existing.clientId === null) {
      throw new AzureDevOpsConnectDenied(
        'this connection uses the deployment’s Microsoft application, whose secret is rotated in Setup',
        409,
        'deployment_secret'
      )
    }
    const { identity } = await this.verify({
      organization: existing.organization,
      tenantId: existing.tenantId,
      clientId: existing.clientId,
      clientSecret
    })
    if (
      !sameGuid(identity.identityId, existing.identityId) ||
      !sameGuid(identity.organizationInstanceId, existing.organizationInstanceId)
    ) {
      throw new AzureDevOpsConnectDenied(
        'the new secret signs in as a different identity — disconnect and connect that application instead',
        409,
        'identity_mismatch'
      )
    }
    const sealedSecret = await this.deps.cipher.seal(clientSecret, orgScope(OrgId(orgId)))
    const updated = await this.deps.connections.replaceSecret(orgId, connectionId, identity, sealedSecret)
    if (!updated) throw missing()
    this.deps.tokens.purge(connectionId)
    await this.deps.bindings.setStateForConnection(connectionId, 'ready', null, CONNECTION_REASONS)
    await this.deps.onCredentialEpochChanged?.(orgId, updated)
    return updated
  }

  /** §3.5: a rotated deployment secret reaches every `deployment` connection at boot, each advancing its epoch. */
  async reconcileDeploymentSecret(): Promise<number> {
    const app = this.deps.deploymentApplication
    if (!app) return 0
    let advanced = 0
    const fingerprint = this.deps.secretFingerprint(app.clientSecret)
    for (const connection of await this.deps.connections.listBySource('deployment')) {
      try {
        if (connection.secretFingerprint === fingerprint) continue
        const updated = await this.deps.connections.advanceEpoch(connection.id, fingerprint)
        this.deps.tokens.purge(connection.id)
        if (!updated) continue
        advanced += 1
        await this.deps.onCredentialEpochChanged?.(connection.orgId, updated)
      } catch (err) {
        this.deps.log?.warn(
          { err, connectionId: connection.id },
          'azure devops: re-stamping the deployment secret failed'
        )
      }
    }
    if (advanced > 0) this.deps.log?.info?.({ connections: advanced }, 'azure devops: deployment secret rotated')
    return advanced
  }

  /** The client credentials a connection's tokens are requested with. */
  private async credentialsOf(
    connection: AzureDevOpsConnectionRecord
  ): Promise<{ tenantId: string; clientId: string; clientSecret: string }> {
    if (connection.credentialSource === 'deployment') {
      const app = this.deps.deploymentApplication
      if (!app) {
        throw new AzureDevOpsConnectDenied(
          'the deployment’s Microsoft application is no longer configured',
          409,
          'deployment_application_missing'
        )
      }
      return { tenantId: connection.tenantId, clientId: app.clientId, clientSecret: app.clientSecret }
    }
    const clientSecret = await this.deps.secrets.get(connection.orgId, connection.id)
    if (!clientSecret || !connection.clientId) {
      throw new AzureDevOpsConnectDenied('the connection has no stored client secret', 409, 'secret_missing')
    }
    return { tenantId: connection.tenantId, clientId: connection.clientId, clientSecret }
  }

  /** Drop the connection's cached token so the next request mints a fresh one. */
  purgeToken(connectionId: string): void {
    this.deps.tokens.purge(connectionId)
  }

  /** The connection's cached token (§3.4); a definite refusal degrades the connection and every binding it serves. */
  async accessToken(connection: AzureDevOpsConnectionRecord): Promise<CachedAzureDevOpsToken> {
    const credentials = await this.credentialsOf(connection)
    let token: CachedAzureDevOpsToken
    try {
      token = await this.deps.tokens.get(connection.id, connection.credentialEpoch, () =>
        requestAccessToken(this.deps.api, credentials)
      )
    } catch (e) {
      throw await this.failed(connection, e)
    }
    // A token proves the secret again; access to the organization is proven only by an Azure DevOps answer.
    if (connection.state === 'degraded' && connection.stateReason === 'secret_rejected') {
      await this.recover(connection, ['secret_rejected'])
    }
    return token
  }

  /** One Azure DevOps call under the connection's token: a stale token is retried once, a success recovers degraded state (§3.5). */
  async withApi<T>(connection: AzureDevOpsConnectionRecord, call: (token: string) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      const { token } = await this.accessToken(connection)
      try {
        const result = await call(token)
        if (connection.state === 'degraded') await this.recover(connection, CONNECTION_REASONS)
        return result
      } catch (e) {
        if (e instanceof AzureDevOpsApiError && e.code === 'UNAUTHORIZED' && attempt === 0) {
          this.deps.tokens.purge(connection.id)
          continue
        }
        throw await this.failed(connection, e)
      }
    }
  }

  /** Record a connection-level verdict on the connection and all its bindings; returns the error to rethrow. */
  private async failed(connection: AzureDevOpsConnectionRecord, e: unknown): Promise<unknown> {
    if (!(e instanceof AzureDevOpsApiError)) return e
    const reason: AzureDevOpsDegradedReason | undefined =
      e.code === 'SECRET_REJECTED' ? 'secret_rejected' : e.code === 'ACCESS_REVOKED' ? 'access_revoked' : undefined
    if (reason === undefined) return e
    this.deps.tokens.purge(connection.id)
    try {
      await this.deps.connections.setState(connection.id, 'degraded', reason)
      const degraded = await this.deps.bindings.setStateForConnection(connection.id, 'runtime_degraded', reason)
      this.deps.log?.warn({ connectionId: connection.id, reason, degraded }, 'azure devops: connection degraded')
    } catch (err) {
      this.deps.log?.warn({ err, connectionId: connection.id }, 'azure devops: recording a degraded connection failed')
    }
    return e
  }

  private async recover(
    connection: AzureDevOpsConnectionRecord,
    reasons: readonly AzureDevOpsDegradedReason[]
  ): Promise<void> {
    if (connection.stateReason !== null && !reasons.includes(connection.stateReason)) return
    try {
      await this.deps.connections.setState(connection.id, 'connected', null)
      await this.deps.bindings.setStateForConnection(connection.id, 'ready', null, reasons)
    } catch (err) {
      this.deps.log?.warn({ err, connectionId: connection.id }, 'azure devops: recording a recovered connection failed')
    }
  }

  /** Remove the connection and its unreferenced bindings; refused while a workspace or grant still names one. */
  async disconnect(orgId: string, connectionId: string): Promise<'removed' | 'referenced' | 'missing'> {
    const outcome = await this.deps.connections.remove(orgId, connectionId)
    if (outcome === 'removed') this.deps.tokens.purge(connectionId)
    return outcome
  }
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'code' in e && (e as { code: unknown }).code === 'P2002'
}

function taken(): AzureDevOpsConnectDenied {
  return new AzureDevOpsConnectDenied(
    'this Azure DevOps organization is already connected to another organization on this deployment',
    409,
    'AZURE_DEVOPS_ORGANIZATION_TAKEN'
  )
}

function missing(): AzureDevOpsConnectDenied {
  return new AzureDevOpsConnectDenied('azure devops connection not found', 404, 'connection_missing')
}
