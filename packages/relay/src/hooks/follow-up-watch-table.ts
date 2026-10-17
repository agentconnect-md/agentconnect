/** The objects follow-ups watch (assistant-mode.md §5.14): a memory copy of the CP's `rc/follow-up-watch` EVTs, which names no agent or follow-up. */
import { followUpWatchKey, type RcFollowUpWatch } from '@agentconnect.md/protocol'
import { ProjectionSnapshot } from '../projection-snapshot.js'

export class FollowUpWatchTable {
  private readonly watches = new Map<string, RcFollowUpWatch>()
  private readonly snapshot = new ProjectionSnapshot()

  apply(update: RcFollowUpWatch): void {
    const key = followUpWatchKey(update)
    this.snapshot.see(key)
    if (update.watched) this.watches.set(key, update)
    else this.watches.delete(key)
  }

  /** Whether a verified event on this object should reach the CP: watched, under the installation that delivered it. */
  watched(object: Pick<RcFollowUpWatch, 'provider' | 'repoId' | 'subject' | 'number' | 'installationId'>): boolean {
    return this.watches.get(followUpWatchKey(object))?.installationId === object.installationId
  }

  beginSnapshot(snapshotId: string): void {
    this.snapshot.begin(snapshotId)
  }

  /** Drop each object the replay did not name, such as one unwatched while the link was down. */
  endSnapshot(snapshotId: string, withheld: readonly string[]): void {
    for (const key of this.snapshot.end(snapshotId, this.watches.keys(), withheld)) this.watches.delete(key)
  }

  abandonSnapshot(): void {
    this.snapshot.abandon()
  }
}
