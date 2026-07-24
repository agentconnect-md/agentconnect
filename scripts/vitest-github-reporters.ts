import { join } from 'node:path'
import type { TestUserConfig } from 'vitest/config'

export function githubActionsReporters(summaryFile: string): TestUserConfig['reporters'] {
  // Outside GitHub Actions, return the concrete default reporter — NOT undefined:
  // `reporters: undefined` crashes vitest 4's config resolution ("Cannot read
  // properties of undefined (reading 'length')") before test discovery, breaking
  // every local `vitest run` that doesn't fake GITHUB_ACTIONS=true.
  if (process.env.GITHUB_ACTIONS !== 'true') return ['default']

  const summaryDirectory = process.env.VITEST_JOB_SUMMARY_DIR

  return [
    'default',
    [
      'github-actions',
      {
        jobSummary: summaryDirectory ? { outputPath: join(summaryDirectory, summaryFile) } : { enabled: false }
      }
    ]
  ]
}
