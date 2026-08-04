import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isSafeCliSelection,
  resolveSkillSelections,
  skillInstallLeaf,
  type SnapshotFileRef
} from '../src/skills/skill-cli-selection.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** Write a snapshot-shaped tree of SKILL.md files and return its file refs. */
async function snapshot(skills: Record<string, string | null>): Promise<{ dir: string; files: SnapshotFileRef[] }> {
  const dir = await mkdtemp(join(tmpdir(), 'ac-skill-selection-'))
  roots.push(dir)
  const files: SnapshotFileRef[] = []
  for (const [path, name] of Object.entries(skills)) {
    const absolute = join(dir, ...path.split('/'))
    await mkdir(dirname(absolute), { recursive: true })
    const frontmatter = name === null ? 'description: d' : `name: ${name}\ndescription: d`
    await writeFile(absolute, `---\n${frontmatter}\n---\n# body\n`)
    files.push({ path })
  }
  return { dir, files }
}

describe('skillInstallLeaf', () => {
  it('mirrors the pinned CLI sanitizeName exactly', () => {
    expect(skillInstallLeaf('grill-me')).toBe('grill-me')
    expect(skillInstallLeaf('Grill Me')).toBe('grill-me')
    expect(skillInstallLeaf('grill_me')).toBe('grill_me')
    expect(skillInstallLeaf('--Grill  Me--')).toBe('grill-me')
    expect(skillInstallLeaf('.hidden.')).toBe('hidden')
    expect(skillInstallLeaf('烧烤')).toBe('unnamed-skill')
    expect(skillInstallLeaf(`x${'y'.repeat(300)}`)).toHaveLength(255)
  })
})

describe('isSafeCliSelection', () => {
  it('accepts display names and refuses option-shaped or non-ASCII values', () => {
    expect(isSafeCliSelection('Grill Me')).toBe(true)
    expect(isSafeCliSelection('grill-me')).toBe(true)
    expect(isSafeCliSelection('')).toBe(false)
    expect(isSafeCliSelection('-s')).toBe(false)
    expect(isSafeCliSelection('--agent')).toBe(false)
    expect(isSafeCliSelection('a\nb')).toBe(false)
    expect(isSafeCliSelection('烧烤')).toBe(false)
  })
})

describe('resolveSkillSelections', () => {
  it('passes an already-canonical frontmatter name through unchanged', async () => {
    const { dir, files } = await snapshot({ 'skills/grill-me/SKILL.md': 'grill-me' })
    await expect(resolveSkillSelections('src', dir, files, ['grill-me'])).resolves.toEqual({
      cliSelections: ['grill-me'],
      expectedLeaves: ['grill-me']
    })
  })

  it('resolves a canonical selection to a display-style frontmatter name (#371)', async () => {
    const { dir, files } = await snapshot({
      'skills/grill-me/SKILL.md': 'Grill Me',
      'skills/other/SKILL.md': 'other'
    })
    await expect(resolveSkillSelections('src', dir, files, ['grill-me', 'other'])).resolves.toEqual({
      cliSelections: ['Grill Me', 'other'],
      expectedLeaves: ['grill-me', 'other']
    })
  })

  it('resolves a directory-name selection and reports the differing install leaf', async () => {
    const { dir, files } = await snapshot({ 'skills/grill-me/SKILL.md': 'grill_me' })
    await expect(resolveSkillSelections('src', dir, files, ['grill-me'])).resolves.toEqual({
      cliSelections: ['grill_me'],
      expectedLeaves: ['grill_me']
    })
  })

  it('resolves a root SKILL.md by its sanitized frontmatter name', async () => {
    const { dir, files } = await snapshot({ 'SKILL.md': 'Root Skill' })
    await expect(resolveSkillSelections('src', dir, files, ['root-skill'])).resolves.toEqual({
      cliSelections: ['Root Skill'],
      expectedLeaves: ['root-skill']
    })
  })

  it('requires no resolution when the selection is empty (install everything)', async () => {
    const { dir, files } = await snapshot({ 'skills/anything/SKILL.md': 'Whatever Name' })
    await expect(resolveSkillSelections('src', dir, files, [])).resolves.toEqual({
      cliSelections: [],
      expectedLeaves: []
    })
  })

  it('lists the available canonical names when a selection matches nothing', async () => {
    const { dir, files } = await snapshot({
      'skills/grill-me/SKILL.md': 'Grill Me',
      'skills/nameless/SKILL.md': null
    })
    await expect(resolveSkillSelections('src', dir, files, ['missing'])).rejects.toThrow(
      /"missing" was not found in source "src" \(available: grill-me\)/
    )
  })

  it('rejects a selection matching two distinct skill names', async () => {
    const { dir, files } = await snapshot({
      'skills/grill-me/SKILL.md': 'Grill Me',
      'packs/grill-me/SKILL.md': 'grill me'
    })
    await expect(resolveSkillSelections('src', dir, files, ['grill-me'])).rejects.toThrow(/matches more than one/)
  })

  it('rejects two selections resolving to the same skill', async () => {
    const { dir, files } = await snapshot({ 'skills/grill-me/SKILL.md': 'grill_me' })
    await expect(resolveSkillSelections('src', dir, files, ['grill-me', 'grill_me'])).rejects.toThrow(
      /resolve to the same skill/
    )
  })

  it('refuses a resolved name the CLI argv cannot carry safely', async () => {
    const { dir, files } = await snapshot({ 'skills/grill-me/SKILL.md': '--Grill Me' })
    await expect(resolveSkillSelections('src', dir, files, ['grill-me'])).rejects.toThrow(/cannot select safely/)
  })
})
