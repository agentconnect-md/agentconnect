// An anonymous Source off GitHub resolved over the pod's exec channel (source-cache.md §5, §6.1).
import { AgentSkillEntry, DEFAULT_WORKSPACE_GIT_ALLOWED_ORIGINS } from '@agentconnect.md/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveSkillRefInPod } from '../src/skills/pod-skill-ref.js'
import type { GitRunner } from '../src/workspace/git-runner.js'
import { configureWorkspaceGitOrigins } from '../src/workspace/git-origin-policy.js'

const URL_ = 'https://git.example.test/team/skills'
const TRUNK = 'a'.repeat(40)
const RELEASE = 'b'.repeat(40)

function podRunner(stdout: string | Error) {
  const calls: Array<{ args: string[]; env: Record<string, string> }> = []
  const runner = (env: Record<string, string>): GitRunner =>
    ({
      withEnv: (next: Record<string, string>) => runner(next),
      raw: async (args: string[]) => {
        calls.push({ args, env })
        if (stdout instanceof Error) throw stdout
        return stdout
      }
    }) as unknown as GitRunner
  return { runner: runner({}), calls }
}

const entry = (ref?: string) =>
  AgentSkillEntry.parse({ name: 'other', source: URL_, skills: [], ...(ref !== undefined ? { ref } : {}) })

afterEach(() => configureWorkspaceGitOrigins(DEFAULT_WORKSPACE_GIT_ALLOWED_ORIGINS))

describe('pod-local skill ref resolution', () => {
  it('names the default branch with one scoped listing that reads no repository config', async () => {
    const pod = podRunner(`ref: refs/heads/trunk\tHEAD\n${TRUNK}\tHEAD\n`)
    expect(await resolveSkillRefInPod(entry(), pod.runner)).toEqual({
      ok: true,
      commit: TRUNK,
      ref: 'refs/heads/trunk',
      pinned: false,
      credentialed: false
    })
    expect(pod.calls).toHaveLength(1)
    expect(pod.calls[0]!.args).toEqual(['ls-remote', '-q', '--symref', '--', URL_, 'HEAD'])
    expect(pod.calls[0]!.env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' })
    expect(pod.calls[0]!.env.GIT_DIR).toMatch(/^\/nonexistent\//)
  })

  it('names a short branch, takes a pinned commit as given, and reports anything else as unresolved', async () => {
    const branch = podRunner(`${RELEASE}\trefs/heads/release\n`)
    expect(await resolveSkillRefInPod(entry('release'), branch.runner)).toMatchObject({
      ok: true,
      commit: RELEASE,
      ref: 'refs/heads/release'
    })
    const pinned = podRunner(new Error('must not run'))
    expect(await resolveSkillRefInPod(entry(TRUNK), pinned.runner)).toEqual({
      ok: true,
      commit: TRUNK,
      pinned: true,
      credentialed: false
    })
    expect(pinned.calls).toEqual([])
    expect(await resolveSkillRefInPod(entry('absent'), podRunner('').runner)).toEqual({ ok: false })
    expect(await resolveSkillRefInPod(entry('main'), podRunner(new Error('exit 128')).runner)).toEqual({ ok: false })
  })

  it('never sends a URL the daemon origin policy refuses to the pod', async () => {
    configureWorkspaceGitOrigins(['https://github.com'])
    const pod = podRunner(`ref: refs/heads/trunk\tHEAD\n${TRUNK}\tHEAD\n`)
    expect(await resolveSkillRefInPod(entry(), pod.runner)).toEqual({ ok: false })
    expect(pod.calls).toEqual([])
  })
})
