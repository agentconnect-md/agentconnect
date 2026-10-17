import { describe, expect, it } from 'vitest'
import {
  MembersOptOutUnreadableError,
  isMemberIdentityKey,
  membersEntryKey,
  parseMembersDirectory,
  parseMembersOptOut,
  renderMembersDirectory,
  renderMembersOptOut,
  withoutMembersEntries
} from './index.js'

const FILE = [
  '---',
  'name: members',
  'description: who works on what',
  '---',
  '# Members',
  '',
  '## Alice (@alice on Slack) `slack:T0EXAMPLE:U0ALICE`',
  'Role: release manager (self, 2026-10-02)',
  '',
  '## Bob `user:user-bob`',
  'Knows about: the billing service (#release-train, 2026-10-15)',
  ''
].join('\n')

describe('the people directory grammar', () => {
  it('reads each entry by the key its heading ends in, and renders the file back exactly', () => {
    const directory = parseMembersDirectory(FILE)
    expect(directory.preamble[0]).toBe('---')
    expect(directory.entries.map((e) => e.key)).toEqual(['slack:T0EXAMPLE:U0ALICE', 'user:user-bob'])
    expect(directory.entries[0]!.lines).toEqual(['Role: release manager (self, 2026-10-02)', ''])
    expect(renderMembersDirectory(directory)).toBe(FILE)
  })

  it('accepts a console key or a platform key whose tenant may hold a colon, and nothing else', () => {
    expect(isMemberIdentityKey('user:abc')).toBe(true)
    expect(isMemberIdentityKey('feishu:feishu:cli_a:ou_1')).toBe(true)
    expect(isMemberIdentityKey('slack:T1')).toBe(false)
    expect(isMemberIdentityKey('Alice')).toBe(false)
    expect(membersEntryKey('Alice (@alice)')).toBeUndefined()
    expect(membersEntryKey('Alice `not a key`')).toBeUndefined()
  })

  it('removes the entries of the named keys and leaves the rest as written', () => {
    const { text, removed } = withoutMembersEntries(FILE, ['slack:T0EXAMPLE:U0ALICE', 'user:nobody'])
    expect(removed).toEqual(['slack:T0EXAMPLE:U0ALICE'])
    expect(text).not.toContain('Alice')
    expect(text).toContain('## Bob `user:user-bob`')
    expect(withoutMembersEntries(FILE, ['user:nobody'])).toEqual({ text: FILE, removed: [] })
  })

  it('keeps the opt-out marker as sorted keys with their dates, and refuses a malformed one', () => {
    const marker = renderMembersOptOut(
      new Map([
        ['user:b', '2026-10-17'],
        ['slack:T1:U1', '2026-10-16']
      ])
    )
    expect([...parseMembersOptOut(marker).keys()]).toEqual(['slack:T1:U1', 'user:b'])
    expect(parseMembersOptOut(null).size).toBe(0)
    expect(() => parseMembersOptOut('{nope')).toThrow(MembersOptOutUnreadableError)
    expect(() => parseMembersOptOut('[]')).toThrow(MembersOptOutUnreadableError)
  })
})
