// Which full ref an anonymous skill entry follows, from one pattern-scoped `git ls-remote` (source-cache.md §5, §8).
import { execFile } from 'node:child_process'
import { workspaceGitOriginOf } from '@agentconnect.md/protocol'
import { parseResolvableRef } from '../codehost/ref-spec.js'
import { authorizeWorkspaceGitUrl } from '../workspace/git-origin-policy.js'
import { buildSkillGitAcquisitionEnv } from './skill-git-source.js'

/** Each stream's cap: a handful of exact patterns print a few lines, far below the 64 KiB shim frame. */
export const GIT_SKILL_REF_NAME_MAX_BYTES = 16 * 1024
const DEFAULT_TIMEOUT_MS = 10_000
const OID = /^[0-9a-f]{40}$/
/** No credential rides this listing, so no agent's identity does either. */
const ANONYMOUS_ASKER = 'anonymous-skill-ref-check'

export interface GitRefNameInvocation {
  args: string[]
  env: Record<string, string>
  cwd: string
  timeoutMs: number
}

/** Runs one git invocation; rejects on a non-zero exit, a timeout or an overflowing stream. */
export type GitRefNameRunner = (invocation: GitRefNameInvocation) => Promise<string>

/** The full ref the entry's name selects with its commit (peeled for an annotated tag), or why none is named. */
export type GitSkillRefNaming =
  { kind: 'named'; ref: string; commit: string } | { kind: 'unnamed'; reason: 'ambiguous' | 'absent' | 'invalid' }

export interface NameGitSkillRefInput {
  /** The canonical github.com HTTPS clone URL. */
  url: string
  /** The entry's short name; undefined for the default branch. */
  name?: string
  /** Daemon-private directory used as HOME and cwd. */
  privateHome: string
  timeoutMs?: number
  run?: GitRefNameRunner
}

export const runBoundedGit: GitRefNameRunner = (invocation) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      invocation.args,
      {
        cwd: invocation.cwd,
        env: invocation.env,
        timeout: invocation.timeoutMs,
        killSignal: 'SIGTERM',
        maxBuffer: GIT_SKILL_REF_NAME_MAX_BYTES,
        windowsHide: true
      },
      (error, stdout) => {
        if (error)
          reject(new Error(`git ${invocation.args[0]} failed (${(error as { code?: unknown }).code ?? 'error'})`))
        else resolve(String(stdout))
      }
    )
  })

/** Name the ref an anonymous entry follows: no name is the default branch; a short name must be exactly one branch or tag. */
export async function nameGitSkillRef(input: NameGitSkillRefInput): Promise<GitSkillRefNaming> {
  // The daemon's origin policy again, and the one P2 host: nothing else is ever listed.
  const url = authorizeWorkspaceGitUrl(input.url)
  if (workspaceGitOriginOf(url) !== 'https://github.com') throw new Error('skill ref naming supports only github.com')
  const name = input.name
  // A valid refname has no glob characters, so the patterns below cannot widen the listing.
  if (name !== undefined && parseResolvableRef(`refs/heads/${name}`)?.kind !== 'branch') {
    return { kind: 'unnamed', reason: 'invalid' }
  }
  const head = `refs/heads/${name}`
  const tag = `refs/tags/${name}`
  const patterns = name === undefined ? ['--symref', '--', url, 'HEAD'] : ['--', url, head, tag, `${tag}^{}`]
  const env = {
    ...buildSkillGitAcquisitionEnv({
      agentId: ANONYMOUS_ASKER,
      cloneUrl: url,
      privateHome: input.privateHome,
      useGitCredential: false
    }),
    GIT_CEILING_DIRECTORIES: input.privateHome
  }
  const stdout = await (input.run ?? runBoundedGit)({
    args: ['ls-remote', '-q', ...patterns],
    env,
    cwd: input.privateHome,
    timeoutMs: Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)
  })
  // Patterns tail-match, so only exact names count.
  const oids = new Map<string, string>()
  let symref: string | undefined
  for (const line of stdout.split('\n')) {
    const [left, right] = line.trim().split('\t')
    if (left === undefined || right === undefined) continue
    if (left.startsWith('ref: ')) {
      if (right === 'HEAD') symref = left.slice('ref: '.length).trim()
    } else if (OID.test(left.toLowerCase())) oids.set(right, left.toLowerCase())
  }
  if (name === undefined) {
    const commit = oids.get('HEAD')
    if (symref === undefined || commit === undefined) return { kind: 'unnamed', reason: 'absent' }
    return parseResolvableRef(symref)?.kind === 'branch'
      ? { kind: 'named', ref: symref, commit }
      : { kind: 'unnamed', reason: 'invalid' }
  }
  const branch = oids.get(head)
  const tagged = oids.get(`${tag}^{}`) ?? oids.get(tag)
  // A name that is both a branch and a tag is left unnamed rather than guessed.
  if (branch !== undefined && tagged !== undefined) return { kind: 'unnamed', reason: 'ambiguous' }
  if (branch !== undefined) return { kind: 'named', ref: head, commit: branch }
  if (tagged !== undefined) return { kind: 'named', ref: tag, commit: tagged }
  return { kind: 'unnamed', reason: 'absent' }
}
