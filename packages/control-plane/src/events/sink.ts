/**
 * `events/sink.ts` — the dashboard feed seam (design §2.3 `SessionEventSink`).
 *
 * The WS `event/session` handler `publish()`es converged session milestones
 * (NO bodies — metadata only); the C2 SSE route (`/stream`) `subscribe()`s and
 * relays them to the WebUI. An in-process pub/sub for the co-process MVP; the Go
 * split replaces the implementation behind this port (e.g. a broker) without
 * touching either edge.
 */
import type { EventSession } from '@agentconnect.md/protocol'
import type { DaemonId } from '../domain/ids.js'

/** A milestone as relayed to subscribers: the daemon that reported it + the event. */
export interface SessionEventEnvelope {
  daemonId: DaemonId
  event: EventSession
}

export interface SessionEventSink {
  /** Fan a converged milestone out to all current subscribers. */
  publish(daemonId: DaemonId, ev: EventSession): void
  /** Subscribe; returns an unsubscribe fn. */
  subscribe(cb: (e: SessionEventEnvelope) => void): () => void
}

/** In-process fan-out. Subscriber errors are isolated so one bad listener can't break the rest. */
export class InMemorySessionEventSink implements SessionEventSink {
  private readonly subscribers = new Set<(e: SessionEventEnvelope) => void>()

  publish(daemonId: DaemonId, ev: EventSession): void {
    const envelope: SessionEventEnvelope = { daemonId, event: ev }
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
