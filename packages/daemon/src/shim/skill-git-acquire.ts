import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  BUNDLE_REF_LIST_ARGS,
  BundleFallback,
  CONNECTIVITY_CHECK_ARGS,
  attemptWithBundle,
  bundleDownloadWarningOf,
  bundleRefNamesOf,
  scrubBundleDetail,
  type BundleFallbackReason,
  type BundleStep
} from '../source-cache/bundle-retry.js'
import {
  GIT_SKILL_SOURCE_SNAPSHOT_LIMITS,
  SkillSourceSnapshotError,
  inspectLocalSkillSource,
  type SkillSourceSnapshot,
  type SkillSourceSnapshotLimits
} from '../skills/skill-source-snapshot.js'
import {
  ExecRefusedError,
  assertNoRefusedArguments,
  isValidBranchRef,
  isValidFullRef
} from '../workspace/git-command-policy.js'
import { GITCRED_AGENT_ENV, GITCRED_CAPABILITY_ENV, GITCRED_SOCKET_ENV } from '../gitcred/env.js'
import { GITCRED_HOSTS_ENV } from '../gitcred/managed-hosts.js'
import { assertStagingPrivate } from './bundle-staging.js'
import { GitSkillPlanSchema, type GitSkillPlan, type SkillSkipCode } from './skill-protocol.js'

// Shim-internal Git skill acquisition (source-cache.md §6.1, §8): composed argv over a private staging dir, never the exec channel.

/** Every stream of every spawn is capped here, the same 64 KiB a shim exec frame carries. */
export const SKILL_GIT_MAX_STREAM_BYTES = 64 * 1024
export const DEFAULT_SKILL_GIT_TIMEOUT_MS = 10 * 60_000
const EMPTY_CONFIG = '/dev/null'
const PLANNED_REF = 'refs/agentconnect/planned'
const COMMIT_RE = /^[0-9a-f]{40}$/
const STAGING_LABEL = 'skill Git staging'
// A single-branch bundle carries one ref; more than this is hostile and would cost one spawn per ref.
const MAX_BUNDLE_REFS = 64
// Only what Git needs to run and to trust the operator's TLS roots; HOME is replaced by a private empty one.
const PASSTHROUGH_ENV = [
  'PATH',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'GIT_SSL_CAINFO',
  'GIT_SSL_CAPATH'
]
// The only credential-window variables the gitcred helper reads; anything else the caller passes is dropped.
const CREDENTIAL_ENV = [GITCRED_CAPABILITY_ENV, GITCRED_AGENT_ENV, GITCRED_SOCKET_ENV, GITCRED_HOSTS_ENV]
// Only a transport spawn can be refused by a remote; a local `permission denied` (EACCES) is not access_denied.
const TRANSPORT_SUBCOMMANDS = new Set(['clone', 'fetch', 'ls-remote'])
const ACCESS_DENIED_RE =
  /authentication failed|could not read (username|password)|terminal prompts disabled|requested url returned error: 40[13]|repository not found|permission denied|access denied/i
const MISSING_REF_RE = /couldn't find remote ref|no such remote ref|not our ref/i
// An exit-0 clone that still walked into an object the bundle advertised but did not carry.
const UNREADABLE_OBJECT_RE = /^error: Could not read [0-9a-f]{40,64}/m

export interface SkillGitInvocation {
  args: string[]
  cwd: string
  env: Record<string, string>
  timeoutMs: number
  abort?: AbortSignal
}

export interface SkillGitOutput {
  code: number
  stdout: string
  stderr: string
}

/** How the acquisition spawns Git: resolves with any exit code, rejects with the typed errors below. */
export type SkillGitRunner = (invocation: SkillGitInvocation) => Promise<SkillGitOutput>

/** A spawn that ran past its deadline: not a bundle fallback, the Source is skipped for this run. */
export class SkillGitTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillGitTimeoutError'
  }
}

/** The caller cancelled; it propagates. */
export class SkillGitAbortedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AbortError'
  }
}

/** A stream past {@link SKILL_GIT_MAX_STREAM_BYTES}: the child was killed and the step failed. */
export class SkillGitOutputOverflowError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillGitOutputOverflowError'
  }
}

/** A plan field the acquisition will not compose into argv, refused before any spawn. */
export class SkillGitPlanRefusedError extends ExecRefusedError {
  constructor(message: string) {
    super(`skill Git plan refused: ${message}`)
    this.name = 'SkillGitPlanRefusedError'
  }
}

// A failed Git step with the §11 code it maps to; the raw detail is for the log only.
class SkillGitFailure extends Error {
  constructor(
    readonly code: SkillSkipCode,
    detail: string
  ) {
    super(detail)
    this.name = 'SkillGitFailure'
  }
}

/** The local runner: argv only, no shell, each stream bounded, killed on timeout or abort. */
export const runLocalSkillGit: SkillGitRunner = (invocation) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      invocation.args,
      {
        cwd: invocation.cwd,
        env: invocation.env,
        timeout: invocation.timeoutMs,
        killSignal: 'SIGTERM',
        maxBuffer: SKILL_GIT_MAX_STREAM_BYTES,
        ...(invocation.abort ? { signal: invocation.abort } : {})
      },
      (error, stdout, stderr) => {
        const failure = error as (Error & { code?: unknown; signal?: string | null; killed?: boolean }) | null
        const subcommand = invocation.args[0] ?? 'git'
        if (failure?.code === 'ABORT_ERR') return reject(new SkillGitAbortedError(`git ${subcommand} was cancelled`))
        if (failure?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          return reject(
            new SkillGitOutputOverflowError(`git ${subcommand} printed past ${SKILL_GIT_MAX_STREAM_BYTES} bytes`)
          )
        }
        if (failure && failure.killed === true && failure.signal === 'SIGTERM') {
          return reject(new SkillGitTimeoutError(`git ${subcommand} was terminated after ${invocation.timeoutMs}ms`))
        }
        // Any other signal (SIGSEGV, an OOM SIGKILL) is equally not-a-fallback, but logged as what it was.
        if (failure && typeof failure.signal === 'string') {
          return reject(new SkillGitTimeoutError(`git ${subcommand} was killed by ${failure.signal}`))
        }
        if (failure && typeof failure.code === 'string')
          return reject(new Error(`git could not be run: ${failure.message}`))
        resolve({
          code: typeof failure?.code === 'number' ? failure.code : 0,
          stdout: String(stdout),
          stderr: String(stderr)
        })
      }
    )
  })

/** The gitcred helper for the Source's host, with the env carrying the caller's credential-window capability. */
export interface SkillGitCredential {
  /** The https host base the helper answers for, e.g. `https://github.com`. */
  host: string
  /** The `credential.<host>.helper` value. */
  helper: string
  /** The helper's own `AC_GITCRED_*` variables; any other name is dropped, never forwarded. */
  env: Record<string, string>
}

interface EnvOptions {
  home: string
  /** GIT_CEILING_DIRECTORIES: repository discovery never walks above the staging root. */
  ceiling: string
  shimEnv: Record<string, string | undefined>
  credential?: SkillGitCredential
  allowFileProtocol: boolean
}

/** The complete environment of a shim-internal skill Git: no system, global or agent config; hooks, fsmonitor and submodules off. */
export function skillGitEnv(options: EnvOptions, { lazyFetch }: { lazyFetch: boolean }): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of PASSTHROUGH_ENV) {
    const value = options.shimEnv[name]
    if (value !== undefined) env[name] = value
  }
  const credential = options.credential
  for (const name of CREDENTIAL_ENV) {
    const value = credential?.env[name]
    if (value !== undefined) env[name] = value
  }
  const pairs: Array<[string, string]> = [
    ['core.hooksPath', EMPTY_CONFIG],
    ['core.fsmonitor', 'false'],
    ['core.sparseCheckout', 'false'],
    ['credential.helper', ''],
    ['http.followRedirects', 'false'],
    ['fetch.bundleURI', ''],
    ['transfer.bundleURI', 'false'],
    ['fetch.uriProtocols', ''],
    ['submodule.recurse', 'false'],
    ['fetch.recurseSubmodules', 'false'],
    ['gc.auto', '0'],
    ['advice.graftFileDeprecated', 'false'],
    ['maintenance.auto', 'false']
  ]
  if (credential) {
    pairs.push(
      [`credential.${credential.host}.helper`, ''],
      [`credential.${credential.host}.helper`, credential.helper],
      [`credential.${credential.host}.useHttpPath`, 'true']
    )
  }
  pairs.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key
    env[`GIT_CONFIG_VALUE_${index}`] = value
  })
  return {
    ...env,
    HOME: options.home,
    XDG_CONFIG_HOME: options.home,
    GIT_CONFIG_COUNT: String(pairs.length),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: EMPTY_CONFIG,
    GIT_ALLOW_PROTOCOL: options.allowFileProtocol ? 'https:file' : 'https',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_GRAFT_FILE: EMPTY_CONFIG,
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CEILING_DIRECTORIES: options.ceiling,
    ...(lazyFetch ? {} : { GIT_NO_LAZY_FETCH: '1' })
  }
}

function assertCredential(credential: SkillGitCredential | undefined): void {
  if (!credential) return
  let url: URL
  try {
    url = new URL(credential.host)
  } catch {
    throw new SkillGitPlanRefusedError('credential host is not a URL')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new SkillGitPlanRefusedError('credential host must be a bare https origin')
  }
  if (credential.helper === '' || /[\r\n\0]/.test(credential.helper)) {
    throw new SkillGitPlanRefusedError('credential helper is empty or multi-line')
  }
}

// A field Git could read as an option or a path escape; the plan schema refuses these too, this is the spawn-side check.
function assertArgumentSafe(label: string, value: string | undefined): void {
  if (value === undefined) return
  if (value.startsWith('-')) throw new SkillGitPlanRefusedError(`${label} starts with '-'`)
  if (value.includes('..')) throw new SkillGitPlanRefusedError(`${label} contains '..'`)
  if (/[\0\r\n]/.test(value)) throw new SkillGitPlanRefusedError(`${label} contains a control character`)
}

/** Validate a plan entry before anything is spawned; returns it parsed. */
export function assertAcquirablePlan(plan: unknown): GitSkillPlan {
  const candidate = plan as Partial<Record<keyof GitSkillPlan, unknown>> | null
  if (candidate && typeof candidate === 'object') {
    for (const key of ['url', 'ref', 'plannedCommit', 'subDir', 'getUrl'] as const) {
      const value = candidate[key]
      if (value !== undefined && typeof value !== 'string') throw new SkillGitPlanRefusedError(`${key} is not a string`)
      // A presigned query may hold `..` harmlessly; only a leading '-' matters for the GET URL.
      if (key === 'getUrl') {
        if (typeof value === 'string' && value.startsWith('-'))
          throw new SkillGitPlanRefusedError(`getUrl starts with '-'`)
      } else assertArgumentSafe(key, value as string | undefined)
    }
  }
  const parsed = GitSkillPlanSchema.safeParse(plan)
  if (!parsed.success) throw new SkillGitPlanRefusedError(parsed.error.issues[0]?.message ?? 'invalid plan')
  const value = parsed.data
  if (value.ref !== undefined && !isValidBranchRef(value.ref) && !isValidFullRef(value.ref, 'refs/tags/')) {
    throw new SkillGitPlanRefusedError('ref is not a full branch or tag name')
  }
  return value
}

/** A Git that can run the in-pod skill path: `--bundle-uri` (2.38) and an honored `GIT_NO_LAZY_FETCH` (source-cache.md §13). */
export function gitSupportsInPodSkills(version: string): boolean {
  const match = /(?:^|\s)(\d+)\.(\d+)(?:\.(\d+))?/.exec(version.trim())
  if (!match) return false
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)]
  if (major !== 2) return major > 2
  // The GIT_NO_LAZY_FETCH fix was backported to these maintenance lines; 2.45.1 and later carry it.
  const floors: Record<number, number> = { 39: 4, 40: 2, 41: 1, 42: 2, 43: 4, 44: 1, 45: 1 }
  if (minor > 45) return true
  const floor = floors[minor]
  return floor !== undefined && patch >= floor
}

export interface SkillGitAcquireInput {
  /** Never a keepInstalled entry: the caller filters those out, this module clones whatever it is given. */
  plan: GitSkillPlan
  /** The shim-private 0700 staging root under its runtime root, never under the agent workspace. */
  stagingRoot: string
  git?: SkillGitRunner
  /** Test seam: the shim's own environment; default `process.env`. */
  shimEnv?: Record<string, string | undefined>
  /** The caller's credential window; absent runs anonymously. */
  credential?: SkillGitCredential
  /** Per-spawn deadline. */
  timeoutMs?: number
  abort?: AbortSignal
  limits?: Partial<SkillSourceSnapshotLimits>
  /** Test only: admit `file://` transport beside https. */
  allowFileProtocol?: boolean
  log?: { warn(message: string): void }
}

export type SkillGitBundleOutcome =
  { kind: 'uncached' } | { kind: 'hit' } | { kind: 'fallback'; reason: BundleFallbackReason }

export type SkillGitAcquireResult =
  | {
      kind: 'installed'
      sourceId: string
      commit: string
      /** The checked-out subdirectory, `.git`-free and snapshot-verified. */
      root: string
      /** The blobless clone's git dir, kept for a write-back bundle. */
      gitDir: string
      snapshot: SkillSourceSnapshot
      bundle: SkillGitBundleOutcome
      /** Remove the staging directory; the caller does this once it is done with `root` and `gitDir`. */
      release(): Promise<void>
    }
  | { kind: 'skipped'; sourceId: string; code: SkillSkipCode; reason: string }

type Outcome =
  | { kind: 'ok'; root: string; gitDir: string; snapshot: SkillSourceSnapshot }
  | { kind: 'skip'; code: SkillSkipCode; reason: string }

interface Attempt {
  plan: GitSkillPlan
  dir: string
  repo: string
  gitDir: string
  tree: string
  run(args: string[], options?: { lazyFetch?: boolean; extraEnv?: Record<string, string> }): Promise<SkillGitOutput>
}

const SKIP_REASONS: Record<SkillSkipCode, string> = {
  resolution_failed: 'the Source could not be resolved',
  access_denied: 'the repository refused access',
  ref_moved: 'the ref moved after resolution',
  commit_unavailable: 'the planned commit or subdirectory is not available',
  sha_fetch_refused: 'the host refused the pinned commit and no branch or tag reaches it',
  fetch_failed: 'fetching the repository failed',
  limits_exceeded: 'the skill content exceeds the snapshot limits or holds a link or special file',
  cli_failed: 'the skill CLI failed'
}

const skip = (code: SkillSkipCode): Outcome => ({ kind: 'skip', code, reason: SKIP_REASONS[code] })

function failureOf(output: SkillGitOutput, args: string[]): SkillGitFailure {
  const remote = TRANSPORT_SUBCOMMANDS.has(args[0] ?? '')
  const code: SkillSkipCode = remote && ACCESS_DENIED_RE.test(output.stderr) ? 'access_denied' : 'fetch_failed'
  return new SkillGitFailure(code, `git ${args[0]} exited ${output.code}: ${output.stderr}`)
}

async function must(
  attempt: Attempt,
  args: string[],
  options?: Parameters<Attempt['run']>[1]
): Promise<SkillGitOutput> {
  const output = await attempt.run(args, options)
  if (output.code !== 0) throw failureOf(output, args)
  return output
}

async function hasCommit(attempt: Attempt, commit: string): Promise<boolean> {
  return (await attempt.run(['cat-file', '-e', `${commit}^{commit}`])).code === 0
}

// The bundle supplies objects, never the commit: a present planned commit is final, else the origin must name it (§8).
async function ensurePlannedCommit(attempt: Attempt): Promise<Outcome | undefined> {
  const { plan } = attempt
  if (await hasCommit(attempt, plan.plannedCommit)) return undefined
  if (plan.ref !== undefined) {
    const args = ['fetch', '-q', '--no-tags', '--', 'origin', `+${plan.ref}:${PLANNED_REF}`]
    const fetched = await attempt.run(args, { lazyFetch: true })
    if (fetched.code !== 0) {
      if (MISSING_REF_RE.test(fetched.stderr)) return skip('ref_moved')
      throw failureOf(fetched, args)
    }
    const tip = (await must(attempt, ['rev-parse', '--verify', '--quiet', `${PLANNED_REF}^{commit}`])).stdout.trim()
    return tip === plan.plannedCommit ? undefined : skip('ref_moved')
  }
  const wanted = await attempt.run(['fetch', '-q', '--no-tags', '--', 'origin', plan.plannedCommit], {
    lazyFetch: true
  })
  if (wanted.code === 0 && (await hasCommit(attempt, plan.plannedCommit))) return undefined
  // The host refused a SHA want (allowReachableSHA1InWant is off outside GitHub and GitLab): look among its branches and tags.
  await must(
    attempt,
    ['fetch', '-q', '--', 'origin', '+refs/heads/*:refs/remotes/origin/*', '+refs/tags/*:refs/tags/*'],
    {
      lazyFetch: true
    }
  )
  return (await hasCommit(attempt, plan.plannedCommit)) ? undefined : skip('sha_fetch_refused')
}

// `read-tree --reset -u` into a private index places only the subtree, batch-fetches its blobs, and leaves no `.git` in the root.
async function checkoutSubtree(attempt: Attempt): Promise<Outcome | undefined> {
  const { plan } = attempt
  const treeish = plan.subDir === undefined ? `${plan.plannedCommit}^{tree}` : `${plan.plannedCommit}:${plan.subDir}`
  const kind = await attempt.run(['cat-file', '-t', treeish])
  if (kind.code !== 0 || kind.stdout.trim() !== 'tree') return skip('commit_unavailable')
  await mkdir(attempt.tree, { mode: 0o700 })
  await must(attempt, ['read-tree', '--reset', '-u', treeish], {
    lazyFetch: true,
    extraEnv: { GIT_DIR: attempt.gitDir, GIT_WORK_TREE: attempt.tree, GIT_INDEX_FILE: join(attempt.dir, 'index') }
  })
  return undefined
}

async function acquireOnce(
  attempt: Attempt,
  bundleUrl: string | undefined,
  step: BundleStep,
  limits: SkillSourceSnapshotLimits
): Promise<Outcome> {
  const { plan } = attempt
  const bundle = bundleUrl === undefined ? [] : [`--bundle-uri=${bundleUrl}`]
  // Blobless and never shallow: a shallow repository's bundle can never seed a clone (§8).
  const cloneArgs = ['clone', '-q', '--filter=blob:none', '--no-checkout', ...bundle, '--', plan.url, attempt.repo]
  const cloned = await step('clone-failed', () => must(attempt, cloneArgs, { lazyFetch: true }))
  if (bundleUrl !== undefined) {
    const warning = bundleDownloadWarningOf(cloned.stderr)
    if (warning !== undefined) throw new BundleFallback('download-warning', warning)
    const unreadable = UNREADABLE_OBJECT_RE.exec(cloned.stderr)
    if (unreadable) throw new BundleFallback('connectivity', unreadable[0])
    const refs = bundleRefNamesOf((await step('inspect-failed', () => must(attempt, [...BUNDLE_REF_LIST_ARGS]))).stdout)
    if (refs.length === 0) throw new BundleFallback('no-bundle-refs', 'no ref under refs/bundles/ after the clone')
    if (refs.length > MAX_BUNDLE_REFS)
      throw new BundleFallback('inspect-failed', `${refs.length} refs under refs/bundles/`)
    // Not a complete gate for a filtered (promisor) bundle; an unreadable subtree below falls back instead.
    await step('connectivity', () => must(attempt, [...CONNECTIVITY_CHECK_ARGS]))
    await step('cleanup-failed', async () => {
      for (const ref of refs) await must(attempt, ['update-ref', '-d', ref])
    })
  }
  const unplanned = await step('acquire-failed', () => ensurePlannedCommit(attempt))
  if (unplanned) return unplanned
  const missing = await step('acquire-failed', () => checkoutSubtree(attempt))
  // A bundle-seeded object store may lack what it advertised, so only the bundle-free attempt may call it unavailable.
  if (missing?.kind === 'skip' && missing.code === 'commit_unavailable' && bundleUrl !== undefined)
    throw new BundleFallback('connectivity', 'the planned subtree is unreadable without the origin')
  if (missing) return missing
  try {
    const snapshot = await inspectLocalSkillSource(attempt.tree, { limits })
    return { kind: 'ok', root: attempt.tree, gitDir: attempt.gitDir, snapshot }
  } catch (err) {
    if (err instanceof SkillSourceSnapshotError) return skip('limits_exceeded')
    throw err
  }
}

// A bundled attempt's 403 may be the presigned GET's, so access_denied falls back and the bundle-free retry reports it.
const notAFallback = (err: unknown): boolean =>
  err instanceof SkillGitTimeoutError ||
  err instanceof SkillGitAbortedError ||
  (err instanceof Error && err.name === 'AbortError')

const plainStep: BundleStep = (_reason, run) => run()

/** Clone a planned Git skill Source into private staging, verify the commit, check out its subdirectory and snapshot it. */
export async function acquireSkillGitSource(input: SkillGitAcquireInput): Promise<SkillGitAcquireResult> {
  const plan = assertAcquirablePlan(input.plan)
  assertCredential(input.credential)
  assertStagingPrivate(input.stagingRoot, STAGING_LABEL)
  const git = input.git ?? runLocalSkillGit
  const shimEnv = input.shimEnv ?? process.env
  const timeoutMs = Math.min(input.timeoutMs ?? DEFAULT_SKILL_GIT_TIMEOUT_MS, DEFAULT_SKILL_GIT_TIMEOUT_MS)
  const limits = { ...GIT_SKILL_SOURCE_SNAPSHOT_LIMITS, ...input.limits }
  const sourceId = plan.sourceId
  const warn = (message: string): void =>
    input.log?.warn(`skill git ${sourceId}: ${scrubBundleDetail(message, plan.getUrl)}`)

  const open = async (): Promise<Attempt> => {
    const dir = await mkdtemp(join(input.stagingRoot, 'skill-git-'))
    const home = join(dir, 'home')
    await mkdir(home, { mode: 0o700 })
    const repo = join(dir, 'repo')
    const envOptions: EnvOptions = {
      home,
      ceiling: input.stagingRoot,
      shimEnv,
      ...(input.credential ? { credential: input.credential } : {}),
      allowFileProtocol: input.allowFileProtocol === true
    }
    const attempt: Attempt = {
      plan,
      dir,
      repo,
      gitDir: join(repo, '.git'),
      tree: join(dir, 'tree'),
      run: async (args, options = {}) => {
        assertNoRefusedArguments(args)
        if (input.abort?.aborted) throw new SkillGitAbortedError('skill Git acquisition was cancelled')
        const env = { ...skillGitEnv(envOptions, { lazyFetch: options.lazyFetch === true }), ...options.extraEnv }
        const cwd = args[0] === 'clone' ? dir : repo
        return await git({ args, cwd, env, timeoutMs, ...(input.abort ? { abort: input.abort } : {}) })
      }
    }
    return attempt
  }
  const discard = (dir: string): Promise<void> => rm(dir, { recursive: true, force: true })

  const settle = async (
    attempt: Attempt,
    outcome: Outcome,
    bundle: SkillGitBundleOutcome
  ): Promise<SkillGitAcquireResult> => {
    if (outcome.kind === 'skip') {
      await discard(attempt.dir)
      return { kind: 'skipped', sourceId, code: outcome.code, reason: outcome.reason }
    }
    return {
      kind: 'installed',
      sourceId,
      commit: plan.plannedCommit,
      root: outcome.root,
      gitDir: outcome.gitDir,
      snapshot: outcome.snapshot,
      bundle,
      release: () => discard(attempt.dir)
    }
  }

  const unsettled = async (attempt: Attempt, err: unknown): Promise<SkillGitAcquireResult> => {
    await discard(attempt.dir)
    if (err instanceof SkillGitAbortedError || (err instanceof Error && err.name === 'AbortError')) throw err
    warn(err instanceof Error ? err.message : String(err))
    const code: SkillSkipCode = err instanceof SkillGitFailure ? err.code : 'fetch_failed'
    return { kind: 'skipped', sourceId, code, reason: SKIP_REASONS[code] }
  }

  let fallback: BundleFallbackReason | undefined
  if (plan.getUrl !== undefined) {
    const attempt = await open()
    try {
      const result = await attemptWithBundle(notAFallback, (step) => acquireOnce(attempt, plan.getUrl, step, limits))
      if (result.kind === 'hit') return await settle(attempt, result.value, { kind: 'hit' })
      fallback = result.reason
      warn(`bundled attempt fell back (${result.reason}): ${result.detail}`)
    } catch (err) {
      return await unsettled(attempt, err)
    }
    // The retry contract: the whole staging directory, object database included, goes before the clean retry.
    await discard(attempt.dir)
  }
  const attempt = await open()
  try {
    const outcome = await acquireOnce(attempt, undefined, plainStep, limits)
    return await settle(
      attempt,
      outcome,
      fallback === undefined ? { kind: 'uncached' } : { kind: 'fallback', reason: fallback }
    )
  } catch (err) {
    return await unsettled(attempt, err)
  }
}

export interface SkillGitLsRemoteInput {
  url: string
  /** A full `refs/heads/*` or `refs/tags/*` name. */
  ref: string
  stagingRoot: string
  git?: SkillGitRunner
  shimEnv?: Record<string, string | undefined>
  credential?: SkillGitCredential
  timeoutMs?: number
  abort?: AbortSignal
  allowFileProtocol?: boolean
}

/** A commit this pod resolved itself: used only by this pod's own preparation, never shared (source-cache.md §5). */
export interface PodLocalCommit {
  commit: string
  trust: 'pod-local'
}

/** Anonymous resolution of one ref by name; undefined when the remote does not have it. Dormant in P2. */
export async function lsRemoteSkillRef(input: SkillGitLsRemoteInput): Promise<PodLocalCommit | undefined> {
  if (input.ref === '') throw new SkillGitPlanRefusedError('ref is empty')
  const { url } = assertAcquirablePlan({
    sourceId: 'ls-remote',
    sourceKind: 'git',
    url: input.url,
    ref: input.ref,
    plannedCommit: '0'.repeat(40),
    selections: []
  })
  assertCredential(input.credential)
  assertStagingPrivate(input.stagingRoot, STAGING_LABEL)
  const dir = await mkdtemp(join(input.stagingRoot, 'skill-ls-remote-'))
  try {
    const home = join(dir, 'home')
    await mkdir(home, { mode: 0o700 })
    const env = skillGitEnv(
      {
        home,
        ceiling: input.stagingRoot,
        shimEnv: input.shimEnv ?? process.env,
        ...(input.credential ? { credential: input.credential } : {}),
        allowFileProtocol: input.allowFileProtocol === true
      },
      { lazyFetch: false }
    )
    // Scoped by name, with the peeled form for an annotated tag, so the listing stays a few lines however many refs the remote has.
    const { ref } = input
    const args = ['ls-remote', '-q', '--', url, ref, `${ref}^{}`]
    assertNoRefusedArguments(args)
    const timeoutMs = Math.min(input.timeoutMs ?? DEFAULT_SKILL_GIT_TIMEOUT_MS, DEFAULT_SKILL_GIT_TIMEOUT_MS)
    const output = await (input.git ?? runLocalSkillGit)({
      args,
      cwd: dir,
      env,
      timeoutMs,
      ...(input.abort ? { abort: input.abort } : {})
    })
    if (output.code !== 0) throw failureOf(output, args)
    let direct: string | undefined
    let peeled: string | undefined
    for (const line of output.stdout.split('\n')) {
      const [oid, name] = line.trim().split('\t')
      if (oid === undefined || !COMMIT_RE.test(oid)) continue
      if (name === ref) direct = oid
      else if (name === `${ref}^{}`) peeled = oid
    }
    const commit = peeled ?? direct
    return commit === undefined ? undefined : { commit, trust: 'pod-local' }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** The §11 code a thrown ls-remote failure maps to, for a caller that skips the Source on it. */
export function skillGitSkipCodeOf(err: unknown): SkillSkipCode {
  return err instanceof SkillGitFailure && err.code === 'access_denied' ? 'access_denied' : 'resolution_failed'
}
