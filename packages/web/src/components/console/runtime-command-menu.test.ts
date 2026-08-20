import { describe, expect, it } from 'vitest'
import { commandQueryAt } from '@/lib/conversation-addressing'
import {
  commandInsertion,
  leadingCommandToken,
  matchCommands,
  offerableCommands,
  type CommandCandidate
} from '@/components/console/runtime-command-menu'

const AGENT_A = { agentId: 'a', agentName: 'Alice' }
const AGENT_B = { agentId: 'b', agentName: 'Bob' }
const candidate = (agent: typeof AGENT_A, name: string): CommandCandidate => ({
  ...agent,
  name,
  description: `${name} does a thing`,
  hint: null
})

describe('commandQueryAt', () => {
  it('opens on a leading slash and narrows on what follows', () => {
    expect(commandQueryAt('/', 1)).toEqual({ start: 0, query: '' })
    expect(commandQueryAt('/rev', 4)).toEqual({ start: 0, query: 'rev' })
    expect(commandQueryAt('  /rev', 6)).toEqual({ start: 2, query: 'rev' })
  })

  it('opens after mentions, since picking a command may have inserted one', () => {
    expect(commandQueryAt('@Bob /rev', 9)).toEqual({ start: 5, query: 'rev' })
    expect(commandQueryAt('@Alice @Bob /co', 15)).toEqual({ start: 12, query: 'co' })
  })

  it('leaves an ordinary slash alone — a command is the prompt’s leading token', () => {
    expect(commandQueryAt('look at src/index.ts', 20)).toBeNull()
    expect(commandQueryAt('see https://example.test/x', 26)).toBeNull()
    expect(commandQueryAt('do this /then', 13)).toBeNull()
    // A space ends the query: the picker narrows on the command word only.
    expect(commandQueryAt('/review this pr', 15)).toBeNull()
  })
})

describe('offerableCommands', () => {
  it('offers only skills — built-ins (console-owned ones included) cannot be dispatched', () => {
    const offered = offerableCommands(AGENT_A, [
      { name: 'code-review', description: 'Review the diff (project)', hint: '[pr]' },
      { name: '$refactor', description: 'Restructure safely', hint: null },
      { name: 'superpowers:brainstorming', description: '(superpowers) Explore intent', hint: null },
      { name: 'model', description: 'Set the AI model for Claude Code', hint: '<model>' },
      { name: 'compact', description: 'Clear conversation history', hint: null },
      { name: 'mcp:docs:search', description: 'Search the docs', hint: null }
    ])
    expect(offered.map((c) => c.name)).toEqual(['code-review', '$refactor', 'superpowers:brainstorming'])
    expect(offered[0]).toMatchObject({ agentId: 'a', agentName: 'Alice', hint: '[pr]' })
  })

  it('trusts the daemon’s record-time skill bit over the (possibly truncated) description', () => {
    const offered = offerableCommands(AGENT_A, [
      // Long description whose `(user)` marker was eaten by the daemon's display cap.
      { name: 'agentconnect-setup', description: 'x'.repeat(512), hint: null, skill: true },
      // And the inverse: the bit outranks a suffix that would have matched.
      { name: 'weird', description: 'looks like (user)', hint: null, skill: false }
    ])
    expect(offered.map((c) => c.name)).toEqual(['agentconnect-setup'])
  })
})

describe('matchCommands', () => {
  it('ranks a prefix match above a substring one', () => {
    const all = [candidate(AGENT_A, 'code-review'), candidate(AGENT_A, 'review'), candidate(AGENT_A, 'tdd')]
    expect(matchCommands(all, 're', 8).map((c) => c.name)).toEqual(['review', 'code-review'])
  })

  it('keeps the same name from two agents — they are different commands', () => {
    const all = [candidate(AGENT_A, 'code-review'), candidate(AGENT_B, 'code-review')]
    const matched = matchCommands(all, 'code', 8)
    expect(matched).toHaveLength(2)
    expect(matched.map((c) => c.agentId).sort()).toEqual(['a', 'b'])
  })

  it('reaches a codex `$name` from a bare typed query', () => {
    const all = [candidate(AGENT_A, '$code-review'), candidate(AGENT_A, 'tdd')]
    expect(matchCommands(all, 'code', 8).map((c) => c.name)).toEqual(['$code-review'])
  })

  it('offers everything on an empty query, bounded by the limit', () => {
    const all = Array.from({ length: 40 }, (_, i) => candidate(AGENT_A, `cmd-${i}`))
    expect(matchCommands(all, '', 8)).toHaveLength(8)
  })
})

describe('commandInsertion', () => {
  it('replaces the typed token verbatim and leaves the caret ready for an argument', () => {
    const next = commandInsertion({ text: '/co', anchorStart: 0, spanEnd: 3, command: { name: 'code-review' } })
    expect(next.text).toBe('/code-review ')
    expect(next.caret).toBe(next.text.length)
  })

  // The owner is addressed structurally (the pick rides mentions[]) — an inline `@Name` would
  // displace the command from the leading position the daemon's translation gate matches on.
  it('never writes a mention into the draft', () => {
    const next = commandInsertion({ text: '/co', anchorStart: 0, spanEnd: 3, command: { name: 'code-review' } })
    expect(next.text).not.toContain('@')
  })

  it('keeps the advertised `$` name and any text typed after the token', () => {
    const next = commandInsertion({
      text: '/co the release',
      anchorStart: 0,
      spanEnd: 3,
      command: { name: '$code-review' }
    })
    expect(next.text).toBe('/$code-review  the release')
    expect(next.caret).toBe('/$code-review '.length)
  })
})

describe('leadingCommandToken', () => {
  it('reads the token a draft leads with, tolerating whitespace and complete mentions', () => {
    expect(leadingCommandToken('/code-review 42')).toBe('code-review')
    expect(leadingCommandToken('  /$refactor')).toBe('$refactor')
    expect(leadingCommandToken('@Bob /tdd now')).toBe('tdd')
  })

  it('reads nothing from a draft the command no longer leads', () => {
    expect(leadingCommandToken('run /code-review')).toBeNull()
    expect(leadingCommandToken('@Bob the log is in /tmp')).toBeNull()
    expect(leadingCommandToken('hello')).toBeNull()
  })
})
