import { appendFile } from 'node:fs/promises'

// A rerun can resume artifact preparation after this commit's release tag was already published.
export async function analyzeCommits(_pluginConfig, { env, branch, lastRelease }) {
  if (
    Number(env.GITHUB_RUN_ATTEMPT) > 1 &&
    env.GITHUB_SHA &&
    lastRelease.gitHead === env.GITHUB_SHA &&
    lastRelease.channels?.includes(branch.channel ?? null) &&
    env.GITHUB_OUTPUT
  ) {
    await appendFile(env.GITHUB_OUTPUT, `version=${lastRelease.gitTag}\n`)
  }
}

export async function success(_pluginConfig, { env, nextRelease }) {
  if (env.GITHUB_OUTPUT) {
    await appendFile(env.GITHUB_OUTPUT, `version=${nextRelease.gitTag}\n`)
  }
  if (env.GITHUB_STEP_SUMMARY) {
    await appendFile(env.GITHUB_STEP_SUMMARY, `### 🚀 Release ${nextRelease.gitTag}\n\n${nextRelease.notes}\n`)
  }
}
