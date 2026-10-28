import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  reconcileSkillBundles,
  treeDigest,
  type CandidateSkillBundle,
  type SkillFileReceipt
} from '../src/skills/skill-install-ledger.js'

// The start gate only exists inside the sandbox wrapper; pin the ungated launch so every host runs this.
vi.mock('../src/skills/offline-sandbox.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/skills/offline-sandbox.js')>()),
  probeOfflineSandboxHost: () => ({ available: false, reason: 'pinned off for this test' })
}))

const BUNDLE = '.claude/skills/doc-skill'
const SKILL = '---\nname: doc-skill\ndescription: fixture\n---\n'
const sha256 = (body: string): string => createHash('sha256').update(body).digest('hex')

/** A source holding `files`, and the candidate receipt for it. */
async function candidate(dir: string, sourceKey: string, files: Record<string, string>): Promise<CandidateSkillBundle> {
  const receipts: SkillFileReceipt[] = []
  for (const [path, body] of Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))) {
    await mkdir(join(dir, path, '..'), { recursive: true })
    await writeFile(join(dir, path), body)
    receipts.push({ path, mode: 0o600, size: Buffer.byteLength(body), sha256: sha256(body) })
  }
  return { relativeRoot: BUNDLE, sourceKey, sourceDir: dir, files: receipts, treeDigest: treeDigest(receipts) }
}

describe.skipIf(process.platform === 'win32')('file-less directories in an installed skill', () => {
  let root: string
  let cwd: string
  let options: { cwd: string; stateDir: string; agentId: string; runtime: string; cliVersion: string }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ac-skill-fileless-'))
    cwd = join(root, 'workspace')
    await mkdir(cwd)
    options = { cwd, stateDir: join(root, 'state'), agentId: 'a1', runtime: 'claude', cliVersion: '1.5.21' }
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('drops the write-staging directories a runtime left behind and still updates the skill', async () => {
    await reconcileSkillBundles({
      ...options,
      fingerprint: 'v1',
      candidates: [await candidate(join(root, 'v1'), 'doc:v1', { 'SKILL.md': SKILL, 'references/a.md': 'a1\n' })]
    })
    const target = join(cwd, ...BUNDLE.split('/'))
    // What Claude Code leaves in each directory a session works in.
    for (const staging of ['.claude/.cc-writes', 'references/.claude/.cc-writes']) {
      await mkdir(join(target, staging), { recursive: true })
    }
    const warnings: string[] = []

    const result = await reconcileSkillBundles({
      ...options,
      fingerprint: 'v2',
      candidates: [await candidate(join(root, 'v2'), 'doc:v2', { 'SKILL.md': SKILL, 'references/a.md': 'a2\n' })],
      warn: (message) => warnings.push(message)
    })

    expect(result.conflicts).toEqual([])
    expect(result.installed).toEqual([BUNDLE])
    expect(warnings).toEqual([])
    expect(await readFile(join(target, 'references/a.md'), 'utf8')).toBe('a2\n')
    expect(existsSync(join(target, '.claude'))).toBe(false)
    expect(existsSync(join(target, 'references/.claude'))).toBe(false)
  })

  it('keeps a foreign directory that holds a file, skipping the skill as edited', async () => {
    await reconcileSkillBundles({
      ...options,
      fingerprint: 'v1',
      candidates: [await candidate(join(root, 'v1'), 'doc:v1', { 'SKILL.md': SKILL, 'references/a.md': 'a1\n' })]
    })
    const target = join(cwd, ...BUNDLE.split('/'))
    await mkdir(join(target, 'notes/empty'), { recursive: true })
    await writeFile(join(target, 'notes/kept.md'), 'mine\n')

    const result = await reconcileSkillBundles({
      ...options,
      fingerprint: 'v2',
      candidates: [await candidate(join(root, 'v2'), 'doc:v2', { 'SKILL.md': SKILL, 'references/a.md': 'a2\n' })],
      warn: () => undefined
    })

    expect(result.installed).toEqual([])
    expect(await readFile(join(target, 'notes/kept.md'), 'utf8')).toBe('mine\n')
    expect(await readFile(join(target, 'references/a.md'), 'utf8')).toBe('a1\n')
  })
})
