import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants, promises as fsp, type BigIntStats } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { under } from '../fs/contained-path.js'
import { inspectLocalSkillSource } from './skill-source-snapshot.js'
import { canonicalSkillMutationRoot, runSkillWorkspaceMutation } from './skill-workspace-mutator.js'
import { withSkillMutationHelperLease, type SkillMutationHelperLease } from './skill-workspace-lock-lease.js'

// An applying/cleanup journal can contain two complete receipt sets: up to 64
// bundles × 64 files × a 1 KiB path in each set, plus 4 KiB source keys and JSON
// escaping. Control characters and backslashes are rejected below, bounding
// remaining string escaping to at most 2×. The legal worst case is below 24 MiB;
// 32 MiB leaves structural headroom while keeping hostile state reads capped.
export const MAX_SKILL_LEDGER_BYTES = 32 * 1024 * 1024
const MAX_RECEIPT_FILES = 64
const MAX_RECEIPT_BYTES = 4 * 1024 * 1024
const MAX_RECEIPT_FILE_BYTES = 512 * 1024
const MAX_LAYOUT_SEGMENTS = 8
const SAFE_LAYOUT_SEGMENT = /^\.?[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/
const SAFE_BUNDLE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?$/
const RESERVED_FIRST = new Set(['.git', '.agentconnect'])
const SAFE_OPERATION = /^[a-f0-9-]{36}$/
const SAFE_QUARANTINE = /^\.agentconnect-skill-(?:new|old|trash)-[a-f0-9-]{36}$/
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/
const EXTERNAL_LOCK_WAIT_MS = 60_000
const EXTERNAL_LOCK_BUSY_MS = 1_000

export interface PathIdentity {
  dev: string
  ino: string
}

export interface SkillFileReceipt {
  path: string
  mode: number
  size: number
  sha256: string
}

interface SkillBundleReceipt {
  relativeRoot: string
  sourceKey: string
  treeDigest: string
  files: SkillFileReceipt[]
}

export interface OwnedSkillBundle extends SkillBundleReceipt {
  identity: PathIdentity
}

export interface CandidateSkillBundle extends SkillBundleReceipt {
  sourceDir: string
}

export interface SkillGitResolution {
  /** SHA-256 of normalized repository + effective ref acquisition identity. */
  definitionDigest: string
  /** Exact commit selected when that definition was first acquired. */
  resolvedCommit: string
}

interface JournalOperation {
  relativeRoot: string
  operationId: string
  reservationName: string
  quarantineName: string
  tombstoneName: string
  reservationIdentity?: PathIdentity
  markerIdentity?: PathIdentity
}

interface ReadyCleanup {
  operations: JournalOperation[]
  prior: OwnedSkillBundle[]
}

interface LedgerBase {
  version: 3
  workspaceRealpath: string
  workspaceIdentity: PathIdentity
  agentId: string
  runtime: string
  cliVersion: string
}

interface ReadyLedger extends LedgerBase {
  phase: 'ready'
  fingerprint?: string
  owned: OwnedSkillBundle[]
  gitResolutions: SkillGitResolution[]
  cleanup?: ReadyCleanup
}

interface ApplyingLedger extends LedgerBase {
  phase: 'applying'
  priorFingerprint?: string
  priorGitResolutions: SkillGitResolution[]
  prior: OwnedSkillBundle[]
  pending: SkillBundleReceipt[]
  operations: JournalOperation[]
}

export type SkillInstallLedger = ReadyLedger | ApplyingLedger

export interface SkillLedgerLocation {
  workspaceRealpath: string
  workspaceIdentity: PathIdentity
  file: string
}

export interface ReconcileSkillBundlesOptions {
  cwd: string
  stateDir: string
  agentId: string
  runtime: string
  cliVersion: string
  fingerprint: string
  candidates: CandidateSkillBundle[]
  gitResolutions?: SkillGitResolution[]
  /** Untrusted compatibility hints from old workspace-local markers. They may
   * improve a conflict error, but never confer deletion or replacement rights. */
  legacyOwned?: string[]
  /** The caller already holds `withSkillWorkspaceLock` across acquisition. */
  lockHeld?: boolean
  /** Reports a bundle skipped because its destination is not this ledger's to write. */
  warn?: (message: string) => void
}

export interface ReconcileSkillBundlesResult {
  installed: string[]
  removed: string[]
  skipped: 'unchanged' | null
  /** Destinations left untouched because they are not owned by this ledger. */
  conflicts: string[]
}

export class SkillLedgerSafetyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SkillLedgerSafetyError'
  }
}

const cwdLocks = new Map<string, Promise<unknown>>()

export async function withSkillWorkspaceLock<T>(cwd: string, fn: () => Promise<T>, stateDir?: string): Promise<T> {
  // Serialize reincarnations at the same lexical path too. The incarnation is
  // checked after the lock is acquired and is part of the durable ledger key.
  const key = await fsp.realpath(cwd).catch(() => resolve(cwd))
  const prior = cwdLocks.get(key) ?? Promise.resolve()
  const run = async (): Promise<T> => {
    const external = stateDir ? await acquireExternalWorkspaceLock(key, stateDir) : undefined
    try {
      return await (external ? withSkillMutationHelperLease(external, fn) : fn())
    } finally {
      await external?.release()
    }
  }
  const result = prior.then(run, run)
  const tail = result.then(
    () => undefined,
    () => undefined
  )
  cwdLocks.set(key, tail)
  try {
    return await result
  } finally {
    if (cwdLocks.get(key) === tail) cwdLocks.delete(key)
  }
}

export async function skillLedgerLocation(cwd: string, stateDir: string): Promise<SkillLedgerLocation> {
  const lexical = resolve(cwd)
  const stat = await fsp.lstat(lexical, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw safety('skill workspace root is unsafe')
  const workspaceRealpath = await fsp.realpath(lexical)
  const workspaceIdentity = identity(stat)
  await assertWorkspaceIdentity(lexical, workspaceRealpath, workspaceIdentity)
  const key = createHash('sha256')
    .update(workspaceRealpath)
    .update('\0')
    .update(workspaceIdentity.dev)
    .update('\0')
    .update(workspaceIdentity.ino)
    .digest('hex')
  const dir = join(stateDir, 'workspace-skills')
  await ensureTrustedStateDir(stateDir, dir)
  return { workspaceRealpath, workspaceIdentity, file: join(dir, `${key}.json`) }
}

export async function readSkillLedger(location: SkillLedgerLocation): Promise<SkillInstallLedger | null> {
  try {
    const stat = await fsp.lstat(location.file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_SKILL_LEDGER_BYTES) {
      throw safety('skill ownership ledger is not a bounded regular file')
    }
    const value = JSON.parse(await fsp.readFile(location.file, 'utf8')) as unknown
    return parseLedger(value, location)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    if (error instanceof SkillLedgerSafetyError) throw error
    throw safety('skill ownership ledger is unreadable', error)
  }
}

export function assertSkillLedgerOwner(ledger: SkillInstallLedger, agentId: string): void {
  if (ledger.agentId !== agentId) {
    throw safety(`workspace skill ownership belongs to another agent (${ledger.agentId})`)
  }
}

/** Verify daemon-owned live bundles byte-for-byte with the same bounded,
 * descriptor/no-follow walker used for immutable source snapshots. */
export async function installedBundlesIntact(
  cwd: string,
  bundles: OwnedSkillBundle[],
  expectedWorkspace?: PathIdentity
): Promise<boolean> {
  try {
    if (expectedWorkspace) await assertCurrentWorkspace(cwd, expectedWorkspace)
    for (const bundle of bundles) {
      const found = await bundleIdentity(join(cwd, ...bundle.relativeRoot.split('/')), bundle)
      if (!found || !sameIdentity(found, bundle.identity)) return false
    }
    if (expectedWorkspace) await assertCurrentWorkspace(cwd, expectedWorkspace)
    return true
  } catch {
    return false
  }
}

/** Recover an interrupted mutation to the last durable coherent set. */
export async function recoverSkillLedger(
  cwd: string,
  location: SkillLedgerLocation,
  ledger: SkillInstallLedger
): Promise<ReadyLedger> {
  try {
    await assertCurrentWorkspace(cwd, location.workspaceIdentity)
    if (ledger.phase === 'ready') {
      if (!ledger.cleanup) return ledger
      await finishReadyCleanup(cwd, location, ledger, ledger.cleanup)
      const cleaned: ReadyLedger = { ...ledger }
      delete cleaned.cleanup
      await writeSkillLedger(location.file, cleaned)
      return cleaned
    }

    const priorByPath = new Map(ledger.prior.map((entry) => [entry.relativeRoot, entry]))
    for (const operation of [...ledger.operations].reverse()) {
      const prior = priorByPath.get(operation.relativeRoot)
      await mutate(
        {
          action: 'discard',
          cwd,
          workspaceIdentity: location.workspaceIdentity,
          relativeRoot: operation.relativeRoot,
          tombstoneName: operation.tombstoneName,
          operationId: operation.operationId,
          reservationName: operation.reservationName,
          ...(operation.reservationIdentity && operation.markerIdentity
            ? {
                reservation: {
                  identity: operation.reservationIdentity,
                  markerIdentity: operation.markerIdentity
                }
              }
            : {}),
          ...(prior ? { prior } : {})
        },
        []
      )
      if (prior) {
        await mutate(
          {
            action: 'restore',
            cwd,
            workspaceIdentity: location.workspaceIdentity,
            relativeRoot: operation.relativeRoot,
            operationId: operation.operationId,
            quarantineName: operation.quarantineName,
            prior
          },
          []
        )
      }
    }
    const ready: ReadyLedger = {
      version: 3,
      phase: 'ready',
      workspaceRealpath: location.workspaceRealpath,
      workspaceIdentity: location.workspaceIdentity,
      agentId: ledger.agentId,
      runtime: ledger.runtime,
      cliVersion: ledger.cliVersion,
      ...(ledger.priorFingerprint ? { fingerprint: ledger.priorFingerprint } : {}),
      owned: ledger.prior,
      gitResolutions: ledger.priorGitResolutions
    }
    if (!(await installedBundlesIntact(cwd, ready.owned, location.workspaceIdentity))) {
      throw safety('interrupted skill publication could not restore the prior receipt set')
    }
    await writeSkillLedger(location.file, ready)
    return ready
  } catch (error) {
    if (error instanceof SkillLedgerSafetyError) throw error
    throw safety('skill ownership recovery failed', error)
  }
}

// Two harnesses name one root differently (.agents/skills vs .claude/skills, commonly symlinked), so key ownership by the real directory.
async function canonicalizeRelativeRoot(cwd: string, relativeRoot: string): Promise<string> {
  try {
    const canonical = await canonicalSkillMutationRoot(cwd, relativeRoot)
    if (canonical === relativeRoot) return relativeRoot
    validateRelativeRoot(canonical)
    return canonical
  } catch {
    // An alias that escapes the workspace is still refused where it is written, so keeping the original defers to that check.
    return relativeRoot
  }
}

async function canonicalizeCandidates(
  cwd: string,
  candidates: CandidateSkillBundle[]
): Promise<CandidateSkillBundle[]> {
  const resolved: CandidateSkillBundle[] = []
  for (const candidate of candidates) {
    resolved.push({ ...candidate, relativeRoot: await canonicalizeRelativeRoot(cwd, candidate.relativeRoot) })
  }
  return resolved
}

async function canonicalizeOwned(cwd: string, owned: OwnedSkillBundle[]): Promise<OwnedSkillBundle[]> {
  const resolved: OwnedSkillBundle[] = []
  for (const entry of owned) {
    resolved.push({ ...entry, relativeRoot: await canonicalizeRelativeRoot(cwd, entry.relativeRoot) })
  }
  return resolved
}

async function destinationOccupied(cwd: string, relativeRoot: string): Promise<boolean> {
  try {
    await fsp.lstat(join(cwd, ...relativeRoot.split('/')))
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export async function reconcileSkillBundles(
  options: ReconcileSkillBundlesOptions
): Promise<ReconcileSkillBundlesResult> {
  const run = (): Promise<ReconcileSkillBundlesResult> => reconcileSkillBundlesLocked(options)
  return options.lockHeld ? run() : withSkillWorkspaceLock(options.cwd, run, options.stateDir)
}

async function reconcileSkillBundlesLocked(
  options: ReconcileSkillBundlesOptions
): Promise<ReconcileSkillBundlesResult> {
  let recoveryLedger: SkillInstallLedger | undefined
  let location: SkillLedgerLocation | undefined
  try {
    location = await skillLedgerLocation(options.cwd, options.stateDir)
    let ledger = await readSkillLedger(location)
    if (ledger) {
      assertSkillLedgerOwner(ledger, options.agentId)
      ledger = await recoverSkillLedger(options.cwd, location, ledger)
    }
    if (
      ledger?.phase === 'ready' &&
      ledger.fingerprint === options.fingerprint &&
      (await installedBundlesIntact(options.cwd, ledger.owned, location.workspaceIdentity))
    ) {
      return { installed: [], removed: [], skipped: 'unchanged', conflicts: [] }
    }

    const deduped = dedupeCandidates(await canonicalizeCandidates(options.cwd, options.candidates))
    const gitResolutions = validateGitResolutions(options.gitResolutions ?? [])
    for (const candidate of deduped) {
      validateCandidate(candidate)
      if (!(await bundleIdentity(candidate.sourceDir, candidate))) {
        throw safety(`candidate skill receipt does not match ${candidate.relativeRoot}`)
      }
    }

    // Canonicalize the recorded set too: a ledger written under another harness names the same directory by its other root.
    const prior = await canonicalizeOwned(options.cwd, ledger?.owned ?? [])
    const priorByPath = new Map(prior.map((entry) => [entry.relativeRoot, entry]))
    const legacyHints = new Set<string>()
    for (const hint of options.legacyOwned ?? []) {
      legacyHints.add(await canonicalizeRelativeRoot(options.cwd, hint))
    }
    const conflicts: string[] = []
    const candidates: CandidateSkillBundle[] = []
    for (const candidate of deduped) {
      if (
        priorByPath.has(candidate.relativeRoot) ||
        !(await destinationOccupied(options.cwd, candidate.relativeRoot))
      ) {
        candidates.push(candidate)
        continue
      }
      const detail = legacyHints.has(candidate.relativeRoot)
        ? 'legacy workspace marker is not trusted; remove or migrate it explicitly'
        : 'the path is not owned by this daemon ledger'
      // Skipping leaves the path untouched, which is what refusing wanted; one foreign bundle must not stop every other skill.
      conflicts.push(candidate.relativeRoot)
      options.warn?.(`skills: skipped unowned skill ${candidate.relativeRoot}: ${detail}`)
    }

    const paths = [
      ...new Set([...prior.map((entry) => entry.relativeRoot), ...candidates.map((entry) => entry.relativeRoot)])
    ].sort()
    const operations: JournalOperation[] = paths.map((relativeRoot) => ({
      relativeRoot,
      operationId: randomUUID(),
      reservationName: `.agentconnect-skill-new-${randomUUID()}`,
      quarantineName: `.agentconnect-skill-old-${randomUUID()}`,
      tombstoneName: `.agentconnect-skill-trash-${randomUUID()}`
    }))
    const nextApplying: ApplyingLedger = {
      version: 3,
      phase: 'applying',
      workspaceRealpath: location.workspaceRealpath,
      workspaceIdentity: location.workspaceIdentity,
      agentId: options.agentId,
      runtime: options.runtime,
      cliVersion: options.cliVersion,
      ...(ledger?.fingerprint ? { priorFingerprint: ledger.fingerprint } : {}),
      priorGitResolutions: ledger?.gitResolutions ?? [],
      prior,
      pending: candidates.map(stripCandidate),
      operations
    }
    await writeSkillLedger(location.file, nextApplying)
    // Recovery authority begins only after the journal is durable. If writing
    // the applying ledger failed, no live mutation has occurred and pretending
    // otherwise could operate from state that never became authoritative.
    recoveryLedger = nextApplying

    const candidatesByPath = new Map(candidates.map((entry) => [entry.relativeRoot, entry]))
    const owned: OwnedSkillBundle[] = []
    for (const operation of operations) {
      const priorEntry = priorByPath.get(operation.relativeRoot)
      const candidate = candidatesByPath.get(operation.relativeRoot)
      if (candidate) {
        const reserved = await mutate(
          {
            action: 'reserve',
            cwd: options.cwd,
            workspaceIdentity: location.workspaceIdentity,
            relativeRoot: operation.relativeRoot,
            operationId: operation.operationId,
            reservationName: operation.reservationName,
            quarantineName: operation.quarantineName,
            ...(priorEntry ? { prior: priorEntry } : {})
          },
          []
        )
        const reservationIdentity = parseIdentity(reserved.identity)
        const markerIdentity = parseIdentity(reserved.markerIdentity)
        if (!reservationIdentity || !markerIdentity) {
          throw safety(`skill publisher omitted reservation authority for ${candidate.relativeRoot}`)
        }
        operation.reservationIdentity = reservationIdentity
        operation.markerIdentity = markerIdentity
        // This fsynced journal update is the deletion-authority boundary. The
        // populate helper is not invoked until both inodes are durable, so a
        // crash without them can leave only an empty/marker-only reservation.
        await writeSkillLedger(location.file, nextApplying)
        recoveryLedger = nextApplying
      }
      const result = await mutate(
        {
          action: 'apply',
          cwd: options.cwd,
          workspaceIdentity: location.workspaceIdentity,
          relativeRoot: operation.relativeRoot,
          operationId: operation.operationId,
          reservationName: operation.reservationName,
          quarantineName: operation.quarantineName,
          ...(operation.reservationIdentity && operation.markerIdentity
            ? {
                reservation: {
                  identity: operation.reservationIdentity,
                  markerIdentity: operation.markerIdentity
                }
              }
            : {}),
          ...(!candidate && priorEntry ? { prior: priorEntry } : {}),
          ...(candidate ? { candidate: { ...stripCandidate(candidate), sourceDir: candidate.sourceDir } } : {})
        },
        candidate ? [candidate.sourceDir] : []
      )
      if (candidate) {
        const targetIdentity = parseIdentity(result.targetIdentity)
        if (!targetIdentity) throw safety(`skill publisher omitted the target identity for ${candidate.relativeRoot}`)
        if (!sameIdentity(targetIdentity, operation.reservationIdentity!)) {
          throw safety(`skill publisher changed the reservation identity for ${candidate.relativeRoot}`)
        }
        owned.push({ ...stripCandidate(candidate), identity: targetIdentity })
      }
    }

    const readyWithCleanup: ReadyLedger = {
      version: 3,
      phase: 'ready',
      workspaceRealpath: location.workspaceRealpath,
      workspaceIdentity: location.workspaceIdentity,
      agentId: options.agentId,
      runtime: options.runtime,
      cliVersion: options.cliVersion,
      // A skipped conflict leaves the plan unmet, so keep the fingerprint non-matching and let the next preparation retry once the path is clear.
      fingerprint: conflicts.length > 0 ? `conflicts:${randomUUID()}` : options.fingerprint,
      owned,
      gitResolutions,
      cleanup: { operations, prior }
    }
    await writeSkillLedger(location.file, readyWithCleanup)
    recoveryLedger = readyWithCleanup
    await finishReadyCleanup(options.cwd, location, readyWithCleanup, readyWithCleanup.cleanup!)
    const ready: ReadyLedger = { ...readyWithCleanup }
    delete ready.cleanup
    await writeSkillLedger(location.file, ready)
    if (!(await installedBundlesIntact(options.cwd, owned, location.workspaceIdentity))) {
      throw safety('published skill set failed final receipt verification')
    }
    return {
      installed: candidates.map((entry) => entry.relativeRoot),
      removed: prior.map((entry) => entry.relativeRoot),
      skipped: null,
      conflicts
    }
  } catch (error) {
    if (recoveryLedger && location) {
      try {
        await recoverSkillLedger(options.cwd, location, recoveryLedger)
      } catch (recoveryError) {
        throw safety('skill installation failed and the prior executable set could not be restored', recoveryError)
      }
    }
    if (error instanceof SkillLedgerSafetyError) throw error
    throw safety('skill ownership reconciliation failed', error)
  }
}

async function finishReadyCleanup(
  cwd: string,
  location: SkillLedgerLocation,
  ledger: ReadyLedger,
  cleanup: ReadyCleanup
): Promise<void> {
  const ownedByPath = new Map(ledger.owned.map((entry) => [entry.relativeRoot, entry]))
  const priorByPath = new Map(cleanup.prior.map((entry) => [entry.relativeRoot, entry]))
  for (const operation of cleanup.operations) {
    const owned = ownedByPath.get(operation.relativeRoot)
    if (owned) {
      if (!operation.markerIdentity) throw safety('ready cleanup is missing reservation marker authority')
      await mutate(
        {
          action: 'finalize',
          cwd,
          workspaceIdentity: location.workspaceIdentity,
          relativeRoot: operation.relativeRoot,
          operationId: operation.operationId,
          markerIdentity: operation.markerIdentity,
          expected: owned
        },
        []
      )
    }
    const prior = priorByPath.get(operation.relativeRoot)
    if (prior) {
      await mutate(
        {
          action: 'cleanup',
          cwd,
          workspaceIdentity: location.workspaceIdentity,
          relativeRoot: operation.relativeRoot,
          name: operation.quarantineName,
          tombstoneName: operation.tombstoneName,
          expected: prior
        },
        []
      )
    }
  }
  await assertCurrentWorkspace(cwd, location.workspaceIdentity)
}

async function mutate(
  spec: { cwd: string } & Record<string, unknown>,
  readRoots: string[]
): Promise<Record<string, unknown>> {
  try {
    return await runSkillWorkspaceMutation(spec, readRoots)
  } catch (error) {
    throw safety('confined skill workspace mutation was refused', error)
  }
}

async function bundleIdentity(root: string, bundle: SkillBundleReceipt): Promise<PathIdentity | null> {
  try {
    validateReceipt(bundle)
    const before = await fsp.lstat(root, { bigint: true })
    if (!before.isDirectory() || before.isSymbolicLink()) return null
    const inspected = await inspectLocalSkillSource(root)
    const files: SkillFileReceipt[] = inspected.files.map((file) => ({
      path: file.path,
      mode: file.mode & 0o111 ? 0o700 : 0o600,
      size: file.size,
      sha256: file.sha256.replace(/^sha256:/, '')
    }))
    const after = await fsp.lstat(root, { bigint: true })
    if (!after.isDirectory() || !sameIdentity(identity(before), identity(after))) return null
    return JSON.stringify(files) === JSON.stringify(bundle.files) && treeDigest(files) === bundle.treeDigest
      ? identity(after)
      : null
  } catch {
    return null
  }
}

export function treeDigest(files: SkillFileReceipt[]): string {
  return createHash('sha256').update(JSON.stringify(files)).digest('hex')
}

function validateRelativeRoot(value: string): void {
  if (isAbsolute(value) || value.includes('\0') || value.includes('\\') || Buffer.byteLength(value, 'utf8') > 1_024) {
    throw safety(`unsafe skill receipt path: ${value}`)
  }
  const parts = value.split('/')
  if (
    parts.length < 2 ||
    parts.length > MAX_LAYOUT_SEGMENTS ||
    parts.at(-2) !== 'skills' ||
    !SAFE_BUNDLE.test(parts.at(-1)!) ||
    parts.slice(0, -1).some((part) => !SAFE_LAYOUT_SEGMENT.test(part)) ||
    RESERVED_FIRST.has(parts[0]!.toLowerCase())
  ) {
    throw safety(`unsafe skill receipt path: ${value}`)
  }
}

function validateReceipt(bundle: SkillBundleReceipt): void {
  validateRelativeRoot(bundle.relativeRoot)
  if (
    typeof bundle.sourceKey !== 'string' ||
    bundle.sourceKey.length === 0 ||
    Buffer.byteLength(bundle.sourceKey, 'utf8') > 4_096 ||
    CONTROL_RE.test(bundle.sourceKey) ||
    !/^[a-f0-9]{64}$/.test(bundle.treeDigest) ||
    !Array.isArray(bundle.files) ||
    bundle.files.length === 0 ||
    bundle.files.length > MAX_RECEIPT_FILES
  ) {
    throw safety('invalid skill bundle receipt')
  }
  const seen = new Set<string>()
  let bytes = 0
  let priorPath = ''
  for (const file of bundle.files) {
    const parts = file.path.split('/')
    if (
      !file.path ||
      isAbsolute(file.path) ||
      file.path.includes('\\') ||
      file.path.includes('\0') ||
      CONTROL_RE.test(file.path) ||
      parts.some((part) => !part || part === '.' || part === '..') ||
      parts.length > 32 ||
      Buffer.byteLength(file.path, 'utf8') > 1_024 ||
      (file.mode !== 0o600 && file.mode !== 0o700) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > MAX_RECEIPT_FILE_BYTES ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      seen.has(file.path) ||
      (priorPath && priorPath >= file.path)
    ) {
      throw safety('invalid skill file receipt')
    }
    bytes += file.size
    if (bytes > MAX_RECEIPT_BYTES) throw safety('skill bundle receipt exceeds its byte limit')
    seen.add(file.path)
    priorPath = file.path
  }
  if (!seen.has('SKILL.md') || treeDigest(bundle.files) !== bundle.treeDigest) {
    throw safety('invalid skill tree receipt')
  }
}

function validateOwned(bundle: OwnedSkillBundle): void {
  validateReceipt(bundle)
  validateIdentity(bundle.identity)
}

function validateCandidate(bundle: CandidateSkillBundle): void {
  validateReceipt(bundle)
  if (typeof bundle.sourceDir !== 'string' || !isAbsolute(bundle.sourceDir))
    throw safety('invalid candidate source path')
}

function stripCandidate(candidate: CandidateSkillBundle): SkillBundleReceipt {
  return {
    relativeRoot: candidate.relativeRoot,
    sourceKey: candidate.sourceKey,
    treeDigest: candidate.treeDigest,
    files: candidate.files
  }
}

function dedupeCandidates(candidates: CandidateSkillBundle[]): CandidateSkillBundle[] {
  const byExact = new Map<string, CandidateSkillBundle>()
  const byFold = new Map<string, string>()
  for (const candidate of candidates) {
    validateCandidate(candidate)
    const folded = candidate.relativeRoot.toLowerCase()
    const prior = byFold.get(folded)
    if (prior && prior !== candidate.relativeRoot) {
      throw safety(`case-folded skill destination collision: ${prior} and ${candidate.relativeRoot}`)
    }
    byFold.set(folded, candidate.relativeRoot)
    byExact.set(candidate.relativeRoot, candidate)
  }
  return [...byExact.values()].sort((a, b) => a.relativeRoot.localeCompare(b.relativeRoot))
}

interface LockOwner {
  pid: number
  token: string
  helperPgid?: number
}

interface ExternalWorkspaceLock extends SkillMutationHelperLease {
  release(): Promise<void>
}

async function acquireExternalWorkspaceLock(workspaceKey: string, stateDir: string): Promise<ExternalWorkspaceLock> {
  const lockRoot = join(stateDir, 'workspace-skill-locks')
  await ensureTrustedStateDir(stateDir, lockRoot)
  const key = createHash('sha256').update(workspaceKey).digest('hex')
  const databaseFile = join(lockRoot, 'leases.sqlite3')
  await ensureLockDatabaseFile(databaseFile, lockRoot)
  const token = randomUUID()
  const deadline = Date.now() + EXTERNAL_LOCK_WAIT_MS
  const database = openLockDatabase(databaseFile)

  try {
    for (;;) {
      let acquired = false
      try {
        acquired = withImmediateTransaction(database, () => {
          const existing = readDatabaseLockOwner(database, key)
          if (
            existing &&
            (processAlive(existing.pid) || (existing.helperPgid && processGroupAlive(existing.helperPgid)))
          ) {
            return false
          }

          if (existing) {
            const changed = database
              .prepare(
                `UPDATE workspace_skill_leases
                    SET owner_pid = ?, owner_token = ?, helper_pgid = NULL, updated_at = ?
                  WHERE workspace_key = ? AND owner_pid = ? AND owner_token = ?`
              )
              .run(process.pid, token, Date.now(), key, existing.pid, existing.token).changes
            if (changed !== 1) throw safety('workspace skill lock ownership changed during reclaim')
          } else {
            database
              .prepare(
                `INSERT INTO workspace_skill_leases
                   (workspace_key, owner_pid, owner_token, helper_pgid, updated_at)
                 VALUES (?, ?, ?, NULL, ?)`
              )
              .run(key, process.pid, token, Date.now())
          }
          return true
        })
      } catch (error) {
        if (!isSqliteBusy(error)) throw error
      }
      if (acquired) break
      if (Date.now() >= deadline) throw safety('timed out waiting for the workspace skill lock')
      await new Promise((resolveWait) => setTimeout(resolveWait, 50))
    }
  } catch (error) {
    database.close()
    if (error instanceof SkillLedgerSafetyError) throw error
    throw safety('workspace skill lock failed', error)
  }

  return {
    async registerHelper(pgid) {
      if (!Number.isSafeInteger(pgid) || pgid <= 0 || !processGroupAlive(pgid)) {
        throw safety('skill mutation helper process group is unavailable')
      }
      await withImmediateTransactionRetry(database, () => {
        if (!processGroupAlive(pgid)) throw safety('skill mutation helper process group is unavailable')
        const owner = readDatabaseLockOwner(database, key)
        if (!owner || owner.pid !== process.pid || owner.token !== token || owner.helperPgid !== undefined) {
          throw safety('workspace skill lock ownership changed')
        }
        const changed = database
          .prepare(
            `UPDATE workspace_skill_leases
                SET helper_pgid = ?, updated_at = ?
              WHERE workspace_key = ? AND owner_pid = ? AND owner_token = ? AND helper_pgid IS NULL`
          )
          .run(pgid, Date.now(), key, process.pid, token).changes
        if (changed !== 1) throw safety('workspace skill lock ownership changed')
      })
    },
    async clearHelper(pgid) {
      if (!Number.isSafeInteger(pgid) || pgid <= 0) throw safety('invalid skill mutation helper process group')
      if (processGroupAlive(pgid)) throw safety('skill mutation helper process group is still alive')
      await withImmediateTransactionRetry(database, () => {
        if (processGroupAlive(pgid)) throw safety('skill mutation helper process group is still alive')
        const owner = readDatabaseLockOwner(database, key)
        if (!owner || owner.pid !== process.pid || owner.token !== token || owner.helperPgid !== pgid) {
          throw safety('workspace skill lock ownership changed')
        }
        const changed = database
          .prepare(
            `UPDATE workspace_skill_leases
                SET helper_pgid = NULL, updated_at = ?
              WHERE workspace_key = ? AND owner_pid = ? AND owner_token = ? AND helper_pgid = ?`
          )
          .run(Date.now(), key, process.pid, token, pgid).changes
        if (changed !== 1) throw safety('workspace skill lock ownership changed')
      })
    },
    async release() {
      try {
        await withImmediateTransactionRetry(database, () => {
          const changed = database
            .prepare(
              `DELETE FROM workspace_skill_leases
                WHERE workspace_key = ? AND owner_pid = ? AND owner_token = ? AND helper_pgid IS NULL`
            )
            .run(key, process.pid, token).changes
          if (changed !== 1) throw safety('workspace skill lock ownership changed')
        })
      } finally {
        database.close()
      }
    }
  }
}

function openLockDatabase(path: string): DatabaseSync {
  try {
    const database = new DatabaseSync(path, {
      timeout: EXTERNAL_LOCK_BUSY_MS,
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false
    })
    database.enableDefensive(true)
    database.exec(`
      PRAGMA synchronous = FULL;
      PRAGMA trusted_schema = OFF;
      CREATE TABLE IF NOT EXISTS workspace_skill_leases (
        workspace_key TEXT PRIMARY KEY NOT NULL,
        owner_pid INTEGER NOT NULL,
        owner_token TEXT NOT NULL,
        helper_pgid INTEGER,
        updated_at INTEGER NOT NULL
      ) WITHOUT ROWID;
    `)
    return database
  } catch (error) {
    throw safety('workspace skill lock database is unavailable', error)
  }
}

async function ensureLockDatabaseFile(path: string, parent: string): Promise<void> {
  try {
    const handle = await fsp.open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR, 0o600)
    try {
      await handle.chmod(0o600)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await syncDirectory(parent)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw safety('workspace skill lock database could not be created', error)
    }
  }

  const stat = await fsp.lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw safety('workspace skill lock database path is unsafe')
  }
  if (typeof process.geteuid === 'function' && stat.uid !== process.geteuid()) {
    throw safety('workspace skill lock database has another owner')
  }
  await fsp.chmod(path, 0o600)
}

function readDatabaseLockOwner(database: DatabaseSync, key: string): LockOwner | null {
  const value = database
    .prepare(
      `SELECT owner_pid AS pid, owner_token AS token, helper_pgid AS helperPgid
         FROM workspace_skill_leases
        WHERE workspace_key = ?`
    )
    .get(key) as { pid?: unknown; token?: unknown; helperPgid?: unknown } | undefined
  if (!value) return null
  if (
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) <= 0 ||
    typeof value.token !== 'string' ||
    value.token.length > 128 ||
    (value.helperPgid !== null && (!Number.isSafeInteger(value.helperPgid) || (value.helperPgid as number) <= 0))
  ) {
    throw safety('workspace skill lock database contains an invalid lease')
  }
  return {
    pid: value.pid as number,
    token: value.token,
    ...(value.helperPgid === null ? {} : { helperPgid: value.helperPgid as number })
  }
}

function withImmediateTransaction<T>(database: DatabaseSync, fn: () => T): T {
  database.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    database.exec('COMMIT')
    return result
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch {
      // Preserve the original error. SQLite rolls back open transactions when
      // the connection closes, and the caller fails closed on this lease.
    }
    throw error
  }
}

async function withImmediateTransactionRetry<T>(database: DatabaseSync, fn: () => T): Promise<T> {
  const deadline = Date.now() + EXTERNAL_LOCK_WAIT_MS
  for (;;) {
    try {
      return withImmediateTransaction(database, fn)
    } catch (error) {
      if (!isSqliteBusy(error)) throw error
      if (Date.now() >= deadline) throw safety('timed out updating the workspace skill lock', error)
      await new Promise((resolveWait) => setTimeout(resolveWait, 50))
    }
  }
}

function isSqliteBusy(error: unknown): boolean {
  const code = (error as { code?: unknown }).code
  return code === 'ERR_SQLITE_ERROR' && /database is locked|database is busy/i.test(String((error as Error).message))
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function processGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await fsp.open(path, fsConstants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function ensureTrustedStateDir(stateDir: string, child: string): Promise<void> {
  await fsp.mkdir(stateDir, { recursive: true, mode: 0o700 })
  const state = await fsp.lstat(stateDir)
  if (!state.isDirectory() || state.isSymbolicLink()) throw safety('skill state directory is unsafe')
  if (typeof process.geteuid === 'function' && state.uid !== process.geteuid()) {
    throw safety('skill state directory has another owner')
  }
  await fsp.chmod(stateDir, 0o700)
  await fsp.mkdir(child, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error
  })
  const childStat = await fsp.lstat(child)
  if (!childStat.isDirectory() || childStat.isSymbolicLink()) throw safety('skill ledger directory is unsafe')
  const stateReal = await fsp.realpath(stateDir)
  const childReal = await fsp.realpath(child)
  if (!under(stateReal, childReal)) throw safety('skill ledger directory escapes its state root')
  await fsp.chmod(childReal, 0o700)
}

async function writeSkillLedger(file: string, ledger: SkillInstallLedger): Promise<void> {
  const body = `${JSON.stringify(ledger)}\n`
  if (Buffer.byteLength(body) > MAX_SKILL_LEDGER_BYTES) throw safety('skill ownership ledger exceeds its size limit')
  const temp = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`)
  const handle = await fsp.open(temp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600)
  try {
    await handle.writeFile(body)
    await handle.chmod(0o600)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await fsp.rename(temp, file)
    const directory = await fsp.open(dirname(file), fsConstants.O_RDONLY)
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

function parseLedger(value: unknown, location: SkillLedgerLocation): SkillInstallLedger {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw safety('skill ownership ledger is invalid')
  const row = value as Record<string, unknown>
  if (
    row.version !== 3 ||
    row.workspaceRealpath !== location.workspaceRealpath ||
    !sameIdentity(parseRequiredIdentity(row.workspaceIdentity), location.workspaceIdentity) ||
    (row.phase !== 'ready' && row.phase !== 'applying') ||
    typeof row.agentId !== 'string' ||
    row.agentId.length === 0 ||
    typeof row.runtime !== 'string' ||
    typeof row.cliVersion !== 'string'
  ) {
    throw safety('skill ownership ledger is invalid')
  }
  const base: LedgerBase = {
    version: 3,
    workspaceRealpath: location.workspaceRealpath,
    workspaceIdentity: location.workspaceIdentity,
    agentId: row.agentId,
    runtime: row.runtime,
    cliVersion: row.cliVersion
  }
  if (row.phase === 'ready') {
    return {
      ...base,
      phase: 'ready',
      ...(typeof row.fingerprint === 'string' ? { fingerprint: row.fingerprint } : {}),
      owned: parseOwnedList(row.owned),
      gitResolutions: validateGitResolutions(row.gitResolutions ?? []),
      ...(row.cleanup === undefined ? {} : { cleanup: parseCleanup(row.cleanup) })
    }
  }
  return {
    ...base,
    phase: 'applying',
    ...(typeof row.priorFingerprint === 'string' ? { priorFingerprint: row.priorFingerprint } : {}),
    priorGitResolutions: validateGitResolutions(row.priorGitResolutions ?? []),
    prior: parseOwnedList(row.prior),
    pending: parseReceiptList(row.pending),
    operations: parseOperations(row.operations)
  }
}

function validateGitResolutions(value: unknown): SkillGitResolution[] {
  if (!Array.isArray(value) || value.length > 64) throw safety('skill ownership ledger has invalid Git resolutions')
  const seen = new Set<string>()
  return value
    .map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw safety('skill ownership ledger has invalid Git resolutions')
      }
      const resolution = entry as SkillGitResolution
      if (
        !/^[a-f0-9]{64}$/.test(resolution.definitionDigest) ||
        !/^[a-f0-9]{40}$/.test(resolution.resolvedCommit) ||
        seen.has(resolution.definitionDigest)
      ) {
        throw safety('skill ownership ledger has invalid Git resolutions')
      }
      seen.add(resolution.definitionDigest)
      return { ...resolution }
    })
    .sort((a, b) => a.definitionDigest.localeCompare(b.definitionDigest))
}

function parseOwnedList(value: unknown): OwnedSkillBundle[] {
  if (!Array.isArray(value) || value.length > 64) throw safety('skill ownership ledger is invalid')
  return value.map((entry) => {
    validateOwned(entry as OwnedSkillBundle)
    return entry as OwnedSkillBundle
  })
}

function parseReceiptList(value: unknown): SkillBundleReceipt[] {
  if (!Array.isArray(value) || value.length > 64) throw safety('skill ownership ledger is invalid')
  return value.map((entry) => {
    validateReceipt(entry as SkillBundleReceipt)
    return entry as SkillBundleReceipt
  })
}

function parseOperations(value: unknown): JournalOperation[] {
  if (!Array.isArray(value) || value.length > 128) throw safety('skill ownership ledger is invalid')
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw safety('skill ownership ledger is invalid')
    const operation = entry as JournalOperation
    validateRelativeRoot(operation.relativeRoot)
    if (
      !SAFE_OPERATION.test(operation.operationId) ||
      !SAFE_QUARANTINE.test(operation.reservationName) ||
      !SAFE_QUARANTINE.test(operation.quarantineName) ||
      !SAFE_QUARANTINE.test(operation.tombstoneName) ||
      (operation.reservationIdentity === undefined) !== (operation.markerIdentity === undefined)
    ) {
      throw safety('skill ownership ledger is invalid')
    }
    if (operation.reservationIdentity) validateIdentity(operation.reservationIdentity)
    if (operation.markerIdentity) validateIdentity(operation.markerIdentity)
    return {
      relativeRoot: operation.relativeRoot,
      operationId: operation.operationId,
      reservationName: operation.reservationName,
      quarantineName: operation.quarantineName,
      tombstoneName: operation.tombstoneName,
      ...(operation.reservationIdentity && operation.markerIdentity
        ? {
            reservationIdentity: { ...operation.reservationIdentity },
            markerIdentity: { ...operation.markerIdentity }
          }
        : {})
    }
  })
}

function parseCleanup(value: unknown): ReadyCleanup {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw safety('skill ownership ledger is invalid')
  const cleanup = value as Record<string, unknown>
  return { operations: parseOperations(cleanup.operations), prior: parseOwnedList(cleanup.prior) }
}

function identity(stat: BigIntStats): PathIdentity {
  return { dev: stat.dev.toString(), ino: stat.ino.toString() }
}

function parseIdentity(value: unknown): PathIdentity | null {
  try {
    validateIdentity(value as PathIdentity)
    return value as PathIdentity
  } catch {
    return null
  }
}

function parseRequiredIdentity(value: unknown): PathIdentity {
  const parsed = parseIdentity(value)
  if (!parsed) throw safety('skill ownership ledger has an invalid filesystem identity')
  return parsed
}

function validateIdentity(value: PathIdentity): void {
  if (!value || typeof value !== 'object' || !/^\d+$/.test(value.dev) || !/^\d+$/.test(value.ino)) {
    throw safety('invalid skill filesystem identity')
  }
}

function sameIdentity(left: PathIdentity, right: PathIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

async function assertCurrentWorkspace(cwd: string, expected: PathIdentity): Promise<void> {
  const lexical = resolve(cwd)
  const real = await fsp.realpath(lexical)
  await assertWorkspaceIdentity(lexical, real, expected)
}

async function assertWorkspaceIdentity(
  lexical: string,
  expectedRealpath: string,
  expected: PathIdentity
): Promise<void> {
  const stat = await fsp.lstat(lexical, { bigint: true })
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (await fsp.realpath(lexical)) !== expectedRealpath ||
    !sameIdentity(identity(stat), expected)
  ) {
    throw safety('skill workspace incarnation changed')
  }
}

function safety(message: string, cause?: unknown): SkillLedgerSafetyError {
  return new SkillLedgerSafetyError(message, cause === undefined ? undefined : { cause })
}
