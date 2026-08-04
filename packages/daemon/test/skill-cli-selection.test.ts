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

/** Write a snapshot-shaped tree of files and return their receipt refs.
 * SKILL.md values are a frontmatter name (default body), `{ name, body,
 * frontmatter? }` for control over both, or `null` for a nameless manifest;
 * `{ raw }` writes any file verbatim (lockfiles, plugin manifests). */
async function snapshot(
  entries: Record<string, string | null | { name?: string; body?: string; frontmatter?: string; raw?: string }>
): Promise<{ dir: string; files: SnapshotFileRef[] }> {
  const dir = await mkdtemp(join(tmpdir(), 'ac-skill-selection-'))
  roots.push(dir)
  const files: SnapshotFileRef[] = []
  for (const [path, value] of Object.entries(entries)) {
    const absolute = join(dir, ...path.split('/'))
    await mkdir(dirname(absolute), { recursive: true })
    let content: string
    if (typeof value === 'object' && value !== null && value.raw !== undefined) {
      content = value.raw
    } else {
      const name = typeof value === 'object' && value !== null ? value.name : (value ?? undefined)
      const body = (typeof value === 'object' && value !== null ? value.body : undefined) ?? '# body\n'
      const extra = (typeof value === 'object' && value !== null ? value.frontmatter : undefined) ?? 'description: d'
      const frontmatter = name === undefined || name === null ? extra : `name: ${name}\n${extra}`
      content = `---\n${frontmatter}\n---\n${body}`
    }
    await writeFile(absolute, content)
    files.push({ path, size: Buffer.byteLength(content) })
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
    // skills/more/grill-me sits one grandchild below the skills container, so
    // the CLI's discovery (and therefore ours) sees both.
    const { dir, files } = await snapshot({
      'skills/grill-me/SKILL.md': 'Grill Me',
      'skills/more/grill-me/SKILL.md': 'grill me'
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

  it('pulls in a same-source skill the selected body invokes by slash reference (#371)', async () => {
    const { dir, files } = await snapshot({
      'skills/productivity/grill-me/SKILL.md': { name: 'grill-me', body: 'Run a `/grilling` session.\n' },
      'skills/productivity/grilling/SKILL.md': 'grilling',
      'skills/productivity/unrelated/SKILL.md': 'unrelated'
    })
    await expect(resolveSkillSelections('src', dir, files, ['grill-me'])).resolves.toEqual({
      cliSelections: ['grill-me', 'grilling'],
      expectedLeaves: ['grill-me', 'grilling']
    })
  })

  it('closes references transitively and tolerates cycles', async () => {
    const { dir, files } = await snapshot({
      'skills/a/SKILL.md': { name: 'a', body: 'Run /b now.\n' },
      'skills/b/SKILL.md': { name: 'b', body: 'Delegate to /c, or restart via /a.\n' },
      'skills/c/SKILL.md': 'c'
    })
    await expect(resolveSkillSelections('src', dir, files, ['a'])).resolves.toEqual({
      cliSelections: ['a', 'b', 'c'],
      expectedLeaves: ['a', 'b', 'c']
    })
  })

  it('ignores slash tokens that name nothing in the source and explicit duplicates', async () => {
    const { dir, files } = await snapshot({
      'skills/grill-me/SKILL.md': {
        name: 'grill-me',
        body: 'See /tmp/log, https://x.test/path, then run `/grilling` and `/grill-me`.\n'
      },
      'skills/grilling/SKILL.md': 'grilling'
    })
    await expect(resolveSkillSelections('src', dir, files, ['grill-me', 'grilling'])).resolves.toEqual({
      cliSelections: ['grill-me', 'grilling'],
      expectedLeaves: ['grill-me', 'grilling']
    })
  })

  it('resolves a display-style referenced name through its canonical token', async () => {
    const { dir, files } = await snapshot({
      'skills/grill-me/SKILL.md': { name: 'grill-me', body: 'Run `/grilling`.\n' },
      'skills/grilling/SKILL.md': 'Grilling Session'
    })
    // /grilling matches the grilling DIRECTORY; the CLI matches the display
    // name and installs under its sanitized leaf.
    await expect(resolveSkillSelections('src', dir, files, ['grill-me'])).resolves.toEqual({
      cliSelections: ['grill-me', 'Grilling Session'],
      expectedLeaves: ['grill-me', 'grilling-session']
    })
  })

  it('rejects a directory alias whose frontmatter name is shared by a sibling skill', async () => {
    // The CLI selects by frontmatter name alone (case-insensitively, exact
    // names de-duplicated by discovery order): emitting `-s Shared` here could
    // install alpha while the user selected beta, with the identical leaf
    // keeping the receipt check green.
    const { dir, files } = await snapshot({
      'skills/alpha/SKILL.md': 'Shared',
      'skills/beta/SKILL.md': 'Shared'
    })
    await expect(resolveSkillSelections('src', dir, files, ['beta'])).rejects.toThrow(
      /"beta".*"Shared".*does not uniquely identify one skill.*skills\/alpha\/SKILL\.md/
    )
  })

  it('rejects a leaf selection and a slash reference resolving to a case-folded shared name', async () => {
    const caseOnly = await snapshot({
      'skills/alpha/SKILL.md': 'Shared',
      'skills/beta/SKILL.md': 'SHARED'
    })
    await expect(resolveSkillSelections('src', caseOnly.dir, caseOnly.files, ['shared'])).rejects.toThrow(
      /matches more than one skill/
    )
    const viaAlias = await snapshot({
      'skills/alpha/SKILL.md': 'Shared',
      'skills/beta/SKILL.md': 'SHARED'
    })
    await expect(resolveSkillSelections('src', viaAlias.dir, viaAlias.files, ['beta'])).rejects.toThrow(
      /does not uniquely identify one skill/
    )
    const viaReference = await snapshot({
      'skills/entry/SKILL.md': { name: 'entry', body: 'Run `/beta`.\n' },
      'skills/alpha/SKILL.md': 'Shared',
      'skills/beta/SKILL.md': 'SHARED'
    })
    await expect(resolveSkillSelections('src', viaReference.dir, viaReference.files, ['entry'])).rejects.toThrow(
      /does not uniquely identify one skill/
    )
  })

  it('fails closed when a reference is ambiguous in the source', async () => {
    const { dir, files } = await snapshot({
      'skills/grill-me/SKILL.md': { name: 'grill-me', body: 'Run `/grilling`.\n' },
      'skills/grilling/SKILL.md': 'grilling one',
      'skills/more/grilling/SKILL.md': 'grilling two'
    })
    await expect(resolveSkillSelections('src', dir, files, ['grill-me'])).rejects.toThrow(
      /reference "\/grilling" matches more than one/
    )
  })

  it('ignores manifests the pinned CLI cannot discover or refuses to parse (#572 review)', async () => {
    // The reviewer's reproduction: a same-named manifest that the CLI ignores
    // (outside its discovery paths, or missing a required field) must not make
    // a valid selection ambiguous.
    const { dir, files } = await snapshot({
      'skills/valid/SKILL.md': 'Shared',
      'examples/fixture/SKILL.md': 'Shared', // valid manifest, undiscoverable path
      'skills/incomplete/SKILL.md': { name: 'Shared', frontmatter: '' }, // no description
      'skills/hidden/SKILL.md': { name: 'Shared', frontmatter: 'description: d\nmetadata:\n  internal: true' },
      'skills/node_modules/dep/SKILL.md': 'Shared' // SKIP_DIRS-pruned grandchild
    })
    await expect(resolveSkillSelections('src', dir, files, ['valid'])).resolves.toEqual({
      cliSelections: ['Shared'],
      expectedLeaves: ['shared']
    })
  })

  it('mirrors the CLI root-manifest early return: a valid root SKILL.md is the whole source', async () => {
    const { dir, files } = await snapshot({
      'SKILL.md': 'root-skill',
      'skills/nested/SKILL.md': 'nested'
    })
    await expect(resolveSkillSelections('src', dir, files, ['nested'])).rejects.toThrow(
      /"nested" was not found in source "src" \(available: root-skill\)/
    )
    await expect(resolveSkillSelections('src', dir, files, ['root-skill'])).resolves.toEqual({
      cliSelections: ['root-skill'],
      expectedLeaves: ['root-skill']
    })
  })

  it('uses the recursive fallback only when the normal discovery pass finds nothing', async () => {
    const fallback = await snapshot({ 'examples/fixture/SKILL.md': 'deep-skill' })
    await expect(resolveSkillSelections('src', fallback.dir, fallback.files, ['deep-skill'])).resolves.toEqual({
      cliSelections: ['deep-skill'],
      expectedLeaves: ['deep-skill']
    })
    const shadowed = await snapshot({
      'skills/normal/SKILL.md': 'normal',
      'examples/fixture/SKILL.md': 'deep-skill'
    })
    await expect(resolveSkillSelections('src', shadowed.dir, shadowed.files, ['deep-skill'])).rejects.toThrow(
      /"deep-skill" was not found in source "src" \(available: normal\)/
    )
  })

  it('excludes committed lockfile installs under harness directories like the CLI', async () => {
    const { dir, files } = await snapshot({
      'skills/deploy/SKILL.md': 'deploy',
      '.claude/skills/deploy/SKILL.md': 'deploy',
      'skills-lock.json': { raw: JSON.stringify({ version: 1, skills: { deploy: {} } }) }
    })
    // The committed .claude/skills copy is an "installed project skill" to the
    // CLI; only the real source under skills/ is a candidate, so the selection
    // stays unambiguous.
    await expect(resolveSkillSelections('src', dir, files, ['deploy'])).resolves.toEqual({
      cliSelections: ['deploy'],
      expectedLeaves: ['deploy']
    })
  })

  it('discovers skills below committed .claude-plugin manifests like the CLI', async () => {
    // A plugin manifest's `skills` entries are skill DIRECTORY paths; the CLI
    // searches their dirname as an extra container.
    const { dir, files } = await snapshot({
      '.claude-plugin/plugin.json': { raw: JSON.stringify({ skills: ['./tools/grill-me'] }) },
      'tools/grill-me/SKILL.md': 'grill-me'
    })
    await expect(resolveSkillSelections('src', dir, files, ['grill-me'])).resolves.toEqual({
      cliSelections: ['grill-me'],
      expectedLeaves: ['grill-me']
    })
  })
})
