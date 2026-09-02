/**
 * `events/sink.ts` — the dashboard feed seam (design §2.3 `SessionEventSink`).
 *
 * The WS handlers publish converged session milestones plus body-free transcript
 * invalidations; the C2 SSE route (`/stream`) relays them to the WebUI. An
 * in-process pub/sub for the co-process MVP; the Go split replaces the
 * implementation behind this port (e.g. a broker) without touching either edge.
 */
import type { AgentActivity, EventSession, SessionActivity } from '@agentconnect.md/protocol'
import type { DaemonId } from '../domain/ids.js'

/** A metadata event as relayed to subscribers, stamped with its reporting daemon. */
export type SessionEventEnvelope =
  | { daemonId: DaemonId; event: EventSession; activity?: never; state?: never }
  | { daemonId: DaemonId; activity: SessionActivity; event?: never; state?: never }
  | { daemonId: DaemonId; state: AgentActivity; event?: never; activity?: never }

export interface SessionEventSink {
  /** Fan a converged milestone out to all current subscribers. */
  publish(daemonId: DaemonId, ev: EventSession): void
  /** Fan a body-free transcript invalidation out to current subscribers. */
  publishActivity(daemonId: DaemonId, activity: SessionActivity): void
  /** Fan a session's live wait-state change out (slack-approval-dm.md §7). */
  publishState(daemonId: DaemonId, state: AgentActivity): void
  /** Subscribe; returns an unsubscribe fn. */
  subscribe(cb: (e: SessionEventEnvelope) => void): () => void
}

/** In-process fan-out. Subscriber errors are isolated so one bad listener can't break the rest. */
export class InMemorySessionEventSink implements SessionEventSink {
  private readonly subscribers = new Set<(e: SessionEventEnvelope) => void>()

  publish(daemonId: DaemonId, ev: EventSession): void {
    const envelope: SessionEventEnvelope = { daemonId, event: ev }
    this.fanOut(envelope)
  }

  publishActivity(daemonId: DaemonId, activity: SessionActivity): void {
    this.fanOut({ daemonId, activity })
  }

  publishState(daemonId: DaemonId, state: AgentActivity): void {
    this.fanOut({ daemonId, state })
  }

  private fanOut(envelope: SessionEventEnvelope): void {
    for (const cb of this.subscribers) {
      try {
        cb(envelope)
      } catch {
        // isolate: a throwing subscriber must not stop delivery to the others.
      }
    }
  }

  subscribe(cb: (e: SessionEventEnvelope) => void): () => void {
    this.subscribers.add(cb)
    return () => {
      this.subscribers.delete(cb)
    }
  }
}
