// The people directory's person rules (assistant-mode.md §5.17): who an entry may be about, on whose turn, and who opted out.
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MEMBERS_OPT_OUT_PATH } from '@agentconnect.md/protocol'
import { MemoryEntriesError } from '../src/memory/entries/contract.js'
import { LocalMemoryFs } from '../src/memory/fs.js'
import { sidecarMemoryHistory } from '../src/memory/home.js'
import {
  checkMembersWrite,
  clearMembers,
  lineSource,
  membersKeys,
  readMembersOptOut,
  relinkMembers,
  updateMembersOptOut,
  type MembersLookups,
  type MembersWriter
} from '../src/memory/members-directory.js'
import { readMemoryFileIfPresent, writeMemoryFile } from '../src/memory/store.js'

const ALICE = 'slack:T0EXAMPLE:U0ALICE'
const BOB = 'slack:T0EXAMPLE:U0BOB'
const CAROL = 'user:user-carol'
const OUTSIDER = 'slack:T0EXAMPLE:U0GUEST'
const HEAD = '---\nname: members\ndescription: who works on what\n---\n# Members\n'

const entry = (name: string, key: string, ...lines: string[]) => [`## ${name} \`${key}\``, ...lines].join('\n')
const file = (...entries: string[]) => [HEAD, ...entries].join('\n')

function lookups(
  over: { members?: string[]; linked?: Record<string, string>; optedOut?: string[] } = {}
): MembersLookups {
  const members = new Set(over.members ?? [ALICE, BOB, CAROL])
  return {
    member: async (key) => members.has(key),
    consoleKey: async (key) => over.linked?.[key],
    optedOut: async () => new Map((over.optedOut ?? []).map((k) => [k, '2026-10-01']))
  }
}

/** A builder whose round read these people, each in these places. */
const seenIn = (seen: Record<string, string[]>): MembersWriter => ({
  kind: 'builder',
  seen: new Map(Object.entries(seen).map(([key, places]) => [key, new Set(places)]))
})

const conversation = (senders: string[], mentioned: string[] = [], place = 'release-train'): MembersWriter => ({
  kind: 'conversation',
  senders: new Set(senders),
  mentioned: new Set(mentioned),
  place
})

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e
  )
  expect(error).toBeInstanceOf(MemoryEntriesError)
  return (error as Error).message
}

describe('an entry written on a conversation turn', () => {
  it("takes the sender's own words as self and a mentioned person's as the place's", async () => {
    const after = file(
      entry('Alice', ALICE, 'Role: release manager (self, 2026-10-17)'),
      entry('Bob', BOB, 'Works on: billing (#release-train, 2026-10-17)')
    )
    expect(await checkMembersWrite(null, after, conversation([ALICE], [BOB]), lookups())).toEqual({
      optOut: [],
      lift: []
    })
  })

  it('refuses an entry about someone not on the turn, naming who is', async () => {
    const after = file(entry('Bob', BOB, 'Works on: billing (#release-train, 2026-10-17)'))
    const message = await refusal(checkMembersWrite(null, after, conversation([ALICE]), lookups()))
    expect(message).toContain('not on this turn')
    expect(message).toContain(`\`${ALICE}\` (sent this)`)
  })

  it('refuses self for someone who only was mentioned, and a source that is not this place', async () => {
    const self = file(entry('Bob', BOB, 'Role: billing owner (self, 2026-10-17)'))
    expect(await refusal(checkMembersWrite(null, self, conversation([ALICE], [BOB]), lookups()))).toContain(
      'sourced self'
    )
    const elsewhere = file(entry('Bob', BOB, 'Role: billing owner (#other-room, 2026-10-17)'))
    expect(await refusal(checkMembersWrite(null, elsewhere, conversation([ALICE], [BOB]), lookups()))).toContain(
      'must be sourced #release-train'
    )
  })

  it('checks only the lines the write adds, so an older line keeps its source', async () => {
    const before = file(entry('Bob', BOB, 'Knows about: billing (example-org/example-repo CODEOWNERS, 2026-10-01)'))
    const after = file(
      entry(
        'Bob',
        BOB,
        'Knows about: billing (example-org/example-repo CODEOWNERS, 2026-10-01)',
        'Works on: invoices (#release-train, 2026-10-17)'
      )
    )
    await expect(checkMembersWrite(before, after, conversation([ALICE], [BOB]), lookups())).resolves.toBeDefined()
    // An entry the write leaves alone is never checked, even about someone absent.
    const other = file(entry('Alice', ALICE, 'Role: release manager (self, 2026-10-17)'))
    await expect(
      checkMembersWrite(
        before,
        `${other}\n${entry('Bob', BOB, 'Knows about: billing (example-org/example-repo CODEOWNERS, 2026-10-01)')}`,
        conversation([ALICE]),
        lookups()
      )
    ).resolves.toBeDefined()
  })

  it('refuses a non-member, someone who opted out, a keyless heading and a key used twice', async () => {
    const guest = file(entry('Guest', OUTSIDER, 'Role: visitor (self, 2026-10-17)'))
    expect(await refusal(checkMembersWrite(null, guest, conversation([OUTSIDER]), lookups()))).toContain(
      'not about a member'
    )
    const alice = file(entry('Alice', ALICE, 'Role: release manager (self, 2026-10-17)'))
    expect(
      await refusal(checkMembersWrite(null, alice, conversation([ALICE]), lookups({ optedOut: [ALICE] })))
    ).toContain('cleared their entry')
    const keyless = file('## Alice\nRole: release manager (self, 2026-10-17)')
    expect(await refusal(checkMembersWrite(null, keyless, conversation([ALICE]), lookups()))).toContain(
      'ends in no identity key'
    )
    expect(await refusal(checkMembersWrite(null, file(alice, alice), conversation([ALICE]), lookups()))).toContain(
      'two entries'
    )
  })

  it('asks for the console key of a linked platform identity, which a cleared console account then covers', async () => {
    const alice = file(entry('Alice', ALICE, 'Role: release manager (self, 2026-10-17)'))
    const linked = { [ALICE]: CAROL }
    expect(
      await refusal(
        checkMembersWrite(null, alice, conversation([ALICE, CAROL]), lookups({ linked, optedOut: [CAROL] }))
      )
    ).toContain(`key it \`${CAROL}\``)
    const carol = file(entry('Alice', CAROL, 'Role: release manager (self, 2026-10-17)'))
    await expect(
      checkMembersWrite(null, carol, conversation([ALICE, CAROL]), lookups({ linked }))
    ).resolves.toBeDefined()
  })

  it('removes an entry only of someone on the turn', async () => {
    const before = file(
      entry('Alice', ALICE, 'Role: x (self, 2026-10-01)'),
      entry('Bob', BOB, 'Role: y (self, 2026-10-01)')
    )
    const withoutBob = file(entry('Alice', ALICE, 'Role: x (self, 2026-10-01)'))
    expect(await refusal(checkMembersWrite(before, withoutBob, conversation([ALICE]), lookups()))).toContain('stays')
    await expect(checkMembersWrite(before, withoutBob, conversation([ALICE], [BOB]), lookups())).resolves.toEqual({
      optOut: [],
      lift: []
    })
  })

  it('refuses a round no person is behind, a private place and a dream with the reason the writer carries', async () => {
    const reason = 'it is written only on a turn a person typed.'
    expect(
      await refusal(checkMembersWrite(null, file(entry('Alice', ALICE)), { kind: 'refused', reason }, lookups()))
    ).toBe(`members.md: ${reason} Nothing was saved.`)
  })
})

describe('an opt-out across linked identities', () => {
  it('keeps out a person who cleared their platform entry and then linked a console account', async () => {
    const carol = file(entry('Carol', CAROL, 'Role: designer (self, 2026-10-17)'))
    const linked = { [ALICE]: CAROL }
    expect(
      await refusal(
        checkMembersWrite(null, carol, conversation([ALICE, CAROL]), lookups({ linked, optedOut: [ALICE] }))
      )
    ).toContain('cleared their entry')
    const read = file(entry('Carol', CAROL, 'Role: designer (#release-train, 2026-10-17)'))
    expect(
      await refusal(
        checkMembersWrite(null, read, seenIn({ [CAROL]: ['release-train'] }), lookups({ linked, optedOut: [ALICE] }))
      )
    ).toContain('cleared their entry')
  })

  it('refuses a heading written with a tab like any other, so its person is checked', async () => {
    const tabbed = file(`##\tAlice (@alice on Slack) \`${ALICE}\`\nRole: x (self, 2026-10-17)`)
    expect(
      await refusal(checkMembersWrite(null, tabbed, { kind: 'own', keys: [BOB] }, lookups({ optedOut: [ALICE] })))
    ).toContain('only your own entry')
  })
})

describe('a first look or research', () => {
  const bob = file(entry('Bob', BOB, 'Role: billing owner (#release-train, 2026-10-17)'))

  it('adds someone whose messages its round read, sourced by a place it read them in', async () => {
    await expect(checkMembersWrite(null, bob, seenIn({ [BOB]: ['release-train'] }), lookups())).resolves.toEqual({
      optOut: [],
      lift: []
    })
    // Membership and the opt-out still decide, as everywhere.
    const seen = seenIn({ [BOB]: ['release-train'] })
    expect(await refusal(checkMembersWrite(null, bob, seen, lookups({ optedOut: [BOB] })))).toContain(
      'cleared their entry'
    )
    expect(await refusal(checkMembersWrite(null, bob, seen, lookups({ members: [] })))).toContain('not about a member')
  })

  it('refuses someone its round did not read, listing whom it read and where', async () => {
    const message = await refusal(
      checkMembersWrite(null, bob, seenIn({ [ALICE]: ['release-train', 'ops'] }), lookups())
    )
    expect(message).toContain('whose messages this round did not read')
    expect(message).toContain(`\`${ALICE}\` (#release-train, #ops)`)
    expect(await refusal(checkMembersWrite(null, bob, seenIn({}), lookups()))).toContain("read no one's messages")
  })

  it('refuses a line sourced by a place where its round did not read that person, or sourced self', async () => {
    const elsewhere = file(entry('Bob', BOB, 'Role: billing owner (#ops, 2026-10-17)'))
    expect(
      await refusal(checkMembersWrite(null, elsewhere, seenIn({ [BOB]: ['release-train'] }), lookups()))
    ).toContain('must be sourced by a place where this round read their messages: #release-train')
    const self = file(entry('Bob', BOB, 'Role: billing owner (self, 2026-10-17)'))
    expect(await refusal(checkMembersWrite(null, self, seenIn({ [BOB]: ['release-train'] }), lookups()))).toContain(
      'sourced self'
    )
  })

  it('keeps a code-host source for an entry already there, and starts no new one from it', async () => {
    const owner = 'Knows about: billing (example-org/example-repo CODEOWNERS, 2026-10-17)'
    const old = file(entry('Bob', BOB, 'Role: billing owner (#release-train, 2026-10-01)'))
    const added = file(entry('Bob', BOB, 'Role: billing owner (#release-train, 2026-10-01)', owner))
    await expect(checkMembersWrite(old, added, seenIn({}), lookups())).resolves.toBeDefined()
    await expect(
      checkMembersWrite(null, file(entry('Bob', BOB, owner)), seenIn({ [BOB]: ['release-train'] }), lookups())
    ).rejects.toThrow('must be sourced by a place where this round read their messages')
  })
})

describe("a person's own conversation", () => {
  const own: MembersWriter = { kind: 'own', keys: [CAROL, ALICE] }

  it('changes only their own entry, under their console key, in their own words', async () => {
    const before = file(entry('Bob', BOB, 'Role: billing owner (#release-train, 2026-10-01)'))
    const mine = `${before}\n${entry('Carol', CAROL, 'Role: designer (self, 2026-10-17)')}`
    await expect(checkMembersWrite(before, mine, own, lookups())).resolves.toEqual({ optOut: [], lift: [] })
    const bob = file(entry('Bob', BOB, 'Role: tester (#release-train, 2026-10-01)'))
    expect(await refusal(checkMembersWrite(before, bob, own, lookups()))).toContain('only your own entry')
    const sourced = file(entry('Carol', CAROL, 'Role: designer (#release-train, 2026-10-17)'))
    expect(await refusal(checkMembersWrite(null, sourced, own, lookups()))).toContain('must be sourced self')
    const platformKeyed = file(entry('Carol', ALICE, 'Role: designer (self, 2026-10-17)'))
    expect(await refusal(checkMembersWrite(null, platformKeyed, own, lookups()))).toContain(`under \`${CAROL}\``)
  })

  it('opts them out by every key they are known by when they remove their entry, and lifts it when they write it again', async () => {
    const mine = file(entry('Carol', CAROL, 'Role: designer (self, 2026-10-17)'))
    expect(await checkMembersWrite(mine, file(), own, lookups())).toEqual({ optOut: [CAROL, ALICE], lift: [] })
    expect(await checkMembersWrite(null, mine, own, lookups({ optedOut: [CAROL] }))).toEqual({
      optOut: [],
      lift: [CAROL]
    })
    // Every mark they carry lifts, a linked identity's included, so the next relink keeps the entry.
    expect(
      await checkMembersWrite(null, mine, own, lookups({ optedOut: [CAROL, ALICE], linked: { [ALICE]: CAROL } }))
    ).toEqual({ optOut: [], lift: [CAROL, ALICE] })
    // Moving an older platform-keyed entry onto the console key keeps them in.
    const old = file(entry('Carol', ALICE, 'Role: designer (self, 2026-10-01)'))
    expect(await checkMembersWrite(old, mine, own, lookups())).toEqual({ optOut: [], lift: [] })
  })
})

describe('the opt-out marker and the directory file', () => {
  function tree() {
    const fs = new LocalMemoryFs(mkdtempSync(join(tmpdir(), 'ac-members-')))
    return { fs, history: sidecarMemoryHistory(fs) }
  }
  const seed = async (fs: LocalMemoryFs, history: ReturnType<typeof sidecarMemoryHistory>, text: string) =>
    writeMemoryFile(fs, 'members.md', text, undefined, 'tool', history)
  const now = new Date('2026-10-17T00:00:00Z')

  it('keeps the marker beside the person layers, out of every memory store', async () => {
    const { fs } = tree()
    await updateMembersOptOut(fs, { add: [ALICE, BOB] }, now)
    await updateMembersOptOut(fs, { remove: [BOB] }, now)
    expect([...(await readMembersOptOut(fs)).keys()]).toEqual([ALICE])
    expect(MEMBERS_OPT_OUT_PATH.startsWith('people/')).toBe(true)
    expect(await fs.readFile(MEMBERS_OPT_OUT_PATH)).not.toBeNull()
  })

  it('clears entries and marks their people, saying whether one was there', async () => {
    const { fs, history } = tree()
    await seed(
      fs,
      history,
      file(entry('Alice', ALICE, 'Role: x (self, 2026-10-01)'), entry('Bob', BOB, 'Role: y (self, 2026-10-01)'))
    )
    expect(await clearMembers(fs, history, [ALICE], [ALICE], now)).toBe(true)
    expect(await membersKeys(fs)).toEqual([BOB])
    expect((await readMembersOptOut(fs)).has(ALICE)).toBe(true)
    expect(await clearMembers(fs, history, [ALICE], [], now)).toBe(false)
  })

  it('moves a platform-keyed entry onto the console key on linking, and drops it when one is there', async () => {
    const { fs, history } = tree()
    await seed(fs, history, file(entry('Alice (@alice on Slack)', ALICE, 'Role: x (self, 2026-10-01)')))
    await relinkMembers(fs, history, ALICE, CAROL, now)
    expect(await membersKeys(fs)).toEqual([CAROL])
    expect(await readMemoryFileIfPresent(fs, 'members.md')).toContain(`## Alice (@alice on Slack) \`${CAROL}\``)
    await seed(
      fs,
      history,
      file(entry('Alice', ALICE, 'Role: old (self, 2026-10-01)'), entry('Alice', CAROL, 'Role: new (self, 2026-10-17)'))
    )
    await relinkMembers(fs, history, ALICE, CAROL, now)
    expect(await readMemoryFileIfPresent(fs, 'members.md')).not.toContain('Role: old')
  })

  it('keeps an entry its person wrote again once every mark they carried lifted', async () => {
    const { fs, history } = tree()
    await updateMembersOptOut(fs, { add: [ALICE, CAROL] }, now)
    await updateMembersOptOut(fs, { remove: [CAROL, ALICE] }, now)
    await seed(fs, history, file(entry('Alice', CAROL, 'Role: x (self, 2026-10-17)')))
    await relinkMembers(fs, history, ALICE, CAROL, now)
    expect(await membersKeys(fs)).toEqual([CAROL])
  })

  it('carries an opt-out across linking to both keys and drops their entries', async () => {
    const { fs, history } = tree()
    await seed(fs, history, file(entry('Alice', CAROL, 'Role: x (self, 2026-10-01)')))
    await updateMembersOptOut(fs, { add: [ALICE] }, now)
    await relinkMembers(fs, history, ALICE, CAROL, now)
    expect([...(await readMembersOptOut(fs)).keys()].sort()).toEqual([CAROL, ALICE].sort())
    expect(await membersKeys(fs)).toEqual([])
  })
})

describe('a line source', () => {
  it('reads the source before the date, with or without (inferred)', () => {
    expect(lineSource('Role: x (self, 2026-10-02)')).toBe('self')
    expect(lineSource('Ask about: dates (#release-train, 2026-10-15) (inferred)')).toBe('#release-train')
    expect(lineSource('Role: no source')).toBeUndefined()
  })
})
