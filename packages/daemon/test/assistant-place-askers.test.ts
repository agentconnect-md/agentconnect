// Who may approve a proposal in its own place (assistant-mode.md §5.10): the routing ladder, asked about a person's own message.
import { describe, expect, it } from 'vitest'
import { personCouldActivate, type AskerPlace } from '../src/assistant/place-askers.js'
import type { RoutingRule } from '../src/router/routing-rule.js'

const CHANNEL: AskerPlace = {
  agentId: 'agent-a',
  integrationId: 'int-a',
  platform: 'slack',
  channel: 'C1',
  isDm: false
}
const DM: AskerPlace = { ...CHANNEL, channel: 'D1', isDm: true }

const rule = (match: RoutingRule['match'], over: Partial<RoutingRule> = {}): RoutingRule => ({
  agentId: 'agent-a',
  integrationId: 'int-a',
  botUserId: 'U0BOT',
  scope: {},
  match,
  source: 'config',
  platform: 'slack',
  ...over
})

describe('whether a person could start a turn of the agent in a place', () => {
  it('is yes where a mention, a plain message or the keyword would activate it', () => {
    expect(personCouldActivate([rule({ kind: 'mention' })], CHANNEL)).toBe(true)
    expect(personCouldActivate([rule({ kind: 'auto' }, { scope: { channel: 'C1' } })], CHANNEL)).toBe(true)
    expect(personCouldActivate([rule({ kind: 'keyword', value: 'deploy' })], CHANNEL)).toBe(true)
    expect(personCouldActivate([rule({ kind: 'dm' })], DM)).toBe(true)
  })

  it('is no where the conversation is switched off, out of scope, or only a decision would admit it', () => {
    expect(personCouldActivate([rule({ kind: 'mention' }, { mutedChannels: ['C1'] })], CHANNEL)).toBe(false)
    expect(personCouldActivate([rule({ kind: 'auto' }, { scope: { channel: 'C2' } })], CHANNEL)).toBe(false)
    expect(personCouldActivate([rule({ kind: 'decision' }, { scope: { channel: 'C1' } })], CHANNEL)).toBe(false)
    expect(personCouldActivate([rule({ kind: 'dm' })], CHANNEL)).toBe(false)
    // A mention needs the bot's id to be addressed at all.
    expect(personCouldActivate([rule({ kind: 'mention' }, { botUserId: '' })], CHANNEL)).toBe(false)
  })

  it('reads only this agent’s rules on this integration', () => {
    expect(personCouldActivate([rule({ kind: 'auto' }, { agentId: 'agent-b' })], CHANNEL)).toBe(false)
    expect(personCouldActivate([rule({ kind: 'auto' }, { integrationId: 'int-b' })], CHANNEL)).toBe(false)
    expect(personCouldActivate([rule({ kind: 'auto' }, { platform: 'telegram' })], CHANNEL)).toBe(false)
    expect(personCouldActivate([], CHANNEL)).toBe(false)
  })
})
