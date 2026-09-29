import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  readSkillLedger,
  reconcileSkillBundles,
  skillLedgerLocation,
  treeDigest,
  type CandidateSkillBundle,
  type SkillFileReceipt
} from '../src/skills/skill-install-ledger.js'

// Counts helper runs by kind, and can fail one batch after it has run some of its steps — the state a
// helper that dies partway through a batch leaves, which is what recovery must handle.
const helperRuns = vi.hoisted(() => ({
  single: [] as string[],
  batches: [] as string[][],
  failAfter: undefined as { action: string; steps: number } | undefined
}))

vi.mock('../src/skills/skill-workspace-mutator.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/skills/skill-workspace-mutator.js')>()
  return {
    ...actual,
    runSkillWorkspaceMutation: async (...args: Parameters<typeof actual.runSkillWorkspaceMutation>) => {
      helperRuns.single.push(String((args[0] as { action?: unknown }).action))
      return await actual.runSkillWorkspaceMutation(...args)
    },
    runSkillWorkspaceMutations: async (...args: Parameters<typeof actual.runSkillWorkspaceMutations>) => {
      const [specs, readRoots, signal] = args
      const actions = specs.map((spec) => String((spec as { action?: unknown }).action))
      helperRuns.batches.push(actions)
      const fail = helperRuns.failAfter
      if (fail && actions[0] === fail.action) {
        helperRuns.failAfter = undefined
        await actual.runSkillWorkspaceMutations(specs.slice(0, fail.steps), readRoots, signal)
        throw new Error('helper died mid-batch')
      }
      return await actual.runSkillWorkspaceMutations(specs, readRoots, signal)
    }
  }
})

const sha256 = (body: string): string => createHash('sha256').update(body).digest('hex')

describe.skipIf(process.platform === 'win32')('skill publication in batched helper runs', () => {
  let root: string
  let cwd: string
  let stateDir: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ac-skill-bulk-'))
    cwd = join(root, 'workspace')
    stateDir = join(root, 'state')
    await mkdir(cwd)
    helperRuns.single = []
    helperRuns.batches = []
    helperRuns.failAfter = undefined
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  /** `count` one-file skills whose body carries `version`, each from its own source directory. */
  async function candidates(count: number, version: string): Promise<CandidateSkillBundle[]> {
    const out: CandidateSkillBundle[] = []
    for (let index = 0; index < count; index++) {
      const sourceDir = join(root, `source-${version}`, `skill-${index}`)
      await mkdir(sourceDir, { recursive: true })
      const body = `---\nname: skill-${index}\ndescription: ${version}\n---\n`
      await writeFile(join(sourceDir, 'SKILL.md'), body)
      const files: SkillFileReceipt[] = [
        { path: 'SKILL.md', mode: 0o600, size: Buffer.byteLength(body), sha256: sha256(body) }
      ]
      out.push({
        relativeRoot: `.agents/skills/skill-${index}`,
        sourceKey: 'fixture',
        sourceDir,
        files,
        treeDigest: treeDigest(files)
      })
    }
    return out
  }

  const reconcile = async (list: CandidateSkillBundle[], fingerprint: string) =>
    await reconcileSkillBundles({
      cwd,
      stateDir,
      agentId: 'a1',
      runtime: 'codex',
      cliVersion: '1.5.21',
      fingerprint,
      candidates: list
    })

  const installedDescriptions = async (count: number): Promise<string[]> => {
    const out: string[] = []
    for (let index = 0; index < count; index++) {
      const body = await readFile(join(cwd, '.agents', 'skills', `skill-${index}`, 'SKILL.md'), 'utf8')
      out.push(/description: (\w+)/.exec(body)![1]!)
    }
    return out
  }

  it('publishes a first install in one reserve, one apply and one finalize helper run', async () => {
    const result = await reconcile(await candidates(20, 'v1'), 'v1')
    expect(result.installed).toHaveLength(20)
    expect(await installedDescriptions(20)).toEqual(Array(20).fill('v1'))
    expect(helperRuns.single).toEqual([])
    expect(helperRuns.batches.map((actions) => [actions[0], actions.length])).toEqual([
      ['reserve', 20],
      ['apply', 20],
      ['finalize', 20]
    ])
    // Nothing of the staging protocol is left beside the published skills.
    expect((await readdir(join(cwd, '.agents', 'skills'))).sort()).toEqual(
      Array.from({ length: 20 }, (_, index) => `skill-${index}`).sort()
    )
  })

  it('replaces a published set with finalize and cleanup of every bundle in the same batched pass', async () => {
    await reconcile(await candidates(10, 'v1'), 'v1')
    helperRuns.batches = []
    const result = await reconcile(await candidates(10, 'v2'), 'v2')
    expect(result.installed).toHaveLength(10)
    expect(await installedDescriptions(10)).toEqual(Array(10).fill('v2'))
    expect(helperRuns.single).toEqual([])
    const [reserve, apply, cleanup] = helperRuns.batches
    expect(reserve).toEqual(Array(10).fill('reserve'))
    expect(apply).toEqual(Array(10).fill('apply'))
    // Per path, finalize then cleanup, exactly the order of one mutation each.
    expect(cleanup).toEqual(Array.from({ length: 10 }, () => ['finalize', 'cleanup']).flat())
    expect(helperRuns.batches).toHaveLength(3)
  })

  it('splits a pass that exceeds the batch step limit into more helper runs', async () => {
    await reconcile(await candidates(40, 'v1'), 'v1')
    helperRuns.batches = []
    await reconcile(await candidates(40, 'v2'), 'v2')
    // 40 finalize + 40 cleanup steps: more than one run may carry.
    const cleanupRuns = helperRuns.batches.filter((actions) => actions[0] === 'finalize')
    expect(cleanupRuns.map((actions) => actions.length)).toEqual([64, 16])
    expect(await installedDescriptions(40)).toEqual(Array(40).fill('v2'))
  })

  it.each([
    ['reserve', 3],
    ['apply', 3]
  ])('restores the prior set when the %s helper dies after %i steps of its batch', async (action, steps) => {
    await reconcile(await candidates(8, 'v1'), 'v1')
    helperRuns.failAfter = { action, steps }
    await expect(reconcile(await candidates(8, 'v2'), 'v2')).rejects.toThrow()
    // Recovery ran from the journal: the whole prior set is back, nothing of v2 is published.
    expect(await installedDescriptions(8)).toEqual(Array(8).fill('v1'))
    expect((await readdir(join(cwd, '.agents', 'skills'))).sort()).toEqual(
      Array.from({ length: 8 }, (_, index) => `skill-${index}`).sort()
    )
    const ledger = await readSkillLedger(await skillLedgerLocation(cwd, stateDir))
    expect(ledger?.phase).toBe('ready')
    // The next run publishes cleanly over what recovery left.
    const result = await reconcile(await candidates(8, 'v3'), 'v3')
    expect(result.installed).toHaveLength(8)
    expect(await installedDescriptions(8)).toEqual(Array(8).fill('v3'))
  })
})
