// A Slack permission card's notification text is clamped like its header, so a click's payload never carries a whole command.
import { describe, expect, it } from 'vitest'
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk/unstable'
import { slackApprovalCards } from '../src/platforms/slack/approval-card.js'

const params = (title: string): RequestPermissionRequest => ({
  sessionId: 's1',
  toolCall: { toolCallId: 'tc1', title },
  options: [
    { optionId: 'yes', name: 'Yes', kind: 'allow_once' },
    { optionId: 'no', name: 'No', kind: 'reject_once' }
  ]
})

describe('slackApprovalCards.build', () => {
  it('clamps a long tool-call title in the notification text', () => {
    const title = `bq query '${'SELECT a FROM t UNION '.repeat(100)}'`
    const draft = slackApprovalCards.build({ requestId: 'r1', params: params(title) }) as { fallback: string }
    expect(draft.fallback.startsWith('Permission requested: bq query')).toBe(true)
    expect(draft.fallback.length).toBeLessThanOrEqual('Permission requested: '.length + 200)
  })

  it('keeps a short title whole', () => {
    const draft = slackApprovalCards.build({ requestId: 'r1', params: params('ls -la') }) as { fallback: string }
    expect(draft.fallback).toBe('Permission requested: ls -la')
  })
})
