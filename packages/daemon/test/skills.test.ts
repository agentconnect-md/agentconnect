import { describe, it, expect } from 'vitest'
import { composeSource } from '../src/skills/install-skills.js'
import { skillsAgentId } from '../src/skills/runtime-agent-map.js'

describe('skillsAgentId', () => {
  it('maps known runtimes (bare + acp-suffixed) to npx-skills agent ids', () => {
    expect(skillsAgentId('claude')).toBe('claude-code')
    expect(skillsAgentId('claude-acp')).toBe('claude-code')
    expect(skillsAgentId('codex-acp')).toBe('codex')
    expect(skillsAgentId('opencode')).toBe('opencode')
    expect(skillsAgentId('qwen-code')).toBe('gemini-cli')
    expect(skillsAgentId('cursor')).toBe('cursor')
  })
  it('returns undefined for an unmapped runtime', () => {
    expect(skillsAgentId('some-exotic-agent')).toBeUndefined()
  })
})

describe('composeSource', () => {
  const base = { name: 'x', skills: [] as string[] }

  it('passes a bare source through untouched', () => {
    expect(composeSource({ ...base, source: 'acme/skills' })).toBe('acme/skills')
  })

  it('composes a shorthand + ref into a github tree URL', () => {
    expect(composeSource({ ...base, source: 'acme/skills', ref: 'v1.2.0' })).toBe(
      'https://github.com/acme/skills/tree/v1.2.0'
    )
  })

  it('appends the subdir to the tree path', () => {
    expect(composeSource({ ...base, source: 'acme/skills', ref: 'main', subDir: 'skills' })).toBe(
      'https://github.com/acme/skills/tree/main/skills'
    )
  })

  it('defaults ref to main when only a subdir is given', () => {
    expect(composeSource({ ...base, source: 'acme/skills', subDir: 'pack' })).toBe(
      'https://github.com/acme/skills/tree/main/pack'
    )
  })

  it('leaves an already-tree source alone', () => {
    const s = 'https://github.com/acme/skills/tree/main/pack'
    expect(composeSource({ ...base, source: s, ref: 'ignored' })).toBe(s)
  })

  it('does not compose non-github sources', () => {
    expect(composeSource({ ...base, source: 'https://gitlab.com/acme/skills', ref: 'v1' })).toBe(
      'https://gitlab.com/acme/skills'
    )
  })
})
