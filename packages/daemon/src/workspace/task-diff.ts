import { createHash } from 'node:crypto'
import { workspaceGitLocalEnv } from './git-injection.js'
import type { GitRunner } from './git-runner.js'

export interface TaskDiff {
  /** The repositories the diff covers, each with the base branch it compares against; no base means the task's saved start. */
  repositories: readonly { title: string; base?: string }[]
  /** Whether a repository cloned during the task joins the diff once it appears. */
  discovers?: boolean
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
  /** A clone the agent made itself: its remote's default branch is the base, and it has no saved start to fall back on. */
  baseFromOriginHead?: true
  /** A directory whose untracked files are not task work, such as the landing zone for saved chat attachments. */
  skipUntracked?: string
}

export class TaskDiffUnavailable extends Error {}
export class TaskDiffIneligible extends TaskDiffUnavailable {}

const DIFF_LIMIT = 180_000
const PATHS_LIMIT = 16_000
const DIFF_OPTIONS = ['--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=all']
const ORIGIN = 'refs/remotes/origin/'

interface TaskDiffSource {
  git: GitRunner
  from: string[]
  base?: string
  name: string
  title: string
  skipUntracked?: string
}

// A repository with its base branch diffs from where the task's branch left it, so commits, rebases and merges never widen the diff.
export async function openTaskDiff(
  roots: readonly TaskDiffRoot[],
  sessionKey: string,
  initialize: boolean,
  discover?: () => Promise<readonly TaskDiffRoot[]>
): Promise<TaskDiff> {
  if (!roots.length && !discover)
    throw new TaskDiffIneligible('No task repository is available for automatic diff updates.')
  const ref = `refs/agentconnect/task-diff/${createHash('sha256').update(sessionKey).digest('hex')}`
  const sources: TaskDiffSource[] = []
  const repositories: { title: string; base?: string }[] = []
  const add = (source: TaskDiffSource): void => {
    sources.push(source)
    repositories.push({ title: source.title, ...(source.base ? { base: source.base } : {}) })
  }
  let ineligible: TaskDiffIneligible | undefined
  const open = async (root: TaskDiffRoot): Promise<TaskDiffSource | undefined> => {
    const git = root.git.withEnv({ ...workspaceGitLocalEnv(), GIT_OPTIONAL_LOCKS: '0' })
    const verify = async (name: string): Promise<string | undefined> =>
      (await git.readBounded(['rev-parse', '--verify', '--quiet', name], 256).catch(() => undefined))?.out
        .toString()
        .trim() || undefined
    const source = { git, name: root.name, title: root.title ?? root.name, skipUntracked: root.skipUntracked }
    const branch = root.branch ?? (root.baseFromOriginHead ? await originHead(git) : undefined)
    const upstream = branch ? `${ORIGIN}${branch}` : undefined
    if (upstream && (await verify(upstream)))
      return { ...source, from: ['--merge-base', upstream], base: `origin/${branch}` }
    if (root.baseFromOriginHead) return undefined
    // Without a base branch, a task's immutable Git ref survives commits and daemon restarts without changing the user's index.
    let base = await verify(ref)
    if (!base) {
      if (!initialize) {
        ineligible ??= new TaskDiffIneligible(
          'This task has no saved starting point; its earlier changes will not be published automatically.'
        )
        return undefined
      }
      const status = await git.readBounded(['status', '--porcelain', '-uall'], PATHS_LIMIT)
      if (status.overflow || status.out.length) {
        ineligible ??= new TaskDiffIneligible(
          'The task repository already has changes, so an automatic diff cannot safely choose a starting point.'
        )
        return undefined
      }
      base = (await git.readBounded(['rev-parse', '--verify', 'HEAD'], 256)).out.toString().trim()
      if (!/^[a-f0-9]{40,64}$/.test(base)) throw new TaskDiffUnavailable('The task repository has no starting commit.')
      await git.raw(['update-ref', ref, base, ''])
    }
    if (!/^[a-f0-9]{40,64}$/.test(base)) throw new TaskDiffUnavailable('The saved task starting point is unavailable.')
    return { ...source, from: [base] }
  }
  // A clone still being written, or one that cannot be read yet, stays out until a later read finds it ready.
  const join = async (signal?: AbortSignal): Promise<void> => {
    for (const root of discover ? await discover().catch(() => []) : []) {
      signal?.throwIfAborted()
      if (sources.some((source) => source.name === root.name)) continue
      const source = await open({ ...root, baseFromOriginHead: true }).catch(() => undefined)
      if (source) add(source)
    }
  }
  for (const root of roots) {
    const source = await open(root)
    if (source) add(source)
  }
  await join()
  if (!sources.length)
    throw ineligible ?? new TaskDiffIneligible('No task repository is available for automatic diff updates.')
  return {
    repositories,
    discovers: discover !== undefined,
    async read(signal) {
      await join(signal)
      const prefixed = sources.length > 1
      let result = ''
      const append = (text: string): void => {
        result += text
        if (Buffer.byteLength(result) > DIFF_LIMIT)
          throw new TaskDiffUnavailable(
            'The task diff is too large to display completely in Slack; use the repository or PR to review it.'
          )
      }
      for (const { git, from, base, name, skipUntracked } of sources) {
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
        // Filtered here rather than by pathspec, so the Git arguments every execution plane admits stay the same.
        const files = paths.out
          .toString('utf8')
          .split('\0')
          .filter((file) => file && !(skipUntracked && file.startsWith(`${skipUntracked}/`)))
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

/** The branch `origin/HEAD` names, as a clone records its remote's default; undefined when it names none. */
async function originHead(git: GitRunner): Promise<string | undefined> {
  const head = await git.readBounded(['symbolic-ref', '--quiet', `${ORIGIN}HEAD`], 256).catch(() => undefined)
  const name = head?.out.toString().trim()
  return name?.startsWith(ORIGIN) && name.length > ORIGIN.length ? name.slice(ORIGIN.length) : undefined
}
