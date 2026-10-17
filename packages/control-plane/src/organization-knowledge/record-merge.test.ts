// The one-time move's mechanical merges (assistant-mode.md §5.16 "Migration").
import { describe, expect, it } from 'vitest'
import { parseOrganizationFile } from '@agentconnect.md/protocol'
import { mergeAbout, mergeChannels, mergePeople } from './record-merge.js'

const at = (day: number) => new Date(Date.UTC(2026, 9, day))

describe('mergeAbout', () => {
  it('keeps the newest copy as the base and adds the lines it lacks to the same section', () => {
    const older = [
      '# Example Org',
      'Example Org builds release tooling (#general, 2026-10-01)',
      'It sells to platform teams (#general, 2026-10-02)',
      '',
      '## Repositories and systems',
      '- example-org/example-repo holds the billing service (example-org/example-repo, 2026-10-03)'
    ].join('\n')
    const newer = [
      '# Example Org',
      'Example Org builds release tooling (#general, 2026-10-05)',
      '',
      '## How it works',
      'Releases are cut on Tuesdays (#release, 2026-10-06)'
    ].join('\n')
    const merged = mergeAbout([
      { text: older, at: at(3) },
      { text: newer, at: at(6) }
    ])
    expect(merged).toBe(
      [
        '# Example Org',
        '',
        'Example Org builds release tooling (#general, 2026-10-05)',
        'It sells to platform teams (#general, 2026-10-02)',
        '',
        '## How it works',
        'Releases are cut on Tuesdays (#release, 2026-10-06)',
        '',
        '## Repositories and systems',
        '- example-org/example-repo holds the billing service (example-org/example-repo, 2026-10-03)',
        ''
      ].join('\n')
    )
    expect(parseOrganizationFile('organization.md', merged).ok).toBe(true)
  })

  it('keeps the summary at ten lines by dropping the oldest-dated extras', () => {
    const lines = (from: number, count: number) =>
      Array.from(
        { length: count },
        (_, i) => `Fact ${from + i} (#general, 2026-10-${String(from + i).padStart(2, '0')})`
      )
    const merged = mergeAbout([
      { text: ['# Org', ...lines(1, 8)].join('\n'), at: at(9) },
      { text: ['# Org', ...lines(10, 5)].join('\n'), at: at(1) }
    ])
    const summary = merged.split('\n').filter((line) => line.startsWith('Fact'))
    expect(summary).toHaveLength(10)
    expect(summary.slice(8)).toEqual([lines(14, 1)[0], lines(13, 1)[0]])
  })
})

describe('mergeChannels', () => {
  it('unions places by name, the newest date winning, and drops place-file links', () => {
    const merged = mergeChannels([
      {
        text: '# Channels\n#release: release trains [[release]] (#release, 2026-10-01)\n#ops: incidents (#ops, 2026-10-04)',
        at: at(4)
      },
      { text: '# Channels\n#Release: release trains and freezes (#release, 2026-10-03)', at: at(3) }
    ])
    expect(merged).toBe(
      '# Channels\n\n#Release: release trains and freezes (#release, 2026-10-03)\n#ops: incidents (#ops, 2026-10-04)\n'
    )
    expect(parseOrganizationFile('channels.md', merged).ok).toBe(true)
  })
})

describe('mergePeople', () => {
  const alice = '## Alice (@alice on Slack) `slack:T0EXAMPLE:U0ALICE`'
  const bob = '## Bob (@bob on Slack) `slack:T0EXAMPLE:U0BOB`'

  it('unions entries by key and lines by field and text, and drops an opted-out key', () => {
    const merged = mergePeople(
      [
        { text: ['# People', alice, 'Role: release manager (self, 2026-10-02)'].join('\n'), at: at(5) },
        {
          text: [
            '# People',
            alice,
            'Role: release manager (self, 2026-10-01)',
            'Works on: the 2.5 train (#release, 2026-10-03)',
            bob,
            'Role: on-call lead (self, 2026-10-01)'
          ].join('\n'),
          at: at(3)
        }
      ],
      new Set(['slack:T0EXAMPLE:U0BOB'])
    )
    expect(merged).toBe(
      [
        '# People',
        '',
        alice,
        'Role: release manager (self, 2026-10-02)',
        'Works on: the 2.5 train (#release, 2026-10-03)',
        ''
      ].join('\n')
    )
    expect(parseOrganizationFile('members.md', merged).ok).toBe(true)
  })

  it('keeps each entry at ten lines by dropping the oldest-dated extras', () => {
    const facts = (from: number, count: number) =>
      Array.from(
        { length: count },
        (_, i) => `Knows about: area ${from + i} (#ops, 2026-10-${String(from + i).padStart(2, '0')})`
      )
    const merged = mergePeople(
      [
        { text: [alice, ...facts(1, 9)].join('\n'), at: at(9) },
        { text: [alice, ...facts(20, 3)].join('\n'), at: at(1) }
      ],
      new Set()
    )
    const lines = merged.split('\n').filter((line) => line.startsWith('Knows about'))
    expect(lines).toHaveLength(10)
    expect(lines.at(-1)).toBe(facts(22, 1)[0])
  })
})
