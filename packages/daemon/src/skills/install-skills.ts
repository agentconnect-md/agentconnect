/**
 * Unified workspace skill installer.
 *
 * Git sources, centrally managed bundles, and accepted local Dream bundles all
 * become daemon-owned immutable local snapshots and are passed through the same
 * exact pinned `skills` CLI. The CLI runs in a disposable private cell and never
 * sees the live workspace, provider credentials, Git credentials, or ambient
 * HOME. Its derived filesystem receipt is then reconciled through one trusted
 * external ownership ledger. Runtime-specific destination layout is therefore
 * owned exclusively by the CLI, not duplicated here.
 */
import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants, promises as fsp, type Stats } from 'node:fs'
import { dirname, join } from 'node:path'
import { AgentSkillEntry } from '@agentconnect.md/protocol'
import type { Agent } from '../agents/agent-schema.js'
import { containedTarget } from '../fs/contained-path.js'
import { skillsAgentIdForRuntime } from '../runtimes/skills-capability.js'
import {
  installedBundlesIntact,
  assertSkillLedgerOwner,
  readSkillLedger,
  reconcileSkillBundles,
  recoverSkillLedger,
  skillLedgerLocation,
  treeDigest,
  withSkillWorkspaceLock,
  type CandidateSkillBundle,
  type SkillGitResolution,
  SkillLedgerSafetyError,
  type SkillFileReceipt
} from './skill-install-ledger.js'
import { resolveSkillSelections } from './skill-cli-selection.js'
import { acquireGitSkillSource, isPinnedGitSkillRef, resolveBoundedGitSkillSource } from './skill-git-source.js'
import { GIT_SKILL_SOURCE_SNAPSHOT_LIMITS, snapshotLocalSkillSource } from './skill-source-snapshot.js'
import { PINNED_SKILLS_CLI_VERSION, stageSkillsCliCell, type SkillsCliCellResult } from './skills-cli-cell.js'

export const SKILLS_CLI_SPEC = `skills@${PINNED_SKILLS_CLI_VERSION}`
// v3: selection resolution + slash-reference dependency expansion change the
// materialized bundle set for unchanged wire inputs; the bump invalidates
// ready v2 fingerprints so every workspace reconciles once under the new
// semantics instead of retaining pre-expansion alias-only installs.
const INSTALLER_SCHEMA = 3
const LEGACY_MARKER_BYTES = 64 * 1024
const LEGACY_MARKERS = ['skills-install.json', 'dream-skills-install.json'] as const
const LEGACY_OWNED = /^(?:\.claude\/skills|\.agents\/skills)\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const MAX_GIT_SKILL_SOURCES = 64
const MAX_LOCAL_SKILL_SOURCES = 64
const MAX_CLI_INVOCATIONS = 128
const MAX_PUBLISHED_SKILL_BUNDLES = 64
const MAX_PUBLISHED_SKILL_FILES = 1_024
const MAX_PUBLISHED_SKILL_BYTES = 64 * 1024 * 1024
const MAX_INPUT_FILES = 8_192
const MAX_INPUT_BYTES = 256 * 1024 * 1024

/** Kept as a compatibility seam for tests/operators, but mutable/floating
 * overrides are no longer accepted. Runtime execution resolves the installed
 * exact dependency directly and does not invoke npx. */
export function resolveSkillsCliSpec(env: NodeJS.ProcessEnv = process.env): string {
  const requested = env.AC_SKILLS_CLI?.trim()
  if (requested && requested !== SKILLS_CLI_SPEC) {
    throw new Error(`AC_SKILLS_CLI must be the exact audited spec ${SKILLS_CLI_SPEC}`)
  }
  return SKILLS_CLI_SPEC
}

/** Historical wire-format helper. Acquisition parses the same entry directly;
 * this remains exported for compatibility and documentation examples. */
export function composeSource(entry: AgentSkillEntry): string {
  const { source, ref, subDir } = entry
  if (/\/tree\//.test(source)) return source
  if (!ref && !subDir) return source
  const shorthand = /^[^/\s]+\/[^/\s]+$/.test(source)
  const base = shorthand ? `https://github.com/${source}` : source
  if (!/^https?:\/\/github\.com\//i.test(base)) return source
  const suffix = subDir ? `/${subDir.replace(/^\/+/, '')}` : ''
  return `${base.replace(/\/+$/, '')}/tree/${ref ?? 'main'}${suffix}`
}

export interface LocalSkillSource {
  kind: 'managed' | 'dream'
  /** Stable, credential-free source identity persisted in receipts. */
  key: string
  name: string
  sourceDir: string
  /** Stable upstream content identity. For managed sources this is the archive
   * digest, which is intentionally not the same as the extracted tree digest. */
  contentDigest?: string
  /** Optional trusted digest of the extracted local tree itself. */
  expectedTreeDigest?: string
}

export interface SkillsCliInvocation {
  sourceDir: string
  sourceKey: string
  agentId: string
  skills: string[]
  /** Fresh private directory. An injected runner may materialize here. */
  cellDir: string
}

export interface SkillsCliInvocationBundle {
  relativeRoot: string
  sourceDir: string
  /** Optional corroborating fields from a test/embedding runner. The daemon
   * always independently snapshots and hashes sourceDir before publication. */
  treeDigest?: string
  files?: SkillFileReceipt[]
}

export interface SkillsCliInvocationResult {
  bundles: SkillsCliInvocationBundle[]
  stdoutDigest: string
  stderrDigest: string
  isolation?: 'kernel' | 'process'
  isolationReason?: string
  cleanup?: () => void
}

export type SkillsCliInvoker = (input: SkillsCliInvocation) => Promise<SkillsCliInvocationResult>

export type GitSkillAcquirer = (
  entry: AgentSkillEntry,
  options: { destination: string; agentId: string; useGitCredential: boolean }
) => Promise<{ sourceDir: string; resolvedCommit: string }>

export interface InstallSkillsOptions {
  /** Trusted daemon-owned state root, never inside the agent-writable cwd. */
  stateDir?: string
  /** Audited skills CLI identity from the resolved runtime capability. */
  /** `null` explicitly disables an otherwise-audited runtime id. Omission uses
   * the daemon's trusted built-in compatibility overlay. */
  skillsAgentId?: string | null
  localSkills?: LocalSkillSource[]
  useGitCredential?: boolean
  runCli?: SkillsCliInvoker
  acquireGit?: GitSkillAcquirer
  /** What a TRACKING ref points at now (shared-skills.md §5). Absent ⇒ every
   * source keeps its retained commit, which is what a caller with no network
   * seam wants; null for one entry ⇒ unknown, so the retained commit stands. */
  resolveGitRef?: (entry: AgentSkillEntry) => Promise<string | null>
  warn?: (message: string) => void
}

export interface InstallSkillsResult {
  installed: string[]
  removed: string[]
  skipped: 'unchanged' | null
  /** Checkout-relative roots this daemon owns after the run — what git must be told to ignore. */
  owned: string[]
  errors: Array<{ source: string; error: string }>
}

interface PreparedSource {
  key: string
  name: string
  sourceDir: string
  /** `-s` values for the CLI: the SKILL.md frontmatter names it matches. */
  skills: string[]
  /** Exact CLI-derived leaf directory names `skills` must produce (empty ⇒
   * install everything the source exposes, any leaves). */
  expectedLeaves: string[]
  contentDigest: string
}

/** Reconcile all source classes in one ordered transaction. Expected source
 * misses degrade to no AgentConnect-managed skills; a containment/journal
 * failure throws because starting with ambiguous stale executable content is
 * less safe than refusing the workspace. */
export async function installSkills(
  agent: Pick<Agent, 'id' | 'runtime' | 'skills'> & { dir?: string },
  cwd: string,
  opts: InstallSkillsOptions = {}
): Promise<InstallSkillsResult> {
  const stateDir =
    opts.stateDir ?? join(agent.dir ?? dirname(await fsp.realpath(cwd)), '.agentconnect', 'skill-installer')
  return withSkillWorkspaceLock(cwd, () => installSkillsLocked(agent, cwd, { ...opts, stateDir }), stateDir)
}

async function installSkillsLocked(
  agent: Pick<Agent, 'id' | 'runtime' | 'skills'> & { dir?: string },
  cwd: string,
  opts: InstallSkillsOptions
): Promise<InstallSkillsResult> {
  const result: InstallSkillsResult = { installed: [], removed: [], skipped: null, owned: [], errors: [] }
  const wireGitSources = agent.skills ?? []
  const localSources = opts.localSkills ?? []
  if (localSources.length > MAX_LOCAL_SKILL_SOURCES) throw new Error('too many local skill sources')
  const gitSources: AgentSkillEntry[] = []
  const sourceNames = new Set<string>()
  for (const [index, entry] of wireGitSources.entries()) {
    const parsed = AgentSkillEntry.safeParse(entry)
    if (!parsed.success) {
      opts.warn?.(`skills: omitted historical Git source ${index + 1}; it fails current installation admission`)
      continue
    }
    if (sourceNames.has(parsed.data.name)) {
      opts.warn?.(`skills: omitted duplicate historical Git source name "${parsed.data.name}"`)
      continue
    }
    if (gitSources.length >= MAX_GIT_SKILL_SOURCES) {
      opts.warn?.(`skills: omitted historical Git source ${index + 1}; at most ${MAX_GIT_SKILL_SOURCES} are installed`)
      continue
    }
    sourceNames.add(parsed.data.name)
    gitSources.push(parsed.data)
  }
  const invocationCount = gitSources.length + localSources.length
  if (invocationCount > MAX_CLI_INVOCATIONS) throw new Error('too many skills CLI invocations')
  const agentId =
    opts.skillsAgentId === undefined ? skillsAgentIdForRuntime(agent.runtime) : (opts.skillsAgentId ?? undefined)
  const hasDesired = gitSources.length > 0 || localSources.length > 0
  if (!agentId && hasDesired) {
    opts.warn?.(`skills: runtime "${agent.runtime}" has not passed skills CLI compatibility admission`)
  }

  const stateDir =
    opts.stateDir ?? join(agent.dir ?? dirname(await fsp.realpath(cwd)), '.agentconnect', 'skill-installer')
  await ensurePrivateStateRoot(stateDir)
  const runsDir = join(stateDir, 'runs')
  await fsp.mkdir(runsDir, { recursive: true, mode: 0o700 })
  await fsp.chmod(runsDir, 0o700)
  const scratch = await fsp.mkdtemp(join(runsDir, 'install-'))
  await fsp.chmod(scratch, 0o700)
  let retainedGitResolutions: SkillGitResolution[] = []

  const localPrepared: PreparedSource[] = []
  let inputFiles = 0
  let inputBytes = 0
  const accountInput = (fileCount: number, totalBytes: number): void => {
    inputFiles += fileCount
    inputBytes += totalBytes
    if (inputFiles > MAX_INPUT_FILES || inputBytes > MAX_INPUT_BYTES) {
      throw new Error('aggregate skill sources exceed the installer limits')
    }
  }
  try {
    for (const [index, source] of localSources.entries()) {
      const destination = join(scratch, 'inputs', `local-${index}`)
      await prepareSnapshotDestination(destination)
      const snapshot = await snapshotLocalSkillSource(source.sourceDir, destination)
      accountInput(snapshot.fileCount, snapshot.totalBytes)
      if (source.expectedTreeDigest && source.expectedTreeDigest !== snapshot.sha256) {
        throw new Error(`local skill source "${source.name}" does not match its declared content digest`)
      }
      localPrepared.push({
        key: source.key,
        name: source.name,
        sourceDir: destination,
        skills: [source.name],
        expectedLeaves: [source.name],
        contentDigest: snapshot.sha256
      })
    }

    const legacyState = await readLegacyOwned(cwd)
    const location = await skillLedgerLocation(cwd, stateDir)
    let ledger = await readSkillLedger(location)
    if (ledger) {
      assertSkillLedgerOwner(ledger, agent.id)
      ledger = await recoverSkillLedger(cwd, location, ledger)
    }
    const trackedCommits = await resolveTrackedCommits(gitSources, opts.resolveGitRef)
    const installedResolutions = currentGitResolutions(gitSources, ledger?.gitResolutions ?? [])
    retainedGitResolutions = retainedAfterTracking(installedResolutions, trackedCommits)
    // The commit this run intends to install per acquisition identity: the tracked
    // head where one is known, else the commit already installed. It rides the plan
    // fingerprint because the publication layer decides on that fingerprint alone —
    // a moved head that did not change it would be acquired and then discarded as
    // unchanged. An unavailable answer keeps the installed commit and so keeps the
    // fingerprint, which is what makes "unknown" a no-op rather than a rebuild.
    const plannedCommits = plannedGitCommits(gitSources, installedResolutions, trackedCommits)
    // One recipe, evaluated twice: over what this run PLANS to install (the skip
    // decisions) and, after acquisition, over what it actually installed (the value
    // the ledger keeps). A first install cannot know the commit a moving ref will
    // resolve to, so recording the plan there would make the very next run's
    // fingerprint differ from it and rebuild for nothing.
    const fingerprintFor = (plan: Map<string, string>): string =>
      fingerprint({
        schema: INSTALLER_SCHEMA,
        cli: SKILLS_CLI_SPEC,
        runtime: agent.runtime,
        agentId: agentId ?? '',
        git: gitSources,
        plan: [...plan].sort(([a], [b]) => a.localeCompare(b)),
        local: localPrepared.map(({ key, name, contentDigest }) => ({ key, name, contentDigest }))
      })
    const planFingerprint = fingerprintFor(plannedCommits)
    const desiredGitResolutionCount = new Set(gitSources.map(gitResolutionDigest)).size
    assertNoUnmigratedLegacyState(legacyState)
    // Claim every prepared workspace, even before it has executable skills.
    // Otherwise another agent can keep a live sandbox with write authority to
    // this cwd and tamper a bundle that is published here later. The external
    // workspace lock makes this first-owner decision serial across daemons.
    if (
      ledger?.phase === 'ready' &&
      ledger.fingerprint === planFingerprint &&
      retainedGitResolutions.length === desiredGitResolutionCount &&
      (await installedBundlesIntact(cwd, ledger.owned, location.workspaceIdentity))
    ) {
      result.skipped = 'unchanged'
      result.owned = ledger.owned.map((bundle) => bundle.relativeRoot)
      return result
    }

    if (!agentId) {
      const reconciled = await reconcileSkillBundles({
        cwd,
        stateDir,
        agentId: agent.id,
        runtime: agent.runtime,
        cliVersion: PINNED_SKILLS_CLI_VERSION,
        fingerprint: fingerprintFor(plannedGitCommits(gitSources, retainedGitResolutions, new Map())),
        candidates: [],
        gitResolutions: retainedGitResolutions,
        legacyOwned: legacyState.owned,
        lockHeld: true,
        warn: opts.warn
      })
      result.removed.push(...reconciled.removed)
      result.owned = reconciled.owned.map((bundle) => bundle.relativeRoot)
      return result
    }

    const prepared: PreparedSource[] = []
    const resolutionsByDefinition = new Map(
      retainedGitResolutions.map((resolution) => [resolution.definitionDigest, resolution.resolvedCommit])
    )
    const installedByDefinition = new Map(
      installedResolutions.map((resolution) => [resolution.definitionDigest, resolution.resolvedCommit])
    )
    // Acquisition identities this run wanted but could not build. Their installed
    // bundles are kept: the source is still desired and the bytes on disk are its
    // own older commit, so removing them would cost the agent a working skill for
    // an upstream outage. See §6.3.
    const unresolvedDefinitions = new Set<string>()
    for (const [index, entry] of gitSources.entries()) {
      const definitionDigest = gitResolutionDigest(entry)
      try {
        const acquisitionDir = join(scratch, 'acquired', `git-${index}`)
        await fsp.mkdir(dirname(acquisitionDir), { recursive: true, mode: 0o700 })
        await fsp.mkdir(acquisitionDir, { mode: 0o700 })
        // A sibling entry that shares this acquisition identity has already resolved
        // it in THIS run, and both must land on identical bytes; otherwise take what
        // the plan says (the tracked head, a pin, or the installed commit).
        const plannedCommit = resolutionsByDefinition.get(definitionDigest) ?? plannedCommits.get(definitionDigest)
        const acquisitionEntry = plannedCommit ? { ...entry, ref: plannedCommit } : entry
        const acquired = await (opts.acquireGit ?? acquireGitSkillSource)(acquisitionEntry, {
          destination: acquisitionDir,
          agentId: agent.id,
          useGitCredential: opts.useGitCredential === true
        })
        const resolvedCommit = acquired.resolvedCommit.toLowerCase()
        if (!/^[a-f0-9]{40}$/.test(resolvedCommit) || (plannedCommit && resolvedCommit !== plannedCommit)) {
          throw new Error(`Git source "${entry.name}" did not resolve to its planned commit`)
        }
        resolutionsByDefinition.set(definitionDigest, resolvedCommit)
        const destination = join(scratch, 'inputs', `git-${index}`)
        await prepareSnapshotDestination(destination)
        const snapshot = await snapshotLocalSkillSource(acquired.sourceDir, destination, {
          limits: GIT_SKILL_SOURCE_SNAPSHOT_LIMITS
        })
        accountInput(snapshot.fileCount, snapshot.totalBytes)
        // The CLI matches `-s` values against SKILL.md frontmatter names but the
        // wire carries canonical leaf names, so resolve each selection against
        // the snapshot first (#371). One source invocation carries all selected
        // skills; we independently require the exact resolved leaf-name set
        // below, so a CLI that returns success after installing only a valid
        // subset still fails the transaction.
        const selection = await resolveSkillSelections(entry.name, destination, snapshot.files, entry.skills)
        prepared.push({
          key: `git:${index}:${definitionDigest}:${resolvedCommit}${entry.skills.length > 0 ? `:${fingerprint(entry.skills)}` : ''}`,
          name: entry.name,
          sourceDir: destination,
          skills: selection.cliSelections,
          expectedLeaves: selection.expectedLeaves,
          contentDigest: snapshot.sha256
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown Git skill source error'
        result.errors.push({ source: entry.name, error: message })
        opts.warn?.(`skills: Git source ${entry.name} unavailable (${message}); keeping what is installed`)
        unresolvedDefinitions.add(definitionDigest)
        // The ledger must keep naming the commit that is ON DISK — the tracking
        // check may have dropped this retention to force the (now failed) rebuild.
        const installed = installedByDefinition.get(definitionDigest)
        if (installed !== undefined) resolutionsByDefinition.set(definitionDigest, installed)
      }
    }
    prepared.push(...localPrepared)
    const nextGitResolutions = currentGitResolutions(
      gitSources,
      [...resolutionsByDefinition].map(([definitionDigest, resolvedCommit]) => ({ definitionDigest, resolvedCommit }))
    )
    // Owned bundles belonging to a source this run could not build: still desired,
    // so the publication leaves them exactly as they are instead of removing them.
    const preserveOwned =
      unresolvedDefinitions.size > 0
        ? (ledger?.owned ?? [])
            .filter((bundle) => {
              const digest = gitSourceKeyDefinition(bundle.sourceKey)
              return digest !== undefined && unresolvedDefinitions.has(digest)
            })
            .map((bundle) => bundle.relativeRoot)
        : []
    // What the publication layer stores and compares: the commits actually acquired.
    const installedFingerprint = fingerprintFor(plannedGitCommits(gitSources, nextGitResolutions, new Map()))

    const runCli = opts.runCli ?? runPinnedSkillsCli
    const candidatesByPath = new Map<string, CandidateSkillBundle>()
    let stagedCandidateFiles = 0
    let stagedCandidateBytes = 0
    for (const [index, source] of prepared.entries()) {
      const cellDir = join(scratch, 'cells', `${index}-${randomUUID()}`)
      await fsp.mkdir(cellDir, { recursive: true, mode: 0o700 })
      let invocation: SkillsCliInvocationResult | undefined
      try {
        invocation = await runCli({
          sourceDir: source.sourceDir,
          sourceKey: source.key,
          agentId,
          skills: source.skills,
          cellDir
        })
        if (invocation.isolation === 'process') {
          opts.warn?.(
            `skills: kernel sandbox unavailable; using private-process fallback${invocation.isolationReason ? ` (${invocation.isolationReason})` : ''}`
          )
        }
        if (invocation.bundles.length === 0) {
          throw new Error(`skills CLI produced no bundles for ${source.name}`)
        }
        if (source.expectedLeaves.length > 0) {
          const expected = [...source.expectedLeaves].sort()
          const actual = invocation.bundles.map((bundle) => bundle.relativeRoot.split('/').at(-1) ?? '').sort()
          if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            throw new Error(`skills CLI output did not exactly match selection for ${source.name}`)
          }
        }
        for (const [bundleIndex, bundle] of invocation.bundles.entries()) {
          const destination = join(scratch, 'candidates', `${index}-${bundleIndex}`)
          await prepareSnapshotDestination(destination)
          const snap = await snapshotLocalSkillSource(bundle.sourceDir, destination)
          stagedCandidateFiles += snap.fileCount
          stagedCandidateBytes += snap.totalBytes
          const files: SkillFileReceipt[] = snap.files.map((file) => ({
            path: file.path,
            mode: file.mode & 0o111 ? 0o700 : 0o600,
            size: file.size,
            sha256: stripShaPrefix(file.sha256)
          }))
          const candidate: CandidateSkillBundle = {
            relativeRoot: bundle.relativeRoot,
            sourceKey: source.key,
            sourceDir: destination,
            files,
            treeDigest: treeDigest(files)
          }
          const replaced = candidatesByPath.get(candidate.relativeRoot)
          if (replaced) {
            opts.warn?.(
              `skills: source "${source.name}" overrides "${replaced.sourceKey}" at CLI-derived path ${candidate.relativeRoot}`
            )
          }
          candidatesByPath.set(candidate.relativeRoot, candidate)
          if (replaced) {
            await fsp.rm(replaced.sourceDir, { recursive: true, force: true })
            stagedCandidateFiles -= replaced.files.length
            stagedCandidateBytes -= replaced.files.reduce((total, file) => total + file.size, 0)
          }
          if (
            candidatesByPath.size > MAX_PUBLISHED_SKILL_BUNDLES ||
            stagedCandidateFiles > MAX_PUBLISHED_SKILL_FILES ||
            stagedCandidateBytes > MAX_PUBLISHED_SKILL_BYTES
          ) {
            throw new Error('aggregate skills CLI output exceeds the publication limits')
          }
        }
      } finally {
        invocation?.cleanup?.()
      }
    }

    const candidates = [...candidatesByPath.values()]
    const candidateFiles = candidates.reduce((total, candidate) => total + candidate.files.length, 0)
    const candidateBytes = candidates.reduce(
      (total, candidate) => total + candidate.files.reduce((bytes, file) => bytes + file.size, 0),
      0
    )
    if (
      candidates.length > MAX_PUBLISHED_SKILL_BUNDLES ||
      candidateFiles > MAX_PUBLISHED_SKILL_FILES ||
      candidateBytes > MAX_PUBLISHED_SKILL_BYTES
    ) {
      throw new Error('aggregate skills CLI output exceeds the publication limits')
    }

    const reconciled = await reconcileSkillBundles({
      cwd,
      stateDir,
      agentId: agent.id,
      runtime: agent.runtime,
      cliVersion: PINNED_SKILLS_CLI_VERSION,
      // A run that could not build every desired source has not met its plan, so
      // its fingerprint must not let the next preparation skip the retry.
      fingerprint: unresolvedDefinitions.size > 0 ? `failed:${randomUUID()}` : installedFingerprint,
      candidates,
      ...(preserveOwned.length > 0 ? { preserveOwned } : {}),
      gitResolutions: nextGitResolutions,
      legacyOwned: legacyState.owned,
      lockHeld: true,
      warn: opts.warn
    })
    result.installed.push(...reconciled.installed)
    result.removed.push(...reconciled.removed)
    result.skipped = reconciled.skipped
    result.owned = reconciled.owned.map((bundle) => bundle.relativeRoot)
    for (const conflict of reconciled.conflicts) {
      result.errors.push({ source: conflict, error: 'destination is not owned by this daemon ledger; skill skipped' })
    }
    return result
  } catch (error) {
    if (error instanceof SkillLedgerSafetyError) throw error
    const message = error instanceof Error ? error.message : 'unknown skill installation error'
    result.errors.push({ source: '*', error: message })
    opts.warn?.(`skills: unified install failed; clearing previously managed skills (${message})`)
    try {
      const legacyState = await readLegacyOwned(cwd)
      const cleanupLocation = await skillLedgerLocation(cwd, stateDir)
      let cleanupLedger = await readSkillLedger(cleanupLocation)
      if (cleanupLedger) {
        assertSkillLedgerOwner(cleanupLedger, agent.id)
        cleanupLedger = await recoverSkillLedger(cwd, cleanupLocation, cleanupLedger)
      }
      retainedGitResolutions = currentGitResolutions(gitSources, cleanupLedger?.gitResolutions ?? [])
      assertNoUnmigratedLegacyState(legacyState)
      // An install that threw says nothing about whether the operator still wants
      // these skills — only that this run could not rebuild them — and a published
      // bundle's source key names its acquisition identity, not its repository, so
      // this pass cannot even tell a re-pinned source from a removed one. It
      // therefore keeps what is published and leaves pruning to the next run that
      // actually computes a desired set. An EMPTY desired set is the exception: that
      // is a complete statement, and disabled executable content must not stay
      // active on it (§6.3).
      const nothingDesired = gitSources.length === 0 && (opts.localSkills ?? []).length === 0
      const keep = nothingDesired ? [] : (cleanupLedger?.owned ?? []).map((bundle) => bundle.relativeRoot)
      const cleared = await reconcileSkillBundles({
        cwd,
        stateDir,
        agentId: agent.id,
        runtime: agent.runtime,
        cliVersion: PINNED_SKILLS_CLI_VERSION,
        fingerprint: `failed:${randomUUID()}`,
        candidates: [],
        ...(keep.length > 0 ? { preserveOwned: keep } : {}),
        gitResolutions: retainedGitResolutions,
        legacyOwned: legacyState.owned,
        lockHeld: true,
        warn: opts.warn
      })
      result.removed.push(...cleared.removed)
      result.owned = cleared.owned.map((bundle) => bundle.relativeRoot)
      return result
    } catch (cleanupError) {
      throw new Error(
        `skill installation failed and stale executable content could not be reconciled: ${cleanupError instanceof Error ? cleanupError.message : 'unknown error'}`,
        { cause: error }
      )
    }
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function runPinnedSkillsCli(input: SkillsCliInvocation): Promise<SkillsCliInvocationResult> {
  const result: SkillsCliCellResult = await stageSkillsCliCell({
    sourceSnapshot: input.sourceDir,
    agentId: input.agentId,
    selectedSkills: input.skills,
    tempParent: input.cellDir
  })
  return {
    bundles: result.bundles.map((bundle) => ({ relativeRoot: bundle.relativePath, sourceDir: bundle.absolutePath })),
    stdoutDigest: fingerprint(result.execution.stdout),
    stderrDigest: fingerprint(result.execution.stderr),
    ...(result.execution.isolation ? { isolation: result.execution.isolation } : {}),
    ...(result.execution.isolationReason ? { isolationReason: result.execution.isolationReason } : {}),
    cleanup: result.cleanup
  }
}

interface LegacyOwnershipState {
  markers: string[]
  owned: string[]
}

async function readLegacyOwned(cwd: string): Promise<LegacyOwnershipState> {
  const markers: string[] = []
  const owned = new Set<string>()
  for (const markerName of LEGACY_MARKERS) {
    try {
      const root = join(cwd, '.agentconnect')
      const target = await containedTarget(cwd, root, join(root, markerName), {
        create: false,
        label: 'legacy skill marker'
      })
      if (!target) continue
      let stat: Stats
      try {
        stat = await fsp.lstat(target)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      markers.push(markerName)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > LEGACY_MARKER_BYTES) {
        throw new Error('legacy marker is not a bounded regular file')
      }
      const parsed = JSON.parse((await readBoundedRegularFile(target, stat)).toString('utf8')) as {
        installed?: unknown
      }
      if (!Array.isArray(parsed.installed)) throw new Error('legacy marker does not contain an installed array')
      for (const value of parsed.installed) {
        if (typeof value !== 'string' || !LEGACY_OWNED.test(value)) {
          throw new Error('legacy marker contains an unsafe installed path')
        }
        owned.add(value)
      }
    } catch (error) {
      if (error instanceof SkillLedgerSafetyError) throw error
      throw new SkillLedgerSafetyError(
        `legacy skill ownership marker ${markerName} is unsafe and must be removed explicitly`,
        { cause: error }
      )
    }
  }
  return { markers, owned: [...owned].sort() }
}

function assertNoUnmigratedLegacyState(legacy: LegacyOwnershipState): void {
  if (legacy.markers.length === 0) return
  throw new SkillLedgerSafetyError(
    'legacy skill installation state requires explicit migration: move or remove every skill path listed by ' +
      '.agentconnect/skills-install.json or .agentconnect/dream-skills-install.json, then remove those markers; ' +
      'the unified installer will not trust them as deletion authority'
  )
}

async function readBoundedRegularFile(path: string, before: Stats): Promise<Buffer> {
  const handle = await fsp.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
  try {
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.size > LEGACY_MARKER_BYTES
    ) {
      throw new Error('legacy marker changed while opening')
    }
    const body = Buffer.alloc(opened.size)
    let offset = 0
    while (offset < body.length) {
      const { bytesRead } = await handle.read(body, offset, body.length - offset, offset)
      if (bytesRead === 0) throw new Error('legacy marker changed while reading')
      offset += bytesRead
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead !== 0) {
      throw new Error('legacy marker changed while reading')
    }
    const after = await handle.stat()
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
      throw new Error('legacy marker changed while reading')
    }
    return body
  } finally {
    await handle.close()
  }
}

async function ensurePrivateStateRoot(stateDir: string): Promise<void> {
  await fsp.mkdir(stateDir, { recursive: true, mode: 0o700 })
  const stat = await fsp.lstat(stateDir)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('skill installer state root is unsafe')
  await fsp.chmod(stateDir, 0o700)
}

async function prepareSnapshotDestination(destination: string): Promise<void> {
  const parent = dirname(destination)
  await fsp.mkdir(parent, { recursive: true, mode: 0o700 })
  await fsp.chmod(parent, 0o700)
}

/** Resolve every TRACKING ref once, keyed by acquisition identity. A pinned ref
 * is never asked about, and a resolver that answers null (offline, rate-limited)
 * contributes nothing — in both cases the retained commit keeps serving, so an
 * unavailable answer can never rebuild a workspace. */
export async function resolveTrackedCommits(
  entries: AgentSkillEntry[],
  resolve: ((entry: AgentSkillEntry) => Promise<string | null>) | undefined
): Promise<Map<string, string>> {
  const tracked = new Map<string, string>()
  if (!resolve) return tracked
  for (const entry of entries) {
    if (isPinnedGitSkillRef(entry)) continue
    const digest = gitResolutionDigest(entry)
    if (tracked.has(digest)) continue
    const commit = await resolve(entry)
    if (commit && /^[a-f0-9]{40}$/i.test(commit)) tracked.set(digest, commit.toLowerCase())
  }
  return tracked
}

/** What to install per acquisition identity: a pinned ref names its own commit, a
 * tracked one names the head just resolved, and anything else keeps the commit
 * already installed. */
export function plannedGitCommits(
  entries: AgentSkillEntry[],
  installed: SkillGitResolution[],
  tracked: Map<string, string>
): Map<string, string> {
  const planned = new Map<string, string>()
  // Stated first, so a pinned source's plan is known before it has ever been installed.
  for (const entry of entries) {
    const ref = resolveBoundedGitSkillSource(entry).ref
    if (ref && isPinnedGitSkillRef(entry)) planned.set(gitResolutionDigest(entry), ref.toLowerCase())
  }
  for (const resolution of installed) planned.set(resolution.definitionDigest, resolution.resolvedCommit)
  for (const [digest, commit] of tracked) planned.set(digest, commit)
  return planned
}

/** Retention survives only where the tracked head still agrees with it, so a
 * moved head cannot leave the previous commit's record standing behind the tree
 * this run installs. */
export function retainedAfterTracking(
  retained: SkillGitResolution[],
  tracked: Map<string, string>
): SkillGitResolution[] {
  return retained.filter((resolution) => {
    const head = tracked.get(resolution.definitionDigest)
    return head === undefined || head === resolution.resolvedCommit
  })
}

export function currentGitResolutions(
  entries: AgentSkillEntry[],
  resolutions: SkillGitResolution[]
): SkillGitResolution[] {
  const desired = new Set(entries.map(gitResolutionDigest))
  return resolutions
    .filter((resolution) => desired.has(resolution.definitionDigest))
    .sort((a, b) => a.definitionDigest.localeCompare(b.definitionDigest))
}

/** The acquisition identity inside a published git bundle's source key
 * (`git:<index>:<definitionDigest>:<commit>[:selections]`), or undefined for a
 * bundle that did not come from a git source. */
export function gitSourceKeyDefinition(sourceKey: string): string | undefined {
  const parts = sourceKey.split(':')
  return parts[0] === 'git' && parts.length >= 4 ? parts[2] : undefined
}

export function gitResolutionDigest(entry: AgentSkillEntry): string {
  const source = resolveBoundedGitSkillSource(entry)
  return fingerprint({ githubRepoId: entry.githubRepoId, cloneUrl: source.cloneUrl, ref: source.ref ?? 'HEAD' })
}

function fingerprint(value: unknown): string {
  return createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex')
}

function stripShaPrefix(value: string): string {
  return value.startsWith('sha256:') ? value.slice('sha256:'.length) : value
}
