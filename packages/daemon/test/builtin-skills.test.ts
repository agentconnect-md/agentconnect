import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import {
  BUILTIN_IMAGES_SKILL,
  BUILTIN_MCP_SKILL_NAMES,
  isMigratedBuiltinGitSkillSource,
  reserveBuiltinSkills
} from '../src/skills/builtin-skills.js'
import type { LocalSkillSource } from '../src/skills/install-skills.js'

const source = (key: string, name: string): LocalSkillSource => ({ kind: 'managed', key, name, sourceDir: '/x' })

/** The preset `agentconnect` source exactly as the Control Plane projects it into AgentSpec.skills. */
const PRESET = {
  name: 'agentconnect',
  source: 'agentconnect-md/agentconnect-skill',
  githubRepoId: '1322557433',
  ref: 'main',
  subDir: 'skills',
  skills: [] as string[]
}

describe('builtin skills', () => {
  it('ships agentconnect-images in the package for readSkill', () => {
    const dir = fileURLToPath(new URL(`../builtin-skills/${BUILTIN_IMAGES_SKILL}`, import.meta.url))
    const manifest = readFileSync(join(dir, 'SKILL.md'), 'utf8')
    const front = parseYaml(manifest.split('---')[1]!) as { name: string; description: string }
    expect(front.name).toBe(BUILTIN_IMAGES_SKILL)
    expect(manifest).toContain('shareFile')
  })

  it('reserves every built-in name against managed and Dream sources, and drops a legacy builtin source', () => {
    const warn = vi.fn()
    const kept = reserveBuiltinSkills(
      [
        source('builtin:agentconnect-images:abc', 'agentconnect-images'),
        ...BUILTIN_MCP_SKILL_NAMES.map((name, i) => source(`managed:${i}:1:d`, name)),
        { ...source('dream:agentconnect-platform', 'agentconnect-platform'), kind: 'dream' },
        source('dream:other:d', 'other')
      ],
      warn
    )
    expect(kept.map((s) => s.key)).toEqual(['dream:other:d'])
    expect(warn).toHaveBeenCalledTimes(BUILTIN_MCP_SKILL_NAMES.length + 1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"agentconnect-create-team" is reserved'))
  })
})

describe('isMigratedBuiltinGitSkillSource', () => {
  it.each([
    ['the projected preset', PRESET],
    ['an omitted ref, subDir and repository id', { name: 'agentconnect', source: PRESET.source }],
    ['an absent name', { source: PRESET.source, githubRepoId: PRESET.githubRepoId }],
    ['a full HTTPS URL', { ...PRESET, source: 'https://github.com/agentconnect-md/agentconnect-skill.git' }],
    [
      'a trailing slash and mixed case',
      { ...PRESET, source: 'https://GitHub.com/AgentConnect-md/agentconnect-skill/' }
    ],
    ['an SCP address', { ...PRESET, source: 'git@github.com:agentconnect-md/agentconnect-skill.git' }],
    ['a slash-padded subDir', { ...PRESET, subDir: '/skills/' }],
    ['a selection of built-in skills', { ...PRESET, skills: ['agentconnect-images', 'agentconnect-platform'] }]
  ])('skips %s', (_label, entry) => {
    expect(isMigratedBuiltinGitSkillSource(entry)).toBe(true)
  })

  it.each([
    ['a renamed source', { ...PRESET, name: 'house-skills' }],
    [
      'a source repointed at a fork with a stale repository id',
      { ...PRESET, source: 'example-org/agentconnect-skill' }
    ],
    ['a different repository id', { ...PRESET, githubRepoId: '42' }],
    ['a non-main ref', { ...PRESET, ref: 'v2' }],
    ['a pinned commit', { ...PRESET, ref: 'a'.repeat(40) }],
    ['another subDir', { ...PRESET, subDir: 'extra' }],
    ['a non-builtin skill', { ...PRESET, skills: ['agentconnect-images', 'house-style'] }],
    ['another host', { ...PRESET, source: 'https://gitlab.example.test/agentconnect-md/agentconnect-skill' }]
  ])('keeps %s', (_label, entry) => {
    expect(isMigratedBuiltinGitSkillSource(entry)).toBe(false)
  })
})
