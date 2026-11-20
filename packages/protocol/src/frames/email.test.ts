import { describe, expect, it } from 'vitest'
import {
  buildEnvelope,
  decodeEnvelope,
  EMAIL_MEMBERS_MAX,
  EMAIL_MEMBERS_V1_FEATURE,
  AgentEmailMembersOk,
  IntegrationEmailConfig,
  WireEmailCall,
  WireEmailStartedTag
} from '../index.js'

const AGENT_ID = '11111111-1111-4111-8111-111111111111'
const ALICE = 'alice@corp.example.test'
const BOB = 'bob@corp.example.test'

const decodes = (type: 'agent/email-members' | 'agent/email-members/ok', payload: unknown): boolean =>
  decodeEnvelope(JSON.stringify(buildEnvelope(type, payload as never, { orgId: 'org-a' }))).ok

describe('agent/email-members frames (email-integration.md §4)', () => {
  it('round-trips one address, a batch, and an answer naming the admitted ones', () => {
    expect(decodes('agent/email-members', { agentId: AGENT_ID, addresses: [ALICE] })).toBe(true)
    expect(decodes('agent/email-members', { agentId: AGENT_ID, addresses: [ALICE, BOB] })).toBe(true)
    expect(decodes('agent/email-members/ok', { members: [{ address: ALICE, consoleUserId: 'user-1' }] })).toBe(true)
    expect(decodes('agent/email-members/ok', { members: [] })).toBe(true)
    expect(EMAIL_MEMBERS_V1_FEATURE).toBe('email-members-v1')
  })

  it('refuses an ask that names nobody, too many, or an address that is not canonical', () => {
    const many = Array.from({ length: EMAIL_MEMBERS_MAX + 1 }, (_, index) => `m${index}@corp.example.test`)
    for (const addresses of [[], many, ['Alice@corp.example.test'], ['Alice <alice@corp.example.test>'], ['alice']])
      expect(decodes('agent/email-members', { agentId: AGENT_ID, addresses }), JSON.stringify(addresses)).toBe(false)
    expect(decodes('agent/email-members', { agentId: 'not-a-uuid', addresses: [ALICE] })).toBe(false)
  })

  it('carries the addresses no member holds and whether they may write now, and reads an older answer', () => {
    const answer = { members: [], outsiders: ['stranger@other.example.test'], outsideSenders: 'admitted' }
    expect(decodes('agent/email-members/ok', answer)).toBe(true)
    expect(decodes('agent/email-members/ok', { ...answer, outsideSenders: 'maybe' })).toBe(false)
    expect(
      decodes('agent/email-members/ok', { ...answer, outsiders: ['Stranger <stranger@other.example.test>'] })
    ).toBe(false)
    expect(AgentEmailMembersOk.parse({ members: [] })).toEqual({ members: [] })
  })

  it('refuses an answer that admits an address without its console user', () => {
    expect(decodes('agent/email-members/ok', { members: [{ address: ALICE }] })).toBe(false)
    expect(decodes('agent/email-members/ok', { members: [{ address: ALICE, consoleUserId: '' }] })).toBe(false)
  })
})

describe('IntegrationEmailConfig (email-integration.md §2)', () => {
  const config = {
    address: 'helper@mail.example.test',
    egress: 'relay',
    botId: '22222222-2222-4222-8222-222222222222'
  }

  it('names the address and the relay egress, and no credential', () => {
    expect(IntegrationEmailConfig.parse({ ...config, apiToken: 'never' })).toEqual(config)
    expect(IntegrationEmailConfig.safeParse({ ...config, address: 'Helper@mail.example.test' }).success).toBe(false)
    expect(IntegrationEmailConfig.safeParse({ ...config, egress: 'direct' }).success).toBe(false)
    expect(IntegrationEmailConfig.safeParse({ address: config.address, egress: 'relay' }).success).toBe(false)
  })

  it('says who may write, and reads a config without it as an older Control Plane sends one', () => {
    expect(IntegrationEmailConfig.parse({ ...config, whoMayWrite: 'anyone' }).whoMayWrite).toBe('anyone')
    expect(IntegrationEmailConfig.parse(config).whoMayWrite).toBeUndefined()
    expect(IntegrationEmailConfig.safeParse({ ...config, whoMayWrite: 'everyone' }).success).toBe(false)
  })
})

describe('a mail send (email-integration.md §6.2, §6.4)', () => {
  const send = {
    op: 'send',
    ticket: 'e1.dGhyZWFk.1700000000000.bWFj',
    audience: ['stranger@other.example.test'],
    to: ['stranger@other.example.test'],
    cc: [],
    subject: 'Re: Plan',
    inReplyTo: 'm1@other.example.test',
    references: [],
    text: 'Hello',
    html: '<p>Hello</p>'
  }

  it('may mark a reply that reaches someone outside the organization', () => {
    const parsed = WireEmailCall.parse({ ...send, outside: true })
    expect(parsed.op === 'send' && parsed.outside).toBe(true)
    expect(WireEmailCall.parse(send)).not.toHaveProperty('outside')
  })
})

describe('a started mail (email-integration.md §6.4)', () => {
  const start = {
    op: 'start',
    tag: 'abcdefghijklmnopqrst',
    to: ['stranger@other.example.test'],
    cc: ['alice@corp.example.test'],
    subject: 'Plan',
    text: 'Hello',
    html: '<p>Hello</p>'
  }

  it('carries a tag and the recipients, and no ticket, threading header or sender', () => {
    expect(
      WireEmailCall.parse({ ...start, from: 'someone@corp.example.test', inReplyTo: 'm1@x.example.test' })
    ).toEqual(start)
    expect(WireEmailStartedTag.parse('234567abcdefghijklmn')).toBe('234567abcdefghijklmn')
  })

  it('refuses a tag of another shape, no recipient, or a subject that could add a header', () => {
    const refused = [
      { tag: 'ABCDEFGHIJKLMNOPQRST' },
      { tag: 'abcdefghijklmnopqrs' },
      { tag: 'abcdefghijklmnopqrst1' },
      { tag: 'abcdefghijklmnopqrs1' },
      { to: [] },
      { subject: '' },
      { subject: 'Plan\r\nBcc: eve@other.example.test' },
      { cc: ['Eve <eve@other.example.test>'] }
    ]
    for (const change of refused)
      expect(WireEmailCall.safeParse({ ...start, ...change }).success, JSON.stringify(change)).toBe(false)
  })
})
