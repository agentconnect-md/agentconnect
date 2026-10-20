import type { MaskedChatEvent } from '../session/chat-events.js'
import { AhpChatProjection } from './chat-projection.js'

// Read-only diagnostics: bounded derived state, no connections, dispatch, journal, or execution owner.
export class AhpShadowService {
  private readonly sessions = new Map<string, AhpChatProjection>()
  accept(event: MaskedChatEvent): void {
    let projection = this.sessions.get(event.sessionId)
    if (!projection) {
      if (this.sessions.size >= 64) {
        const idle = [...this.sessions].find(([, entry]) => !entry.snapshot().activeTurn)
        if (!idle) return
        this.sessions.delete(idle[0])
      }
      projection = new AhpChatProjection(
        event.sessionId,
        `ahp-chat:/shadow/${encodeURIComponent(event.sessionId)}/main`,
        'Conversation',
        event.at,
        () => {}
      )
      this.sessions.set(event.sessionId, projection)
    }
    projection.accept(event)
    projection.retainCompleted(32 * 1024)
    if (Buffer.byteLength(JSON.stringify(projection.snapshot())) > 64 * 1024) this.sessions.delete(event.sessionId)
  }
  snapshot(sessionId: string) {
    return this.sessions.get(sessionId)?.snapshot()
  }
  dispose(): void {
    this.sessions.clear()
  }
}
