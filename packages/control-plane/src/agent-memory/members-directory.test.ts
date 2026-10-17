import { describe, expect, it } from 'vitest'
import { MEMBERS_OPT_OUT_PATH, parseMembersOptOut } from '@agentconnect.md/protocol'
import { AgentId, OrgId } from '../domain/ids.js'
import type { AgentMemoryFileRepo } from '../persistence/ports.js'
import { clearMembersInTables, keyMatchesLinkedIdentity, ownDirectoryKeys } from './members-directory.js'

const AGENT = AgentId('a0a0a0a0-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
const ORG = OrgId('00000000-0000-4000-8000-000000000001')

/** The file table as a map: staged appends, then a commit that checks the mtime it was handed. */
function table(seed: Record<string, string> = {}) {
  const rows = new Map<string, { text: string; mtime: Date }>(
    Object.entries(seed).map(([path, text]) => [path, { text, mtime: new Date('2026-10-01T00:00:00Z') }])
  )
  const staged = new Map<string, string>()
  let tick = 0
  const files: Pick<AgentMemoryFileRepo, 'read' | 'append' | 'commit'> = {
    async read(_agent, path) {
      const row = rows.get(path)
      if (!row) return null
      const slice = Buffer.from(row.text)
      return { size: slice.length, mtime: row.mtime, slice }
    },
    async append(_agent, _org, path, chunk, create) {
      staged.set(path, (create ? '' : (staged.get(path) ?? '')) + Buffer.from(chunk).toString('utf8'))
      return { ok: true, size: staged.get(path)!.length }
    },
    async commit(_agent, path, temp, ifMatchMtime, _now, ifAbsent) {
      const text = staged.get(temp)
      staged.delete(temp)
      if (text === undefined) return { ok: false, reason: 'temp-missing' }
      const row = rows.get(path)
      if (ifAbsent ? row !== undefined : row?.mtime.toISOString() !== ifMatchMtime)
        return { ok: false, reason: 'conflict' }
      const mtime = new Date(Date.UTC(2026, 9, 17, 0, 0, ++tick))
      rows.set(path, { text, mtime })
      return { ok: true, size: text.length, mtime }
    }
  }
  return { files, rows, staged }
}

const MEMBERS = [
  '# Members',
  '',
  '## Alice `slack:T0EXAMPLE:U0ALICE`',
  'Role: release manager (self, 2026-10-02)',
  '',
  '## Bob `user:user-bob`',
  'Works on: billing (#release-train, 2026-10-15)',
  ''
].join('\n')

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

describe('a clear in a Control-Plane home', () => {
  it('marks the keys first, then removes their entries and nothing else', async () => {
    const t = table({ 'memory/members.md': MEMBERS })
    const at = new Date('2026-10-17T00:00:00Z')
    expect(
      await clearMembersInTables(t.files, AGENT, ORG, ['slack:T0EXAMPLE:U0ALICE'], ['slack:T0EXAMPLE:U0ALICE'], at)
    ).toBe(true)
    expect(t.rows.get('memory/members.md')!.text).not.toContain('Alice')
    expect(t.rows.get('memory/members.md')!.text).toContain('## Bob `user:user-bob`')
    expect([...parseMembersOptOut(t.rows.get(MEMBERS_OPT_OUT_PATH)!.text).keys()]).toEqual(['slack:T0EXAMPLE:U0ALICE'])
    expect(t.staged.size).toBe(0)
  })

  it('says there was nothing to clear, and still keeps the person out', async () => {
    const t = table()
    expect(await clearMembersInTables(t.files, AGENT, ORG, ['user:user-carol'], ['user:user-carol'], new Date())).toBe(
      false
    )
    expect(t.rows.has('memory/members.md')).toBe(false)
    expect(parseMembersOptOut(t.rows.get(MEMBERS_OPT_OUT_PATH)!.text).has('user:user-carol')).toBe(true)
  })
})
