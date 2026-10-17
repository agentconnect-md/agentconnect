// The first look's rules (assistant-mode.md §5.13): which places take one, its prompts, its reach and its bounds.
import { describe, expect, it } from 'vitest'
import type { Integration } from '../src/agents/agent-schema.js'
import {
  FIRST_LOOK_JOIN_WAIT_MS,
  firstLookHandling,
  firstLookPlaceRefusal,
  firstLookPrompt,
  firstLookProposalRefusal,
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
import { MEMBER_FIELDS, ORGANIZATION_SECTIONS } from '../src/memory/organization-files.js'

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
  it('keeps its place’s own reads, memory reads and writes and its own recordCheck, and nothing that posts or reacts', () => {
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
        'listMemoryEntries',
        'getMemoryEntry',
        'recall',
        'listChannels',
        'searchPublicMessages',
        'findKnowledge',
        'readCodeHostDiscussions',
        'sendMessage',
        'addReaction',
        'propose',
        'writeMemory',
        'createMemoryEntry',
        'updateMemoryEntry',
        'deleteMemoryEntry'
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
      'listMemoryEntries',
      'getMemoryEntry',
      'writeMemory',
      'createMemoryEntry',
      'updateMemoryEntry',
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
  const flat = (text: string) => text.replace(/\s+/g, ' ')

  it('fills the task prompt’s placeholders, and says "you are in" for one someone asked for', () => {
    const joined = firstLookPrompt({ ...facts, requested: false })
    expect(joined).toMatch(/^You are taking a first look at "releases", a public channel you were just added to\./)
    expect(joined).toContain('the last 30 days or 500 messages, whichever\nis less')
    expect(joined).toContain('actually do with its tools: sendMessage, followUp.')
    // A check never sees a new message, so an event-shaped suggestion is put as a check on a schedule.
    expect(joined).toContain(
      'A check runs only on its schedule or when\nmessaged, never on a new message, so put one that must notice new messages as a check on a\nschedule of what came in since the last one.'
    )
    expect(joined).toMatch(/Hand it back with recordCheck: a one-line observation, this report, and done set\.$/)
    expect(joined).not.toContain('{')
    expect(firstLookPrompt({ ...facts, requested: true })).toContain('a public channel you are in. Read it')
  })

  it('writes the place’s own topic file itself, and reports only what the long session acts on', () => {
    const prompt = firstLookPrompt({ ...facts, requested: false })
    expect(prompt).toContain('You cannot post or react: only your memory writes\nand your report leave this task.')
    expect(prompt).toContain(
      'Then write to memory, without a layer argument:\n1. A topic file named after the place, dated, with a description header so MEMORY.md lists it.'
    )
    expect(flat(prompt)).toContain('And what recurs: things that happened at least twice on a rhythm, and when.')
    // An open request stays out of memory even when the place files it under another heading.
    expect(flat(prompt)).toContain('Write nothing in flight, no request still open wherever it appears')
    expect(flat(prompt)).toContain('one line on what this place is for, then these sections.')
    expect(prompt.match(/^## .+$/gm)).toEqual(['## In flight', '## Where I could help', '## Not covered'])
    // A private channel, a group chat or an external place writes only its own file.
    for (const shared of ['organization.md', 'channels.md', 'members.md', 'index: false', 'updateMemoryEntry'])
      expect(prompt).not.toContain(shared)
  })

  it('in a place that writes the shared layer, also keeps the organization files in their shapes', () => {
    const prompt = firstLookPrompt({ ...facts, requested: false, shared: true, memberKey: 'slack:T0EXAMPLE:' })
    expect(prompt).toContain(
      '1. A topic file named after the place, dated, with "index: false" in its header so MEMORY.md leaves it out.'
    )
    // An entry is keyed by its person's identity, which a member id here completes (assistant-mode.md §5.17).
    expect(flat(prompt)).toContain('"## Display name (@handle on Platform) `slack:T0EXAMPLE:<member id>`"')
    expect(flat(firstLookPrompt({ ...facts, requested: false, shared: true }))).toContain(
      "write no members.md entry from this place, since its people's keys cannot be told."
    )
    // The place's file is out of the index, so its line in channels.md is how later sessions there find it.
    expect(flat(prompt)).toContain(
      '- channels.md: one line for this place, linking the file above: "#name: what it is for — [[file name]] (#name, date)", e.g. "#release-train: release decisions — [[release-train]] (#release-train, 2026-10-17)".'
    )
    expect(flat(prompt)).toContain('Merge it into its sections, not as a new block; write nothing when nothing is new.')
    expect(flat(prompt)).toContain(
      '- members.md: the roles people here state for themselves or others, one entry per person.'
    )
    expect(flat(prompt)).toContain(
      'Never opinions or evaluations of a person, judgments of their work, sensitive personal attributes'
    )
    // The shapes the daemon checks, named as the check names them.
    expect(flat(prompt)).toContain('Every fact is one line ending in its source and date, "(#name, YYYY-MM-DD)"')
    for (const section of ORGANIZATION_SECTIONS) expect(flat(prompt)).toContain(`"## ${section}"`)
    for (const field of MEMBER_FIELDS) expect(flat(prompt)).toContain(`"${field}:"`)
    // Places merge into the same files, so each save carries the revision it read, and a conflict is merged again.
    expect(flat(prompt)).toContain(
      'never rewrite them with writeMemory: find each with listMemoryEntries, read its text and revision with getMemoryEntry, then save it with updateMemoryEntry and that revision, or createMemoryEntry while it does not exist. On CONFLICT, read it again, merge, and save again.'
    )
    expect(prompt.match(/^## .+$/gm)).toEqual(['## In flight', '## Where I could help', '## Not covered'])
  })

  it('tells the long session only to speak, since the first look wrote memory itself', () => {
    for (const cards of [true, false]) {
      const handling = firstLookHandling('@-mention me', { external: false, cards })
      expect(handling).toContain(
        'When a first look reports back (it has already written what it learned to memory):\n1. Post one short introduction'
      )
      for (const write of [
        'Write "How this place works"',
        'organization.md',
        'channels.md',
        'index: false',
        'MemoryEntry'
      ])
        expect(handling).not.toContain(write)
    }
  })

  it('tells the long session what to do, step 2 as text, and nothing to post once the place turned external', () => {
    const handling = firstLookHandling('I read every message', { external: false })
    expect(handling).toContain('how to\n   reach you (I read every message).')
    expect(handling).toContain('2. In the same message, list each "Where I could help" item in one line')
    expect(handling).toContain('3. Ask at most one question')
    expect(handling).toContain('Then post nothing\n   more on your own.')
    expect(handling).not.toContain('propose')
    // What people read names a channel, never its raw platform id.
    expect(handling).toMatch(/\nIn everything people read, name a channel by its name or link, never by its raw id\.$/)
    // Where the place has cards, step 2 offers the suggestions with propose, under the introduction.
    const cards = firstLookHandling('@-mention me', { external: false, cards: true })
    expect(cards).toContain(
      '2. Under it, offer each "Where I could help" item with propose. Offer an "In flight" item as a\n   follow-up only if someone is visibly waiting on it.'
    )
    expect(cards).not.toContain('In the same message')
    expect(firstLookHandling('@-mention me', { external: true, cards: true })).not.toContain('propose')
    const external = firstLookHandling('@-mention me', { external: true })
    expect(external).not.toContain('Post one short introduction')
    expect(external).not.toContain('raw id')
    expect(external).toContain('post nothing about this first look in it')
  })

  it('tells step 2 in both forms that a follow-up needs a first check, and how to word an event-shaped one', () => {
    for (const cards of [true, false]) {
      const step2 = firstLookHandling('@-mention me', { external: false, cards }).split('\n2. ')[1]!.split('\n3. ')[0]!
      expect(step2).toContain(
        'A follow-up runs only at its next check or when messaged, so give each one a first check,\n   and word one that must notice new messages as a check on a schedule ("each weekday at 10:00'
      )
    }
  })

  it('refuses a follow-up form with no first check, and lets one with a first check or a task through', () => {
    const followUp = { title: 'Release notes', doneWhen: 'Each release has notes.', nextCheck: undefined }
    expect(firstLookProposalRefusal({ followUp })).toBe(
      'a follow-up offered after a first look needs followUp.nextCheck, since nothing else would wake it: set its ' +
        'first check, and word one that must notice new messages as a check on a schedule; nothing was proposed'
    )
    expect(firstLookProposalRefusal({ followUp: { ...followUp, nextCheck: Date.parse('2099-01-01T10:00:00Z') } })).toBe(
      undefined
    )
    expect(firstLookProposalRefusal({ followUp: undefined })).toBeUndefined()
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
