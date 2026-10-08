import { chmodSync, mkdirSync } from 'node:fs'
import { assertStagingPrivate } from './bundle-staging.js'
import { gitSupportsInPodSkills, runLocalSkillGit, type SkillGitRunner } from './skill-git-acquire.js'

// Whether this shim may advertise `skill-git-in-pod-v1` (source-cache.md §13): probed once at start, never fatal.

/** The startup `git --version` deadline; a Git that cannot answer this fast keeps the daemon path. */
export const SKILL_GIT_PROBE_TIMEOUT_MS = 10_000

export type SkillGitInPodProbe = { ok: true; version: string } | { ok: false; reason: string }

/** Probe the image's Git and the skill staging dir; any doubt keeps daemon acquisition rather than failing a session. */
export async function probeSkillGitInPod(input: {
  stagingDir: string
  git?: SkillGitRunner
  env?: Record<string, string | undefined>
  timeoutMs?: number
}): Promise<SkillGitInPodProbe> {
  try {
    mkdirSync(input.stagingDir, { recursive: true, mode: 0o700 })
    chmodSync(input.stagingDir, 0o700)
    assertStagingPrivate(input.stagingDir, 'skill Git staging')
  } catch (error) {
    return { ok: false, reason: `skill staging unusable: ${(error as Error).message}` }
  }
  const env = input.env ?? process.env
  let version: string
  try {
    // The shared runner caps each stream at 64 KiB and kills the child at the deadline.
    const output = await (input.git ?? runLocalSkillGit)({
      args: ['--version'],
      cwd: input.stagingDir,
      env: {
        ...(env.PATH ? { PATH: env.PATH } : {}),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0'
      },
      timeoutMs: input.timeoutMs ?? SKILL_GIT_PROBE_TIMEOUT_MS
    })
    if (output.code !== 0) return { ok: false, reason: `git --version exited ${output.code}` }
    version = output.stdout.trim().split('\n', 1)[0]!.slice(0, 200)
  } catch (error) {
    return { ok: false, reason: `git --version failed: ${(error as Error).message}` }
  }
  if (!gitSupportsInPodSkills(version)) return { ok: false, reason: `${version || 'unknown Git'} is too old` }
  return { ok: true, version }
}
