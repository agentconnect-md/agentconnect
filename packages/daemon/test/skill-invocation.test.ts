import { describe, expect, it } from 'vitest'
import { isSkillCommand } from '@agentconnect.md/protocol'
import { matchSkillInvocation, renderSkillInvocation } from '../src/session/skill-invocation.js'

// Shapes taken from real advertisements captured 2026-08-20: claude-agent-acp 0.70.0 marks skill
// scope as a description suffix; codex-acp advertises skills as `$name`; both list built-ins bare.
const CLAUDE_TABLE = [
  { name: 'code-review', description: 'Review the current diff … (user)', hint: '[pr-number]' },
  { name: 'zz-probe', description: 'Probe skill for tests. (project)', hint: null },
  { name: 'superpowers:brainstorming', description: '(superpowers) You MUST use this…', hint: null },
  { name: 'mcp:docs:search', description: 'Search the docs prompt', hint: null },
  { name: 'model', description: 'Set the AI model for Claude Code', hint: '<model>' },
  { name: 'compact', description: 'Clear conversation history but keep a summary', hint: null }
]
const CODEX_TABLE = [
  { name: '$code-review', description: 'Review the current diff', hint: null },
  { name: 'review', description: 'Review my current changes', hint: null },
  { name: 'compact', description: 'Summarize to free context', hint: null }
]

describe('isSkillCommand', () => {
  it('recognizes each adapter’s skill markers and nothing else', () => {
    expect(CLAUDE_TABLE.filter(isSkillCommand).map((c) => c.name)).toEqual([
      'code-review',
      'zz-probe',
      'superpowers:brainstorming'
    ])
    expect(CODEX_TABLE.filter(isSkillCommand).map((c) => c.name)).toEqual(['$code-review'])
  })
})

describe('matchSkillInvocation', () => {
  it('matches a typed /skill with and without arguments', () => {
    expect(matchSkillInvocation('/code-review 1234', CLAUDE_TABLE)).toEqual({ name: 'code-review', args: '1234' })
    expect(matchSkillInvocation('/zz-probe', CLAUDE_TABLE)).toEqual({ name: 'zz-probe', args: '' })
    expect(matchSkillInvocation('  /code-review  x ', CLAUDE_TABLE)).toEqual({ name: 'code-review', args: 'x' })
  })

  it('accepts the Slack `!` alias', () => {
    expect(matchSkillInvocation('!code-review 1234', CLAUDE_TABLE)).toEqual({ name: 'code-review', args: '1234' })
  })

  it('resolves a hand-typed bare name to codex’s advertised `$name`', () => {
    expect(matchSkillInvocation('/code-review 1', CODEX_TABLE)).toEqual({ name: '$code-review', args: '1' })
    expect(matchSkillInvocation('/$code-review', CODEX_TABLE)).toEqual({ name: '$code-review', args: '' })
  })

  it('lets a skill win over a same-named built-in, whatever the advertisement order', () => {
    const table = [
      { name: 'review', description: 'Review my current changes', hint: null },
      { name: '$review', description: 'Team review skill', hint: null }
    ]
    expect(matchSkillInvocation('/review now', table)).toEqual({ name: '$review', args: 'now' })
  })

  it('matches case-insensitively, like codex’s own parse', () => {
    expect(matchSkillInvocation('/Code-Review 1', CLAUDE_TABLE)).toEqual({ name: 'code-review', args: '1' })
  })

  it('trusts the record-time skill bit over the truncated description', () => {
    const truncated = [{ name: 'agentconnect-setup', description: 'x'.repeat(512), hint: null, skill: true }]
    expect(matchSkillInvocation('/agentconnect-setup', truncated)).toEqual({ name: 'agentconnect-setup', args: '' })
  })

  it('never translates a built-in — prose cannot dispatch one', () => {
    expect(matchSkillInvocation('/model haiku', CLAUDE_TABLE)).toBeNull()
    expect(matchSkillInvocation('/compact', CLAUDE_TABLE)).toBeNull()
    expect(matchSkillInvocation('/review', CODEX_TABLE)).toBeNull()
    expect(matchSkillInvocation('/mcp:docs:search q', CLAUDE_TABLE)).toBeNull()
  })

  it('leaves ordinary text alone: paths, dates, unknown names, mid-sentence slashes', () => {
    expect(matchSkillInvocation('/Users/pc/x is broken', CLAUDE_TABLE)).toBeNull()
    expect(matchSkillInvocation('/2026 goals', CLAUDE_TABLE)).toBeNull()
    expect(matchSkillInvocation('/no-such-skill', CLAUDE_TABLE)).toBeNull()
    expect(matchSkillInvocation('run /code-review please', CLAUDE_TABLE)).toBeNull()
    expect(matchSkillInvocation('/', CLAUDE_TABLE)).toBeNull()
    expect(matchSkillInvocation('hello there', CLAUDE_TABLE)).toBeNull()
  })
})

describe('renderSkillInvocation', () => {
  // The template is probe-validated on both runtimes (module header) — codex needs the literal
  // advertised token present for inline expansion, so `$name` keeps its `$`.
  it('renders the probe-validated instruction, advertised name verbatim', () => {
    expect(renderSkillInvocation({ name: 'code-review', args: '1234' })).toBe('Run the command /code-review 1234')
    expect(renderSkillInvocation({ name: 'code-review', args: '' })).toBe('Run the command /code-review')
    expect(renderSkillInvocation({ name: '$code-review', args: 'x' })).toBe('Run the command /$code-review x')
  })
})
