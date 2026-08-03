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
