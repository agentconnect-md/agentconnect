/**
 * Organization-registered GitHub Apps (github-app-git-credentials.md §Dedicated Apps).
 *
 * Registration verifies the key against GitHub (`GET /app` with the App's own
 * JWT must name the given App), records the bot user id behind `<slug>[bot]`,
 * stores the sealed key and claims the App's installations for the org. The
 * App has no webhook: events keep arriving through the deployment App, so the
 * installation roster is refreshed by sync, never by a doorbell.
 */
import { OrgId } from '../domain/ids.js'
import type {
  GithubAppRecord,
  GithubAppRepo,
  GithubAppSecretStore,
  GithubInstallationFacts,
  GithubInstallationRecord,
  GithubInstallationRepo
} from '../persistence/ports.js'
import { githubRequest, githubRequestPage, mintAppJwt, type FetchLike, type GithubPage } from './api.js'
import type { GithubAppRegistry } from './app-registry.js'
import { githubAppConfigFromParts, type GithubAppConfig } from './config.js'

interface GhApp {
  id: number
  slug: string
  client_id?: string
}

interface GhInstallation {
  id: number
  account: { login: string; type: string } | null
  repository_selection: string
  suspended_at: string | null
  permissions?: Record<string, string>
}

export class GithubAppRegistrationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GithubAppRegistrationError'
  }
}

export interface GithubAppsServiceDeps {
  apps: GithubAppRepo
  secrets: GithubAppSecretStore
  installations: Pick<GithubInstallationRepo, 'upsertFromGithub' | 'listClaimsForOrg' | 'markRevokedByInstallationId'>
  registry: Pick<GithubAppRegistry, 'invalidate'>
  /** The deployment App's id: registering it again as a dedicated App is a mistake. */
  deploymentAppId: number
  botUserId: (slug: string) => Promise<number>
  /** Per-installation cache drop after the roster changed. */
  onInstallationChanged?: (installationId: bigint, orgId: OrgId) => void | Promise<void>
  fetchImpl?: FetchLike
  baseUrl?: string
}

export class GithubAppsService {
  constructor(private readonly deps: GithubAppsServiceDeps) {}

  list(orgId: OrgId): Promise<GithubAppRecord[]> {
    return this.deps.apps.listForOrg(orgId)
  }

  get(orgId: OrgId, id: string): Promise<GithubAppRecord | null> {
    return this.deps.apps.get(orgId, id)
  }

  async register(
    orgId: OrgId,
    input: { appId: number; clientId?: string | null; privateKeyB64: string }
  ): Promise<{ app: GithubAppRecord; installations: GithubInstallationRecord[] }> {
    if (input.appId === this.deps.deploymentAppId) {
      throw new GithubAppRegistrationError('this is the deployment GitHub App; agents use it by default')
    }
    let cfg: GithubAppConfig
    try {
      // The slug is not known before GitHub answers; the JWT needs only the issuer and key.
      cfg = githubAppConfigFromParts({ ...input, slug: '' })
    } catch (e) {
      throw new GithubAppRegistrationError((e as Error).message)
    }
    const app = await githubRequest<GhApp>('/app', {
      auth: await mintAppJwt(cfg),
      fetchImpl: this.deps.fetchImpl,
      baseUrl: this.deps.baseUrl
    })
    if (app.id !== input.appId) {
      throw new GithubAppRegistrationError(`the private key belongs to GitHub App ${app.id}, not ${input.appId}`)
    }
    const botUserId = await this.deps.botUserId(app.slug)
    const row = await this.deps.apps.create({
      orgId,
      appId: BigInt(app.id),
      slug: app.slug,
      clientId: input.clientId ?? app.client_id ?? null,
      botUserId: BigInt(botUserId)
    })
    await this.deps.secrets.put(orgId, row.id, input.privateKeyB64)
    this.deps.registry.invalidate(row.id)
    const installations = await this.syncInstallations(row, { ...cfg, slug: app.slug })
    return { app: row, installations }
  }

  /** Re-pull the App's installation roster: new installations are claimed, missing ones marked revoked. */
  async sync(orgId: OrgId, id: string): Promise<GithubInstallationRecord[] | null> {
    const app = await this.deps.apps.get(orgId, id)
    if (!app) return null
    const privateKeyB64 = await this.deps.secrets.get(orgId, app.id)
    if (!privateKeyB64) throw new GithubAppRegistrationError('the private key of this App is missing')
    const cfg = githubAppConfigFromParts({
      appId: Number(app.appId),
      slug: app.slug,
      clientId: app.clientId,
      privateKeyB64
    })
    return this.syncInstallations(app, cfg)
  }

  /** Installations claimed for an App. */
  async installationsOf(orgId: OrgId, id: string): Promise<GithubInstallationRecord[]> {
    return (await this.deps.installations.listClaimsForOrg(orgId)).filter(
      (row) => row.githubAppId === id && row.revokedAt === null
    )
  }

  async delete(orgId: OrgId, id: string): Promise<boolean> {
    const claimed = await this.installationsOf(orgId, id)
    const deleted = await this.deps.apps.delete(orgId, id)
    if (!deleted) return false
    this.deps.registry.invalidate(id)
    for (const row of claimed) await this.deps.onInstallationChanged?.(row.installationId, orgId)
    return true
  }

  private async syncInstallations(app: GithubAppRecord, cfg: GithubAppConfig): Promise<GithubInstallationRecord[]> {
    const live: GithubInstallationRecord[] = []
    const seen = new Set<bigint>()
    let path: string | null = '/app/installations?per_page=100'
    while (path) {
      const page: GithubPage<GhInstallation[]> = await githubRequestPage<GhInstallation[]>(path, {
        auth: await mintAppJwt(cfg),
        fetchImpl: this.deps.fetchImpl,
        baseUrl: this.deps.baseUrl
      })
      for (const ins of page.data) {
        const facts = toFacts(ins)
        seen.add(facts.installationId)
        live.push(await this.deps.installations.upsertFromGithub(app.orgId, facts, app.id))
        await this.deps.onInstallationChanged?.(facts.installationId, app.orgId)
      }
      path = page.nextPath ?? null
    }
    const known = (await this.deps.installations.listClaimsForOrg(app.orgId)).filter(
      (row) => row.githubAppId === app.id
    )
    for (const row of known) {
      if (seen.has(row.installationId) || row.revokedAt !== null) continue
      await this.deps.installations.markRevokedByInstallationId(row.installationId)
      await this.deps.onInstallationChanged?.(row.installationId, app.orgId)
    }
    return live
  }
}

function toFacts(ins: GhInstallation): GithubInstallationFacts {
  return {
    installationId: BigInt(ins.id),
    accountLogin: ins.account?.login ?? '',
    accountType: ins.account?.type ?? 'User',
    repositorySelection: ins.repository_selection,
    suspendedAt: ins.suspended_at ? new Date(ins.suspended_at) : null,
    permissions: ins.permissions ?? {}
  }
}
