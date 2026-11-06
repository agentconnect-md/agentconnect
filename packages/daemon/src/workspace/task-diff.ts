import { createHash } from 'node:crypto'
import { workspaceGitLocalEnv } from './git-injection.js'
import type { GitRunner } from './git-runner.js'

export interface TaskDiff {
  /** The repositories the diff covers, each with the base branch it compares against; no base means the task's saved start. */
  repositories: readonly { title: string; base?: string }[]
  read(signal?: AbortSignal): Promise<string>
}

export interface TaskDiffRoot {
  git: GitRunner
  /** The directory its files sit under when the diff covers several repositories. */
  name: string
  /** How the agent is told about it; defaults to `name`. */
  title?: string
  /** The branch the task's checkout was cut from; its `origin/` copy is the comparison base. */
  branch?: string
}

export class TaskDiffUnavailable extends Error {}
export class TaskDiffIneligible extends TaskDiffUnavailable {}

const DIFF_LIMIT = 180_000
const PATHS_LIMIT = 16_000
const DIFF_OPTIONS = ['--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=all']

// A repository with its base branch diffs from where the task's branch left it, so commits, rebases and merges never widen the diff.
export async function openTaskDiff(
  roots: readonly TaskDiffRoot[],
  sessionKey: string,
  initialize: boolean
): Promise<TaskDiff> {
  if (!roots.length) throw new TaskDiffIneligible('No task repository is available for automatic diff updates.')
  const ref = `refs/agentconnect/task-diff/${createHash('sha256').update(sessionKey).digest('hex')}`
  const sources: Array<{ git: GitRunner; from: string[]; base?: string; name: string; title: string }> = []
  let ineligible: TaskDiffIneligible | undefined
  for (const root of roots) {
    const git = root.git.withEnv({ ...workspaceGitLocalEnv(), GIT_OPTIONAL_LOCKS: '0' })
    const verify = async (name: string): Promise<string | undefined> =>
      (await git.readBounded(['rev-parse', '--verify', '--quiet', name], 256).catch(() => undefined))?.out
        .toString()
        .trim() || undefined
    const source = { git, name: root.name, title: root.title ?? root.name }
    const upstream = root.branch ? `refs/remotes/origin/${root.branch}` : undefined
    if (upstream && (await verify(upstream))) {
      sources.push({ ...source, from: ['--merge-base', upstream], base: `origin/${root.branch}` })
      continue
    }
    // Without a base branch, a task's immutable Git ref survives commits and daemon restarts without changing the user's index.
    let base = await verify(ref)
    if (!base) {
      if (!initialize) {
        ineligible ??= new TaskDiffIneligible(
          'This task has no saved starting point; its earlier changes will not be published automatically.'
        )
        continue
      }
      const status = await git.readBounded(['status', '--porcelain', '-uall'], PATHS_LIMIT)
      if (status.overflow || status.out.length) {
        ineligible ??= new TaskDiffIneligible(
          'The task repository already has changes, so an automatic diff cannot safely choose a starting point.'
        )
        continue
      }
      base = (await git.readBounded(['rev-parse', '--verify', 'HEAD'], 256)).out.toString().trim()
      if (!/^[a-f0-9]{40,64}$/.test(base)) throw new TaskDiffUnavailable('The task repository has no starting commit.')
      await git.raw(['update-ref', ref, base, ''])
    }
    if (!/^[a-f0-9]{40,64}$/.test(base)) throw new TaskDiffUnavailable('The saved task starting point is unavailable.')
    sources.push({ ...source, from: [base] })
  }
  if (!sources.length) throw ineligible!
  const prefixed = sources.length > 1
  return {
    repositories: sources.map(({ title, base }) => ({ title, ...(base ? { base } : {}) })),
    async read(signal) {
      let result = ''
      const append = (text: string): void => {
        result += text
        if (Buffer.byteLength(result) > DIFF_LIMIT)
          throw new TaskDiffUnavailable(
            'The task diff is too large to display completely in Slack; use the repository or PR to review it.'
          )
      }
      for (const { git, from, base, name } of sources) {
        signal?.throwIfAborted()
        const prefix = prefixed ? `${name}/` : ''
        const prefixes = [`--src-prefix=a/${prefix}`, `--dst-prefix=b/${prefix}`]
        const tracked = await git
          .readBounded(['diff', ...DIFF_OPTIONS, ...prefixes, ...from, '--'], DIFF_LIMIT)
          .catch((error: unknown) => {
            if (signal?.aborted || !base) throw error
            throw new TaskDiffUnavailable(`The task repository no longer shares history with ${base}.`)
          })
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
