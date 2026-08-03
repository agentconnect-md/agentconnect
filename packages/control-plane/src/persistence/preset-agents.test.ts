/**
 * Validation-parity pins for the preset seam (preset-agents.md §3.2/§3.3).
 *
 * Provisioning writes the agent row through `PgAgentRepo.create`, NOT through
 * `CreateAgentBody` — so the preset's fixed identity must be provably legal
 * under the DTO rules it bypasses, and the reserved-slug set must cover it.
 */
import { describe, expect, it } from 'vitest'
import { AGENT_ICON_GLYPHS, AgentSkillEntry } from '@agentconnect.md/protocol'
import { GENERAL_PRESET, PRESET_AGENT_SKILLS, PRESET_SKILL_SOURCE, RESERVED_AGENT_SLUGS } from './preset-agents.js'
import { HEX_COLOR_RE } from '../agents/agent-icon.js'
import { parseSkillRef } from '../orchestrator/skillSource.js'

// The DTO's AgentSlug grammar (dto/index.ts) — duplicated here as the drift
// guard: if either side changes shape, this pin fails before a preset ships.
const AGENT_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

describe('GENERAL_PRESET validation parity', () => {
  it('carries a slug that is legal under the DTO grammar and ≤63 chars', () => {
    expect(GENERAL_PRESET.name).toMatch(AGENT_SLUG_RE)
    expect(GENERAL_PRESET.name.length).toBeLessThanOrEqual(63)
  })

  it('is protected by the reserved-slug set (not impersonable)', () => {
    expect(RESERVED_AGENT_SLUGS.has(GENERAL_PRESET.name)).toBe(true)
  })

  it('pins the fixed brand identity', () => {
    expect(GENERAL_PRESET.displayName).toBe('AgentConnect')
    expect(GENERAL_PRESET.icon.kind).toBe('glyph')
    expect(AGENT_ICON_GLYPHS).toContain(GENERAL_PRESET.icon.glyph)
    expect(GENERAL_PRESET.icon.color).toMatch(HEX_COLOR_RE)
  })
})

describe('PRESET_SKILL_SOURCE validation parity', () => {
  it('projects to a legal AgentSpec skill entry (the exact shape the daemon installs)', () => {
    // Mirrors agentSpecAssembler's candidate construction: if the constants ever
    // stop parsing, resolveAgentSkillEntries would silently DROP the source and
    // the preset would ship skill-less — fail here instead.
    const entry = AgentSkillEntry.safeParse({
      name: PRESET_SKILL_SOURCE.name,
      source: PRESET_SKILL_SOURCE.source,
      githubRepoId: PRESET_SKILL_SOURCE.githubRepoId.toString(),
      ref: PRESET_SKILL_SOURCE.ref,
      subDir: PRESET_SKILL_SOURCE.subDir,
      skills: [...PRESET_SKILL_SOURCE.skills]
    })
    expect(entry.success).toBe(true)
  })

  it('carries a ref — a subdir source without one is refused by the skill-sources route', () => {
    expect(PRESET_SKILL_SOURCE.subDir).toBeTruthy()
    expect(PRESET_SKILL_SOURCE.ref).toBeTruthy()
  })

  it('every default enable-ref resolves to this source and survives its skill filter', () => {
    expect(PRESET_AGENT_SKILLS.length).toBeGreaterThan(0)
    for (const ref of PRESET_AGENT_SKILLS) {
      const { source, skill } = parseSkillRef(ref)
      expect(source).toBe(PRESET_SKILL_SOURCE.name)
      // A whole-source ref would broaden beyond the filter; a filtered-out pick
      // would make resolveAgentSkillEntries omit the source entirely.
      expect(skill).not.toBeNull()
      expect(PRESET_SKILL_SOURCE.skills).toContain(skill!)
    }
  })
})

describe('RESERVED_AGENT_SLUGS', () => {
  it('reserves exactly the shipped preset slug (assistant names released, 2026-07-29)', () => {
    expect([...RESERVED_AGENT_SLUGS]).toEqual(['agentconnect'])
  })
})
