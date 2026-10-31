/** Agents' dedicated GitHub Apps' webhook secrets, keyed by GitHub App id (`rc/github-app-assign`); secrets are never logged. */
import type { RcGithubAppAssign } from '@agentconnect.md/protocol'
import { ProjectionSnapshot } from '../projection-snapshot.js'

export class GithubAppWebhookTable {
  private readonly byId = new Map<string, RcGithubAppAssign>()
  private readonly snapshot = new ProjectionSnapshot()

  apply(assign: RcGithubAppAssign): void {
    this.snapshot.see(assign.githubAppId)
    this.byId.set(assign.githubAppId, assign)
  }

  remove(githubAppId: string): void {
    this.byId.delete(githubAppId)
  }

  /** The secret a delivery naming this GitHub App id must be signed with; undefined ⇒ not a dedicated App. */
  secretFor(appId: string): string | undefined {
    for (const entry of this.byId.values()) if (entry.appId === appId) return entry.webhookSecret
    return undefined
  }

  beginSnapshot(snapshotId: string): void {
    this.snapshot.begin(snapshotId)
  }

  endSnapshot(snapshotId: string, withheld: readonly string[]): void {
    for (const id of this.snapshot.end(snapshotId, this.byId.keys(), withheld)) this.byId.delete(id)
  }

  abandonSnapshot(): void {
    this.snapshot.abandon()
  }
}
