import { describe, expect, it } from 'vitest'
import { keyMatchesLinkedIdentity, ownDirectoryKeys } from './members-directory.js'

describe("a console user's own directory keys", () => {
  it('match a linked chat identity by platform and member, under its tenant or one that contains it', () => {
    expect(
      keyMatchesLinkedIdentity('slack:T0EXAMPLE:U0ALICE', {
        platform: 'slack',
        tenant: 'T0EXAMPLE',
        memberId: 'U0ALICE'
      })
    ).toBe(true)
    expect(
      keyMatchesLinkedIdentity('slack:T0OTHER:U0ALICE', { platform: 'slack', tenant: 'T0EXAMPLE', memberId: 'U0ALICE' })
    ).toBe(false)
    expect(
      keyMatchesLinkedIdentity('feishu:lark:cli_a:on_1', { platform: 'feishu', tenant: 'lark', memberId: 'on_1' })
    ).toBe(true)
    expect(keyMatchesLinkedIdentity('discord:bot1:42', { platform: 'discord', tenant: 'global', memberId: '42' })).toBe(
      true
    )
    expect(keyMatchesLinkedIdentity('user:42', { platform: 'discord', tenant: 'global', memberId: '42' })).toBe(false)
  })

  it('are their console key and the linked identities entries are keyed by, never anyone else', () => {
    const links = [{ platform: 'slack', tenant: 'T0EXAMPLE', memberId: 'U0ALICE' }]
    expect(ownDirectoryKeys('user-alice', ['slack:T0EXAMPLE:U0ALICE', 'user:user-bob'], links)).toEqual([
      'user:user-alice',
      'slack:T0EXAMPLE:U0ALICE'
    ])
    expect(ownDirectoryKeys('user-bob', ['slack:T0EXAMPLE:U0ALICE'], [])).toEqual(['user:user-bob'])
  })
})
