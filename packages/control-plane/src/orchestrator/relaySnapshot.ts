// A full relay-projection replay framed as one snapshot, so the relay prunes what a reconnect replay no longer names (high-availability.md).
import { randomUUID } from 'node:crypto'
import {
  RC_SNAPSHOT_MAX_WITHHELD,
  RELAY_PROJECTION_SNAPSHOT_V1_FEATURE,
  type RcSnapshotKind
} from '@agentconnect.md/protocol'
import { advertises } from '../domain/daemon-features.js'
import type { RelayChannel } from '../ws/relay-registry.js'

/** Replay one projection to a relay; an enumeration failure throws before the end frame, so the relay prunes nothing. */
export async function replaySnapshot(
  ch: RelayChannel,
  kind: RcSnapshotKind,
  replay: (withhold: (id: string) => void) => Promise<void>
): Promise<void> {
  if (!advertises(ch.features, [RELAY_PROJECTION_SNAPSHOT_V1_FEATURE])) return replay(() => {})
  const snapshotId = randomUUID()
  // Sent before the replay reads anything, so a change committed after that read reaches the relay after the begin.
  ch.send('rc/snapshot-begin', { kind, snapshotId })
  const withheld = new Set<string>()
  await replay((id) => withheld.add(id))
  // Too many failures to name is an incomplete stream: the relay keeps its copy rather than prune it.
  if (withheld.size > RC_SNAPSHOT_MAX_WITHHELD) return
  ch.send('rc/snapshot-end', { kind, snapshotId, withheld: [...withheld] })
}
