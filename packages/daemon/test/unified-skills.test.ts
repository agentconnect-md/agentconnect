import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { detectSandbox } from '../src/acp/sandbox.js'

// A real bwrap sandbox launch (and its nested seccomp helper) is far slower than
// the 5s default, especially on shared CI runners. Give each end-to-end install
// room so a slow-but-correct run is not a false timeout.
// (Exercised by the Linux sandbox lane in .github/workflows/test.yaml.)
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })
import {
  installSkills,
  type LocalSkillSource,
  type SkillsCliInvocation,
  type SkillsCliInvocationResult
} from '../src/skills/install-skills.js'

const skillBody = (name: string, marker = name) =>
  `---\nname: ${name}\ndescription: ${name} fixture\n---\n# ${marker}\n`

async function writeSkill(root: string, name: string, marker = name): Promise<string> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), skillBody(name, marker))
  return dir
}

function digest(body: string): string {
  return createHash('sha256').update(body).digest('hex')
}

/** A deterministic CLI seam: it decides the harness directory and copies the
 * selected bundle into the private cell. The reconciler must derive that path
 * from this receipt; production code is not allowed to predict it. */
function fakeCli(rootForAgent: (agentId: string) => string) {
  const calls: SkillsCliInvocation[] = []
  const run = async (input: SkillsCliInvocation): Promise<SkillsCliInvocationResult> => {
    calls.push(input)
    const name = input.skills[0] ?? 'git-skill'
    const relativeRoot = [rootForAgent(input.agentId), 'skills', name].filter(Boolean).join('/')
    const bundleDir = join(input.cellDir, ...relativeRoot.split('/'))
    await mkdir(bundleDir, { recursive: true })
    const body = await readFile(join(input.sourceDir, 'SKILL.md'), 'utf8')
    await writeFile(join(bundleDir, 'SKILL.md'), body)
    return {
      bundles: [
        {
          relativeRoot,
          sourceDir: bundleDir,
          treeDigest: digest(body),
          files: [{ path: 'SKILL.md', mode: 0o600, size: Buffer.byteLength(body), sha256: digest(body) }]
        }
      ],
      stdoutDigest: digest('ok'),
      stderrDigest: digest('')
    }
  }
  return { calls, run }
}

// Exercise the same live Linux SRT/bwrap boundary as sandbox.test.ts. macOS
// sandbox coverage is deferred to the SRT platform-support follow-up.
const hasBwrap = detectSandbox() === 'bwrap'

describe.skipIf(!hasBwrap)('unified isolated skill installation', () => {
  let root: string
  let cwd: string
  let stateDir: string
  let sources: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ac-unified-skills-'))
    cwd = join(root, 'workspace')
    stateDir = join(root, 'trusted-state')
    sources = join(root, 'sources')
    await mkdir(cwd)
    await mkdir(sources)
  }, 120_000)

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('feeds managed and accepted-local sources through the same CLI invocation seam', async () => {
    const managedDir = await writeSkill(sources, 'managed', 'managed')
    const dreamDir = await writeSkill(sources, 'dream', 'dream')
    const cli = fakeCli(() => '.cli-owned')
    const localSkills: LocalSkillSource[] = [
      { kind: 'managed', key: 'managed:m1:r1', name: 'managed', sourceDir: managedDir },
      { kind: 'dream', key: 'dream:dream', name: 'dream', sourceDir: dreamDir }
    ]

    const result = await installSkills({ id: 'a1', runtime: 'claude', skills: [] }, cwd, {
      stateDir,
      localSkills,
      runCli: cli.run
    })

    expect(result.errors).toEqual([])
    expect(cli.calls.map(({ agentId, skills }) => ({ agentId, skills }))).toEqual([
      { agentId: 'claude-code', skills: ['managed'] },
      { agentId: 'claude-code', skills: ['dream'] }
    ])
    expect(await readFile(join(cwd, '.cli-owned/skills/managed/SKILL.md'), 'utf8')).toContain('# managed')
    expect(await readFile(join(cwd, '.cli-owned/skills/dream/SKILL.md'), 'utf8')).toContain('# dream')
  }, 120_000)

  it('publishes a Codex skill through a contained workspace-local skill-root alias', async () => {
    const sourceDir = await writeSkill(sources, 'audit', 'audit')
    await mkdir(join(cwd, '.claude/skills'), { recursive: true })
    await mkdir(join(cwd, '.agents'))
    await symlink('../.claude/skills', join(cwd, '.agents/skills'))
    const cli = fakeCli(() => '.agents')

    const result = await installSkills({ id: 'a1', runtime: 'codex-acp', skills: [] }, cwd, {
      stateDir,
      localSkills: [{ kind: 'dream', key: 'dream:audit', name: 'audit', sourceDir }],
      runCli: cli.run
    })

    expect(result.errors).toEqual([])
    // Ownership is reported by the real directory, not by whichever root the harness named.
    expect(result.installed).toEqual(['.claude/skills/audit'])
    expect(await readFile(join(cwd, '.claude/skills/audit/SKILL.md'), 'utf8')).toContain('# audit')
  })

  // The real CLI decides the destination: dsh-acp's `universal` identity must land in the
  // `<projectRoot>/.agents/skills` root the DeepSeek Harness skill provider scans.
  it('publishes a DeepSeek Harness skill through the real CLI into .agents/skills', async () => {
    const sourceDir = await writeSkill(sources, 'dsh-golden', 'dsh-golden')

    const result = await installSkills({ id: 'a1', runtime: 'dsh-acp', skills: [] }, cwd, {
      stateDir,
      localSkills: [{ kind: 'dream', key: 'dream:dsh-golden', name: 'dsh-golden', sourceDir }]
    })

    expect(result.errors).toEqual([])
    expect(result.installed).toEqual(['.agents/skills/dsh-golden'])
    expect(await readFile(join(cwd, '.agents/skills/dsh-golden/SKILL.md'), 'utf8')).toContain('# dsh-golden')
  }, 120_000)

  it('keeps an aliased skill root owned across a harness switch', async () => {
    const sourceDir = await writeSkill(sources, 'aliased', 'v1')
    const localSkills: LocalSkillSource[] = [{ kind: 'dream', key: 'dream:aliased', name: 'aliased', sourceDir }]
    await mkdir(join(cwd, '.claude/skills'), { recursive: true })
    await mkdir(join(cwd, '.agents'))
    await symlink('../.claude/skills', join(cwd, '.agents/skills'))
    // Claude names the root .claude/skills; Codex names that same directory .agents/skills.
    const cli = fakeCli((agentId) => (agentId === 'claude-code' ? '.claude' : '.agents'))

    const first = await installSkills({ id: 'a1', runtime: 'claude', skills: [] }, cwd, {
      stateDir,
      localSkills,
      runCli: cli.run
    })
    expect(first.errors).toEqual([])
    expect(existsSync(join(cwd, '.claude/skills/aliased/SKILL.md'))).toBe(true)

    const switched = await installSkills({ id: 'a1', runtime: 'codex', skills: [] }, cwd, {
      stateDir,
      localSkills,
      runCli: cli.run
    })

    // The switch must not read its own bundle as a foreign path, and both harnesses must agree on the real directory.
    expect(switched.errors).toEqual([])
    expect(switched.installed).toEqual(['.claude/skills/aliased'])
    // Surviving bytes are the proof it was not installed under one root and then removed under the other.
    expect(await readFile(join(cwd, '.claude/skills/aliased/SKILL.md'), 'utf8')).toContain('# v1')
  }, 120_000)

  it('skips a foreign bundle at one destination instead of failing the whole install', async () => {
    const takenDir = await writeSkill(sources, 'taken', 'ours')
    const freshDir = await writeSkill(sources, 'fresh', 'fresh')
    const cli = fakeCli(() => '.runtime')
    await mkdir(join(cwd, '.runtime/skills/taken'), { recursive: true })
    await writeFile(join(cwd, '.runtime/skills/taken/SKILL.md'), 'not ours')
    const warnings: string[] = []

    const result = await installSkills({ id: 'a1', runtime: 'claude', skills: [] }, cwd, {
      stateDir,
      localSkills: [
        { kind: 'dream', key: 'dream:taken', name: 'taken', sourceDir: takenDir },
        { kind: 'dream', key: 'dream:fresh', name: 'fresh', sourceDir: freshDir }
      ],
      runCli: cli.run,
      warn: (message) => warnings.push(message)
    })

    expect(result.errors).toEqual([
      { source: '.runtime/skills/taken', error: 'destination is not owned by this daemon ledger; skill skipped' }
    ])
    expect(warnings.some((message) => message.includes('skipped unowned skill .runtime/skills/taken'))).toBe(true)
    // The foreign bytes stay untouched, and one conflict does not cost the agent its other skills.
    expect(await readFile(join(cwd, '.runtime/skills/taken/SKILL.md'), 'utf8')).toBe('not ours')
    expect(existsSync(join(cwd, '.runtime/skills/fresh/SKILL.md'))).toBe(true)

    // An unmet plan must not be recorded as satisfied: the conflict has to keep being reported and retried.
    const repeated = await installSkills({ id: 'a1', runtime: 'claude', skills: [] }, cwd, {
      stateDir,
      localSkills: [
        { kind: 'dream', key: 'dream:taken', name: 'taken', sourceDir: takenDir },
        { kind: 'dream', key: 'dream:fresh', name: 'fresh', sourceDir: freshDir }
      ],
      runCli: cli.run
    })
    expect(repeated.skipped).toBeNull()
    expect(repeated.errors).toHaveLength(1)

    await rm(join(cwd, '.runtime/skills/taken'), { recursive: true })
    const cleared = await installSkills({ id: 'a1', runtime: 'claude', skills: [] }, cwd, {
      stateDir,
      localSkills: [
        { kind: 'dream', key: 'dream:taken', name: 'taken', sourceDir: takenDir },
        { kind: 'dream', key: 'dream:fresh', name: 'fresh', sourceDir: freshDir }
      ],
      runCli: cli.run
    })
    expect(cleared.errors).toEqual([])
    expect(await readFile(join(cwd, '.runtime/skills/taken/SKILL.md'), 'utf8')).toContain('# ours')
  }, 120_000)

  it('refuses a skill-root alias that resolves outside the workspace', async () => {
    const sourceDir = await writeSkill(sources, 'escape', 'escape')
    const outside = join(root, 'outside')
    await mkdir(outside, { recursive: true })
    await mkdir(join(cwd, '.agents'))
    await symlink(outside, join(cwd, '.agents/skills'))
    const cli = fakeCli(() => '.agents')

    // Containment is the security boundary, so an escaping alias fails closed rather than degrading to a skip.
    await expect(
      installSkills({ id: 'a1', runtime: 'codex-acp', skills: [] }, cwd, {
        stateDir,
        localSkills: [{ kind: 'dream', key: 'dream:escape', name: 'escape', sourceDir }],
        runCli: cli.run
      })
    ).rejects.toThrow(/resolves outside workspace|mutation was refused|could not be restored/)
    expect(existsSync(join(outside, 'escape'))).toBe(false)
  }, 120_000)

  it.each([
    ['direct skills root', ''],
    ['multi-component prefix', 'vendor/harness']
  ])('publishes a generic CLI-derived %s without a harness path map', async (_label, cliRoot) => {
    const sourceDir = await writeSkill(sources, 'portable', 'portable')
    const cli = fakeCli(() => cliRoot)

    const result = await installSkills({ id: 'a1', runtime: 'claude', skills: [] }, cwd, {
      stateDir,
      localSkills: [{ kind: 'dream', key: 'dream:portable', name: 'portable', sourceDir }],
      runCli: cli.run
    })

    expect(result.errors).toEqual([])
    expect(await readFile(join(cwd, cliRoot, 'skills/portable/SKILL.md'), 'utf8')).toContain('# portable')
  })

  it('feeds acquired Git, managed, and Dream sources through one ordered CLI seam with later-source precedence', async () => {
    const gitDir = await writeSkill(sources, 'shared', 'git')
    const managedDir = await writeSkill(join(sources, 'managed-root'), 'shared', 'managed')
    const dreamDir = await writeSkill(join(sources, 'dream-root'), 'shared', 'dream')
    const cli = fakeCli(() => '.runtime')

    const result = await installSkills(
      {
        id: 'a1',
        runtime: 'claude',
        skills: [{ name: 'git', source: 'acme/skills', githubRepoId: '42', skills: ['shared'] }]
      },
      cwd,
      {
        stateDir,
        localSkills: [
          { kind: 'managed', key: 'managed:m1:r1', name: 'shared', sourceDir: managedDir },
          { kind: 'dream', key: 'dream:shared', name: 'shared', sourceDir: dreamDir }
        ],
        acquireGit: async () => ({ sourceDir: gitDir, resolvedCommit: 'a'.repeat(40) }),
        runCli: cli.run
      }
    )

    expect(result.errors).toEqual([])
    expect(cli.calls.map((call) => call.sourceKey.split(':')[0])).toEqual(['git', 'managed', 'dream'])
    expect(await readFile(join(cwd, '.runtime/skills/shared/SKILL.md'), 'utf8')).toContain('# dream')
  })

  it('resolves a canonical Git selection to the display-style frontmatter name the CLI matches (#371)', async () => {
    // Issue #371 shape: the wire selection is the canonical directory name,
    // but the CLI matches -s against the SKILL.md frontmatter name and derives
    // the install leaf from it.
    const gitRoot = join(sources, 'grill')
    await mkdir(join(gitRoot, 'skills/grill-me'), { recursive: true })
    await writeFile(join(gitRoot, 'skills/grill-me/SKILL.md'), skillBody('Grill Me', 'grill me'))
    const calls: SkillsCliInvocation[] = []
    const runCli = async (input: SkillsCliInvocation): Promise<SkillsCliInvocationResult> => {
      calls.push(input)
      // Emulate the pinned CLI: install under the sanitized frontmatter name.
      const leaf = input.skills[0]!.toLowerCase().replace(/[\s_]+/g, '-')
      const bundleDir = join(input.cellDir, '.runtime', 'skills', leaf)
      await mkdir(bundleDir, { recursive: true })
      const body = await readFile(join(input.sourceDir, 'skills/grill-me/SKILL.md'), 'utf8')
      await writeFile(join(bundleDir, 'SKILL.md'), body)
      return {
        bundles: [{ relativeRoot: `.runtime/skills/${leaf}`, sourceDir: bundleDir }],
        stdoutDigest: digest('ok'),
        stderrDigest: digest('')
      }
    }

    const result = await installSkills(
      {
        id: 'a1',
        runtime: 'claude',
        skills: [{ name: 'grill', source: 'acme/grill', githubRepoId: '42', skills: ['grill-me'] }]
      },
      cwd,
      { stateDir, acquireGit: async () => ({ sourceDir: gitRoot, resolvedCommit: 'a'.repeat(40) }), runCli }
    )

    expect(result.errors).toEqual([])
    expect(calls.map((call) => call.skills)).toEqual([['Grill Me']])
    expect(result.installed).toContain('.runtime/skills/grill-me')
    expect(await readFile(join(cwd, '.runtime/skills/grill-me/SKILL.md'), 'utf8')).toContain('# grill me')
  })

  it('fails the transaction with the available names when a Git selection matches nothing', async () => {
    const gitRoot = join(sources, 'grill-missing')
    await mkdir(join(gitRoot, 'skills/grill-me'), { recursive: true })
    await writeFile(join(gitRoot, 'skills/grill-me/SKILL.md'), skillBody('Grill Me', 'grill me'))
    const cli = fakeCli(() => '.runtime')

    const result = await installSkills(
      {
        id: 'a1',
        runtime: 'claude',
        skills: [{ name: 'grill', source: 'acme/grill', githubRepoId: '42', skills: ['barbecue'] }]
      },
      cwd,
      { stateDir, acquireGit: async () => ({ sourceDir: gitRoot, resolvedCommit: 'a'.repeat(40) }), runCli: cli.run }
    )

    expect(result.errors[0]?.error).toMatch(/"barbecue" was not found in source "grill" \(available: grill-me\)/)
    expect(cli.calls).toHaveLength(0)
  })

  it('omits invalid historical Git sources and still installs their valid sibling', async () => {
    const validDir = await writeSkill(sources, 'valid', 'valid')
    const cli = fakeCli(() => '.runtime')
    const acquiredSources: string[] = []
    const warnings: string[] = []

    const result = await installSkills(
      {
        id: 'a1',
        runtime: 'claude',
        skills: [
          { name: 'legacy', source: 'https://gitlab.com/acme/legacy', skills: [] },
          { name: 'unbound-old-cp', source: 'acme/unbound', skills: ['unbound'] },
          { name: 'valid', source: 'acme/valid', githubRepoId: '42', skills: ['valid'] }
        ]
      },
      cwd,
      {
        stateDir,
        acquireGit: async (entry) => {
          acquiredSources.push(entry.source)
          return { sourceDir: validDir, resolvedCommit: 'a'.repeat(40) }
        },
        runCli: cli.run,
        warn: (message) => warnings.push(message)
      }
    )

    expect(result.errors).toEqual([])
    expect(acquiredSources).toEqual(['acme/valid'])
    expect(cli.calls).toHaveLength(1)
    expect(result.installed).toContain('.runtime/skills/valid')
    expect(await readFile(join(cwd, '.runtime/skills/valid/SKILL.md'), 'utf8')).toContain('# valid')
    expect(warnings).toContainEqual(expect.stringContaining('omitted historical Git source 1'))
    expect(warnings).toContainEqual(expect.stringContaining('omitted historical Git source 2'))
  })

  it('retains a moving Git source commit across unrelated plan invalidations', async () => {
    const gitDir = await writeSkill(sources, 'git-skill', 'git')
    const dreamDir = await writeSkill(sources, 'local-skill', 'local')
    const cli = fakeCli(() => '.runtime')
    const firstCommit = 'a'.repeat(40)
    const changedCommit = 'b'.repeat(40)
    const requestedRefs: Array<string | undefined> = []
    const acquireGit = async (entry: { ref?: string }) => {
      requestedRefs.push(entry.ref)
      return {
        sourceDir: gitDir,
        resolvedCommit: entry.ref === 'release' ? changedCommit : (entry.ref ?? firstCommit)
      }
    }
    const moving = { name: 'git', source: 'acme/skills', githubRepoId: '42', skills: ['git-skill'] }

    await installSkills({ id: 'a1', runtime: 'claude', skills: [moving] }, cwd, {
      stateDir,
      acquireGit,
      runCli: cli.run
    })
    await installSkills({ id: 'a1', runtime: 'claude', skills: [{ ...moving, name: 'renamed-display' }] }, cwd, {
      stateDir,
      localSkills: [{ kind: 'dream', key: 'dream:local', name: 'local-skill', sourceDir: dreamDir }],
      acquireGit,
      runCli: cli.run
    })
    await installSkills({ id: 'a1', runtime: 'claude', skills: [{ ...moving, githubRepoId: '43' }] }, cwd, {
      stateDir,
      localSkills: [{ kind: 'dream', key: 'dream:local', name: 'local-skill', sourceDir: dreamDir }],
      acquireGit,
      runCli: cli.run
    })
    await installSkills({ id: 'a1', runtime: 'claude', skills: [{ ...moving, ref: 'release' }] }, cwd, {
      stateDir,
      localSkills: [{ kind: 'dream', key: 'dream:local', name: 'local-skill', sourceDir: dreamDir }],
      acquireGit,
      runCli: cli.run
    })

    expect(requestedRefs).toEqual([undefined, firstCommit, undefined, 'release'])
  }, 120_000)

  it('uses the unchanged fast path for duplicate repo/ref acquisition identities', async () => {
    // Real subDir acquisition hands the CLI the subdirectory content, so each
    // entry's snapshot must actually contain its selected skill.
    const oneDir = await writeSkill(join(sources, 'catalog'), 'one', 'git')
    const twoDir = await writeSkill(join(sources, 'catalog'), 'two', 'git')
    const cli = fakeCli(() => '.runtime')
    const commit = 'a'.repeat(40)
    const requestedRefs: Array<string | undefined> = []
    const acquireGit = async (entry: { ref?: string; subDir?: string }) => {
      requestedRefs.push(entry.ref)
      return { sourceDir: entry.subDir === 'catalog/one' ? oneDir : twoDir, resolvedCommit: entry.ref ?? commit }
    }
    const skills = [
      { name: 'one', source: 'acme/skills', githubRepoId: '42', subDir: 'catalog/one', skills: ['one'] },
      { name: 'two', source: 'acme/skills', githubRepoId: '42', subDir: 'catalog/two', skills: ['two'] }
    ]

    await installSkills({ id: 'a1', runtime: 'claude', skills }, cwd, { stateDir, acquireGit, runCli: cli.run })
    const unchanged = await installSkills({ id: 'a1', runtime: 'claude', skills }, cwd, {
      stateDir,
      acquireGit,
      runCli: cli.run
    })

    expect(unchanged.skipped).toBe('unchanged')
    expect(requestedRefs).toEqual([undefined, commit])
    expect(cli.calls).toHaveLength(2)
  }, 120_000)

  it('removes the old CLI-derived root on a harness switch and preserves unowned skills', async () => {
    const sourceDir = await writeSkill(sources, 'deploy', 'v1')
    const localSkills: LocalSkillSource[] = [{ kind: 'dream', key: 'dream:deploy', name: 'deploy', sourceDir }]
    const cli = fakeCli((agentId) => (agentId === 'claude-code' ? '.from-claude' : '.from-codex'))

    await installSkills({ id: 'a1', runtime: 'claude', skills: [] }, cwd, { stateDir, localSkills, runCli: cli.run })
    await mkdir(join(cwd, '.manual/skills/mine'), { recursive: true })
    await writeFile(join(cwd, '.manual/skills/mine/SKILL.md'), 'mine')

    const switched = await installSkills({ id: 'a1', runtime: 'codex', skills: [] }, cwd, {
      stateDir,
      localSkills,
      runCli: cli.run
    })

    expect(switched.removed).toContain('.from-claude/skills/deploy')
    expect(existsSync(join(cwd, '.from-claude/skills/deploy'))).toBe(false)
    expect(existsSync(join(cwd, '.from-codex/skills/deploy/SKILL.md'))).toBe(true)
    expect(existsSync(join(cwd, '.manual/skills/mine/SKILL.md'))).toBe(true)
  }, 120_000)

  it('serializes the complete acquisition/install transaction for one workspace', async () => {
    const sourceDir = await writeSkill(sources, 'serialized', 'serialized')
    const base = fakeCli(() => '.runtime')
    let active = 0
    let maxActive = 0
    const runCli = async (input: SkillsCliInvocation): Promise<SkillsCliInvocationResult> => {
      active += 1
      maxActive = Math.max(maxActive, active)
      try {
        await new Promise((resolve) => setTimeout(resolve, 50))
        return await base.run(input)
      } finally {
        active -= 1
      }
    }
    const options = {
      stateDir,
      localSkills: [{ kind: 'dream' as const, key: 'dream:serialized', name: 'serialized', sourceDir }],
      runCli
    }

    const [first, second] = await Promise.all([
      installSkills({ id: 'a1', runtime: 'claude', skills: [] }, cwd, options),
      installSkills({ id: 'a1', runtime: 'claude', skills: [] }, cwd, options)
    ])

    expect(maxActive).toBe(1)
    expect(base.calls).toHaveLength(1)
    expect([first.skipped, second.skipped]).toContain('unchanged')
  })

  it('claims a prepared cwd before skills exist and rejects every different agent', async () => {
    await expect(installSkills({ id: 'a1', runtime: 'claude', skills: [] }, cwd, { stateDir })).resolves.toMatchObject({
      errors: []
    })
    await expect(installSkills({ id: 'a2', runtime: 'codex', skills: [] }, cwd, { stateDir })).rejects.toThrow(
      /belongs to another agent/
    )

    const sourceDir = await writeSkill(sources, 'owned', 'owned')
    const cli = fakeCli(() => '.runtime')
    await installSkills({ id: 'a1', runtime: 'claude', skills: [] }, cwd, {
      stateDir,
      localSkills: [{ kind: 'dream', key: 'dream:owned', name: 'owned', sourceDir }],
      runCli: cli.run
    })
    await expect(installSkills({ id: 'a2', runtime: 'codex', skills: [] }, cwd, { stateDir })).rejects.toThrow(
      /belongs to another agent/
    )
  })

  it('does not inherit deletion authority when a workspace path is recreated', async () => {
    const sourceDir = await writeSkill(sources, 'recreated', 'reviewed')
    const cli = fakeCli(() => '.runtime')
    const localSkills: LocalSkillSource[] = [{ kind: 'dream', key: 'dream:recreated', name: 'recreated', sourceDir }]
    await installSkills({ id: 'a1', runtime: 'claude', skills: [] }, cwd, {
      stateDir,
      localSkills,
      runCli: cli.run
    })

    await rm(cwd, { recursive: true })
    await mkdir(join(cwd, '.runtime/skills/recreated'), { recursive: true })
    await writeFile(join(cwd, '.runtime/skills/recreated/SKILL.md'), 'manual replacement')

    await expect(
      installSkills({ id: 'a1', runtime: 'claude', skills: [] }, cwd, {
        stateDir,
        localSkills,
        runCli: cli.run
      })
      // A recreated workspace path is rejected fail-closed. The exact guard that
      // fires first is platform-dependent (ownership vs the inode-bound restore
      // check on Linux); both refuse and, crucially, leave the manual content
      // untouched — which is the security property this test pins.
    ).rejects.toThrow(/not owned by this daemon ledger|prior executable set could not be restored/)
    expect(await readFile(join(cwd, '.runtime/skills/recreated/SKILL.md'), 'utf8')).toBe('manual replacement')
  })

  it('checks installed bytes rather than trusting a matching plan fingerprint and preserves tampering', async () => {
    const sourceDir = await writeSkill(sources, 'repair', 'expected')
    const cli = fakeCli(() => '.runtime')
    const localSkills: LocalSkillSource[] = [{ kind: 'dream', key: 'dream:repair', name: 'repair', sourceDir }]

    await installSkills({ id: 'a1', runtime: 'claude', skills: [] }, cwd, { stateDir, localSkills, runCli: cli.run })
    const unchanged = await installSkills({ id: 'a1', runtime: 'claude', skills: [] }, cwd, {
      stateDir,
      localSkills,
      runCli: cli.run
    })
    expect(unchanged.skipped).toBe('unchanged')
    expect(cli.calls).toHaveLength(1)

    await writeFile(join(cwd, '.runtime/skills/repair/SKILL.md'), 'tampered')
    await expect(
      installSkills({ id: 'a1', runtime: 'claude', skills: [] }, cwd, { stateDir, localSkills, runCli: cli.run })
    ).rejects.toThrow(/could not be restored|mutation was refused/i)
    expect(cli.calls).toHaveLength(2)
    expect(await readFile(join(cwd, '.runtime/skills/repair/SKILL.md'), 'utf8')).toBe('tampered')
  }, 120_000)

  it('refuses a workspace-planted parent symlink without touching the outside canary', async () => {
    const sourceDir = await writeSkill(sources, 'safe', 'safe')
    const outside = join(root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'canary'), 'KEEP')
    await symlink(outside, join(cwd, '.runtime'), 'dir')
    const cli = fakeCli(() => '.runtime')

    await expect(
      installSkills({ id: 'a1', runtime: 'claude', skills: [] }, cwd, {
        stateDir,
        localSkills: [{ kind: 'dream', key: 'dream:safe', name: 'safe', sourceDir }],
        runCli: cli.run
      })
    ).rejects.toThrow(/could not be restored|mutation was refused/i)
    expect(await readFile(join(outside, 'canary'), 'utf8')).toBe('KEEP')
    expect(existsSync(join(outside, 'skills/safe'))).toBe(false)
  })

  it('rejects a local source symlink before invoking the CLI', async () => {
    const sourceDir = await writeSkill(sources, 'linked', 'linked')
    const secret = join(root, 'secret')
    await writeFile(secret, 'DO NOT COPY')
    await symlink(secret, join(sourceDir, 'secret.txt'))
    const cli = fakeCli(() => '.runtime')

    const result = await installSkills({ id: 'a1', runtime: 'claude', skills: [] }, cwd, {
      stateDir,
      localSkills: [{ kind: 'dream', key: 'dream:linked', name: 'linked', sourceDir }],
      runCli: cli.run
    })

    expect(result.errors[0]?.error).toMatch(/link/i)
    expect(cli.calls).toHaveLength(0)
  })

  it('rejects a local tree whose fresh snapshot does not match its trusted tree digest', async () => {
    const sourceDir = await writeSkill(sources, 'bound', 'reviewed')
    const cli = fakeCli(() => '.runtime')

    const result = await installSkills({ id: 'a1', runtime: 'claude', skills: [] }, cwd, {
      stateDir,
      localSkills: [
        {
          kind: 'dream',
          key: 'dream:bound',
          name: 'bound',
          sourceDir,
          expectedTreeDigest: `sha256:${'0'.repeat(64)}`
        }
      ],
      runCli: cli.run
    })

    expect(result.errors[0]?.error).toMatch(/declared content digest/)
    expect(cli.calls).toHaveLength(0)
  })

  it('clears a previously owned bundle when a changed source can no longer be staged', async () => {
    const sourceDir = await writeSkill(sources, 'revoked', 'safe')
    const cli = fakeCli(() => '.runtime')
    const localSkills: LocalSkillSource[] = [{ kind: 'dream', key: 'dream:revoked', name: 'revoked', sourceDir }]
    await installSkills({ id: 'a1', runtime: 'claude', skills: [] }, cwd, { stateDir, localSkills, runCli: cli.run })
    expect(existsSync(join(cwd, '.runtime/skills/revoked/SKILL.md'))).toBe(true)

    await writeFile(join(root, 'secret'), 'secret')
    await symlink(join(root, 'secret'), join(sourceDir, 'new-link'))
    const failed = await installSkills({ id: 'a1', runtime: 'claude', skills: [] }, cwd, {
      stateDir,
      localSkills,
      runCli: cli.run
    })

    expect(failed.errors[0]?.error).toMatch(/link/i)
    expect(failed.removed).toContain('.runtime/skills/revoked')
    expect(existsSync(join(cwd, '.runtime/skills/revoked'))).toBe(false)
  })

  it('blocks startup on unmigrated legacy executable state instead of silently preserving stale skills', async () => {
    await mkdir(join(cwd, '.claude/skills/old-owned'), { recursive: true })
    await writeFile(join(cwd, '.claude/skills/old-owned/SKILL.md'), 'old')
    await mkdir(join(cwd, '.claude/skills/manual'), { recursive: true })
    await writeFile(join(cwd, '.claude/skills/manual/SKILL.md'), 'manual')
    await mkdir(join(cwd, '.agentconnect'))
    await writeFile(
      join(cwd, '.agentconnect/skills-install.json'),
      JSON.stringify({ installed: ['.claude/skills/old-owned'] })
    )

    await expect(installSkills({ id: 'a1', runtime: 'claude', skills: [] }, cwd, { stateDir })).rejects.toThrow(
      /requires explicit migration/
    )

    expect(existsSync(join(cwd, '.claude/skills/old-owned'))).toBe(true)
    expect(existsSync(join(cwd, '.claude/skills/manual/SKILL.md'))).toBe(true)
  })

  it('blocks a changed plan before acquisition while legacy executables remain unowned', async () => {
    await mkdir(join(cwd, '.claude/skills/old-owned'), { recursive: true })
    await writeFile(join(cwd, '.claude/skills/old-owned/SKILL.md'), 'old')
    await mkdir(join(cwd, '.agentconnect'))
    await writeFile(
      join(cwd, '.agentconnect/skills-install.json'),
      JSON.stringify({ installed: ['.claude/skills/old-owned'] })
    )
    let acquired = false

    await expect(
      installSkills(
        {
          id: 'a1',
          runtime: 'claude',
          skills: [{ name: 'new', source: 'acme/skills', githubRepoId: '42', skills: [] }]
        },
        cwd,
        {
          stateDir,
          acquireGit: async () => {
            acquired = true
            throw new Error('unreachable')
          }
        }
      )
    ).rejects.toThrow(/requires explicit migration/)

    expect(acquired).toBe(false)
    expect(await readFile(join(cwd, '.claude/skills/old-owned/SKILL.md'), 'utf8')).toBe('old')
  })

  it('blocks a forged legacy marker without letting it authorize deletion', async () => {
    const keep = join(cwd, 'keep')
    await mkdir(keep)
    await writeFile(join(keep, 'canary'), 'KEEP')
    await mkdir(join(cwd, '.agentconnect'))
    await writeFile(
      join(cwd, '.agentconnect/skills-install.json'),
      JSON.stringify({ installed: ['../keep', '.claude/skills/../../keep', '/tmp/anything'] })
    )

    await expect(installSkills({ id: 'a1', runtime: 'claude', skills: [] }, cwd, { stateDir })).rejects.toThrow(
      /legacy skill ownership marker.*unsafe/
    )

    expect(await readFile(join(keep, 'canary'), 'utf8')).toBe('KEEP')
  })

  it('blocks a malformed known legacy marker instead of treating it as absent', async () => {
    await mkdir(join(cwd, '.agentconnect'))
    await writeFile(join(cwd, '.agentconnect/dream-skills-install.json'), '{"installed":')

    await expect(installSkills({ id: 'a1', runtime: 'claude', skills: [] }, cwd, { stateDir })).rejects.toThrow(
      /legacy skill ownership marker.*unsafe/
    )
  })

  it('requires legacy marker removal even when a trusted v3 ledger exists', async () => {
    const sourceDir = await writeSkill(sources, 'owned', 'owned')
    const cli = fakeCli(() => '.runtime')
    const localSkills: LocalSkillSource[] = [{ kind: 'dream', key: 'dream:owned', name: 'owned', sourceDir }]
    await installSkills({ id: 'a1', runtime: 'claude', skills: [] }, cwd, {
      stateDir,
      localSkills,
      runCli: cli.run
    })
    await mkdir(join(cwd, '.agentconnect'), { recursive: true })
    await writeFile(
      join(cwd, '.agentconnect/skills-install.json'),
      JSON.stringify({ installed: ['.claude/skills/stale'] })
    )

    await expect(
      installSkills({ id: 'a1', runtime: 'claude', skills: [] }, cwd, { stateDir, localSkills, runCli: cli.run })
    ).rejects.toThrow(/requires explicit migration/)
    expect(cli.calls).toHaveLength(1)
    expect(existsSync(join(cwd, '.runtime/skills/owned/SKILL.md'))).toBe(true)
  })
})
