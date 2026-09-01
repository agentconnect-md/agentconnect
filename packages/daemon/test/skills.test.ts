import { describe, expect, it } from 'vitest'
import { composeSource, resolveSkillsCliSpec, SKILLS_CLI_SPEC } from '../src/skills/install-skills.js'
import { parseGitSkillSource } from '../src/skills/skill-git-source.js'
import { skillsAgentIdForRuntime } from '../src/runtimes/skills-capability.js'

describe('skillsAgentIdForRuntime', () => {
  it('maps runtimes only to skills CLI agent ids', () => {
    expect(skillsAgentIdForRuntime('claude')).toBe('claude-code')
    expect(skillsAgentIdForRuntime('claude-acp')).toBe('claude-code')
    expect(skillsAgentIdForRuntime('codex-acp')).toBe('codex')
    expect(skillsAgentIdForRuntime('factory-droid')).toBe('droid')
    expect(skillsAgentIdForRuntime('qoder-cli-cn')).toBe('qoder-cn')
    expect(skillsAgentIdForRuntime('dsh-acp')).toBe('universal')
    expect(skillsAgentIdForRuntime('openclaw')).toBe('openclaw')
    expect(skillsAgentIdForRuntime('qwen-code')).toBe('qwen-code')
    expect(skillsAgentIdForRuntime('some-exotic-agent')).toBeUndefined()
  })

  it('lets trusted operator runtime metadata declare or explicitly disable the capability', () => {
    expect(skillsAgentIdForRuntime('custom', { skillsAgentId: 'custom-cli-id' })).toBe('custom-cli-id')
    expect(skillsAgentIdForRuntime('claude-acp', { skillsAgentId: null })).toBeUndefined()
    expect(skillsAgentIdForRuntime('claude-acp', {})).toBe('claude-code')
  })
})

describe('exact skills CLI contract', () => {
  it('uses the audited exact dependency and rejects mutable overrides', () => {
    expect(SKILLS_CLI_SPEC).toBe('skills@1.5.21')
    expect(resolveSkillsCliSpec({})).toBe(SKILLS_CLI_SPEC)
    expect(resolveSkillsCliSpec({ AC_SKILLS_CLI: SKILLS_CLI_SPEC })).toBe(SKILLS_CLI_SPEC)
    for (const mutable of ['skills', 'skills@latest', 'skills@^1.5.0', 'https://example.test/skills.tgz', '--evil']) {
      expect(() => resolveSkillsCliSpec({ AC_SKILLS_CLI: mutable })).toThrow(/exact audited spec/)
    }
  })
})

describe('composeSource compatibility', () => {
  const base = { name: 'x', githubRepoId: '42', skills: [] as string[] }

  it('passes a bare source through and composes GitHub ref/subdir forms', () => {
    expect(composeSource({ ...base, source: 'acme/skills' })).toBe('acme/skills')
    expect(composeSource({ ...base, source: 'acme/skills', ref: 'v1.2.0' })).toBe(
      'https://github.com/acme/skills/tree/v1.2.0'
    )
    expect(composeSource({ ...base, source: 'acme/skills', ref: 'main', subDir: 'skills' })).toBe(
      'https://github.com/acme/skills/tree/main/skills'
    )
    expect(composeSource({ ...base, source: 'acme/skills', subDir: 'pack' })).toBe(
      'https://github.com/acme/skills/tree/main/pack'
    )
  })

  it('leaves already-tree and non-GitHub sources alone', () => {
    const tree = 'https://github.com/acme/skills/tree/main/pack'
    expect(composeSource({ ...base, source: tree, ref: 'ignored' })).toBe(tree)
    expect(composeSource({ ...base, source: 'https://gitlab.com/acme/skills', ref: 'v1' })).toBe(
      'https://gitlab.com/acme/skills'
    )
  })
})

describe('Git skill source acquisition parsing', () => {
  const base = { name: 'x', githubRepoId: '42', skills: [] as string[] }

  it('normalizes shorthands and GitHub tree URLs without passing a live URL to the CLI', () => {
    expect(parseGitSkillSource({ ...base, source: 'acme/skills', ref: 'v1', subDir: 'pack' })).toEqual({
      cloneUrl: 'https://github.com/acme/skills.git',
      ref: 'v1',
      subDir: 'pack'
    })
    expect(parseGitSkillSource({ ...base, source: 'https://github.com/acme/skills/tree/main/packs/core' })).toEqual({
      cloneUrl: 'https://github.com/acme/skills.git',
      ref: 'main',
      subDir: 'packs/core'
    })
  })

  it('rejects local protocols, embedded credentials, and path traversal', () => {
    expect(() => parseGitSkillSource({ ...base, source: 'file:///tmp/skill' })).toThrow(/https or ssh/i)
    expect(() => parseGitSkillSource({ ...base, source: 'https://user:pass@example.test/repo' })).toThrow(/credentials/)
    expect(() => parseGitSkillSource({ ...base, source: 'acme/skills', subDir: '../outside' })).toThrow(
      /unsafe subdirectory/
    )
  })

  it('accepts the shared credential-free SSH forms', () => {
    expect(parseGitSkillSource({ ...base, source: 'git@github.com:acme/skills.git', ref: 'v1' })).toEqual({
      cloneUrl: 'git@github.com:acme/skills.git',
      ref: 'v1'
    })
    expect(parseGitSkillSource({ ...base, source: 'ssh://git@github.com/acme/skills.git' })).toEqual({
      cloneUrl: 'ssh://git@github.com/acme/skills.git'
    })
  })
})
