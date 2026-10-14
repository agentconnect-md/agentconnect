// Anonymous skill Sources on any HTTPS host (source-cache.md §11): the in-pod bounded Git acquisition, run by the daemon.
import { promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  DEFAULT_SKILL_GIT_TIMEOUT_MS,
  acquireSkillGitSource,
  runLocalSkillGit,
  skillGitEnv,
  type SkillGitRunner
} from '../shim/skill-git-acquire.js'
import { authorizeWorkspaceGitUrl } from '../workspace/git-origin-policy.js'
import { namingFromListing, refListingPatterns, type GitSkillRefNaming } from './git-ref-listing.js'
import type { ParsedGitSkillSource } from './skill-git-source.js'

const COMMIT_SHA = /^[0-9a-f]{40}$/i
const DEFAULT_NAMING_TIMEOUT_MS = 10_000
const DEFAULT_ACQUISITION_TIMEOUT_MS = 2 * 60_000

/** Test seams: a Git runner (which may rewrite the https URL to a fixture) and the file transport it then needs. */
export interface HostedGitSkillTransport {
  git?: SkillGitRunner
  allowFileProtocol?: boolean
}

export interface NameHostedGitSkillRefInput extends HostedGitSkillTransport {
  /** The authorized https clone URL. */
  url: string
  /** The entry's ref: absent or `HEAD` is the default branch, `refs/...` itself, anything else one branch or tag. */
  name?: string
  /** Daemon-private directory used as HOME and cwd. */
  privateHome: string
  timeoutMs?: number
}

/** One anonymous, pattern-scoped `ls-remote`: no credential, no system or global config, no redirects, https only. */
export async function nameHostedGitSkillRef(input: NameHostedGitSkillRefInput): Promise<GitSkillRefNaming> {
  // The daemon's origin policy runs again at the network boundary.
  const url = authorizeWorkspaceGitUrl(input.url)
  const name = input.name === 'HEAD' || input.name === '' ? undefined : input.name
  const listing = refListingPatterns(name)
  if (!listing) return { kind: 'unnamed', reason: 'invalid' }
  const env = skillGitEnv(
    {
      home: input.privateHome,
      ceiling: input.privateHome,
      shimEnv: process.env,
      allowFileProtocol: input.allowFileProtocol === true
    },
    { lazyFetch: false }
  )
  const output = await (input.git ?? runLocalSkillGit)({
    args: ['ls-remote', '-q', ...(listing.symref ? ['--symref'] : []), '--', url, ...listing.patterns],
    cwd: input.privateHome,
    env,
    timeoutMs: Math.min(input.timeoutMs ?? DEFAULT_NAMING_TIMEOUT_MS, DEFAULT_SKILL_GIT_TIMEOUT_MS)
  })
  // Git's own output never reaches a log or an error: it may echo whatever the host printed.
  if (output.code !== 0) throw new Error(`skill Git ref listing exited ${output.code}`)
  return namingFromListing(output.stdout, name)
}

export interface AcquireHostedGitSkillOptions extends HostedGitSkillTransport {
  destination: string
  timeoutMs?: number
}

/** Acquire an anonymous Source at its pinned commit or the commit its ref names now; the tree lands at `<destination>/repository/<subDir>`. */
export async function acquireAnonymousGitSkillSource(
  source: ParsedGitSkillSource,
  opts: AcquireHostedGitSkillOptions
): Promise<{ sourceDir: string; resolvedCommit: string; source: ParsedGitSkillSource }> {
  const staging = join(opts.destination, 'git')
  await fsp.mkdir(staging, { recursive: true, mode: 0o700 })
  await fsp.chmod(staging, 0o700)
  const transport = {
    ...(opts.git ? { git: opts.git } : {}),
    ...(opts.allowFileProtocol ? { allowFileProtocol: true } : {})
  }
  let ref: string | undefined
  let commit: string
  if (source.ref !== undefined && COMMIT_SHA.test(source.ref)) commit = source.ref.toLowerCase()
  else {
    const home = join(staging, 'naming')
    await fsp.mkdir(home, { mode: 0o700 })
    const naming = await nameHostedGitSkillRef({
      url: source.cloneUrl,
      ...(source.ref !== undefined ? { name: source.ref } : {}),
      privateHome: home,
      ...transport
    })
    if (naming.kind !== 'named') throw new Error(`skill Git source ref is ${naming.reason} on its host`)
    ref = naming.ref
    commit = naming.commit
  }
  const abort = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_ACQUISITION_TIMEOUT_MS)
  const acquired = await acquireSkillGitSource({
    plan: {
      sourceId: 'daemon',
      sourceKind: 'git',
      url: source.cloneUrl,
      ...(ref !== undefined ? { ref } : {}),
      plannedCommit: commit,
      ...(source.subDir !== undefined ? { subDir: source.subDir } : {}),
      selections: []
    },
    stagingRoot: staging,
    abort,
    shimEnv: process.env,
    ...transport
  })
  if (acquired.kind === 'skipped') throw new Error(`skill Git source skipped (${acquired.code}): ${acquired.reason}`)
  try {
    // Laid out like an extracted archive, so callers and the daemon cache find the subdirectory at the same place.
    const repository = join(opts.destination, 'repository')
    const sourceDir = source.subDir !== undefined ? join(repository, ...source.subDir.split('/')) : repository
    await fsp.mkdir(dirname(sourceDir), { recursive: true, mode: 0o700 })
    await fsp.rename(acquired.root, sourceDir)
    return { sourceDir, resolvedCommit: commit, source }
  } finally {
    await acquired.release()
  }
}
