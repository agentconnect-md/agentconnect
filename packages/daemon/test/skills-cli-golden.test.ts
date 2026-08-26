import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { detectSandbox } from '../src/acp/sandbox.js'

// A real bwrap sandbox launch (and its nested seccomp helper) is far slower than
// the 5s default, especially on shared CI runners; give the golden installs room
// so a slow-but-correct run is not a false timeout.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })
import { resolvePinnedSkillsCli, stageSkillsCliCell } from '../src/skills/skills-cli-cell.js'
import { installSkills } from '../src/skills/install-skills.js'

const roots: string[] = []

async function fixture(): Promise<{ root: string; source: string }> {
  const root = await mkdtemp(join(tmpdir(), 'ac-skills-cli-golden-'))
  roots.push(root)
  const source = join(root, 'local-source')
  await mkdir(join(source, 'scripts'), { recursive: true })
  await writeFile(
    join(source, 'SKILL.md'),
    '---\nname: local-golden\ndescription: Exact pinned CLI golden fixture\n---\n# Local golden\n'
  )
  await writeFile(join(source, 'scripts/run.sh'), '#!/bin/sh\necho golden\n', { mode: 0o755 })
  return { root, source }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

// Exercise the same live Linux SRT/bwrap boundary as sandbox.test.ts. macOS
// sandbox coverage is deferred to the SRT platform-support follow-up.
const hasBwrap = detectSandbox() === 'bwrap'

describe.skipIf(!hasBwrap)('skills@1.5.21 local-source golden', () => {
  it.each([
    ['claude-code', '.claude/skills/local-golden'],
    ['codex', '.agents/skills/local-golden']
  ])('uses the exact installed CLI for %s and derives %s', async (agentId, expectedPath) => {
    const { root, source } = await fixture()
    const result = await stageSkillsCliCell({
      sourceSnapshot: source,
      agentId,
      selectedSkills: ['local-golden'],
      tempParent: root
    })
    try {
      expect(result.bundles.map((bundle) => bundle.relativePath)).toEqual([expectedPath])
      expect(result.execution.exitCode).toBe(0)
      expect(result.execution.stdout).toContain('local-golden')
    } finally {
      result.cleanup()
    }
  })

  it('installs a display-style-named selection plus its slash-referenced dependency (#371)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-skills-cli-golden-'))
    roots.push(root)
    // The mattpocock/skills shape: two-level nesting, a thin alias skill whose
    // body invokes a sibling, and a frontmatter name differing from the
    // directory name.
    const source = join(root, 'grill-source')
    await mkdir(join(source, 'skills/productivity/grill-me'), { recursive: true })
    await mkdir(join(source, 'skills/productivity/grilling'), { recursive: true })
    await mkdir(join(source, 'skills/productivity/unrelated'), { recursive: true })
    await writeFile(
      join(source, 'skills/productivity/grill-me/SKILL.md'),
      '---\nname: Grill Me\ndescription: Alias with a display-style name\n---\nRun a `/grilling` session.\n'
    )
    await writeFile(
      join(source, 'skills/productivity/grilling/SKILL.md'),
      '---\nname: grilling\ndescription: The referenced interview skill\n---\n# Interview relentlessly\n'
    )
    await writeFile(
      join(source, 'skills/productivity/unrelated/SKILL.md'),
      '---\nname: unrelated\ndescription: Must not install\n---\n# unrelated\n'
    )
    const cwd = join(root, 'workspace')
    await mkdir(cwd)

    const result = await installSkills(
      {
        id: 'agent-grill',
        runtime: 'claude',
        skills: [{ name: 'grill', source: 'acme/grill', githubRepoId: '42', skills: ['grill-me'] }]
      },
      cwd,
      {
        stateDir: join(root, 'trusted-state'),
        acquireGit: async () => ({ sourceDir: source, resolvedCommit: 'c'.repeat(40) })
      }
    )

    expect(result.errors).toEqual([])
    expect(result.installed.sort()).toEqual(['.claude/skills/grill-me', '.claude/skills/grilling'])
    expect(await readFile(join(cwd, '.claude/skills/grill-me/SKILL.md'), 'utf8')).toContain('/grilling')
    expect(await readFile(join(cwd, '.claude/skills/grilling/SKILL.md'), 'utf8')).toContain('# Interview relentlessly')
    await expect(readFile(join(cwd, '.claude/skills/unrelated/SKILL.md'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('ignores a same-named manifest the CLI cannot discover and installs the valid selection (#572 review)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-skills-cli-golden-'))
    roots.push(root)
    const source = join(root, 'shadow-source')
    await mkdir(join(source, 'skills/valid'), { recursive: true })
    await mkdir(join(source, 'examples/fixture'), { recursive: true })
    await writeFile(join(source, 'skills/valid/SKILL.md'), '---\nname: Shared\ndescription: the real one\n---\n# ok\n')
    // Valid manifest, but outside the CLI's discovery paths — it must not make
    // the selection ambiguous.
    await writeFile(
      join(source, 'examples/fixture/SKILL.md'),
      '---\nname: Shared\ndescription: example only\n---\n# fixture\n'
    )
    const cwd = join(root, 'workspace')
    await mkdir(cwd)

    const result = await installSkills(
      {
        id: 'agent-shadow',
        runtime: 'claude',
        skills: [{ name: 'shadow', source: 'acme/shadow', githubRepoId: '42', skills: ['valid'] }]
      },
      cwd,
      {
        stateDir: join(root, 'trusted-state'),
        acquireGit: async () => ({ sourceDir: source, resolvedCommit: 'f'.repeat(40) })
      }
    )

    expect(result.errors).toEqual([])
    expect(result.installed).toEqual(['.claude/skills/shared'])
    expect(await readFile(join(cwd, '.claude/skills/shared/SKILL.md'), 'utf8')).toContain('# ok')
  })

  it('fails closed instead of letting the CLI pick between two directories sharing a frontmatter name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-skills-cli-golden-'))
    roots.push(root)
    const source = join(root, 'shared-source')
    await mkdir(join(source, 'skills/alpha'), { recursive: true })
    await mkdir(join(source, 'skills/beta'), { recursive: true })
    await writeFile(join(source, 'skills/alpha/SKILL.md'), '---\nname: Shared\ndescription: first\n---\n# alpha\n')
    await writeFile(join(source, 'skills/beta/SKILL.md'), '---\nname: Shared\ndescription: second\n---\n# beta\n')
    const cwd = join(root, 'workspace')
    await mkdir(cwd)

    const result = await installSkills(
      {
        id: 'agent-shared',
        runtime: 'claude',
        skills: [{ name: 'shared', source: 'acme/shared', githubRepoId: '42', skills: ['beta'] }]
      },
      cwd,
      {
        stateDir: join(root, 'trusted-state'),
        acquireGit: async () => ({ sourceDir: source, resolvedCommit: 'e'.repeat(40) })
      }
    )

    // The pinned CLI would select "Shared" by discovery order and install
    // alpha's content under the same leaf beta would produce — a silent
    // wrong-skill install. The resolver must refuse before the CLI runs.
    expect(result.errors[0]?.error).toMatch(/does not uniquely identify one skill/)
    expect(result.installed).toEqual([])
    await expect(readFile(join(cwd, '.claude/skills/shared/SKILL.md'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('uses that same local-source CLI path after Git acquisition and publishes only receipt-derived bundles', async () => {
    const { root, source } = await fixture()
    const cwd = join(root, 'workspace')
    const stateDir = join(root, 'trusted-state')
    await mkdir(cwd)

    const result = await installSkills(
      {
        id: 'agent-golden',
        runtime: 'claude',
        skills: [{ name: 'git-fixture', source: 'acme/skills', githubRepoId: '42', skills: ['local-golden'] }]
      },
      cwd,
      {
        stateDir,
        acquireGit: async () => ({ sourceDir: source, resolvedCommit: 'b'.repeat(40) })
      }
    )

    expect(result.errors).toEqual([])
    expect(await readFile(join(cwd, '.claude/skills/local-golden/SKILL.md'), 'utf8')).toContain('# Local golden')
    await expect(readFile(join(cwd, 'skills-lock.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    const ledgerFiles = await readdir(join(stateDir, 'workspace-skills'))
    const ledger = await readFile(join(stateDir, 'workspace-skills', ledgerFiles[0]!), 'utf8')
    expect(ledger).not.toContain(source)
    expect(ledger).not.toContain('skills-lock.json')
    expect(ledger).toContain('local-golden')
  })

  it('runs the unbundled exact dependency closure inside the kernel sandbox', async () => {
    const { root, source } = await fixture()
    const require = createRequire(import.meta.url)
    const result = await stageSkillsCliCell({
      sourceSnapshot: source,
      agentId: 'claude-code',
      selectedSkills: ['local-golden'],
      tempParent: root,
      resolveCli: () => resolvePinnedSkillsCli((specifier) => require.resolve(specifier))
    })
    try {
      expect(result.bundles.map((bundle) => bundle.relativePath)).toEqual(['.claude/skills/local-golden'])
    } finally {
      result.cleanup()
    }
  })
})

describe.skipIf(process.platform !== 'win32')('skills@1.5.21 Windows process fallback', () => {
  // Disabled, not platform-skipped: the confined mutation path refuses its own bundle on Windows.
  // skill-install-ledger's Windows case fails on the same gap.
  it.skip('runs the pinned CLI and publishes its receipt-verified bundle', async () => {
    const { root, source } = await fixture()
    const cwd = join(root, 'workspace')
    const stateDir = join(root, 'state')
    await mkdir(cwd)

    const result = await installSkills(
      { id: 'agent-windows', runtime: 'codex-acp', skills: [], managedSkills: [] } as never,
      cwd,
      {
        stateDir,
        skillsAgentId: 'codex',
        localSkills: [{ kind: 'managed', key: 'fixture', name: 'local-golden', sourceDir: source }]
      }
    )

    expect(result.errors).toEqual([])
    expect(result.installed).toEqual(['.agents/skills/local-golden'])
    expect(await readFile(join(cwd, '.agents/skills/local-golden/SKILL.md'), 'utf8')).toContain('# Local golden')
  })
})
