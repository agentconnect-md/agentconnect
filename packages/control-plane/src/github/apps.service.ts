// Organization GitHub Apps: created through GitHub's manifest flow, one agent at a time, synced from their own setup redirect and webhook (§Organization GitHub Apps).
import { randomUUID } from 'node:crypto'
import type { Clock, TimerHandle } from '../domain/clock.js'
import { OrgId } from '../domain/ids.js'
import type {
  AgentRecord,
  GithubAppRecord,
  GithubAppRepo,
  GithubAppSecretStore,
  GithubAppWebhook,
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
  webhook_secret?: string | null
}

interface GhInstallation {
  id: number
  account: { login: string; type: string } | null
  repository_selection: string
  suspended_at: string | null
  permissions?: Record<string, string>
}

/** What an organization App may do: the agent-facing subset of the built-in App's permissions. */
export const ORG_APP_PERMISSIONS = {
  metadata: 'read',
  contents: 'write',
  issues: 'write',
  pull_requests: 'write',
  actions: 'write',
  checks: 'write',
  workflows: 'write',
  deployments: 'read'
} as const

/** The built-in App's events (Setup's manifest), so an agent's hooks fire the same through either. */
export const ORG_APP_EVENTS = [
  'push',
  'issues',
  'issue_comment',
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'check_run',
  'check_suite',
  'workflow_run',
  'deployment',
  'deployment_status',
  'release',
  'repository'
] as const

/** GitHub App names are at most 34 characters. */
const APP_NAME_MAX = 34
/** A setup redirect is unauthenticated, so one App's roster is pulled at most this often from it. */
const SETUP_SYNC_INTERVAL_MS = 10_000

export class GithubAppRegistrationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GithubAppRegistrationError'
  }
}

/** One thing the agent works on through GitHub, and whether an App's installations reach it. */
export interface GithubAppCoverageItem {
  /** `owner/repo`, or an account login for installation-wide grants and hooks. */
  target: string
  kind: 'workspace' | 'repository' | 'review' | 'installation'
  covered: boolean
}

/** Everything an agent works on through GitHub: repositories by name, and whole installations by account. */
export interface AgentGithubScope {
  repositories: Array<{ fullName: string; kind: 'workspace' | 'repository' | 'review' }>
  accounts: Array<{ login: string; kind: 'installation' | 'review' }>
}

export type GithubAppSwitchResult =
  | { ok: true }
  | { ok: false; reason: 'not_covered'; coverage: GithubAppCoverageItem[] }
  | { ok: false; reason: 'app_in_use' | 'agent_changed' | 'unknown_app' }

export interface GithubAppsServiceDeps {
  apps: GithubAppRepo
  secrets: GithubAppSecretStore
  installations: Pick<
    GithubInstallationRepo,
    'upsertFromGithub' | 'listClaimsForOrg' | 'markRevokedByInstallationId' | 'liveByOrgAndAccount'
  >
  /** One-shot nonces, shared with the built-in App's install states. */
  states: GithubInstallStateStore
  registry: Pick<GithubAppRegistry, 'invalidate'>
  botUserId: (slug: string) => Promise<number>
  /** What the agent works on through GitHub; the coverage check and the App's owner read it. */
  agentScope: (agent: AgentRecord) => Promise<AgentGithubScope>
  /** Whether a live installation reaches one repository (selected installations are asked). */
  covers: (installation: GithubInstallationRecord, owner: string, repo: string) => Promise<boolean>
  pepper: string
  clock: Clock
  /** The CP's public origin: GitHub redirects the browser to its `/v1` callbacks. */
  publicCpUrl: string
  /** The console origin, shown as the App's homepage. */
  webAppUrl?: string
  /** The relay's public HTTP origin; an HTTPS one gets the App a webhook. */
  publicRelayUrl?: string
  /** Pushes an App's webhook secret to the relays, or withdraws it. */
  webhooks?: { assign(webhook: GithubAppWebhook): void; unassign(githubAppId: string): void }
  /** Per-installation cache drop after the roster changed. */
  onInstallationChanged?: (installationId: bigint, orgId: OrgId) => void | Promise<void>
  /** The org's Apps or an agent's App changed: compiled hook rules name each agent's App. */
  onAppsChanged?: (orgId: OrgId) => void | Promise<void>
  log?: { warn(obj: unknown, msg?: string): void }
  fetchImpl?: FetchLike
  baseUrl?: string
}

export class GithubAppsService {
  private readonly stateKey: Buffer
  private readonly lastSetupSync = new Map<string, number>()
  private readonly trailingSync = new Map<string, TimerHandle>()
  private stopped = false

  constructor(private readonly deps: GithubAppsServiceDeps) {
    this.stateKey = deriveManifestStateKey(deps.pepper)
  }

  list(orgId: OrgId): Promise<GithubAppRecord[]> {
    return this.deps.apps.listForOrg(orgId)
  }

  get(orgId: OrgId, id: string): Promise<GithubAppRecord | null> {
    return this.deps.apps.get(orgId, id)
  }

  /** The form GitHub's "create App from manifest" page accepts, owned by the account the agent's repositories live on. */
  async startManifest(
    orgId: OrgId,
    agent: AgentRecord
  ): Promise<{ action: string; manifest: Record<string, unknown> }> {
    const scope = await this.deps.agentScope(agent)
    const accounts = [
      ...new Set(
        [...scope.repositories.map((r) => r.fullName.split('/')[0]!), ...scope.accounts.map((a) => a.login)].map((l) =>
          l.toLowerCase()
        )
      )
    ]
    const owner = accounts[0]
    if (!owner) throw new GithubAppRegistrationError('this agent works on no GitHub repository yet')
    const githubAppId = randomUUID()
    const minted = mintManifestState(this.stateKey, { orgId, agentId: agent.id, githubAppId }, this.deps.clock)
    await this.deps.states.put(minted.nonce, orgId, minted.expiresAt)
    // An organization owner's page; a personal account's page when that is where the repositories live.
    const action = new URL(
      (await this.isOrganization(orgId, owner))
        ? `https://github.com/organizations/${owner}/settings/apps/new`
        : 'https://github.com/settings/apps/new'
    )
    action.searchParams.set('state', minted.state)
    const cp = this.deps.publicCpUrl.replace(/\/$/, '')
    const relay = this.deps.publicRelayUrl?.replace(/\/$/, '')
    const manifest = {
      name: appName(agent.name, owner),
      url: this.deps.webAppUrl ?? cp,
      redirect_url: `${cp}/v1/github/apps/manifest/callback`,
      // The agent rides as a path segment, which GitHub keeps when it appends its own query, so the browser returns to it.
      setup_url: `${cp}/v1/github/apps/${githubAppId}/setup/callback/${agent.id}`,
      setup_on_update: true,
      // A private App installs only on its owner, so an agent working across accounts needs a public one.
      public: accounts.length > 1,
      // GitHub delivers only to HTTPS; the same URL as the built-in App, told apart by the App id header.
      ...(relay && new URL(relay).protocol === 'https:'
        ? { hook_attributes: { url: `${relay}/webhooks/github`, active: true }, default_events: [...ORG_APP_EVENTS] }
        : {}),
      default_permissions: ORG_APP_PERMISSIONS
    }
    return { action: action.toString(), manifest }
  }

  /** GitHub's redirect after "Create": convert the one-time code into a free App of the org and say where to install it. */
  async completeManifest(
    state: string,
    code: string
  ): Promise<{ app: GithubAppRecord; agentId: string; installUrl: string } | null> {
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
    const app = await this.deps.apps.create({
      id: parsed.githubAppId,
      orgId,
      appId: BigInt(converted.id),
      slug: converted.slug,
      clientId: converted.client_id ?? null,
      botUserId: BigInt(botUserId)
    })
    const webhookSecret = converted.webhook_secret || undefined
    try {
      await this.deps.secrets.put(orgId, app.id, privateKeyB64, webhookSecret)
    } catch (e) {
      await this.deps.apps.deleteFree(orgId, app.id)
      throw e
    }
    if (webhookSecret) this.deps.webhooks?.assign({ githubAppId: app.id, appId: app.appId, webhookSecret })
    this.deps.registry.invalidate(app.id)
    await this.deps.onAppsChanged?.(orgId)
    return {
      app,
      agentId: parsed.agentId,
      installUrl: `https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new`
    }
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

  /** A verified installation event from the App's own webhook: re-pull its roster, deferred (never dropped) inside the throttle window. */
  async syncFromWebhook(appId: bigint): Promise<void> {
    if (this.stopped) return
    const app = await this.deps.apps.getByAppId(appId)
    if (!app) return
    const last = this.lastSetupSync.get(app.id)
    const waitMs = last === undefined ? 0 : SETUP_SYNC_INTERVAL_MS - (this.deps.clock.now() - last)
    if (waitMs > 0) {
      // GitHub sends most installation transitions once, so the last one inside the window still converges.
      if (!this.trailingSync.has(app.id)) {
        this.trailingSync.set(
          app.id,
          this.deps.clock.setTimeout(() => {
            this.trailingSync.delete(app.id)
            void this.syncFromWebhook(appId).catch((err: unknown) =>
              this.deps.log?.warn({ err, githubAppId: app.id }, 'github app webhook sync failed')
            )
          }, waitMs)
        )
      }
      return
    }
    this.lastSetupSync.set(app.id, this.deps.clock.now())
    await this.sync(app.orgId, app.id)
  }

  /** Every App's webhook secret to one relay, after it (re)registers. */
  async replayWebhooksTo(send: (webhook: GithubAppWebhook) => void): Promise<void> {
    for (const webhook of await this.deps.secrets.listWebhooks()) send(webhook)
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

  /** Which of the agent's repositories and accounts `to` (null ⇒ built-in) reaches. */
  async coverage(agent: AgentRecord, to: string | null): Promise<GithubAppCoverageItem[]> {
    const scope = await this.deps.agentScope(agent)
    const live = (login: string) => this.deps.installations.liveByOrgAndAccount(agent.orgId, login, to)
    const items: GithubAppCoverageItem[] = []
    for (const repository of scope.repositories) {
      const [owner, repo] = repository.fullName.split('/')
      const installation = owner && repo ? await live(owner) : null
      const covered =
        !!installation &&
        !installation.suspendedAt &&
        (installation.repositorySelection === 'all' || (await this.deps.covers(installation, owner!, repo!)))
      items.push({ target: repository.fullName, kind: repository.kind, covered })
    }
    for (const account of scope.accounts) {
      const installation = await live(account.login)
      items.push({
        target: account.login,
        kind: account.kind === 'review' ? 'review' : 'installation',
        covered: !!installation && !installation.suspendedAt
      })
    }
    return items
  }

  /** Moves the agent to `to` (null ⇒ built-in) only once that App reaches everything the agent works on. */
  async switch(agent: AgentRecord, to: string | null): Promise<GithubAppSwitchResult> {
    const from = agent.githubAppId ?? null
    if (from === to) return { ok: true }
    if (to !== null) {
      const app = await this.deps.apps.get(agent.orgId, to)
      if (!app) return { ok: false, reason: 'unknown_app' }
      if (app.agentId !== null) return { ok: false, reason: 'app_in_use' }
    }
    const coverage = await this.coverage(agent, to)
    if (coverage.some((item) => !item.covered)) return { ok: false, reason: 'not_covered', coverage }
    const switched = await this.deps.apps.switchAgent({ orgId: agent.orgId, agentId: agent.id, from, to })
    if (!switched.ok) {
      // An installation vanished between the check and the switch reads as not covered.
      if (switched.kind === 'missing_installation') {
        return { ok: false, reason: 'not_covered', coverage: await this.coverage(agent, to) }
      }
      return { ok: false, reason: switched.kind }
    }
    await this.deps.onAppsChanged?.(agent.orgId)
    return { ok: true }
  }

  /** Deletes a free App with its key and installations; one an agent works through is refused. */
  async delete(orgId: OrgId, id: string): Promise<boolean> {
    const claimed = await this.installationsOf(orgId, id)
    if (!(await this.deps.apps.deleteFree(orgId, id))) return false
    this.deps.registry.invalidate(id)
    this.deps.webhooks?.unassign(id)
    this.lastSetupSync.delete(id)
    for (const row of claimed) await this.deps.onInstallationChanged?.(row.installationId, orgId)
    await this.deps.onAppsChanged?.(orgId)
    return true
  }

  stop(): void {
    this.stopped = true
    for (const timer of this.trailingSync.values()) this.deps.clock.clearTimeout(timer)
    this.trailingSync.clear()
  }

  private async isOrganization(orgId: OrgId, login: string): Promise<boolean> {
    const installed = await this.deps.installations.liveByOrgAndAccount(orgId, login, null)
    return installed ? installed.accountType === 'Organization' : true
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
function appName(agentName: string, owner: string): string {
  return `${agentName}-${owner}`.slice(0, APP_NAME_MAX)
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
