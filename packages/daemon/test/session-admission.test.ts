// The daemon's admission verdict and its per-organization memory of enforcement (org-session-policy.md, Enforcement).
import { describe, expect, it, vi } from 'vitest'
import {
  SESSION_QUOTA_UNAVAILABLE,
  SessionAdmissionGate,
  SessionAdmissionRefusedError,
  sessionAdmissionMessage,
  type SessionAdmitOutcome
} from '../src/session-admission.js'

const AGENT = 'example-agent'
const OTHER_ORG_AGENT = 'example-other-agent'
const REFUSED = { kind: 'refused', limit: 10, used: 10, resetsAt: '2026-12-01T00:00:00.000Z' } as const

function gate(answers: Array<SessionAdmitOutcome | Error>, opts: { live?: boolean } = {}) {
  const admitSession = vi.fn(
    async (_agentId: string, _sessionId: string, _purpose?: string, _o?: { wait?: boolean }) => {
      const next = answers.shift() ?? { kind: 'failed' }
      if (next instanceof Error) throw next
      return next
    }
  )
  const warn = vi.fn()
  const g = new SessionAdmissionGate({
    cp: () => ({ admitsSessions: () => opts.live ?? true, admitSession }),
    orgFor: (agentId) => (agentId === AGENT ? 'org-a' : 'org-b'),
    log: { warn, info: () => {} }
  })
  return { g, admitSession, warn }
}

describe('SessionAdmissionGate', () => {
  it('fails open without waiting while an organization never answered enforcing', async () => {
    const { g, admitSession, warn } = gate([{ kind: 'failed' }])
    expect(await g.admit(AGENT, 's-1')).toEqual({ admitted: true })
    expect(admitSession).toHaveBeenCalledWith(AGENT, 's-1', undefined, { wait: false })
    expect(warn).toHaveBeenCalledOnce()
  })

  it('remembers enforcement per organization and then waits, refusing as unavailable without an answer', async () => {
    const { g, admitSession } = gate([{ kind: 'admitted', enforcing: true }, { kind: 'failed' }, { kind: 'failed' }])
    expect(await g.admit(AGENT, 's-1')).toEqual({ admitted: true })
    expect(g.enforces(AGENT)).toBe(true)
    expect(await g.admit(AGENT, 's-2')).toEqual({ admitted: false, reason: SESSION_QUOTA_UNAVAILABLE })
    expect(admitSession).toHaveBeenLastCalledWith(AGENT, 's-2', undefined, { wait: true })
    // Another organization's last answer is its own.
    expect(await g.admit(OTHER_ORG_AGENT, 's-3')).toEqual({ admitted: true })
    expect(admitSession).toHaveBeenLastCalledWith(OTHER_ORG_AGENT, 's-3', undefined, { wait: false })
  })

  it('treats a throw like no answer', async () => {
    const { g } = gate([REFUSED, new Error('boom')])
    await g.admit(AGENT, 's-1')
    expect(await g.admit(AGENT, 's-2')).toEqual({ admitted: false, reason: SESSION_QUOTA_UNAVAILABLE })
  })

  it('refuses at the limit with the numbers, and remembers the organization enforces', async () => {
    const { g } = gate([REFUSED])
    expect(await g.admit(AGENT, 's-1')).toEqual({
      admitted: false,
      reason: 'session_limit_reached',
      limit: 10,
      used: 10,
      resetsAt: REFUSED.resetsAt
    })
    expect(g.enforces(AGENT)).toBe(true)
  })

  it('forgets enforcement when an answer says it stopped, or a control plane without admission answers', async () => {
    const { g } = gate([REFUSED, { kind: 'admitted' }, REFUSED, { kind: 'unsupported' }])
    await g.admit(AGENT, 's-1')
    expect(await g.admit(AGENT, 's-2')).toEqual({ admitted: true })
    expect(g.enforces(AGENT)).toBe(false)
    await g.admit(AGENT, 's-3')
    expect(await g.admit(AGENT, 's-4')).toEqual({ admitted: true })
    expect(g.enforces(AGENT)).toBe(false)
  })

  it('reads an older control plane’s answer without `enforcing` as not enforcing', async () => {
    const { g } = gate([{ kind: 'admitted' }])
    await g.admit(AGENT, 's-1')
    expect(g.enforces(AGENT)).toBe(false)
  })

  it('sends nothing over a link that is down unless the organization enforces', async () => {
    const down = gate([], { live: false })
    expect(await down.g.admit(AGENT, 's-1')).toEqual({ admitted: true })
    expect(down.admitSession).not.toHaveBeenCalled()
    expect(down.warn).not.toHaveBeenCalled()

    const enforcing = gate([REFUSED, { kind: 'admitted', enforcing: true }])
    await enforcing.g.admit(AGENT, 's-1')
    expect(await enforcing.g.admit(AGENT, 's-2')).toEqual({ admitted: true })
    expect(enforcing.admitSession).toHaveBeenLastCalledWith(AGENT, 's-2', undefined, { wait: true })
  })

  it('admits without a control plane at all', async () => {
    const g = new SessionAdmissionGate({ cp: () => undefined, orgFor: () => 'org-a', log: { warn() {}, info() {} } })
    expect(await g.admit(AGENT, 's-1')).toEqual({ admitted: true })
  })
})

describe('sessionAdmissionMessage', () => {
  it('names the count, the limit and the reset, and that existing sessions continue', () => {
    const text = sessionAdmissionMessage({
      admitted: false,
      reason: 'session_limit_reached',
      limit: 10,
      used: 12,
      resetsAt: '2026-12-01T00:00:00.000Z'
    })
    expect(text).toContain('12 of its 10 sessions')
    expect(text).toContain('2026-12-01 00:00 UTC')
    expect(text).toContain('existing sessions can still continue')
    expect(text.length).toBeLessThanOrEqual(240)
    expect(text).not.toMatch(/control plane/i)
  })

  it('words an unavailable check as temporary', () => {
    const text = sessionAdmissionMessage({ admitted: false, reason: SESSION_QUOTA_UNAVAILABLE })
    expect(text).toMatch(/right now/)
    expect(text).toMatch(/Try again/)
    expect(text.length).toBeLessThanOrEqual(240)
    expect(new SessionAdmissionRefusedError({ admitted: false, reason: SESSION_QUOTA_UNAVAILABLE }).reason).toBe(
      SESSION_QUOTA_UNAVAILABLE
    )
  })
})
