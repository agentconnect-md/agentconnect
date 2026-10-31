// Agents' dedicated GitHub Apps: created through GitHub's manifest flow, synced from their own setup redirect (§Dedicated Apps).
import { randomUUID } from 'node:crypto'
import type { Clock, TimerHandle } from '../domain/clock.js'
import { OrgId } from '../domain/ids.js'
import type {
  GithubAppRecord,
  GithubAppRepo,
  GithubAppSecretStore,
  GithubInstallationFacts,
  GithubInstallationRecord,
  GithubInstallationRepo,
  GithubInstallStateStore
} from '../persistence/ports.js'
import { githubRequest, githubRequestPage, mintAppJwt, type FetchLike, type GithubPage } from './api.js'
import type { GithubAppRegistry } from './app-registry.js'
import { githubAppConfigFromParts, type GithubAppConfig } from './config.js'
import { deriveManifestStateKey, mintManifestState, verifyManifestState } from './install-state.js'

interface GhManifestConversion {
  id: number
  slug: string
  client_id?: string
  pem: string
}

interface GhInstallation {
  id: number
  account: { login: string; type: string } | null
  repository_selection: string
  suspended_at: string | null
  permissions?: Record<string, string>
}

/** What a dedicated App may do: the agent-facing subset of the deployment App's permissions. */
export const DEDICATED_APP_PERMISSIONS = {
  metadata: 'read',
  contents: 'write',
  issues: 'write',
  pull_requests: 'write',
  actions: 'write',
  checks: 'write',
  workflows: 'write',
  deployments: 'read'
} as const

const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/
/** GitHub App names are at most 34 characters. */
const APP_NAME_MAX = 34
/** A setup redirect is unauthenticated, so one App's roster is pulled at most this often from it. */
const SETUP_SYNC_INTERVAL_MS = 10_000
/** A retired App outlives the hour a token minted under it stays valid. */
const RETIRED_APP_GRACE_MS = 60 * 60 * 1000
const RETIRED_APP_REAP_INTERVAL_MS = 10 * 60 * 1000
const RETIRED_APP_REAP_LIMIT = 100

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
  /** One-shot nonces, shared with the deployment App's install states. */
  states: GithubInstallStateStore
  registry: Pick<GithubAppRegistry, 'invalidate'>
  botUserId: (slug: string) => Promise<number>
  pepper: string
  clock: Clock
  /** The CP's public origin: GitHub redirects the browser to its `/v1` callbacks. */
  publicCpUrl: string
  /** The console origin, shown as the App's homepage. */
  webAppUrl?: string
  /** Per-installation cache drop after the roster changed. */
  onInstallationChanged?: (installationId: bigint, orgId: OrgId) => void | Promise<void>
  /** The org's set of dedicated Apps changed (compiled hook rules name their bots). */
  onAppsChanged?: (orgId: OrgId) => void | Promise<void>
  log?: { warn(obj: unknown, msg?: string): void }
  fetchImpl?: FetchLike
  baseUrl?: string
}

export class GithubAppsService {
  private readonly stateKey: Buffer
  private readonly lastSetupSync = new Map<string, number>()
  private timer: TimerHandle | undefined
  private stopped = false

  constructor(private readonly deps: GithubAppsServiceDeps) {
    this.stateKey = deriveManifestStateKey(deps.pepper)
  }

  getForAgent(orgId: OrgId, agentId: string): Promise<GithubAppRecord | null> {
    return this.deps.apps.getForAgent(orgId, agentId)
  }

  /** The form GitHub's "create App from manifest" page accepts, bound to this agent by a signed one-shot state. */
  async startManifest(
    orgId: OrgId,
    agent: { id: string; name: string },
    owner: string | undefined
  ): Promise<{ action: string; manifest: Record<string, unknown> }> {
    if (owner !== undefined && !GITHUB_LOGIN.test(owner)) {
      throw new GithubAppRegistrationError('GitHub organization login is invalid')
    }
    const githubAppId = randomUUID()
    const minted = mintManifestState(this.stateKey, { orgId, agentId: agent.id, githubAppId }, this.deps.clock)
    await this.deps.states.put(minted.nonce, orgId, minted.expiresAt)
    const action = new URL(
      owner ? `https://github.com/organizations/${owner}/settings/apps/new` : 'https://github.com/settings/apps/new'
    )
    action.searchParams.set('state', minted.state)
    const cp = this.deps.publicCpUrl.replace(/\/$/, '')
    const manifest = {
      name: appName(agent.name, owner),
      url: this.deps.webAppUrl ?? cp,
      redirect_url: `${cp}/v1/github/apps/manifest/callback`,
      setup_url: `${cp}/v1/github/apps/${githubAppId}/setup/callback`,
      setup_on_update: true,
      public: false,
      default_permissions: DEDICATED_APP_PERMISSIONS
    }
    return { action: action.toString(), manifest }
  }

  /** GitHub's redirect after "Create": convert the one-time code, bind the App to its agent, return where to install it. */
  async completeManifest(
    state: string,
    code: string
  ): Promise<{ app: GithubAppRecord; installUrl: string } | { orphanedSlug: string } | null> {
    const parsed = verifyManifestState(this.stateKey, state, this.deps.clock)
    if (!parsed || !(await this.deps.states.consume(parsed.nonce))) return null
    const orgId = OrgId(parsed.orgId)
    const converted = await githubRequest<GhManifestConversion>(
      `/app-manifests/${encodeURIComponent(code)}/conversions`,
      { method: 'POST', auth: null, fetchImpl: this.deps.fetchImpl, baseUrl: this.deps.baseUrl }
    )
    const privateKeyB64 = Buffer.from(converted.pem, 'utf8').toString('base64')
    // Parse the key before anything is stored, so a malformed answer leaves no row behind.
    githubAppConfigFromParts({ appId: converted.id, slug: converted.slug, privateKeyB64 })
    const botUserId = await this.deps.botUserId(converted.slug)
    const app = await this.deps.apps.createForAgent({
      id: parsed.githubAppId,
      orgId,
      agentId: parsed.agentId,
      appId: BigInt(converted.id),
      slug: converted.slug,
      clientId: converted.client_id ?? null,
      botUserId: BigInt(botUserId)
    })
    // The agent was deleted or got another App meanwhile: the new App exists on GitHub but nothing here uses it.
    if (!app) return { orphanedSlug: converted.slug }
    try {
      await this.deps.secrets.put(orgId, app.id, privateKeyB64)
    } catch (e) {
      await this.deps.apps.delete(orgId, app.id)
      throw e
    }
    this.deps.registry.invalidate(app.id)
    await this.deps.onAppsChanged?.(orgId)
    return { app, installUrl: `https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new` }
  }

  /** GitHub's redirect after an install or update of the App: re-pull its roster. The App id names one org. */
  async completeSetup(githubAppId: string): Promise<GithubAppRecord | null> {
    const app = await this.deps.apps.getUnscoped(githubAppId)
    if (!app) return null
    const now = this.deps.clock.now()
    if (now - (this.lastSetupSync.get(app.id) ?? 0) >= SETUP_SYNC_INTERVAL_MS) {
      this.lastSetupSync.set(app.id, now)
      await this.sync(app.orgId, app.id)
    }
    return app
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

  /** The agent drops its App and falls back to the deployment App; the App stays, retired, to close its own Checks. */
  remove(orgId: OrgId, id: string): Promise<boolean> {
    return this.deps.apps.retire(orgId, id, new Date(this.deps.clock.now()))
  }

  /** Deletes retired Apps once their grace has passed and every Check they created is finished for good. */
  async reap(): Promise<number> {
    const reaped = await this.deps.apps.reapRetired(
      new Date(this.deps.clock.now() - RETIRED_APP_GRACE_MS),
      RETIRED_APP_REAP_LIMIT
    )
    for (const app of reaped) {
      this.deps.registry.invalidate(app.id)
      this.lastSetupSync.delete(app.id)
      for (const installationId of app.installationIds) {
        await this.deps.onInstallationChanged?.(installationId, app.orgId)
      }
      await this.deps.onAppsChanged?.(app.orgId)
    }
    return reaped.length
  }

  /** Arm the periodic reap; armed by the container's background start, never in tests. */
  start(): void {
    this.stopped = false
    this.arm()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) this.deps.clock.clearTimeout(this.timer)
    this.timer = undefined
  }

  private arm(): void {
    if (this.stopped) return
    this.timer = this.deps.clock.setTimeout(() => {
      this.timer = undefined
      void this.reap()
        .catch((err: unknown) => this.deps.log?.warn({ err }, 'github app reap failed'))
        .finally(() => this.arm())
    }, RETIRED_APP_REAP_INTERVAL_MS)
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

/** `<agent>-<owner>`, trimmed to GitHub's name limit; GitHub lets the user edit it before creating. */
function appName(agentName: string, owner: string | undefined): string {
  const base = owner ? `${agentName}-${owner}` : agentName
  return base.slice(0, APP_NAME_MAX)
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
