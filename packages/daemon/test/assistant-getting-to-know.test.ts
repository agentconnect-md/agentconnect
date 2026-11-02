// The getting-to-know task's rules (assistant-mode.md §5.13): which places take one, its prompts, its reach and its bounds.
import { describe, expect, it } from 'vitest'
import type { Integration } from '../src/agents/agent-schema.js'
import {
  GETTING_TO_KNOW_JOIN_WAIT_MS,
  gettingToKnowHandling,
  gettingToKnowPlaceRefusal,
  gettingToKnowPrompt,
  gettingToKnowProposalRefusal,
  gettingToKnowReach,
  gettingToKnowReadRefusal,
  gettingToKnowTools,
  historyTsMs,
  joinVerdict,
  PendingGettingToKnowTasks,
  withinWindow
} from '../src/assistant/getting-to-know.js'
import { GETTING_TO_KNOW_TOOL, gettingToKnowToolsFor } from '../src/mcp/ops/getting-to-know.js'
import { PROPOSE_TOOL, RECORD_CHECK_TOOL } from '../src/mcp/ops/assistant-items.js'
import type { RoutingRule } from '../src/router/routing-rule.js'
import { obj, type ToolDescriptor } from '../src/tool-schema/descriptor.js'
import { MEMBER_FIELDS, ORGANIZATION_SECTIONS } from '../src/memory/organization-files.js'
import { MEMORY_TOOL_ACCESS_MODES } from '../src/mcp/ops/memory.js'

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

describe('which places take a getting-to-know task', () => {
  it('is an internal channel or group chat of an assistant-mode agent, on a platform with history, that is not Off', () => {
    expect(gettingToKnowPlaceRefusal(ON, integration(), { channel: 'C1' })).toBeUndefined()
    expect(gettingToKnowPlaceRefusal(OFF, integration(), { channel: 'C1' })).toBe('assistant-mode-off')
    expect(gettingToKnowPlaceRefusal(ON, integration(), { channel: 'D1', isDm: true })).toBe('direct')
    expect(gettingToKnowPlaceRefusal(ON, integration({}, 'telegram'), { channel: '-100' })).toBe('no-history')
    expect(gettingToKnowPlaceRefusal(ON, integration({ externalChannels: ['C1'] }), { channel: 'C1' })).toBe('external')
    expect(gettingToKnowPlaceRefusal(ON, integration({ mutedChannels: ['C1'] }), { channel: 'C1' })).toBe('off')
    // A channel a task holds is the task's workspace, never a place of its own (auto-session-mode.md §6.8).
    expect(gettingToKnowPlaceRefusal(ON, integration(), { channel: 'C1', heldByTask: true })).toBe('task-workspace')
  })

  it('takes one on a join once the row is listed appending, waits while it is not listed, and takes none for an Off row', () => {
    expect(joinVerdict(ON, integration(), 'C1')).toBe('take')
    expect(joinVerdict(ON, integration(), 'C9')).toBe('wait')
    expect(joinVerdict(ON, integration({ mutedChannels: ['C1'] }), 'C1')).toBe('drop')
    expect(joinVerdict(ON, integration({ sessionModes: [{ channel: 'C1', mode: 'createNew' }] }), 'C1')).toBe('drop')
    // Under auto the place's long session is its coordinator (auto-session-mode.md §3.4).
    expect(joinVerdict(ON, integration({ sessionModes: [{ channel: 'C1', mode: 'auto' }] }), 'C1')).toBe('take')
    expect(joinVerdict(OFF, integration(), 'C1')).toBe('drop')
    expect(joinVerdict(ON, integration({}, 'telegram'), 'C1')).toBe('drop')
  })

  it('offers gettingToKnow only to such a place’s long session', () => {
    const agent = { ...ON, integrations: [integration()] }
    const at = { channel: 'C1', thread: APPEND, integrationId: 'int-a', isDm: false }
    expect(gettingToKnowToolsFor(agent, at)).toEqual([GETTING_TO_KNOW_TOOL])
    expect(gettingToKnowToolsFor(agent, { ...at, thread: '1700000000.000100' })).toEqual([])
    expect(gettingToKnowToolsFor(agent, { ...at, channel: 'D1', isDm: true })).toEqual([])
    expect(gettingToKnowToolsFor({ ...OFF, integrations: [integration()] }, at)).toEqual([])
    expect(gettingToKnowToolsFor({ ...ON, integrations: [integration({ externalChannels: ['C1'] })] }, at)).toEqual([])
    expect(gettingToKnowToolsFor(agent, { ...at, integrationId: 'int-other' })).toEqual([])
  })

  it('offers that long session propose for its report round only where the place has cards', () => {
    const agent = { ...ON, integrations: [integration()] }
    const at = { channel: 'C1', thread: APPEND, integrationId: 'int-a', isDm: false }
    expect(gettingToKnowToolsFor(agent, at, { cards: true })).toEqual([GETTING_TO_KNOW_TOOL, PROPOSE_TOOL])
    expect(gettingToKnowToolsFor(agent, at, { cards: false })).toEqual([GETTING_TO_KNOW_TOOL])
    expect(gettingToKnowToolsFor(agent, { ...at, thread: '1700000000.000100' }, { cards: true })).toEqual([])
    expect(
      gettingToKnowToolsFor({ ...ON, integrations: [integration({ externalChannels: ['C1'] })] }, at, { cards: true })
    ).toEqual([])
  })

  it('keeps each tool within the runtimes’ limits', () => {
    for (const descriptor of [
      GETTING_TO_KNOW_TOOL,
      PROPOSE_TOOL,
      ...gettingToKnowTools([]).filter((t) => t.name === 'recordCheck')
    ]) {
      // A top-level oneOf would be flattened by the runtime and grow the description; none is used.
      expect('oneOf' in descriptor.inputSchema).toBe(false)
      expect(descriptor.description.length).toBeLessThanOrEqual(2_048)
      expect(Buffer.byteLength(JSON.stringify(descriptor.inputSchema))).toBeLessThanOrEqual(5_000)
    }
  })
})

describe('what a getting-to-know task may read', () => {
  it('keeps its place’s own reads, memory reads and writes and its own recordCheck, and nothing that posts or reacts', () => {
    const names = gettingToKnowTools(
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
    expect(gettingToKnowReadRefusal(ctx, 'getChannelHistory', {})).toBeUndefined()
    expect(gettingToKnowReadRefusal(ctx, 'getChannelHistory', { channel: 'C1' })).toBeUndefined()
    expect(gettingToKnowReadRefusal(ctx, 'getChannelHistory', { channel: 'C2' })).toContain('reads only its own place')
    expect(gettingToKnowReadRefusal(ctx, 'getReactions', { integrationId: 'int-b' })).toContain(
      'reads only its own place'
    )
    expect(gettingToKnowReadRefusal(ctx, 'getUserProfile', { platform: 'discord' })).toContain(
      'reads only its own place'
    )
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
  const facts = { place: '"releases"', kind: 'public channel', platform: 'slack', tools: 'sendMessage, followUp' }
  const flat = (text: string) => text.replace(/\s+/g, ' ')

  it('fills the task prompt’s placeholders, and says "you are in" for one someone asked for', () => {
    const joined = gettingToKnowPrompt({ ...facts, requested: false })
    expect(joined).toMatch(/^You are getting to know "releases", a public channel you were just added to\./)
    expect(joined).toContain('the last 30 days or 500 messages, whichever\nis less')
    expect(joined).toContain('actually do with its tools: sendMessage, followUp.')
    // A check never sees a new message, so an event-shaped suggestion is put as a check on a schedule.
    expect(joined).toContain(
      'A check runs only on its schedule or when\nmessaged, never on a new message, so put one that must notice new messages as a check on a\nschedule of what came in since the last one.'
    )
    expect(joined).toMatch(/Hand it back with recordCheck: a one-line observation, this report, and done set\.$/)
    expect(joined).not.toContain('{')
    expect(gettingToKnowPrompt({ ...facts, requested: true })).toContain('a public channel you are in. Read it')
  })

  it('keeps the read-only mode and names every write it may make, and recordCheck, as outputs that mode leaves alone', () => {
    // Every memory write the tool filter keeps, plus recordCheck: what a plan-mode reminder must not talk it out of.
    const outputs = gettingToKnowTools(Object.keys(MEMORY_TOOL_ACCESS_MODES).map(tool))
      .map((t) => t.name)
      .filter((name) => MEMORY_TOOL_ACCESS_MODES[name] !== 'read')
    expect(outputs).toEqual(['createMemoryEntry', 'updateMemoryEntry', 'writeMemory', 'recordCheck'])
    for (const shared of [false, true]) {
      const prompt = flat(gettingToKnowPrompt({ ...facts, requested: false, shared }))
      expect(prompt).toContain(
        'This session runs under a read-only or plan permission mode, which restricts your native shell and file tools only.'
      )
      const named = prompt.split('file tools only. ')[1]!.split(' are AgentConnect tools')[0]!
      expect(named.split(/, | and /).sort()).toEqual([...outputs].sort())
      expect(prompt).toContain(
        "are AgentConnect tools and this task's outputs, not edits the mode forbids: call them directly, since no one is here to approve a plan."
      )
    }
  })

  it('writes the place’s own topic file itself, and reports only what the long session acts on', () => {
    const prompt = gettingToKnowPrompt({ ...facts, requested: false })
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
    for (const shared of ['organization.md', 'channels.md', 'members.md', 'index: false', 'that revision'])
      expect(prompt).not.toContain(shared)
  })

  it('in a place that writes the shared layer, also keeps the organization files in their shapes', () => {
    const prompt = gettingToKnowPrompt({ ...facts, requested: false, shared: true })
    expect(prompt).toContain(
      '1. A topic file named after the place, dated, with "index: false" in its header so MEMORY.md leaves it out.'
    )
    // An entry is only for someone read here, keyed as the history names them (assistant-mode.md §5.17).
    expect(flat(prompt)).toContain(
      "Add an entry only for someone whose messages you read here, keyed exactly as the history's senderKey shows it"
    )
    // The place's line names its platform, so the console shows that platform's mark and naming.
    expect(flat(prompt)).toContain(
      '- channels.md: one line for this place, "- [slack] <name>: what it is for (#<name>, date)", its name as the platform shows it with no "#", e.g. "- [slack] release-train: release decisions (#release-train, 2026-10-17)".'
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

  it('tells the long session only to speak, since the getting-to-know task wrote memory itself', () => {
    for (const cards of [true, false]) {
      const handling = gettingToKnowHandling('@-mention me', { external: false, cards })
      expect(handling).toContain(
        'When your getting-to-know task reports back (it has already written what it learned to memory):\n1. Post one short introduction'
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
    const handling = gettingToKnowHandling('I read every message', { external: false })
    expect(handling).toContain('how to\n   reach you (I read every message).')
    expect(handling).toContain('2. In the same message, list each "Where I could help" item in one line')
    expect(handling).toContain('3. Ask at most one question')
    expect(handling).toContain('Then post nothing\n   more on your own.')
    expect(handling).not.toContain('propose')
    // What people read names a channel, never its raw platform id.
    expect(handling).toContain(
      '\nIn everything people read, name a channel by its name or link, never by its raw id.\n'
    )
    // People hear what the agent did in plain words, never the internal term.
    expect(handling).toMatch(/\nTell people plainly that you read this place's recent messages to get to know it\.$/)
    // Where the place has cards, step 2 offers the suggestions with propose, under the introduction.
    const cards = gettingToKnowHandling('@-mention me', { external: false, cards: true })
    expect(cards).toContain(
      '2. Under it, offer each "Where I could help" item with propose. Offer an "In flight" item as a\n   follow-up only if someone is visibly waiting on it.'
    )
    expect(cards).not.toContain('In the same message')
    expect(gettingToKnowHandling('@-mention me', { external: true, cards: true })).not.toContain('propose')
    const external = gettingToKnowHandling('@-mention me', { external: true })
    expect(external).not.toContain('Post one short introduction')
    expect(external).not.toContain('raw id')
    expect(external).toContain('post nothing about what you read in it')
  })

  it('tells step 2 in both forms that a follow-up needs a first check, and how to word an event-shaped one', () => {
    for (const cards of [true, false]) {
      const step2 = gettingToKnowHandling('@-mention me', { external: false, cards })
        .split('\n2. ')[1]!
        .split('\n3. ')[0]!
      expect(step2).toContain(
        'A follow-up runs only at its next check or when messaged, so give each one a first check,\n   and word one that must notice new messages as a check on a schedule ("each weekday at 10:00'
      )
    }
  })

  it('refuses a follow-up form with no first check, and lets one with a first check or a task through', () => {
    const followUp = {
      title: 'Release notes',
      doneWhen: 'Each release has notes.',
      nextCheck: undefined,
      watch: undefined
    }
    expect(gettingToKnowProposalRefusal({ followUp })).toBe(
      'a follow-up offered after getting to know a place needs followUp.nextCheck, since nothing else would wake it: set its ' +
        'first check, and word one that must notice new messages as a check on a schedule; nothing was proposed'
    )
    expect(
      gettingToKnowProposalRefusal({ followUp: { ...followUp, nextCheck: Date.parse('2099-01-01T10:00:00Z') } })
    ).toBe(undefined)
    expect(gettingToKnowProposalRefusal({ followUp: undefined })).toBeUndefined()
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
    expect(gettingToKnowReach([rule({ kind: 'mention' })], place)).toBe('@-mention me')
    expect(gettingToKnowReach([rule({ kind: 'auto' }, { scope: { channel: 'C1' } })], place)).toBe(
      'I read every message'
    )
  })
})

describe('joins waiting for their row', () => {
  it('settles each join once, and forgets one that waited too long', () => {
    const joins = new PendingGettingToKnowTasks()
    const join = { agentId: 'a', integrationId: 'int-a', channel: 'C1', at: 0 }
    joins.note(join)
    joins.note({ ...join, channel: 'C2' })
    expect(joins.waiting(1).map((j) => j.channel)).toEqual(['C1', 'C2'])
    expect(joins.done(join)).toBe(true)
    expect(joins.done(join)).toBe(false)
    expect(joins.waiting(GETTING_TO_KNOW_JOIN_WAIT_MS + 1)).toEqual([])
  })
})
