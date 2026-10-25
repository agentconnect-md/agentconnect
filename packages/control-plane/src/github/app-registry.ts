/**
 * Organization-registered GitHub Apps (github-app-git-credentials.md §Dedicated Apps).
 *
 * The registry answers one question for the token signer: which App signs for
 * an installation. The deployment App (`GITHUB_APP_*`) stays the default; an
 * installation that belongs to a registered App is signed with that App's key.
 * Configs are cached per App id because `mintAppJwt` keys its auth cache on the
 * config object; registration and deletion invalidate the entry.
 */
import type { GithubAppRepo, GithubAppSecretStore, GithubInstallationRepo } from '../persistence/ports.js'
import { githubAppConfigFromParts, type GithubAppConfig } from './config.js'

export interface GithubAppRegistryDeps {
  apps: Pick<GithubAppRepo, 'getUnscoped'>
  secrets: Pick<GithubAppSecretStore, 'get'>
  installations: Pick<GithubInstallationRepo, 'getByInstallationId'>
}

export class GithubAppRegistry {
  private readonly configs = new Map<string, Promise<GithubAppConfig | undefined>>()

  constructor(private readonly deps: GithubAppRegistryDeps) {}

  /** The signer for a registered App; undefined when the App or its key is gone. */
  configFor(githubAppId: string): Promise<GithubAppConfig | undefined> {
    let pending = this.configs.get(githubAppId)
    if (!pending) {
      pending = this.load(githubAppId).catch((error) => {
        this.configs.delete(githubAppId)
        throw error
      })
      this.configs.set(githubAppId, pending)
    }
    return pending
  }

  /** The signer for an installation: its registered App, or undefined ⇒ the deployment App. */
  async configForInstallation(installationId: bigint): Promise<GithubAppConfig | undefined> {
    const row = await this.deps.installations.getByInstallationId(installationId)
    if (!row?.githubAppId) return undefined
    const cfg = await this.configFor(row.githubAppId)
    if (!cfg) throw new Error(`github app ${row.githubAppId} for installation ${installationId} is not registered`)
    return cfg
  }

  invalidate(githubAppId: string): void {
    this.configs.delete(githubAppId)
  }

  private async load(githubAppId: string): Promise<GithubAppConfig | undefined> {
    const app = await this.deps.apps.getUnscoped(githubAppId)
    if (!app) return undefined
    const privateKeyB64 = await this.deps.secrets.get(app.orgId, app.id)
    if (!privateKeyB64) return undefined
    return githubAppConfigFromParts({
      appId: Number(app.appId),
      slug: app.slug,
      clientId: app.clientId,
      privateKeyB64
    })
  }
}
