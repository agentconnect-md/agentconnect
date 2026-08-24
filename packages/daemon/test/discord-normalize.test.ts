import { describe, it, expect } from 'vitest'
import {
  normalizeDiscordMessage,
  toAttachment,
  humanizeDiscordText,
  type DiscordMessageLike
} from '../src/discord/normalize.js'
import {
  chunkForDiscord,
  DISCORD_MESSAGE_LIMIT,
  parseDiscordSelect,
  buildDiscordSelectComponents,
  buildLinkComponents
} from '../src/discord/render.js'
import { collapseDiscordChannels, collapseNameLookupIds } from '../src/discord/channels.js'

const base: DiscordMessageLike = {
  id: '111',
  channelId: 'C777',
  url: 'https://discord.com/channels/222/C777/111',
  content: 'hello <@999>',
  authorId: 'U123',
  authorIsBot: false,
  inGuild: true,
  isThread: false,
  mentionUserIds: ['999'],
  attachments: []
}

describe('normalizeDiscordMessage', () => {
  it('maps a top-level guild message without thread affinity, flagged for auto-threading', () => {
    const m = normalizeDiscordMessage(base, { traceId: 't1' })
    expect(m).toMatchObject({
      msgId: 'discord:C777:111',
      platform: 'discord',
      source: 'user',
      channel: 'C777',
      threadUrl: 'https://discord.com/channels/222/C777/111',
      text: 'hello @999', // mention token humanized (see humanizeDiscordText)
      mentionedBots: ['999'],
      sender: { id: 'U123', isBot: false },
      isDm: false
    })
    // Before promotion there is no separate thread id yet.
    expect(m.thread).toBeUndefined()
    // §6.5 emission flip: the generic coordinate only — discordTopLevel retired.
    expect(m.promoteToThread).toBe(true)
    expect((m as Record<string, unknown>).discordTopLevel).toBeUndefined()
    expect(m.attachments).toBeUndefined()
  })

  it('does not flag an in-thread message for auto-threading (it already is a thread)', () => {
    const m = normalizeDiscordMessage(
      { ...base, channelId: 'T555', isThread: true, parentChannelId: 'C777' },
      { traceId: 't' }
    )
    expect(m.channel).toBe('C777')
    expect(m.thread).toBe('T555')
    expect(m.promoteToThread).toBeUndefined()
  })

  it('flags a non-guild message as a DM and does not auto-thread it', () => {
    const m = normalizeDiscordMessage({ ...base, inGuild: false }, { traceId: 't' })
    expect(m.isDm).toBe(true)
    expect(m.thread).toBe('C777')
    expect(m.promoteToThread).toBeUndefined()
  })

  it('carries attachments (public CDN url, no auth) when present', () => {
    const m = normalizeDiscordMessage(
      {
        ...base,
        attachments: [{ id: 'a1', name: 'pic.png', contentType: 'image/png', size: 42, url: 'https://cdn/pic.png' }]
      },
      { traceId: 't' }
    )
    expect(m.attachments).toEqual([
      { id: 'a1', name: 'pic.png', mimeType: 'image/png', size: 42, sourceUrl: 'https://cdn/pic.png' }
    ])
  })

  it('marks a bot author', () => {
    expect(normalizeDiscordMessage({ ...base, authorIsBot: true }, { traceId: 't' }).sender.isBot).toBe(true)
  })

  it('uses the enclosing channel plus the concrete thread id for a thread message', () => {
    const m = normalizeDiscordMessage(
      { ...base, channelId: 'T555', isThread: true, parentChannelId: 'C777' },
      { traceId: 't' }
    )
    expect(m.channel).toBe('C777')
    expect(m.thread).toBe('T555')
    expect('parentChannel' in m).toBe(false)
  })

  it('ignores a stray parent id outside a thread', () => {
    const m = normalizeDiscordMessage({ ...base, parentChannelId: 'C777' }, { traceId: 't' })
    expect(m.channel).toBe('C777')
    expect('parentChannel' in m).toBe(false)
  })

  it('renders a mention with the gateway-supplied handle, so a derived title reads a name', () => {
    const m = normalizeDiscordMessage({ ...base, mentionUserNames: { '999': 'acp-tester' } }, { traceId: 't' })
    expect(m.text).toBe('hello @acp-tester')
  })
})

describe('humanizeDiscordText', () => {
  it('rewrites user / role / channel mentions and custom emoji to compact readable forms', () => {
    expect(humanizeDiscordText('hi <@12> <@!34> <@&56> <#78> <:wave:90> <a:spin:91>')).toBe(
      'hi @12 @34 @&56 #78 :wave: :spin:'
    )
  })

  it('rewrites a <t:unix> timestamp to ISO-8601 and leaves plain markdown untouched', () => {
    expect(humanizeDiscordText('at <t:0:F> **bold**')).toBe('at 1970-01-01T00:00:00.000Z **bold**')
  })

  it('uses supplied handles for user mentions and keeps the id when one is unknown', () => {
    expect(humanizeDiscordText('hi <@12> and <@!34>', { '12': 'alice' })).toBe('hi @alice and @34')
  })
})

describe('collapseDiscordChannels', () => {
  it('folds every thread of a channel onto one row (the duplicate-"#general" bug)', () => {
    const observed = [
      { id: 'T3', name: 'general' },
      { id: 'T2', name: 'general' },
      { id: 'T1', name: 'general' }
    ]
    const scopes = new Map([
      ['T1', { parentId: 'C1' }],
      ['T2', { parentId: 'C1' }],
      ['T3', { parentId: 'C1' }]
    ])
    expect(collapseDiscordChannels(observed, scopes, new Map([['C1', 'general']]))).toEqual([
      { id: 'C1', name: 'general' }
    ])
  })

  it('keeps two same-named channels of ONE guild apart (Discord allows duplicate names)', () => {
    // Identity is the snowflake, never the label: merging these would hide a real
    // conversation and make its trigger unconfigurable.
    const observed = [
      { id: 'T1', name: 'general' },
      { id: 'T2', name: 'general' },
      { id: 'C3', name: 'general' }
    ]
    const scopes = new Map([
      ['T1', { parentId: 'C1' }],
      ['T2', { parentId: 'C2' }]
    ])
    expect(collapseDiscordChannels(observed, scopes, new Map())).toEqual([
      { id: 'C1', name: 'general' },
      { id: 'C2', name: 'general' },
      { id: 'C3', name: 'general' }
    ])
  })

  it('keeps an unresolved id distinct from the channel it may belong to', () => {
    // A thread whose parent isn't known yet stays its own row until the lookup resolves
    // it — a transient duplicate is recoverable, a hidden channel is not.
    const observed = [
      { id: 'C1', name: 'general' },
      { id: 'T9', name: 'general' }
    ]
    expect(collapseDiscordChannels(observed, new Map(), new Map())).toEqual([
      { id: 'C1', name: 'general' },
      { id: 'T9', name: 'general' }
    ])
  })

  it('dedupes repeated ids (DM conversations keep one row each)', () => {
    const observed = [
      { id: 'D1', name: '@dana' },
      { id: 'D2', name: '@dana' },
      { id: 'D1', name: '@dana' }
    ]
    expect(collapseDiscordChannels(observed, new Map(), new Map())).toEqual([
      { id: 'D1', name: '@dana' },
      { id: 'D2', name: '@dana' }
    ])
  })

  it('passes an unresolved row through id-only (the console falls back to the id)', () => {
    expect(collapseDiscordChannels([{ id: '900456' }], new Map(), new Map())).toEqual([{ id: '900456' }])
  })

  it('labels each row with the server it sits in (one bot, a "#general" per guild)', () => {
    const observed = [
      { id: 'T1', name: 'general' },
      { id: 'C2', name: 'general' }
    ]
    const scopes = new Map([
      ['T1', { parentId: 'C1' }],
      ['C1', { spaceId: 'G1' }],
      ['C2', { spaceId: 'G2' }]
    ])
    const names = new Map([
      ['C1', 'general'],
      ['C2', 'general'],
      ['G1', 'Acme HQ'],
      ['G2', 'Side Project']
    ])
    expect(collapseDiscordChannels(observed, scopes, names)).toEqual([
      { id: 'C1', name: 'general', spaceId: 'G1', space: 'Acme HQ' },
      { id: 'C2', name: 'general', spaceId: 'G2', space: 'Side Project' }
    ])
  })

  it('takes the guild off the thread when the enclosing channel has no scope of its own', () => {
    const scopes = new Map([['T1', { parentId: 'C1', spaceId: 'G1' }]])
    expect(collapseDiscordChannels([{ id: 'T1', name: 'general' }], scopes, new Map([['G1', 'Acme HQ']]))).toEqual([
      { id: 'C1', name: 'general', spaceId: 'G1', space: 'Acme HQ' }
    ])
  })

  it('carries the guild id even before its name resolves (identity, then label)', () => {
    const scopes = new Map([['C1', { spaceId: 'G1' }]])
    expect(collapseDiscordChannels([{ id: 'C1', name: 'general' }], scopes, new Map())).toEqual([
      { id: 'C1', name: 'general', spaceId: 'G1' }
    ])
  })

  it('keeps two SAME-NAMED guilds apart by id (Discord allows duplicate server names)', () => {
    const scopes = new Map([
      ['C1', { spaceId: 'G1' }],
      ['C2', { spaceId: 'G2' }]
    ])
    const names = new Map([
      ['G1', 'Acme'],
      ['G2', 'Acme']
    ])
    expect(
      collapseDiscordChannels(
        [
          { id: 'C1', name: 'general' },
          { id: 'C2', name: 'general' }
        ],
        scopes,
        names
      )
    ).toEqual([
      { id: 'C1', name: 'general', spaceId: 'G1', space: 'Acme' },
      { id: 'C2', name: 'general', spaceId: 'G2', space: 'Acme' }
    ])
  })

  it('lists the ids whose names the collapse needs — observed, enclosing channels, guilds', () => {
    const scopes = new Map([
      ['T1', { parentId: 'C1' }],
      ['C1', { spaceId: 'G1' }],
      ['C2', { spaceId: 'G2' }]
    ])
    expect(collapseNameLookupIds([{ id: 'T1' }, { id: 'C2' }], scopes)).toEqual(['T1', 'C1', 'G1', 'C2', 'G2'])
  })
})

describe('toAttachment', () => {
  it('drops a malformed / urlless element', () => {
    expect(toAttachment(null)).toBeNull()
    expect(toAttachment({ id: 'x', url: '' } as never)).toBeNull()
    expect(toAttachment({ id: '', url: 'https://cdn/x' } as never)).toBeNull()
  })

  it('defaults name + mimeType', () => {
    expect(toAttachment({ id: 'a', url: 'https://cdn/a' })).toEqual({
      id: 'a',
      name: 'a',
      mimeType: 'application/octet-stream',
      sourceUrl: 'https://cdn/a'
    })
  })
})

describe('chunkForDiscord', () => {
  it('returns a single chunk when under the limit', () => {
    expect(chunkForDiscord('short')).toEqual(['short'])
  })

  it('splits over-limit text into <=limit chunks, preferring boundaries', () => {
    const para = 'a'.repeat(1500) + '\n\n' + 'b'.repeat(1500)
    const chunks = chunkForDiscord(para)
    expect(chunks.length).toBe(2)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT)
    expect(chunks[0]).toBe('a'.repeat(1500))
    expect(chunks[1]).toBe('b'.repeat(1500))
  })

  it('hard-splits a single token longer than the limit', () => {
    const chunks = chunkForDiscord('x'.repeat(4500))
    expect(chunks.length).toBe(3)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT)
    expect(chunks.join('')).toBe('x'.repeat(4500))
  })
})

describe('parseDiscordSelect', () => {
  it('parses a select custom_id into kind + index', () => {
    expect(parseDiscordSelect('ac_sel:m:0')).toEqual({ kind: 'model', index: 0 })
    expect(parseDiscordSelect('ac_sel:e:3')).toEqual({ kind: 'effort', index: 3 })
    expect(parseDiscordSelect('ac_sel:p:12')).toEqual({ kind: 'permission', index: 12 })
  })

  it('rejects status verbs, unknown codes, and malformed ids', () => {
    expect(parseDiscordSelect('ac_cancel')).toBeNull()
    expect(parseDiscordSelect('ac_sel:x:1')).toBeNull()
    expect(parseDiscordSelect('ac_sel:m:')).toBeNull()
    expect(parseDiscordSelect('ac_sel:m:1x')).toBeNull()
  })
})

describe('buildDiscordSelectComponents', () => {
  it('builds one button per option, flags the current, encodes ac_sel:<code>:<index>', () => {
    const rows = buildDiscordSelectComponents('model', 'sonnet', ['opus', 'sonnet', 'haiku'])
    expect(rows).not.toBeNull()
    const buttons = rows!.flatMap((r) => r.components)
    expect(buttons.map((b) => b.custom_id)).toEqual(['ac_sel:m:0', 'ac_sel:m:1', 'ac_sel:m:2'])
    expect(buttons.map((b) => b.label)).toEqual(['opus', '✅ sonnet', 'haiku'])
    expect(buttons[1]!.style).toBe(3) // current → Success style
    expect(buttons[0]!.style).toBe(2) // others → Secondary
  })

  it('chunks options into rows of five', () => {
    const rows = buildDiscordSelectComponents('effort', undefined, ['1', '2', '3', '4', '5', '6', '7'])
    expect(rows!.map((r) => r.components.length)).toEqual([5, 2])
  })

  it('returns null for no options or more than the 25-button ceiling', () => {
    expect(buildDiscordSelectComponents('model', undefined, [])).toBeNull()
    expect(
      buildDiscordSelectComponents(
        'model',
        undefined,
        Array.from({ length: 26 }, (_, i) => `m${i}`)
      )
    ).toBeNull()
  })
})

describe('buildLinkComponents', () => {
  it('builds a single link-button row (style 5, carries the url, no custom_id)', () => {
    const rows = buildLinkComponents('https://example/session/1')
    expect(rows).toHaveLength(1)
    const btn = rows[0]!.components[0]!
    expect(btn).toMatchObject({ type: 2, style: 5, url: 'https://example/session/1' })
    expect(btn.custom_id).toBeUndefined()
  })
})
