import { createHash } from 'node:crypto'
import { workspaceGitLocalEnv } from './git-injection.js'
import type { GitRunner } from './git-runner.js'

export interface TaskDiff {
  read(signal?: AbortSignal): Promise<string>
}

export class TaskDiffUnavailable extends Error {}

const DIFF_LIMIT = 180_000
const PATHS_LIMIT = 16_000
const DIFF_OPTIONS = ['--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=all']

// A task's immutable Git ref survives commits and daemon restarts without changing the user's index.
export async function openTaskDiff(
  roots: readonly { git: GitRunner; name: string }[],
  sessionKey: string,
  initialize: boolean
): Promise<TaskDiff> {
  if (!roots.length) throw new TaskDiffUnavailable('No task repository is available for automatic diff updates.')
  const ref = `refs/agentconnect/task-diff/${createHash('sha256').update(sessionKey).digest('hex')}`
  const sources: Array<{ git: GitRunner; base: string; prefix: string }> = []
  for (const root of roots) {
    const git = root.git.withEnv({ ...workspaceGitLocalEnv(), GIT_OPTIONAL_LOCKS: '0' })
    const existing = (await git.readBounded(['rev-parse', '--verify', '--quiet', ref], 256).catch(() => undefined))?.out
      .toString()
      .trim()
    let base = existing
    if (!base) {
      if (!initialize)
        throw new TaskDiffUnavailable(
          'This task has no saved starting point; its earlier changes will not be published automatically.'
        )
      const status = await git.readBounded(['status', '--porcelain', '-uall'], PATHS_LIMIT)
      if (status.overflow || status.out.length)
        throw new TaskDiffUnavailable(
          'The task repository already has changes, so an automatic diff cannot safely choose a starting point.'
        )
      base = (await git.readBounded(['rev-parse', '--verify', 'HEAD'], 256)).out.toString().trim()
      if (!/^[a-f0-9]{40,64}$/.test(base)) throw new TaskDiffUnavailable('The task repository has no starting commit.')
      await git.raw(['update-ref', ref, base, ''])
    }
    if (!/^[a-f0-9]{40,64}$/.test(base)) throw new TaskDiffUnavailable('The saved task starting point is unavailable.')
    sources.push({ git, base, prefix: roots.length > 1 ? `${root.name}/` : '' })
  }
  return {
    async read(signal) {
      let result = ''
      const append = (text: string): void => {
        result += text
        if (Buffer.byteLength(result) > DIFF_LIMIT)
          throw new TaskDiffUnavailable(
            'The task diff is too large to display completely in Slack; use the repository or PR to review it.'
          )
      }
      for (const { git, base, prefix } of sources) {
        signal?.throwIfAborted()
        const prefixes = [`--src-prefix=a/${prefix}`, `--dst-prefix=b/${prefix}`]
        const tracked = await git.readBounded(['diff', ...DIFF_OPTIONS, ...prefixes, base, '--'], DIFF_LIMIT)
        if (tracked.overflow)
          throw new TaskDiffUnavailable(
            'The task diff is too large to display completely in Slack; use the repository or PR to review it.'
          )
        append(tracked.out.toString('utf8'))
        const paths = await git.readBounded(['ls-files', '--others', '--exclude-standard', '-z'], PATHS_LIMIT)
        if (paths.overflow)
          throw new TaskDiffUnavailable('The task has too many new files to display completely in Slack.')
        const files = paths.out.toString('utf8').split('\0').filter(Boolean)
        if (files.length > 100)
          throw new TaskDiffUnavailable('The task has too many new files to display completely in Slack.')
        for (const file of files) {
          signal?.throwIfAborted()
          const added = await git.readBounded(
            ['diff', '--no-index', ...DIFF_OPTIONS, ...prefixes, '--', '/dev/null', file],
            DIFF_LIMIT
          )
          if (added.overflow)
            throw new TaskDiffUnavailable('A new task file is too large to display completely in Slack.')
          append(added.out.toString('utf8'))
        }
      }
      return result
    }
  }
}
