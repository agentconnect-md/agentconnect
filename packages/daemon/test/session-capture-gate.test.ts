/**
 * The daemon side of the memory-capture gate (docs/designs/session-visibility.md
 * §5.1): the local fail-closed default, the CP-confirmed override, and the
 * revision rule that makes at-least-once delivery safe.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LocalStore } from '../src/store/local-store.js'

function newStore(): LocalStore {
  return new LocalStore(join(mkdtempSync(join(tmpdir(), 'ac-gate-')), 'daemon.db'))
}

describe('capture gate — local state', () => {
  it('fails closed for a session it has never heard of', () => {
    const store = newStore()
    expect(store.isCaptureExcluded('bot-a', 'unknown-session')).toBe(true)
    expect(store.isCaptureExcluded('bot-a', undefined)).toBe(true)
  })

  it('honors the daemon-local verdict until the CP confirms otherwise', () => {
    const store = newStore()
    store.setLocalCaptureGate('bot-a', 'acp-dm', true)
    store.setLocalCaptureGate('bot-a', 'acp-channel', false)
    expect(store.isCaptureExcluded('bot-a', 'acp-dm')).toBe(true)
    expect(store.isCaptureExcluded('bot-a', 'acp-channel')).toBe(false)
  })

  it('lets the CP-confirmed state win over the local verdict, in both directions', () => {
    const store = newStore()
    // A channel session the CP later pulls private (§4.3 tightening).
    store.setLocalCaptureGate('bot-a', 'acp-1', false)
    expect(store.applyCpCaptureGate('bot-a', 'acp-1', true, 1)).toBe('applied')
    expect(store.isCaptureExcluded('bot-a', 'acp-1')).toBe(true)
    // An A2A child that starts excluded and is confirmed org-visible.
    store.setLocalCaptureGate('bot-a', 'acp-2', true)
    expect(store.applyCpCaptureGate('bot-a', 'acp-2', false, 1)).toBe('applied')
    expect(store.isCaptureExcluded('bot-a', 'acp-2')).toBe(false)
  })

  it('applies a gate that arrives before the session exists locally', () => {
    const store = newStore()
    expect(store.applyCpCaptureGate('bot-a', 'acp-early', false, 3)).toBe('applied')
    expect(store.isCaptureExcluded('bot-a', 'acp-early')).toBe(false)
    // A later local verdict must not clobber the CP's authoritative state.
    store.setLocalCaptureGate('bot-a', 'acp-early', true)
    expect(store.isCaptureExcluded('bot-a', 'acp-early')).toBe(false)
  })

  it('lets an external (Slack/Feishu channel) session capture, following the gate not a hard deny', () => {
    const store = newStore()
    store.upsertSession({
      key: 'slack:C1:T1:bot-a',
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: 'T1',
      acpSessionId: 'acp-external',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1
    })
    store.setLocalCaptureGate('bot-a', 'acp-external', false)
    expect(store.applyCpCaptureGate('bot-a', 'acp-external', false, 1)).toBe('applied')
    store.setSessionClassification('slack:C1:T1:bot-a', {
      externalProvider: 'slack',
      externalRealmKey: 'W1',
      externalResourceKind: 'conversation',
      externalResourceKey: 'C1',
      externalIntegrationId: 'integration-old',
      sourceBindingKind: 'external'
    })
    store.setSessionClassification('slack:C1:T1:bot-a', {
      externalProvider: 'slack',
      externalRealmKey: 'W2',
      externalResourceKind: 'conversation',
      externalResourceKey: 'C2',
      externalIntegrationId: 'integration-new',
      sourceBindingKind: 'external'
    })

    // External is no longer a hard deny: an org-confirmed external session captures.
    expect(store.isCaptureExcluded('bot-a', 'acp-external')).toBe(false)
    // A private push still excludes it, proving it follows the gate.
    expect(store.applyCpCaptureGate('bot-a', 'acp-external', true, 2)).toBe('applied')
    expect(store.isCaptureExcluded('bot-a', 'acp-external')).toBe(true)
    // Source-binding integrity is unchanged: the first-bound realm/resource wins;
    // only the optional integration id is backfilled.
    expect(store.getSessionClassification('bot-a', 'acp-external')).toMatchObject({
      externalRealmKey: 'W1',
      externalResourceKey: 'C1',
      externalIntegrationId: 'integration-new',
      sourceBindingKind: 'external'
    })
  })
})

describe('capture gate — revision rule (§5.1 at-least-once)', () => {
  it('applies the initial revision, so fail-closed state is not mistaken for a duplicate', () => {
    const store = newStore()
    expect(store.applyCpCaptureGate('bot-a', 'acp-1', false, 0)).toBe('applied')
    expect(store.isCaptureExcluded('bot-a', 'acp-1')).toBe(false)
  })

  it('reports a duplicate delivery as superseded WITHOUT reapplying it', () => {
    const store = newStore()
    expect(store.applyCpCaptureGate('bot-a', 'acp-1', true, 4)).toBe('applied')
    // The CP lost the first ack and retransmits the identical frame: still an
    // answer (never an error), just not a second application.
    expect(store.applyCpCaptureGate('bot-a', 'acp-1', true, 4)).toBe('superseded')
    expect(store.isCaptureExcluded('bot-a', 'acp-1')).toBe(true)
  })

  it('ignores an out-of-order older revision but keeps the newer state', () => {
    const store = newStore()
    expect(store.applyCpCaptureGate('bot-a', 'acp-1', true, 7)).toBe('applied')
    expect(store.applyCpCaptureGate('bot-a', 'acp-1', false, 6)).toBe('superseded')
    expect(store.isCaptureExcluded('bot-a', 'acp-1')).toBe(true)
    expect(store.applyCpCaptureGate('bot-a', 'acp-1', false, 8)).toBe('applied')
    expect(store.isCaptureExcluded('bot-a', 'acp-1')).toBe(false)
  })

  it('treats a rev-0 push as superseded once a real revision is stored', () => {
    const store = newStore()
    expect(store.applyCpCaptureGate('bot-a', 'acp-1', true, 2)).toBe('applied')
    expect(store.applyCpCaptureGate('bot-a', 'acp-1', false, 0)).toBe('superseded')
    expect(store.isCaptureExcluded('bot-a', 'acp-1')).toBe(true)
  })
})

describe('capture gate — key (#1037: ACP session ids are runtime-local)', () => {
  it('keeps the gates of two organizations independent for the same ACP session id', () => {
    const store = newStore()
    // On the install-wide shared store both agents legitimately hold `acp-1`.
    store.setLocalCaptureGate('org-x-agent', 'acp-1', true) // a private DM
    store.setLocalCaptureGate('org-y-agent', 'acp-1', false) // an ordinary channel

    // The CP publishes ONLY the other organization's session.
    expect(store.applyCpCaptureGate('org-y-agent', 'acp-1', false, 1)).toBe('applied')

    expect(store.isCaptureExcluded('org-x-agent', 'acp-1')).toBe(true)
    expect(store.isCaptureExcluded('org-y-agent', 'acp-1')).toBe(false)

    // And the reverse: pulling one private leaves the neighbour capturing.
    expect(store.applyCpCaptureGate('org-x-agent', 'acp-1', true, 1)).toBe('applied')
    expect(store.isCaptureExcluded('org-y-agent', 'acp-1')).toBe(false)
  })

  it('orders revisions per agent, so a higher rev next door cannot supersede a push', () => {
    const store = newStore()
    expect(store.applyCpCaptureGate('org-x-agent', 'acp-1', true, 9)).toBe('applied')
    expect(store.applyCpCaptureGate('org-y-agent', 'acp-1', false, 1)).toBe('applied')
    expect(store.isCaptureExcluded('org-x-agent', 'acp-1')).toBe(true)
    expect(store.isCaptureExcluded('org-y-agent', 'acp-1')).toBe(false)
  })

  it('attributes a push from a CP too old to name the agent only when one agent holds the id', () => {
    const store = newStore()
    const put = (key: string, agentId: string) =>
      store.upsertSession({
        key,
        agentId,
        platform: 'slack',
        channel: 'C1',
        thread: key,
        acpSessionId: 'acp-1',
        state: 'idle',
        lastDeliveredTs: null,
        updatedAt: 1
      })
    put('x', 'org-x-agent')
    expect(store.soleAgentForAcpSession('acp-1')).toBe('org-x-agent')
    put('y', 'org-y-agent')
    expect(store.soleAgentForAcpSession('acp-1')).toBeUndefined()
    expect(store.soleAgentForAcpSession('acp-unknown')).toBeUndefined()
  })
})
