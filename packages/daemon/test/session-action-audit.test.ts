/**
 * The audit record for a chat-side session action must describe what happened, not
 * what was clicked. A click that changes nothing — a permission card tapped after the
 * agent's chat authority was withdrawn, a cancel with no turn in flight — must never
 * read as though that user approved a tool call or stopped a run.
 */
import { describe, it, expect } from 'vitest'
import { Daemon } from '../src/daemon.js'

const AGENT = 'agent-1'
const REQUEST = 'req-1'

function daemonWithLog(): { daemon: Daemon; lines: string[] } {
  const daemon = new Daemon({ sandboxMechanism: null } as never)
  const lines: string[] = []
  ;(daemon as never as { log: unknown }).log = {
    info: (m: string) => lines.push(m),
    warn: () => {},
    error: () => {},
    debug: () => {}
  }
  return { daemon, lines }
}

/** A pending chat permission with no `ts`, so no card update is attempted. */
function seedPending(daemon: Daemon, allowRuntimeChangesInChat: boolean): void {
  const inner = daemon as never as {
    agents: Map<string, unknown>
    pendingChatPermissions: Map<string, unknown>
  }
  inner.agents.set(AGENT, { id: AGENT, allowRuntimeChangesInChat })
  inner.pendingChatPermissions.set(REQUEST, {
    agentId: AGENT,
    sessionId: 'acp-1',
    params: { options: [{ optionId: 'allow_once', kind: 'allow_once', name: 'Allow' }] },
    evaluationParams: {},
    conn: {},
    channel: 'C1',
    resolve: () => {}
  })
}

describe('chat-side session action audit', () => {
  it('records a refused permission click as an attempt, never as the decision', () => {
    const { daemon, lines } = daemonWithLog()
    seedPending(daemon, false) // chat authority withdrawn

    ;(daemon as never as { handlePermissionChoice: (i: unknown) => void }).handlePermissionChoice({
      requestId: REQUEST,
      optionId: 'allow_once',
      actor: { userId: 'U-MALLORY' }
    })

    const audit = lines.filter((l) => l.includes('permission:'))
    expect(audit).toHaveLength(1)
    expect(audit[0]).toContain('(refused)')
    expect(audit[0]).toContain('U-MALLORY')
    // The decision form is what a reader would take as "this user allowed the tool".
    expect(audit[0]).not.toContain('permission:allowed')
    // …and the request is genuinely still pending, so nothing was decided.
    expect((daemon as never as { pendingChatPermissions: Map<string, unknown> }).pendingChatPermissions.size).toBe(1)
  })

  it('does not record a cancel that had no turn to stop', () => {
    const { daemon, lines } = daemonWithLog()
    // An unstarted daemon has no store; the key is absent from `inflight` either way,
    // which is exactly the "nothing to cancel" case under test.
    ;(daemon as never as { store: unknown }).store = { getSession: () => undefined }

    ;(daemon as never as { handleStatusAction: (a: unknown) => void }).handleStatusAction({
      kind: 'cancel',
      sessionKey: 'slack:C1:T1:agent-1', // nothing in flight for this key
      actor: { userId: 'U-ALICE' }
    })

    expect(lines.filter((l) => l.includes('"cancel"'))).toEqual([])
  })
})
