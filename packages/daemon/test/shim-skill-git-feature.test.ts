import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { probeSkillGitInPod } from '../src/shim/skill-git-feature.js'
import { SkillGitTimeoutError, type SkillGitInvocation } from '../src/shim/skill-git-acquire.js'

describe('skill-git-in-pod-v1 advertisement probe', () => {
  let root: string | undefined
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
  })
  const staging = async (): Promise<string> => {
    root = await mkdtemp(join(tmpdir(), 'ac-skill-git-probe-'))
    return join(root, 'skills-staging')
  }
  const answering =
    (stdout: string, code = 0, calls: SkillGitInvocation[] = []) =>
    async (invocation: SkillGitInvocation) => {
      calls.push(invocation)
      return { code, stdout, stderr: '' }
    }

  it.each([
    ['git version 2.39.3', false],
    ['git version 2.38.0', false],
    ['git version 2.39.4', true],
    ['git version 2.45.0', false],
    ['git version 2.45.1', true],
    ['git version 2.50.1 (Apple Git-155)', true]
  ])('gates on %s honoring --bundle-uri and GIT_NO_LAZY_FETCH', async (version, ok) => {
    const result = await probeSkillGitInPod({ stagingDir: await staging(), git: answering(`${version}\n`) })
    expect(result.ok).toBe(ok)
  })

  it('runs one bounded, config-free `git --version` and creates the staging dir 0700', async () => {
    const calls: SkillGitInvocation[] = []
    const dir = await staging()
    await probeSkillGitInPod({
      stagingDir: dir,
      git: answering('git version 2.47.3\n', 0, calls),
      env: { PATH: '/bin' }
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      args: ['--version'],
      cwd: dir,
      env: { PATH: '/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
    })
    expect(calls[0]!.timeoutMs).toBeLessThanOrEqual(10_000)
    expect((await stat(dir)).mode & 0o777).toBe(0o700)
  })

  it('keeps the daemon path when Git is missing, failing or stalls', async () => {
    const dir = await staging()
    expect((await probeSkillGitInPod({ stagingDir: dir, git: answering('', 127) })).ok).toBe(false)
    const stalled = await probeSkillGitInPod({
      stagingDir: dir,
      git: async () => {
        throw new SkillGitTimeoutError('git --version was terminated after 10000ms')
      }
    })
    expect(stalled).toEqual({ ok: false, reason: expect.stringContaining('terminated') })
    expect((await probeSkillGitInPod({ stagingDir: dir, git: answering('not a version') })).ok).toBe(false)
  })

  it('keeps the daemon path when the staging dir is unusable, before spawning Git', async () => {
    const dir = await staging()
    // A file where the directory belongs.
    await writeFile(dir, 'not a directory')
    const calls: SkillGitInvocation[] = []
    const result = await probeSkillGitInPod({ stagingDir: dir, git: answering('git version 2.47.3', 0, calls) })
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('skill staging unusable') })
    expect(calls).toHaveLength(0)
    expect(await readFile(dir, 'utf8')).toBe('not a directory')
  })

  it('probes this machine’s real Git within the stream cap', async () => {
    const result = await probeSkillGitInPod({ stagingDir: await staging() })
    if (result.ok) expect(result.version).toMatch(/^git version \d+\.\d+/)
    else expect(result.reason).toMatch(/too old|git --version/)
  })
})
