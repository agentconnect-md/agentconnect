import { describe, expect, it } from 'vitest'
import { normalizeSlackMessage, type SlackMessage } from '../src/slack-message.js'

/**
 * The search credential must not survive normalization.
 *
 * Slack's `action_token` is the only thing that lets a BOT token search the workspace, and it
 * arrives on the ordinary message event. The normalized message is not a safe place for it:
 * the owning daemon persists that object to its durable inbox and replays it after a restart,
 * and the relay forwards it as `rd/msg` `payload`. So ingress lifts the token into memory and
 * normalization drops it — this test is what keeps that true.
 *
 * The guard is structural rather than field-by-field: any future normalizer that copies the
 * raw event wholesale would carry the token along, and a whole-object scan catches that where
 * an assertion on one property name would not.
 */
const event = (over: Partial<SlackMessage> = {}): SlackMessage => ({
  type: 'message',
  channel: 'C1',
  ts: '1700000000.000100',
  user: 'U1',
  text: 'what did we decide about the rollout?',
  action_token: 'xoxa-super-secret',
  ...over
})

describe('Slack search credential', () => {
  it('never appears in the normalized message, at any depth', () => {
    const normalized = normalizeSlackMessage(event())
    expect(normalized).toBeTruthy()
    const serialized = JSON.stringify(normalized)
    expect(serialized).not.toContain('xoxa-super-secret')
    expect(serialized).not.toContain('action_token')
  })

  it('does not otherwise change how the message normalizes', () => {
    const withToken = normalizeSlackMessage(event())
    const without = normalizeSlackMessage(event({ action_token: undefined }))
    expect(withToken).toEqual(without)
  })
})
