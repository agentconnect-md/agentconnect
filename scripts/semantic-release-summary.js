import { appendFile } from 'node:fs/promises'

export async function success(_pluginConfig, { env, nextRelease }) {
  if (env.GITHUB_OUTPUT) {
    await appendFile(env.GITHUB_OUTPUT, `version=${nextRelease.gitTag}\n`)
  }
  if (env.GITHUB_STEP_SUMMARY) {
    await appendFile(env.GITHUB_STEP_SUMMARY, `### 🚀 Released ${nextRelease.gitTag}\n\n${nextRelease.notes}\n`)
  }
}
