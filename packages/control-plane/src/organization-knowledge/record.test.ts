// People's entries by key as the console edits them (assistant-mode.md §5.16 "File views").
import { describe, expect, it } from 'vitest'
import {
  changedPeopleKeys,
  parsePeopleBlock,
  peopleEntries,
  recordShapeRefusal,
  removedPeopleKeys,
  replacePeopleEntries
} from './record.js'

const alice = '## Alice (@alice on Slack) `user:user-alice`\nRole: release manager (self, 2026-10-02)'
const bob = '## Bob (@bob on Slack) `slack:T0EXAMPLE:U0BOB`\nRole: on-call lead (#ops, 2026-10-03)'
const people = `# People\n\n${alice}\n\n${bob}\n`

describe('People entries', () => {
  it('replaces an entry in its place and appends a new one', () => {
    const edited = '## Alice (@alice on Slack) `user:user-alice`\nRole: head of releases (self, 2026-10-09)'
    expect(replacePeopleEntries(people, [], { key: 'user:user-alice', text: edited })).toBe(
      `# People\n\n${edited}\n\n${bob}\n`
    )
    const carol = '## Carol (@carol on Slack) `slack:T0EXAMPLE:U0CAROL`\nRole: designer (self, 2026-10-09)'
    expect(replacePeopleEntries(people, [], { key: 'slack:T0EXAMPLE:U0CAROL', text: carol })).toBe(
      `# People\n\n${alice}\n\n${bob}\n\n${carol}\n`
    )
  })

  it('removes entries by key and tells which went and which changed', () => {
    const cleared = replacePeopleEntries(people, ['slack:T0EXAMPLE:U0BOB'])
    expect(cleared).toBe(`# People\n\n${alice}\n`)
    expect(removedPeopleKeys(people, cleared)).toEqual(['slack:T0EXAMPLE:U0BOB'])
    expect(changedPeopleKeys(people, cleared)).toEqual([])
    expect(recordShapeRefusal('people', cleared)).toBeUndefined()
  })

  it('reads one block as exactly one keyed entry', () => {
    expect(parsePeopleBlock(alice)).toEqual({ key: 'user:user-alice' })
    expect(parsePeopleBlock(`${alice}\n\n${bob}`)).toHaveProperty('refusal')
    expect(parsePeopleBlock('## Alice (@alice on Slack)\nRole: x (self, 2026-10-02)')).toHaveProperty('refusal')
  })

  it("lists a person's own entries only", () => {
    expect(peopleEntries(people, new Set(['user:user-alice']))).toEqual([{ key: 'user:user-alice', text: alice }])
  })

  it('refuses a shape that does not fit, naming the line', () => {
    expect(recordShapeRefusal('channels', '# Channels\n#release: trains')).toMatch(/channels\.md line 2/)
  })
})
