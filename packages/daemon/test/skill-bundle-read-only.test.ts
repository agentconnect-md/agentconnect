import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  reconcileSkillBundles,
  treeDigest,
  type CandidateSkillBundle,
  type SkillFileReceipt
} from '../src/skills/skill-install-ledger.js'
import { removeTree } from './tree-support.js'

// The start gate only exists inside the sandbox wrapper; pin the ungated launch so every host runs this.
vi.mock('../src/skills/offline-sandbox.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/skills/offline-sandbox.js')>()),
  probeOfflineSandboxHost: () => ({ available: false, reason: 'pinned off for this test' })
}))

const BUNDLE = '.claude/skills/doc-skill'
const SKILL = '---\nname: doc-skill\ndescription: fixture\n---\n'
const sha256 = (body: string): string => createHash('sha256').update(body).digest('hex')

/** A source holding `files`, and the candidate receipt for it; a path under `scripts/` is executable. */
async function candidate(dir: string, sourceKey: string, files: Record<string, string>): Promise<CandidateSkillBundle> {
  const receipts: SkillFileReceipt[] = []
  for (const [path, body] of Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))) {
    await mkdir(join(dir, path, '..'), { recursive: true })
    const mode = path.startsWith('scripts/') ? 0o700 : 0o600
    await writeFile(join(dir, path), body, { mode })
    receipts.push({ path, mode, size: Buffer.byteLength(body), sha256: sha256(body) })
  }
  return { relativeRoot: BUNDLE, sourceKey, sourceDir: dir, files: receipts, treeDigest: treeDigest(receipts) }
}

const mode = async (path: string): Promise<number> => (await lstat(path)).mode & 0o777

describe.skipIf(process.platform === 'win32')('an installed skill bundle is read-only', () => {
  let root: string
  let cwd: string
  let target: string
  let options: { cwd: string; stateDir: string; agentId: string; runtime: string; cliVersion: string }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ac-skill-ro-'))
    cwd = join(root, 'workspace')
    target = join(cwd, ...BUNDLE.split('/'))
    await mkdir(cwd)
    options = { cwd, stateDir: join(root, 'state'), agentId: 'a1', runtime: 'claude', cliVersion: '1.5.21' }
  })

  afterEach(async () => {
    await removeTree(root)
  })

  it('publishes without owner-write, so a runtime cannot leave a directory inside it', async () => {
    await reconcileSkillBundles({
      ...options,
      fingerprint: 'v1',
      candidates: [
        await candidate(join(root, 'v1'), 'doc:v1', {
          'SKILL.md': SKILL,
          'references/a.md': 'a1\n',
          'scripts/run.sh': '#!/bin/sh\n'
        })
      ]
    })

    expect(await mode(target)).toBe(0o500)
    expect(await mode(join(target, 'references'))).toBe(0o500)
    expect(await mode(join(target, 'SKILL.md'))).toBe(0o400)
    expect(await mode(join(target, 'scripts/run.sh'))).toBe(0o500)
    // What Claude Code does in each directory a session works in.
    await expect(mkdir(join(target, '.claude'))).rejects.toMatchObject({ code: 'EACCES' })
    await expect(mkdir(join(target, 'references/.claude'))).rejects.toMatchObject({ code: 'EACCES' })
  })

  it('still replaces and removes the bundle it published', async () => {
    await reconcileSkillBundles({
      ...options,
      fingerprint: 'v1',
      candidates: [await candidate(join(root, 'v1'), 'doc:v1', { 'SKILL.md': SKILL, 'references/a.md': 'a1\n' })]
    })

    const replaced = await reconcileSkillBundles({
      ...options,
      fingerprint: 'v2',
      candidates: [await candidate(join(root, 'v2'), 'doc:v2', { 'SKILL.md': SKILL, 'references/a.md': 'a2\n' })]
    })
    expect(replaced.conflicts).toEqual([])
    expect(replaced.installed).toEqual([BUNDLE])
    expect(await readFile(join(target, 'references/a.md'), 'utf8')).toBe('a2\n')
    expect(await mode(target)).toBe(0o500)

    const removed = await reconcileSkillBundles({ ...options, fingerprint: 'v3', candidates: [] })
    expect(removed.conflicts).toEqual([])
    expect(existsSync(target)).toBe(false)
  })
})
