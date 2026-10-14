// Per-Source skill failure codes reported to the CP (source-cache.md §11): what each install path reports and the code each failure carries.
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentSkillStatus, SkillSourceFailureCode } from '@agentconnect.md/protocol'
import {
  installSkills,
  type SkillsCliInvocation,
  type SkillsCliInvocationResult
} from '../src/skills/install-skills.js'
import { SkillSkipCodeSchema } from '../src/shim/skill-protocol.js'
import {
  SkillSourceFailure,
  httpSkillFailure,
  skillSourceFailureCode,
  uniqueSkillSourceFailures
} from '../src/skills/skill-source-failure.js'
import { SkillSourceSnapshotError } from '../src/skills/skill-source-snapshot.js'

const digest = (body: string) => createHash('sha256').update(body).digest('hex')

function fakeCli(fail?: (input: SkillsCliInvocation) => boolean) {
  return async (input: SkillsCliInvocation): Promise<SkillsCliInvocationResult> => {
    if (fail?.(input)) throw new Error('skills CLI exited 1: raw output that must never reach the CP')
    const name = input.skills[0] ?? 'git-skill'
    const relativeRoot = `.runtime/skills/${name}`
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
}

describe('skill source failure codes', () => {
  it('is the shim vocabulary', () => {
    expect(SkillSkipCodeSchema.options).toEqual(SkillSourceFailureCode.options)
  })

  it('reads a tagged failure, a snapshot refusal and an untagged error', () => {
    expect(skillSourceFailureCode(new SkillSourceFailure('ref_moved', 'x'))).toBe('ref_moved')
    expect(skillSourceFailureCode(new SkillSourceSnapshotError('too many files'))).toBe('limits_exceeded')
    expect(skillSourceFailureCode(new Error('boom'))).toBe('fetch_failed')
    expect(skillSourceFailureCode(new Error('boom'), 'cli_failed')).toBe('cli_failed')
  })

  it('reads an authentication refusal as access_denied', () => {
    expect(httpSkillFailure(401, 'fetch_failed', 'm').code).toBe('access_denied')
    expect(httpSkillFailure(403, 'resolution_failed', 'm').code).toBe('access_denied')
    expect(httpSkillFailure(500, 'fetch_failed', 'm').code).toBe('fetch_failed')
  })

  it('keeps the first failure per name and fits the wire bound', () => {
    const many = Array.from({ length: 70 }, (_, i) => ({ name: `s${i}`, code: 'fetch_failed' as const }))
    const unique = uniqueSkillSourceFailures([{ name: 's0', code: 'cli_failed' }, ...many])
    expect(unique[0]).toEqual({ name: 's0', code: 'cli_failed' })
    expect(unique).toHaveLength(64)
    expect(
      AgentSkillStatus.safeParse({
        agentId: '00000000-0000-4000-8000-000000000001',
        failed: unique,
        ts: new Date(0).toISOString()
      }).success
    ).toBe(true)
  })
})

describe('installSkills reports failed Git Sources', () => {
  let root: string
  let cwd: string
  let stateDir: string
  let gitDir: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ac-skill-status-'))
    cwd = join(root, 'workspace')
    stateDir = join(root, 'state')
    gitDir = join(root, 'sources', 'git-skill')
    await mkdir(cwd)
    await mkdir(gitDir, { recursive: true })
    await writeFile(join(gitDir, 'SKILL.md'), '---\nname: git-skill\ndescription: fixture\n---\n# body\n')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const COMMIT = 'a'.repeat(40)
  const github = (name: string, id: string) => ({ name, source: `acme/${name}`, githubRepoId: id, skills: [] })
  const other = (name: string) => ({ name, source: `https://git.example.test/example-org/${name}.git`, skills: [] })

  it('names each failed Source with its code and clears once every Source installs', async () => {
    let failing = true
    const install = () =>
      installSkills(
        { id: 'a1', runtime: 'claude', skills: [github('ok', '41'), other('denied'), github('broken-cli', '43')] },
        cwd,
        {
          stateDir,
          acquireGit: async (entry) => {
            if (failing && entry.name === 'denied') throw new SkillSourceFailure('access_denied', 'raw host text')
            return { sourceDir: gitDir, resolvedCommit: COMMIT }
          },
          runCli: fakeCli((input) => failing && input.sourceKey.startsWith('git:2:'))
        }
      )

    const first = await install()
    expect(first.sourceFailures).toEqual([
      { name: 'denied', code: 'access_denied' },
      { name: 'broken-cli', code: 'cli_failed' }
    ])

    failing = false
    expect((await install()).sourceFailures).toEqual([])
    // The unchanged short-circuit still reports a clean run.
    expect((await install()).sourceFailures).toEqual([])
  })

  it('reports an untagged acquisition error as fetch_failed and nothing without Git Sources', async () => {
    const failed = await installSkills({ id: 'a2', runtime: 'claude', skills: [other('flaky')] }, cwd, {
      stateDir,
      acquireGit: async () => {
        throw new Error('socket hang up')
      },
      runCli: fakeCli()
    })
    expect(failed.sourceFailures).toEqual([{ name: 'flaky', code: 'fetch_failed' }])

    const none = await installSkills({ id: 'a2', runtime: 'claude', skills: [] }, cwd, { stateDir, runCli: fakeCli() })
    expect(none.sourceFailures).toBeUndefined()
  })
})
