import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { BUILTIN_IMAGES_SKILL, builtinSkillSources, reserveBuiltinSkills } from '../src/skills/builtin-skills.js'
import { originForSourceKey } from '../src/skills/local-skill-inventory.js'
import type { LocalSkillSource } from '../src/skills/install-skills.js'

describe('builtin skills', () => {
  it('ships agentconnect-images with a content-addressed builtin key', async () => {
    const [images] = await builtinSkillSources()
    expect(images).toMatchObject({ kind: 'managed', name: BUILTIN_IMAGES_SKILL })
    expect(images!.key).toMatch(/^builtin:agentconnect-images:[0-9a-f]{64}$/)
    const manifest = readFileSync(join(images!.sourceDir, 'SKILL.md'), 'utf8')
    const front = parseYaml(manifest.split('---')[1]!) as { name: string; description: string }
    expect(front.name).toBe(BUILTIN_IMAGES_SKILL)
    expect(manifest).toContain('shareFile')
    expect(originForSourceKey(images!.key)).toBe('managed')
  })

  it('reserves the builtin name over a same-named configured source and installs builtins last', () => {
    const source = (key: string, name: string): LocalSkillSource => ({ kind: 'managed', key, name, sourceDir: '/x' })
    const warn = vi.fn()
    const ordered = reserveBuiltinSkills(
      [
        source('builtin:agentconnect-images:abc', 'agentconnect-images'),
        source('managed:1:1:d', 'agentconnect-images'),
        source('dream:other:d', 'other')
      ],
      warn
    )
    expect(ordered.map((s) => s.key)).toEqual(['dream:other:d', 'builtin:agentconnect-images:abc'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('reserved'))
  })
})
