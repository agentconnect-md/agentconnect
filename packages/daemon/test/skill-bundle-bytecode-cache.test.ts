import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
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

const BUNDLE = '.claude/skills/py-skill'
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

describe.skipIf(process.platform === 'win32')('Python bytecode caches in an installed skill', () => {
  let root: string
  let cwd: string
  let options: { cwd: string; stateDir: string; agentId: string; runtime: string; cliVersion: string }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ac-skill-pycache-'))
    cwd = join(root, 'workspace')
    await mkdir(cwd)
    options = { cwd, stateDir: join(root, 'state'), agentId: 'a1', runtime: 'claude', cliVersion: '1.5.21' }
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('drops the caches a bundled script left behind and still updates the skill', async () => {
    const skill = '---\nname: py-skill\ndescription: fixture\n---\n'
    await reconcileSkillBundles({
      ...options,
      fingerprint: 'v1',
      candidates: [await candidate(join(root, 'v1'), 'py:v1', { 'SKILL.md': skill, 'scripts/run.py': 'print(1)\n' })]
    })
    const target = join(cwd, ...BUNDLE.split('/'))
    // What `python scripts/run.py` and an `import` from the skill root leave in the installed bundle.
    for (const cache of ['scripts/__pycache__', '__pycache__']) {
      await mkdir(join(target, cache))
      await writeFile(join(target, cache, 'run.cpython-312.pyc'), 'bytecode')
    }
    const warnings: string[] = []

    const result = await reconcileSkillBundles({
      ...options,
      fingerprint: 'v2',
      candidates: [await candidate(join(root, 'v2'), 'py:v2', { 'SKILL.md': skill, 'scripts/run.py': 'print(2)\n' })],
      warn: (message) => warnings.push(message)
    })

    expect(result.conflicts).toEqual([])
    expect(result.installed).toEqual([BUNDLE])
    expect(warnings).toEqual([])
    expect(await readFile(join(target, 'scripts/run.py'), 'utf8')).toBe('print(2)\n')
    expect(existsSync(join(target, 'scripts/__pycache__'))).toBe(false)
    expect(existsSync(join(target, '__pycache__'))).toBe(false)
  })

  it('only reads a cache when the skill is unchanged, even through a parent alias outside the workspace', async () => {
    const skill = '---\nname: py-skill\ndescription: fixture\n---\n'
    const unchanged = {
      ...options,
      fingerprint: 'v1',
      candidates: [await candidate(join(root, 'v1'), 'py:v1', { 'SKILL.md': skill, 'scripts/run.py': 'print(1)\n' })]
    }
    await reconcileSkillBundles(unchanged)
    const cache = join(cwd, ...BUNDLE.split('/'), 'scripts/__pycache__/run.cpython-312.pyc')
    await mkdir(join(cache, '..'))
    await writeFile(cache, 'bytecode')

    expect((await reconcileSkillBundles(unchanged)).conflicts).toEqual([])
    expect(await readFile(cache, 'utf8')).toBe('bytecode')

    const outside = join(root, 'outside-claude')
    await rename(join(cwd, '.claude'), outside)
    await symlink(outside, join(cwd, '.claude'))
    await reconcileSkillBundles(unchanged).catch(() => undefined)

    expect(await readFile(join(outside, 'skills/py-skill/scripts/__pycache__/run.cpython-312.pyc'), 'utf8')).toBe(
      'bytecode'
    )
  })

  it('keeps a cache the receipt itself installed', async () => {
    const files = { 'SKILL.md': '---\nname: py-skill\ndescription: fixture\n---\n', '__pycache__/shipped.pyc': 'x' }
    const options1 = { ...options, candidates: [await candidate(join(root, 'v1'), 'py:v1', files)] }
    await reconcileSkillBundles({ ...options1, fingerprint: 'v1' })

    const result = await reconcileSkillBundles({ ...options1, fingerprint: 'v1' })

    expect(result.conflicts).toEqual([])
    expect(await readFile(join(cwd, ...BUNDLE.split('/'), '__pycache__/shipped.pyc'), 'utf8')).toBe('x')
  })
})
