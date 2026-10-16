// The first look's rules (assistant-mode.md §5.13): which places take one, its prompts, its reach and its bounds.
import { describe, expect, it } from 'vitest'
import type { Integration } from '../src/agents/agent-schema.js'
import {
  FIRST_LOOK_JOIN_WAIT_MS,
  firstLookHandling,
  firstLookPlaceRefusal,
  firstLookPrompt,
  firstLookReach,
  firstLookReadRefusal,
  firstLookTools,
  historyTsMs,
  joinVerdict,
  PendingFirstLooks,
  withinWindow
} from '../src/assistant/first-look.js'
import { FIRST_LOOK_TOOL, firstLookToolsFor } from '../src/mcp/ops/first-look.js'
import { PROPOSE_TOOL, RECORD_CHECK_TOOL } from '../src/mcp/ops/assistant-items.js'
import type { RoutingRule } from '../src/router/routing-rule.js'
import { obj, type ToolDescriptor } from '../src/tool-schema/descriptor.js'

const ON = { assistantMode: { enabled: true } }
const OFF = { assistantMode: { enabled: false } }
const APPEND = 'append:1700000000000'

const integration = (over: Record<string, unknown> = {}, platform = 'slack'): Integration =>
  ({
    id: 'int-a',
    platform,
    core: { sessionModes: [{ channel: 'C1', mode: 'append' }], ...over }
  }) as unknown as Integration

const tool = (name: string): ToolDescriptor => ({ name, description: name, inputSchema: obj({}) })

describe('which places take a first look', () => {
  it('is an internal channel or group chat of an assistant-mode agent, on a platform with history, that is not Off', () => {
    expect(firstLookPlaceRefusal(ON, integration(), { channel: 'C1' })).toBeUndefined()
    expect(firstLookPlaceRefusal(OFF, integration(), { channel: 'C1' })).toBe('assistant-mode-off')
    expect(firstLookPlaceRefusal(ON, integration(), { channel: 'D1', isDm: true })).toBe('direct')
    expect(firstLookPlaceRefusal(ON, integration({}, 'telegram'), { channel: '-100' })).toBe('no-history')
    expect(firstLookPlaceRefusal(ON, integration({ externalChannels: ['C1'] }), { channel: 'C1' })).toBe('external')
    expect(firstLookPlaceRefusal(ON, integration({ mutedChannels: ['C1'] }), { channel: 'C1' })).toBe('off')
  })

  it('takes one on a join once the row is listed appending, waits while it is not listed, and takes none for an Off row', () => {
    expect(joinVerdict(ON, integration(), 'C1')).toBe('take')
    expect(joinVerdict(ON, integration(), 'C9')).toBe('wait')
    expect(joinVerdict(ON, integration({ mutedChannels: ['C1'] }), 'C1')).toBe('drop')
    expect(joinVerdict(ON, integration({ sessionModes: [{ channel: 'C1', mode: 'createNew' }] }), 'C1')).toBe('drop')
    expect(joinVerdict(OFF, integration(), 'C1')).toBe('drop')
    expect(joinVerdict(ON, integration({}, 'telegram'), 'C1')).toBe('drop')
  })

  it('offers firstLook only to such a place’s long session', () => {
    const agent = { ...ON, integrations: [integration()] }
    const at = { channel: 'C1', thread: APPEND, integrationId: 'int-a', isDm: false }
    expect(firstLookToolsFor(agent, at)).toEqual([FIRST_LOOK_TOOL])
    expect(firstLookToolsFor(agent, { ...at, thread: '1700000000.000100' })).toEqual([])
    expect(firstLookToolsFor(agent, { ...at, channel: 'D1', isDm: true })).toEqual([])
    expect(firstLookToolsFor({ ...OFF, integrations: [integration()] }, at)).toEqual([])
    expect(firstLookToolsFor({ ...ON, integrations: [integration({ externalChannels: ['C1'] })] }, at)).toEqual([])
    expect(firstLookToolsFor(agent, { ...at, integrationId: 'int-other' })).toEqual([])
  })

  it('offers that long session propose for its report round only where the place has cards', () => {
    const agent = { ...ON, integrations: [integration()] }
    const at = { channel: 'C1', thread: APPEND, integrationId: 'int-a', isDm: false }
    expect(firstLookToolsFor(agent, at, { cards: true })).toEqual([FIRST_LOOK_TOOL, PROPOSE_TOOL])
    expect(firstLookToolsFor(agent, at, { cards: false })).toEqual([FIRST_LOOK_TOOL])
    expect(firstLookToolsFor(agent, { ...at, thread: '1700000000.000100' }, { cards: true })).toEqual([])
    expect(
      firstLookToolsFor({ ...ON, integrations: [integration({ externalChannels: ['C1'] })] }, at, { cards: true })
    ).toEqual([])
  })

  it('keeps each tool within the runtimes’ limits', () => {
    for (const descriptor of [
      FIRST_LOOK_TOOL,
      PROPOSE_TOOL,
      ...firstLookTools([]).filter((t) => t.name === 'recordCheck')
    ]) {
      // A top-level oneOf would be flattened by the runtime and grow the description; none is used.
      expect('oneOf' in descriptor.inputSchema).toBe(false)
      expect(descriptor.description.length).toBeLessThanOrEqual(2_048)
      expect(Buffer.byteLength(JSON.stringify(descriptor.inputSchema))).toBeLessThanOrEqual(5_000)
    }
  })
})

describe('what a first look may read', () => {
  it('keeps its place’s own reads, memory reads and its own recordCheck, and nothing else', () => {
    const names = firstLookTools(
      [
        'getCurrentChannel',
        'getChannelHistory',
        'getThreadHistory',
        'listChannelMembers',
        'getUserProfile',
        'getReactions',
        'listBookmarks',
        'readSlackFile',
        'readMemory',
        'recall',
        'listChannels',
        'searchPublicMessages',
        'findKnowledge',
        'readCodeHostDiscussions',
        'sendMessage',
        'writeMemory'
      ].map(tool)
    )
    expect(names.map((t) => t.name)).toEqual([
      'getCurrentChannel',
      'getChannelHistory',
      'getThreadHistory',
      'listChannelMembers',
      'getUserProfile',
      'getReactions',
      'listBookmarks',
      'readSlackFile',
      'readMemory',
      'recordCheck'
    ])
    const recordCheck = names.at(-1)!
    expect(recordCheck).not.toBe(RECORD_CHECK_TOOL)
    expect(Object.keys((recordCheck.inputSchema as { properties: object }).properties)).toEqual([
      'observation',
      'report',
      'done'
    ])
  })

  it('refuses any argument naming another conversation, bot or platform', () => {
    const ctx = { platform: 'slack', channel: 'C1', integrationId: 'int-a' }
    expect(firstLookReadRefusal(ctx, 'getChannelHistory', {})).toBeUndefined()
    expect(firstLookReadRefusal(ctx, 'getChannelHistory', { channel: 'C1' })).toBeUndefined()
    expect(firstLookReadRefusal(ctx, 'getChannelHistory', { channel: 'C2' })).toContain('reads only its own place')
    expect(firstLookReadRefusal(ctx, 'getReactions', { integrationId: 'int-b' })).toContain('reads only its own place')
    expect(firstLookReadRefusal(ctx, 'getUserProfile', { platform: 'discord' })).toContain('reads only its own place')
  })

  it('reads platform timestamps in seconds or milliseconds, and ends a page at its window', () => {
    expect(historyTsMs('1700000000.000100')).toBe(1_700_000_000_000)
    expect(historyTsMs('1700000000123')).toBe(1_700_000_000_123)
    expect(historyTsMs('not a time')).toBeUndefined()
    const since = 1_700_000_000_000
    const rows = [{ ts: '1700000500.000000' }, { ts: '1700000000.000000' }, { ts: '1699990000.000000' }, { ts: 'x' }]
    expect(withinWindow(rows, since)).toEqual({ kept: rows.slice(0, 2), ended: true })
    expect(withinWindow(rows.slice(0, 2), since)).toEqual({ kept: rows.slice(0, 2), ended: false })
  })
})

describe('the prompts', () => {
  const facts = { place: '"releases"', kind: 'public channel', tools: 'sendMessage, followUp' }

  it('fills the task prompt’s placeholders, and says "you are in" for one someone asked for', () => {
    const joined = firstLookPrompt({ ...facts, requested: false })
    expect(joined).toMatch(/^You are taking a first look at "releases", a public channel you were just added to\./)
    expect(joined).toContain('the last 30 days or 500 messages, whichever\nis less')
    expect(joined).toContain('actually do with its tools: sendMessage, followUp.')
    expect(joined).toMatch(
      /Hand it back with recordCheck: a one-line observation, this answer as its report, and done\nset\. It is your only output\.$/
    )
    expect(joined).not.toContain('{')
    expect(firstLookPrompt({ ...facts, requested: true })).toContain('a public channel you are in. Read it')
  })

  it('tells the long session what to do, step 3 as text, and only step 1 once the place turned external', () => {
    const handling = firstLookHandling('I read every message', { external: false })
    expect(handling).toContain('how to\n   reach you (I read every message).')
    expect(handling).toContain('3. In the same message, list each "Where I could help" item in one line')
    expect(handling).toContain('Then post nothing\n   more on your own.')
    expect(handling).not.toContain('propose')
    // Where the place has cards, step 3 offers the suggestions with propose, under the introduction.
    const cards = firstLookHandling('@-mention me', { external: false, cards: true })
    expect(cards).toContain(
      '3. Under it, offer each "Where I could help" item with propose. Offer an "In flight" item as a\n   follow-up only if someone is visibly waiting on it.'
    )
    expect(cards).not.toContain('In the same message')
    expect(firstLookHandling('@-mention me', { external: true, cards: true })).not.toContain('propose')
    const external = firstLookHandling('@-mention me', { external: true })
    expect(external).toContain('1. Write "How this place works"')
    expect(external).not.toContain('2. Post one short introduction')
    expect(external).toContain('post nothing about this first look in it')
  })

  it('names how people reach the agent there from its trigger', () => {
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
    const place = { agentId: 'agent-a', integrationId: 'int-a', platform: 'slack', channel: 'C1' }
    expect(firstLookReach([rule({ kind: 'mention' })], place)).toBe('@-mention me')
    expect(firstLookReach([rule({ kind: 'auto' }, { scope: { channel: 'C1' } })], place)).toBe('I read every message')
  })
})

describe('joins waiting for their row', () => {
  it('settles each join once, and forgets one that waited too long', () => {
    const joins = new PendingFirstLooks()
    const join = { agentId: 'a', integrationId: 'int-a', channel: 'C1', at: 0 }
    joins.note(join)
    joins.note({ ...join, channel: 'C2' })
    expect(joins.waiting(1).map((j) => j.channel)).toEqual(['C1', 'C2'])
    expect(joins.done(join)).toBe(true)
    expect(joins.done(join)).toBe(false)
    expect(joins.waiting(FIRST_LOOK_JOIN_WAIT_MS + 1)).toEqual([])
  })
})
