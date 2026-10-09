import { describe, expect, it } from 'vitest'
import {
  ASSISTANT_ACTIVITY_ITEMS_MAX,
  ASSISTANT_ACTIVITY_RESULT_BYTES,
  AssistantActivityDraft,
  assistantActivityResultFits,
  buildEnvelope,
  decodeEnvelope,
  FRAME_TYPES
} from '../index.js'

const AGENT_ID = '11111111-1111-4111-8111-111111111111'
const decodes = (type: Parameters<typeof buildEnvelope>[0], payload: unknown): boolean =>
  decodeEnvelope(JSON.stringify(buildEnvelope(type, payload as never, { orgId: 'org-a' }))).ok

const item = {
  id: 'item-1',
  title: 'Ship the release notes',
  status: 'active',
  doneWhen: null,
  nextCheck: '2026-10-10T09:00:00.000Z',
  origin: { platform: 'slack', channel: 'D0ALICE' },
  places: [{ platform: 'webchat', channel: 'conv-1' }],
  createdAt: '2026-10-09T09:00:00.000Z',
  updatedAt: '2026-10-09T09:00:00.000Z'
}

describe('assistant/activity frames', () => {
  it('registers exactly the read and write pairs', () => {
    expect(FRAME_TYPES.filter((t) => t.startsWith('assistant/'))).toEqual([
      'assistant/activity/read',
      'assistant/activity/read/result',
      'assistant/activity/write',
      'assistant/activity/write/result'
    ])
  })

  it('round-trips every read and its answer', () => {
    expect(
      decodes('assistant/activity/read', { agentId: AGENT_ID, operation: 'items', section: 'open', limit: 50 })
    ).toBe(true)
    expect(decodes('assistant/activity/read', { agentId: AGENT_ID, operation: 'item', itemId: 'item-1' })).toBe(true)
    expect(decodes('assistant/activity/read', { agentId: AGENT_ID, operation: 'subsessions', limit: 50 })).toBe(true)
    expect(decodes('assistant/activity/read', { agentId: AGENT_ID, operation: 'drafts', limit: 50 })).toBe(true)
    expect(decodes('assistant/activity/read', { agentId: AGENT_ID, operation: 'grants' })).toBe(true)

    expect(decodes('assistant/activity/read/result', { operation: 'items', items: [item], truncated: false })).toBe(
      true
    )
    expect(
      decodes('assistant/activity/read/result', {
        operation: 'item',
        item: { ...item, summary: 'In review.', observations: [{ text: 'PR opened', at: '2026-10-09T10:00:00.000Z' }] }
      })
    ).toBe(true)
    expect(decodes('assistant/activity/read/result', { operation: 'item', item: null })).toBe(true)
    expect(
      decodes('assistant/activity/read/result', {
        operation: 'subsessions',
        subsessions: [
          { sessionId: null, parentSessionId: 'sid-1', state: 'open', createdAt: '2026-10-09T09:00:00.000Z' },
          { sessionId: 'sid-2', parentSessionId: 'sid-1', state: 'failed', createdAt: '2026-10-09T08:00:00.000Z' }
        ],
        truncated: false
      })
    ).toBe(true)
    expect(
      decodes('assistant/activity/read/result', {
        operation: 'drafts',
        drafts: [
          {
            id: 'draft-1',
            kind: 'reply',
            target: {
              platform: 'slack',
              integrationId: 'int-1',
              channel: 'C0SHARED',
              thread: null,
              name: 'shared',
              dm: false,
              external: true
            },
            text: 'Thanks, we are on it.',
            approver: null,
            createdAt: '2026-10-09T09:00:00.000Z',
            expiresAt: '2026-10-10T09:00:00.000Z'
          }
        ],
        truncated: false
      })
    ).toBe(true)
    expect(
      decodes('assistant/activity/read/result', {
        operation: 'grants',
        grants: [
          {
            id: 'a'.repeat(32),
            source: { platform: 'webchat', integrationId: null, channel: 'conv-1' },
            target: { platform: 'slack', integrationId: 'int-1', channel: 'C0SUPPORT' },
            grantedByName: null,
            grantedAt: '2026-10-09T09:00:00.000Z'
          }
        ],
        truncated: false
      })
    ).toBe(true)
  })

  it('round-trips both edits and their answer', () => {
    expect(decodes('assistant/activity/write', { agentId: AGENT_ID, operation: 'delete-item', itemId: 'item-1' })).toBe(
      true
    )
    expect(
      decodes('assistant/activity/write', { agentId: AGENT_ID, operation: 'revoke-grant', grantId: 'b'.repeat(32) })
    ).toBe(true)
    expect(decodes('assistant/activity/write/result', { operation: 'revoke-grant', found: false })).toBe(true)
  })

  it('round-trips a draft decision and its outcome', () => {
    const decide = {
      agentId: AGENT_ID,
      operation: 'decide-draft',
      draftId: 'draft-1',
      choice: 'always',
      decider: { userId: 'usr-1', name: 'Grace' }
    }
    expect(decodes('assistant/activity/write', decide)).toBe(true)
    expect(decodes('assistant/activity/write', { ...decide, decider: { userId: 'usr-1', name: null } })).toBe(true)
    expect(decodes('assistant/activity/write', { ...decide, choice: 'allow_once' })).toBe(false)
    expect(decodes('assistant/activity/write', { ...decide, decider: undefined })).toBe(false)
    const outcome = { operation: 'decide-draft', result: 'decided', status: 'succeeded', granted: true, failure: null }
    expect(decodes('assistant/activity/write/result', outcome)).toBe(true)
    expect(
      decodes('assistant/activity/write/result', { ...outcome, result: 'not-found', status: null, granted: false })
    ).toBe(true)
    expect(decodes('assistant/activity/write/result', { ...outcome, result: 'maybe' })).toBe(false)
    expect(decodes('assistant/activity/write/result', { ...outcome, failure: 'x'.repeat(2_001) })).toBe(false)

    const draft = {
      id: 'draft-1',
      kind: 'elsewhere',
      target: {
        platform: 'slack',
        integrationId: 'int-1',
        channel: 'C0',
        thread: null,
        name: null,
        dm: false,
        external: false
      },
      text: 'Hi.',
      approver: null,
      createdAt: '2026-10-09T09:00:00.000Z',
      expiresAt: '2026-10-10T09:00:00.000Z'
    }
    const parsed = AssistantActivityDraft.parse(draft)
    expect(parsed.offerAlways).toBe(false)
    expect(AssistantActivityDraft.parse({ ...draft, offerAlways: true }).offerAlways).toBe(true)
  })

  it('refuses unbounded or malformed requests and answers', () => {
    const tooMany = ASSISTANT_ACTIVITY_ITEMS_MAX + 1
    expect(
      decodes('assistant/activity/read', { agentId: AGENT_ID, operation: 'items', section: 'open', limit: tooMany })
    ).toBe(false)
    expect(
      decodes('assistant/activity/read', { agentId: AGENT_ID, operation: 'items', section: 'all', limit: 5 })
    ).toBe(false)
    expect(decodes('assistant/activity/read', { agentId: 'not-a-uuid', operation: 'grants' })).toBe(false)
    expect(decodes('assistant/activity/write', { agentId: AGENT_ID, operation: 'revoke-grant', grantId: 'xyz' })).toBe(
      false
    )
    expect(decodes('assistant/activity/write', { agentId: AGENT_ID, operation: 'drop-everything' })).toBe(false)
    expect(
      decodes('assistant/activity/read/result', {
        operation: 'items',
        items: Array.from({ length: tooMany }, () => item),
        truncated: true
      })
    ).toBe(false)
    expect(
      decodes('assistant/activity/read/result', {
        operation: 'items',
        items: [{ ...item, status: 'paused' }],
        truncated: false
      })
    ).toBe(false)
  })

  it('measures a result against the wire budget', () => {
    expect(assistantActivityResultFits({ operation: 'items', items: [item], truncated: false })).toBe(true)
    expect(assistantActivityResultFits({ text: 'x'.repeat(ASSISTANT_ACTIVITY_RESULT_BYTES) })).toBe(false)
  })
})
