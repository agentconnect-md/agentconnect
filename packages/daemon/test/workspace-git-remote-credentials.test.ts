import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceManager, type WorkspaceRoot } from '../src/workspace/workspace-manager.js'
import { daemonGitCredentialTarget, initGitInjection } from '../src/workspace/git-injection.js'
import { GITCRED_CAPABILITY_ENV } from '../src/gitcred/env.js'
import type { GitRunner } from '../src/workspace/git-runner.js'

// Every daemon-run git that REACHES A REMOTE has to carry the credential-helper pointer, not just the
// helper's env: `workspaceGitConfigPairs` resets `credential.helper` at command scope, which clears the
// repo-local pin written post-clone, so a target that does not re-add it reaches the remote anonymous.
// A public remote answers anonymously, which is why the missing pointer stayed invisible on the primary
// workspace while every FETCH against a remote that demands credentials failed with "could not read
// Username" — and the formal review that needed the exact checkout degraded to revision-only inspection.
// These pin the env at the call sites, where the argument is actually passed.

const HELPER = 'credential.https://github.com.helper'

function configPairs(env: Record<string, string>): Array<[string | undefined, string | undefined]> {
  return Array.from({ length: Number(env.GIT_CONFIG_COUNT ?? 0) }, (_, index) => [
    env[`GIT_CONFIG_KEY_${index}`],
    env[`GIT_CONFIG_VALUE_${index}`]
  ])
}

/** The env of the LAST runner a call built, which is the one that ran the remote command. */
function envsOf(recorded: Record<string, string>[]): Record<string, string> {
  return recorded.at(-1) ?? {}
}

/** A runner that records every env it is handed and never reaches git. `raw` fails like an offline
 *  remote would, so each caller's own degradation runs and the env it built is what the test reads. */
function recordingRunner(recorded: Record<string, string>[]): GitRunner {
  const runner: GitRunner = {
    withEnv: (next) => {
      recorded.push(next)
      return recordingRunner(recorded)
    },
    // The config audit runs before the remote command and must answer, not throw: an empty list is a
    // checkout that pins nothing, which is what lets the caller proceed to the fetch under test.
    raw: async (args) => {
      if (args[0] === 'config') return ''
      throw new Error(`git ${args[0]} failed: no remote in this test`)
    },
    clone: async () => undefined,
    pull: async () => {
      throw new Error('git pull failed: no remote in this test')
    },
    status: async () => ({ files: [], ahead: 0, behind: 0, current: 'main', tracking: null }) as never,
    log: async () => [],
    readBounded: async () => ({ out: Buffer.alloc(0), overflow: false })
  }
  return runner
}

const workspaces = new WorkspaceManager()

const rootFor = (githubApp: boolean): WorkspaceRoot => ({
  cloneUrl: 'https://github.com/acme/authed-repo.git',
  branch: 'main',
  path: '/tmp/does-not-matter',
  worktreesPath: '/tmp/does-not-matter/worktrees',
  githubApp
})

const REVIEW = {
  pullNumber: 7,
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40)
}

beforeAll(() => {
  const runDir = mkdtempSync(join(tmpdir(), 'gitcred-remote-'))
  initGitInjection({
    targetFor: () => daemonGitCredentialTarget({ shimPath: join(runDir, 'helper.sh'), runDir }),
    preWarm: async () => undefined,
    capabilityFor: (agentId) => `cap-${agentId}`
  })
})

/** The helper pointer is present AND lands after the reset that would otherwise wipe it. */
function expectHelperAfterReset(env: Record<string, string>): void {
  const pairs = configPairs(env)
  const reset = pairs.findIndex(([key, value]) => key === 'credential.helper' && value === '')
  const helper = pairs.findIndex(([key, value]) => key === HELPER && (value ?? '').startsWith('!'))
  expect(reset).toBeGreaterThanOrEqual(0)
  expect(helper).toBeGreaterThan(reset)
  expect(env.GIT_TERMINAL_PROMPT).toBe('0')
}

describe('daemon git that reaches a remote', () => {
  it('carries the credential helper on a review fetch — the exact checkout a formal review runs on', async () => {
    const recorded: Record<string, string>[] = []
    workspaces.setGitRunnerResolver(() => recordingRunner(recorded))
    try {
      await expect(workspaces.fetchReviewRevisionIn('bot-1', rootFor(true), 'wt-1', REVIEW)).rejects.toThrow()
    } finally {
      workspaces.setGitRunnerResolver(undefined)
    }
    expectHelperAfterReset(envsOf(recorded))
    expect(envsOf(recorded)[GITCRED_CAPABILITY_ENV]).toBe('cap-bot-1')
  })

  it('carries the credential helper on a root pull', async () => {
    const recorded: Record<string, string>[] = []
    workspaces.setGitRunnerResolver(() => recordingRunner(recorded))
    try {
      // pullRoot degrades on failure rather than throwing — the env it built is the assertion.
      await workspaces.pullRoot('bot-1', rootFor(true), '/tmp/does-not-matter')
    } finally {
      workspaces.setGitRunnerResolver(undefined)
    }
    expectHelperAfterReset(envsOf(recorded))
  })

  it('leaves an anonymous root anonymous — no helper, no capability', async () => {
    const recorded: Record<string, string>[] = []
    workspaces.setGitRunnerResolver(() => recordingRunner(recorded))
    try {
      await workspaces.pullRoot('bot-1', rootFor(false), '/tmp/does-not-matter')
    } finally {
      workspaces.setGitRunnerResolver(undefined)
    }
    const env = envsOf(recorded)
    expect(configPairs(env).some(([key]) => key === HELPER)).toBe(false)
    expect(env[GITCRED_CAPABILITY_ENV]).toBeUndefined()
  })
})
