// The read rule (assistant-mode.md §5.5): a read of another conversation is judged by who is asking.
import { describe, expect, it, vi } from 'vitest'
import {
  askerMayRead,
  askerUnlinked,
  checkPlaceRead,
  isPrivateSource,
  NOBODY,
  NOT_SHARED_HERE,
  NOT_SHARED_UNLINKED,
  privateSourceNote,
  readRefusal,
  sourceClass,
  type ConsoleVerdict,
  type ReadAsker,
  type ReadLookups,
  type SourcePlace,
  type TurnAskers
} from '../src/assistant/place-access.js'

const BOT = 'int-slack'
const publicChannel: SourcePlace = { platform: 'slack', channel: 'C_PUB', kind: 'channel', private: false }
const privateChannel: SourcePlace = { platform: 'slack', channel: 'C_PRIV', kind: 'channel', private: true }
const groupDm: SourcePlace = { platform: 'slack', channel: 'G_MPIM', kind: 'group_dm', private: true }
const dmOfP: SourcePlace = { platform: 'slack', channel: 'D_P', kind: 'dm' }
const dmOfQ: SourcePlace = { platform: 'slack', channel: 'D_Q', kind: 'dm' }

const P: ReadAsker = { kind: 'member', platform: 'slack', integrationId: BOT, userId: 'U_P' }
const GUEST: ReadAsker = { kind: 'member', platform: 'slack', integrationId: BOT, userId: 'U_GUEST' }
const people = (...p: ReadAsker[]): TurnAskers => ({ people: p, nobody: false })

/** A Slack workspace where P and Q are full members and the guest is in C_GUESTS alone; the console knows U_P as user-p. */
function lookups(over: Partial<ReadLookups> = {}): ReadLookups {
  const members: Record<string, string[]> = {
    C_PRIV: ['U_P'],
    G_MPIM: ['U_P', 'U_Q'],
    D_P: ['U_P', 'B_BOT'],
    D_Q: ['U_Q', 'B_BOT'],
    C_GUESTS: ['U_GUEST']
  }
  // The console shows user-p an org-visible DM someone else owns; only its owner may read it.
  const visibleTo: Record<string, string[]> = {
    'user-p': ['ses-tg-group', 'ses-web-p', 'ses-web-q', 'ses-dc-dm-p', 'ses-dc-dm-q', 'ses-dm-unowned']
  }
  const owners: Record<string, string> = {
    'ses-web-p': 'user-p',
    'ses-web-q': 'user-q',
    'ses-dc-dm-p': 'user-p',
    'ses-dc-dm-q': 'user-q'
  }
  return {
    member: vi.fn(async (_bot: string, channel: string, user: string) => members[channel]?.includes(user) === true),
    fullMember: vi.fn(async (_bot: string, user: string) => user === 'U_P' || user === 'U_Q'),
    console: vi.fn(
      async (asker: ReadAsker, sessions: readonly string[], ownerOnly: boolean): Promise<ConsoleVerdict> => {
        if (asker.kind === 'member' && asker.platform !== 'slack') return { asker: 'unidentifiable' }
        const user = asker.kind === 'console' ? asker.userId : asker.userId === 'U_P' ? 'user-p' : undefined
        if (!user) return { asker: 'unlinked' }
        const sees = (id: string) => visibleTo[user]?.includes(id) === true && (!ownerOnly || owners[id] === user)
        return { asker: 'linked', visible: new Set(sessions.filter(sees)) }
      }
    ),
    ...over
  }
}

const judge = (source: SourcePlace, askers: TurnAskers, l: ReadLookups = lookups(), bot: string | undefined = BOT) =>
  readRefusal(source, askers, (asker) => askerMayRead(asker, source, bot, l), bot === BOT)

describe('sourceClass', () => {
  it('confirms a channel public only where its platform reports privacy itself', () => {
    expect(sourceClass(publicChannel)).toBe('public')
    expect(sourceClass({ ...publicChannel, platform: 'discord' })).toBe('public')
    expect(sourceClass({ ...publicChannel, platform: 'feishu' })).toBe('public')
    // A platform that cannot confirm a public channel: Google Chat declares no privacy report.
    expect(sourceClass({ ...publicChannel, platform: 'googlechat' })).toBe('undetermined')
    expect(sourceClass({ ...publicChannel, private: undefined })).toBe('undetermined')
    expect(sourceClass({ platform: 'slack', channel: 'C_X' })).toBe('undetermined')
  })

  it("keeps a private channel and a group DM their members', a DM direct and webchat its own", () => {
    expect(sourceClass(privateChannel)).toBe('members')
    expect(sourceClass({ ...groupDm, private: undefined })).toBe('members')
    expect(sourceClass(dmOfP)).toBe('direct')
    expect(sourceClass({ platform: 'webchat', channel: 'chat-1', kind: 'webchat' })).toBe('webchat')
    expect([privateChannel, groupDm, dmOfP].every(isPrivateSource)).toBe(true)
    expect(isPrivateSource(publicChannel)).toBe(false)
  })
})

describe('on the asker’s own platform and bot', () => {
  it('reads a private channel and a group DM they are in, and refuses one they are not in', async () => {
    expect(await judge(privateChannel, people(P))).toBeUndefined()
    expect(await judge(groupDm, people(P))).toBeUndefined()
    expect(await judge({ ...privateChannel, channel: 'C_OTHER_PRIV' }, people(P))).toBe('private')
  })

  it("reads their own DM, and never someone else's", async () => {
    expect(await judge(dmOfP, people(P))).toBeUndefined()
    expect(await judge(dmOfQ, people(P))).toBe('direct')
  })

  it('reads a public channel as a full member, and refuses a guest one they are not in', async () => {
    expect(await judge(publicChannel, people(P))).toBeUndefined()
    expect(await judge(publicChannel, people(GUEST))).toBe('private')
    expect(await judge({ ...publicChannel, channel: 'C_GUESTS' }, people(GUEST))).toBeUndefined()
  })

  it('opens what a platform that cannot tell standing confirms public, and nothing it cannot confirm', async () => {
    const discordUser: ReadAsker = { kind: 'member', platform: 'discord', integrationId: 'int-dc', userId: '42' }
    const discord = (source: SourcePlace) =>
      readRefusal(
        { ...source, platform: 'discord' },
        people(discordUser),
        (asker) => askerMayRead(asker, { ...source, platform: 'discord' }, 'int-dc', lookups()),
        true
      )
    expect(await discord(publicChannel)).toBeUndefined()
    expect(await discord(privateChannel)).toBe('private')
    expect(await discord(dmOfP)).toBe('direct')
  })

  it('refuses a read when one of several folded senders lacks access', async () => {
    const q: ReadAsker = { ...P, userId: 'U_Q' }
    expect(await judge(privateChannel, people(P, q))).toBe('private')
    expect(await judge(groupDm, people(P, q))).toBeUndefined()
    expect(await judge(dmOfP, people(P, q))).toBe('direct')
  })

  it('refuses when a lookup fails', async () => {
    const failing = lookups({ member: async () => Promise.reject(new Error('ratelimited')) })
    expect(await judge(privateChannel, people(P), failing)).toBe('private')
  })
})

describe('a turn no person is behind', () => {
  it('reads only what its own bot confirms public, and nothing on another platform or bot', async () => {
    expect(await judge(publicChannel, NOBODY)).toBeUndefined()
    expect(await judge(privateChannel, NOBODY)).toBe('private')
    expect(await judge(groupDm, NOBODY)).toBe('private')
    expect(await judge(dmOfP, NOBODY)).toBe('direct')
    expect(await judge({ ...publicChannel, sessions: ['ses-tg-group'] }, NOBODY, lookups(), 'int-other')).toBe(
      'private'
    )
    // Part of a turn with no person behind it narrows a person's own reach too.
    expect(await judge(privateChannel, { people: [P], nobody: true })).toBe('private')
  })
})

describe('across platforms and bots: as the console would show it to the person', () => {
  const tgGroup: SourcePlace = {
    platform: 'telegram',
    channel: '-1002',
    kind: 'channel',
    private: true,
    sessions: ['ses-tg-group']
  }

  it('reads a linked member a group on an unsynced platform the console shows them', async () => {
    expect(await judge(tgGroup, people(P), lookups(), 'int-tg')).toBeUndefined()
    // Every session the read would show must be visible.
    expect(await judge({ ...tgGroup, sessions: ['ses-tg-group', 'ses-hidden'] }, people(P), lookups(), 'int-tg')).toBe(
      'private'
    )
    expect(await judge({ ...tgGroup, sessions: [] }, people(P), lookups(), 'int-tg')).toBe('private')
  })

  it('refuses an asker the console cannot identify, on any other platform', async () => {
    const tgUser: ReadAsker = { kind: 'member', platform: 'telegram', integrationId: 'int-tg', userId: '42' }
    expect(await judge({ ...publicChannel, sessions: ['ses-tg-group'] }, people(tgUser))).toBe('private')
    const discordGroup: SourcePlace = {
      platform: 'discord',
      channel: 'dc-1',
      kind: 'channel',
      private: false,
      sessions: ['ses-tg-group']
    }
    expect(await judge(discordGroup, people(tgUser), lookups(), 'int-dc')).toBe('private')
  })

  it('reads a DM on another platform only for its owner, even one the console shows every member', async () => {
    const l = lookups()
    const dcDm: SourcePlace = { platform: 'discord', channel: 'dc-dm', kind: 'dm', sessions: ['ses-dc-dm-p'] }
    expect(await judge(dcDm, people(P), l, 'int-dc')).toBeUndefined()
    expect(await judge({ ...dcDm, sessions: ['ses-dc-dm-q'] }, people(P), l, 'int-dc')).toBe('direct')
    // A DM no one is recorded as owning is nobody's to read.
    expect(await judge({ ...dcDm, sessions: ['ses-dm-unowned'] }, people(P), l, 'int-dc')).toBe('direct')
    // An undescribed place is held to the same bar; a shared group is not.
    expect(await judge({ ...dcDm, kind: undefined, sessions: ['ses-dc-dm-q'] }, people(P), l, 'int-dc')).toBe(
      'undetermined'
    )
    expect(vi.mocked(l.console).mock.calls.map((call) => call[2])).toEqual([true, true, true, true])
    const group: SourcePlace = { platform: 'discord', channel: 'dc-1', kind: 'channel', sessions: ['ses-tg-group'] }
    await judge(group, people(P), l, 'int-dc')
    expect(vi.mocked(l.console).mock.calls.at(-1)?.[2]).toBe(false)
  })

  it('reads a webchat conversation only for its owner, not for another member the console shows it to', async () => {
    const web: SourcePlace = { platform: 'webchat', channel: 'chat-1', kind: 'webchat', sessions: ['ses-web-p'] }
    expect(await judge(web, people({ kind: 'console', userId: 'user-p' }), lookups(), undefined)).toBeUndefined()
    expect(await judge(web, people({ kind: 'console', userId: 'user-q' }), lookups(), undefined)).toBe('direct')
    const theirs = { ...web, sessions: ['ses-web-q'] }
    expect(await judge(theirs, people({ kind: 'console', userId: 'user-p' }), lookups(), undefined)).toBe('direct')
  })

  it('judges a console asker by the console alone, wherever the source is', async () => {
    const consoleP: ReadAsker = { kind: 'console', userId: 'user-p' }
    expect(await judge({ ...privateChannel, sessions: ['ses-tg-group'] }, people(consoleP))).toBeUndefined()
    expect(await judge({ ...privateChannel, sessions: ['ses-other'] }, people(consoleP))).toBe('private')
  })

  it('refuses when the Control Plane cannot answer', async () => {
    const offline = lookups({ console: async () => Promise.reject(new Error('offline')) })
    expect(await judge(tgGroup, people(P), offline, 'int-tg')).toBe('private')
  })
})

describe('askerUnlinked', () => {
  it('names an unlinked chat member, never a linked one, a console user or one who cannot link', async () => {
    expect(await askerUnlinked(people({ ...P, userId: 'U_NOBODY' }), lookups())).toBe(true)
    expect(await askerUnlinked(people(P), lookups())).toBe(false)
    expect(await askerUnlinked(people({ kind: 'console', userId: 'user-x' }), lookups())).toBe(false)
    const tgUser: ReadAsker = { kind: 'member', platform: 'telegram', integrationId: 'int-tg', userId: '1' }
    expect(await askerUnlinked(people(tgUser), lookups())).toBe(false)
    expect(await askerUnlinked(NOBODY, lookups())).toBe(false)
  })
})

describe('checkPlaceRead', () => {
  it('always reads the current conversation, and counts a refusal by tool and reason only', async () => {
    const recorder = { refused: vi.fn() }
    const mayRead = vi.fn(async () => true)
    const check = (
      tool: Parameters<typeof checkPlaceRead>[0],
      current: SourcePlace,
      source: SourcePlace,
      askers: TurnAskers
    ) => checkPlaceRead(tool, current, source, askers, mayRead, true, recorder)
    expect(await check('recall', privateChannel, privateChannel, NOBODY)).toBeUndefined()
    expect(await check('recall', publicChannel, dmOfQ, NOBODY)).toBe('direct')
    expect(await check('getChannelHistory', publicChannel, privateChannel, NOBODY)).toBe('private')
    expect(await check('getReactions', publicChannel, { platform: 'slack', channel: 'C_X' }, NOBODY)).toBe(
      'undetermined'
    )
    expect(await check('listBookmarks', publicChannel, privateChannel, people(P))).toBeUndefined()
    expect(recorder.refused.mock.calls).toEqual([
      ['recall', 'direct'],
      ['getChannelHistory', 'private'],
      ['getReactions', 'undetermined']
    ])
    expect(mayRead).toHaveBeenCalledTimes(1)
  })
})

describe('the answers it gives', () => {
  it('refuses with one opaque answer that never says what or where, and tells an unlinked asker how to link', () => {
    expect(NOT_SHARED_HERE).toContain("I can't share that here.")
    expect(NOT_SHARED_HERE).not.toMatch(/private|channel|direct|link/i)
    expect(NOT_SHARED_UNLINKED.startsWith(NOT_SHARED_HERE)).toBe(true)
    expect(NOT_SHARED_UNLINKED).toMatch(/Sign-in methods in their console Profile/)
  })

  it('names a private source and asks the model to say where it came from', () => {
    expect(privateSourceNote({ ...privateChannel, name: 'leadership' })).toMatch(
      /^This comes from the private channel "leadership", a private conversation\. .*one short clause/
    )
    expect(privateSourceNote(dmOfP)).toContain('the direct message "D_P"')
    expect(privateSourceNote(groupDm)).toContain('the group DM')
  })
})
