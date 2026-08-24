/**
 * Persist CP-owned agent spec onto the daemon's on-disk `agent.json`, which is
 * the SINGLE SOURCE OF TRUTH for agent config. The CP pushes an `AgentSpec`
 * (agent/upsert + the register/ok roster); we map its CP-owned fields onto the
 * matching `<agentsDir>/<id>/agent.json`:
 *
 *  - if one with that id exists  → field-level MERGE the CP-owned keys into it;
 *  - if none exists             → CREATE a new `<agentsDir>/<name>/agent.json`.
 *
 * CRITICAL: we operate on the RAW JSON TEXT (readFileSync → JSON.parse → set
 * only CP-owned keys → writeFileSync). We never serialize the parsed
 * `LoadedAgent`, whose `workspace.path` has been rewritten to an absolute path.
 * Editing the raw file preserves the original relative `workspace.path`.
 *
 * Locally-owned keys (id, status, integrations, permissions, crons,
 * workspace.path / pullOnNewSession, and the deprecated workspace.skills) are
 * preserved untouched. The top-level `skills` (AgentSkillEntry[]) is CP-owned.
 * `runtime` and `output.mode` are CP-owned when the spec carries them (a spec
 * without the key leaves the local value alone — hand-authored agent.json keeps
 * working).
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import type { Dirent, Stats } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, relative, resolve, isAbsolute, sep } from 'node:path'
import {
  normalizeGitCloneUrl,
  normalizeGithubRepoUrl,
  normalizeRepoSubdir,
  redactGitUrlSecrets,
  type AgentSpec
} from '@agentconnect.md/protocol'
import { ensurePrivateAgentDirectory, protectAgentJson, writeAgentJson } from './agent-json-file.js'
import { findAgentFiles } from './load-agents.js'

export interface WriteAgentDeps {
  /** Known runtime ids; the first is the fallback runtime when creating an agent
   *  and the spec carries no `runtime`. */
  knownRuntimes: string[]
  /** Optional warn sink (e.g. for the runtime fallback). */
  warn?: (msg: string) => void
}

const DETACHED_DIR = '.detached'
const STAGED_DIR = '.staged'
const REMOVED_DIR = '.removed'
const DETACHED_DATA_DIR = 'agent'
const DETACHED_META_FILE = 'metadata.json'
const MOVE_META_FILE = 'metadata.json'
const REMOVED_META_FILE = 'metadata.json'

interface DetachedAgentMetadata {
  agentId: string
  /** Original agent-root path, relative to agentsDir. */
  relativePath: string
}

function assertSafeAgentStorageId(agentId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(agentId) || agentId === '.' || agentId === '..') {
    throw new Error('agent id is unsafe for daemon-local lifecycle storage')
  }
}

export interface AgentMoveStageMetadata {
  moveId: string
  state: 'staging' | 'committed'
  /** Durable marker for the first half of scratch→GitHub conversion. */
  requireEmptyWorkspace?: boolean
}

/** Stable cold-move archive root. It is hidden, so agent discovery ignores it. */
export function detachedAgentDir(agentsDir: string, agentId: string): string {
  assertSafeAgentStorageId(agentId)
  return join(agentsDir, DETACHED_DIR, agentId)
}

export function stagedAgentDir(agentsDir: string, agentId: string): string {
  assertSafeAgentStorageId(agentId)
  return join(agentsDir, STAGED_DIR, agentId)
}

function writeMoveStage(agentsDir: string, agentId: string, metadata: AgentMoveStageMetadata): void {
  const root = stagedAgentDir(agentsDir, agentId)
  const file = join(root, MOVE_META_FILE)
  const temp = join(root, `${MOVE_META_FILE}.tmp`)
  ensurePrivateAgentDirectory(root)
  try {
    writeFileSync(temp, JSON.stringify(metadata, null, 2) + '\n')
    renameSync(temp, file)
  } catch (err) {
    rmSync(temp, { force: true })
    throw err
  }
}

/** Durable fail-closed tombstone: a new move atomically supersedes the old id/state. */
export function stageAgentMove(
  agentsDir: string,
  agentId: string,
  moveId: string,
  requireEmptyWorkspace = false
): void {
  writeMoveStage(agentsDir, agentId, {
    moveId,
    state: 'staging',
    ...(requireEmptyWorkspace ? { requireEmptyWorkspace: true } : {})
  })
}

export function readAgentMoveStage(agentsDir: string, agentId: string): AgentMoveStageMetadata | undefined {
  const root = stagedAgentDir(agentsDir, agentId)
  if (!existsSync(root)) return undefined
  ensurePrivateAgentDirectory(root)
  try {
    const raw = JSON.parse(readFileSync(join(root, MOVE_META_FILE), 'utf8')) as Partial<AgentMoveStageMetadata>
    if (typeof raw.moveId === 'string' && (raw.state === 'staging' || raw.state === 'committed')) {
      return {
        moveId: raw.moveId,
        state: raw.state,
        ...(raw.requireEmptyWorkspace === true ? { requireEmptyWorkspace: true } : {})
      }
    }
  } catch {
    // A corrupt/incomplete tombstone must fail closed, never revive the agent.
  }
  return { moveId: '', state: 'staging' }
}

export function commitAgentMove(agentsDir: string, agentId: string, moveId: string): void {
  const current = readAgentMoveStage(agentsDir, agentId)
  if (!current || current.moveId !== moveId) {
    throw new Error(`cannot commit move "${moveId}" for agent "${agentId}": staging fence changed`)
  }
  if (current.state === 'committed') return
  writeMoveStage(agentsDir, agentId, { moveId, state: 'committed' })
}

export function clearAgentMoveStage(agentsDir: string, agentId: string): void {
  rmSync(stagedAgentDir(agentsDir, agentId), { recursive: true, force: true })
}

export function agentMoveStages(agentsDir: string): Map<string, AgentMoveStageMetadata> {
  const root = join(agentsDir, STAGED_DIR)
  const out = new Map<string, AgentMoveStageMetadata>()
  if (!existsSync(root)) return out
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const metadata = readAgentMoveStage(agentsDir, entry.name)
      if (metadata) out.set(entry.name, metadata)
    }
  } catch {
    // Return every entry collected so far; individual invalid dirs are fail-closed above.
  }
  return out
}

export function stagedAgentIds(agentsDir: string): string[] {
  return [...agentMoveStages(agentsDir)]
    .filter(([, metadata]) => metadata.state === 'staging')
    .map(([agentId]) => agentId)
}

function removalMarkerDir(storeDir: string, agentId: string): string {
  // RegisterOk drop ids are rolling-compatible strings rather than UUID-only.
  // Never use CP-controlled bytes as a path segment; the exact id lives only in
  // private metadata and a fixed-width digest names the containment directory.
  const key = createHash('sha256').update(agentId).digest('hex')
  return join(storeDir, key)
}

function localRemovalStore(agentsDir: string): string {
  return join(agentsDir, REMOVED_DIR)
}

function syncPath(path: string): void {
  // Windows does not expose the POSIX directory-fsync durability primitive.
  // The daemon's production sandbox target is Linux; macOS also supports this
  // for the local development/test path.
  if (process.platform === 'win32') return
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function syncPathIfExists(path: string): void {
  if (existsSync(path)) syncPath(path)
}

function publishRemovalMarker(storeDir: string, agentId: string): void {
  const root = removalMarkerDir(storeDir, agentId)
  const file = join(root, REMOVED_META_FILE)
  const temp = join(root, `${REMOVED_META_FILE}.tmp`)
  ensurePrivateAgentDirectory(root)
  try {
    writeFileSync(temp, JSON.stringify({ agentId }, null, 2) + '\n', { mode: 0o600 })
    syncPath(temp)
    renameSync(temp, file)
    syncPath(root)
    syncPath(storeDir)
    syncPath(dirname(storeDir))
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

/** Persist removal admission before asynchronous quiesce begins. If the daemon
 * crashes after that point but before deleting the active root, startup keeps
 * the replica outside the effective roster until CP removes or re-adds it. */
export interface AgentRemovalMarkResult {
  /** A mirror failed, but at least one independently durable marker landed. */
  degraded: Error[]
}

export function markAgentRemoval(agentsDir: string, agentId: string, obligationDir?: string): AgentRemovalMarkResult {
  // The two stores are independent failure domains. Try both even when the
  // first fails; one successfully-fsynced marker is sufficient to keep restart
  // fail-closed. A later retry repairs the missing mirror.
  const stores = obligationDir ? [obligationDir, localRemovalStore(agentsDir)] : [localRemovalStore(agentsDir)]
  const degraded: Error[] = []
  let published = 0
  for (const store of stores) {
    try {
      publishRemovalMarker(store, agentId)
      published += 1
    } catch (error) {
      degraded.push(error instanceof Error ? error : new Error('agent removal tombstone publication failed'))
    }
  }
  if (published === 0) {
    throw new AggregateError(degraded, `cannot durably publish agent removal for "${agentId}"`)
  }
  return { degraded }
}

function clearRemovalMarker(storeDir: string, agentId: string): void {
  if (!existsSync(storeDir)) return
  rmSync(removalMarkerDir(storeDir, agentId), { recursive: true, force: true })
  // Persist marker deletion. Callers clear only after the active-root delete,
  // archive rename, or authoritative re-add bytes have themselves been fsynced.
  syncPath(storeDir)
  syncPathIfExists(dirname(storeDir))
}

export interface AgentRemovalClearResult {
  /** A mirror could not clear. Its retained/ambiguous marker remains fail-closed. */
  degraded: Error[]
}

export function clearAgentRemoval(agentsDir: string, agentId: string, obligationDir?: string): AgentRemovalClearResult {
  // Attempt both mirrors independently. After a durable delete/archive, a
  // retained marker is availability-only and must not invalidate the stronger
  // destructive fence. Re-add callers instead reject any degraded result before
  // reopening authority.
  const stores = [localRemovalStore(agentsDir), ...(obligationDir ? [obligationDir] : [])]
  const degraded: Error[] = []
  for (const store of stores) {
    try {
      clearRemovalMarker(store, agentId)
    } catch (error) {
      degraded.push(error instanceof Error ? error : new Error('agent removal tombstone clear failed'))
    }
  }
  return { degraded }
}

function nodeErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

function removalStoreRoots(agentsDir: string, obligationDir?: string): string[] {
  return [localRemovalStore(agentsDir), ...(obligationDir ? [obligationDir] : [])]
}

interface RemovalStoreRead {
  valid: Map<string, string>
  corrupt: Map<string, Error>
  /** A regular file/symlink cannot hide marker children, but this mirror is not healthy. */
  knownEmptyDegraded?: Error
  /** Enumeration failed, so this mirror may hide marker identities we cannot recover. */
  unknown?: Error
}

/** Read one mirror without letting its failure suppress a healthy peer. Corrupt
 * marker identities are resolved only after both mirrors have been inspected. */
function readRemovalStore(root: string): RemovalStoreRead {
  const result: RemovalStoreRead = { valid: new Map(), corrupt: new Map() }
  let rootStat: Stats
  try {
    rootStat = lstatSync(root)
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') return result
    result.unknown = new Error('cannot inspect durable agent removal tombstone store', { cause: error })
    return result
  }
  if (rootStat.isSymbolicLink()) {
    result.unknown = new Error('durable agent removal tombstone store must not be a symbolic link')
    return result
  }
  if (!rootStat.isDirectory()) {
    result.knownEmptyDegraded = new Error('durable agent removal tombstone store is not a directory')
    return result
  }

  let entries: Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch (error) {
    result.unknown = new Error('cannot enumerate durable agent removal tombstones', { cause: error })
    return result
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      // A hash-shaped file/symlink occupies a real marker identity. It is not
      // safe to skip unless the peer supplies valid metadata for that digest.
      if (/^[0-9a-f]{64}$/.test(entry.name)) {
        result.corrupt.set(entry.name, new Error(`corrupt agent removal tombstone "${entry.name}"`))
      }
      continue
    }
    try {
      const metadata = JSON.parse(readFileSync(join(root, entry.name, REMOVED_META_FILE), 'utf8')) as {
        agentId?: unknown
      }
      if (typeof metadata.agentId !== 'string') throw new Error('agent id is missing')
      const expected = createHash('sha256').update(metadata.agentId).digest('hex')
      if (expected !== entry.name) throw new Error('metadata digest mismatch')
      result.valid.set(expected, metadata.agentId)
    } catch (error) {
      result.corrupt.set(entry.name, new Error(`corrupt agent removal tombstone "${entry.name}"`, { cause: error }))
    }
  }
  return result
}

export function agentRemovalTombstones(agentsDir: string, obligationDir?: string): Set<string> {
  const reads = removalStoreRoots(agentsDir, obligationDir).map(readRemovalStore)
  const unknown = reads.flatMap((read) => (read.unknown ? [read.unknown] : []))
  if (unknown.length > 0) {
    throw new AggregateError(unknown, 'cannot enumerate durable agent removal tombstones')
  }
  if (reads.every((read) => read.knownEmptyDegraded)) {
    throw new AggregateError(
      reads.flatMap((read) => (read.knownEmptyDegraded ? [read.knownEmptyDegraded] : [])),
      'all durable agent removal tombstone stores are unavailable'
    )
  }

  const valid = new Map<string, string>()
  for (const read of reads) {
    for (const [digest, agentId] of read.valid) {
      const previous = valid.get(digest)
      if (previous !== undefined && previous !== agentId) {
        throw new Error(`conflicting agent removal tombstone "${digest}"`)
      }
      valid.set(digest, agentId)
    }
  }
  for (const read of reads) {
    for (const [digest, error] of read.corrupt) {
      // A valid peer with the same digest recovers the exact fenced identity.
      // Otherwise startup cannot know which authority this marker excluded.
      if (!valid.has(digest)) throw error
    }
  }
  return new Set(valid.values())
}

/** Re-add must not remove the last restart fence and then report failure. Check
 * every store first, clear one redundant marker at a time, and keep an anchor
 * until the final operation. If a delete/fsync races with a new failure, re-arm
 * at least one durable mirror before returning the degradation. */
export function clearAgentRemovalForReadd(
  agentsDir: string,
  agentId: string,
  obligationDir?: string
): AgentRemovalClearResult {
  const stores = removalStoreRoots(agentsDir, obligationDir)
  const marker = createHash('sha256').update(agentId).digest('hex')
  const present: string[] = []
  const degraded: Error[] = []
  for (const store of stores) {
    try {
      const storeStat = lstatSync(store)
      if (!storeStat.isDirectory()) {
        degraded.push(new Error(`durable agent removal tombstone store is not a directory: ${store}`))
        continue
      }
      try {
        lstatSync(join(store, marker))
        present.push(store)
      } catch (error) {
        if (nodeErrorCode(error) !== 'ENOENT') throw error
      }
    } catch (error) {
      if (nodeErrorCode(error) !== 'ENOENT') {
        degraded.push(error instanceof Error ? error : new Error('agent removal tombstone preflight failed'))
      }
    }
  }
  if (degraded.length > 0) return { degraded }

  for (const store of present) {
    try {
      // obligationDir is last, so when both mirrors exist it remains the anchor
      // until the local mirror has been durably cleared.
      clearRemovalMarker(store, agentId)
    } catch (error) {
      degraded.push(error instanceof Error ? error : new Error('agent removal tombstone clear failed'))
      try {
        const rearmed = markAgentRemoval(agentsDir, agentId, obligationDir)
        degraded.push(...rearmed.degraded)
      } catch (rearmError) {
        degraded.push(rearmError instanceof Error ? rearmError : new Error('agent removal tombstone re-arm failed'))
      }
      return { degraded }
    }
  }
  return { degraded }
}

function detachedDataDir(agentsDir: string, agentId: string): string {
  return join(detachedAgentDir(agentsDir, agentId), DETACHED_DATA_DIR)
}

function scrubAgentDependents(file: string, agentId: string): string {
  const original = readFileSync(file, 'utf8')
  pruneAgentDependents(file, agentId, { integrationIds: [], cronIds: [] })
  return original
}

/**
 * Move an active agent root out of the discovery tree without deleting any of
 * its daemon-local state. The metadata preserves custom/nested directory names
 * so a later activate or upsert can restore the exact original location.
 */
export function archiveAgent(agentsDir: string, agentId: string): 'archived' | 'already-detached' | 'missing' {
  const file = findAgentFileById(agentsDir, agentId)
  const archived = detachedDataDir(agentsDir, agentId)
  if (!file) {
    if (!existsSync(archived)) return 'missing'
    ensurePrivateAgentDirectory(detachedAgentDir(agentsDir, agentId))
    const archivedFile = findAgentFileById(archived, agentId)
    if (!archivedFile) throw new Error(`cannot detach agent "${agentId}": detached archive is incomplete`)
    // Idempotent security convergence: an archive produced by an interrupted or
    // older detach must also be scrubbed before a repeated detach can ACK.
    scrubAgentDependents(archivedFile, agentId)
    syncPath(archivedFile)
    syncPath(dirname(archivedFile))
    return 'already-detached'
  }

  const base = resolve(agentsDir)
  const activeDir = resolve(dirname(file))
  const relativePath = relative(base, activeDir)
  // An agentsDir that is itself an agent root cannot be moved underneath itself.
  if (!relativePath || isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    throw new Error(`cannot detach agent "${agentId}": its root is not a child of agentsDir`)
  }

  const archiveRoot = detachedAgentDir(agentsDir, agentId)
  if (existsSync(archiveRoot)) {
    // Crash recovery: metadata may have landed before the active-dir rename, or
    // restore may have renamed data out before removing metadata. With an active
    // root and NO archived data this is an incomplete residue, not a conflict.
    if (!existsSync(archived)) rmSync(archiveRoot, { recursive: true, force: true })
    else throw new Error(`cannot detach agent "${agentId}": an archive already exists while the agent is active`)
  }
  const metadata: DetachedAgentMetadata = { agentId, relativePath }
  const originalAgentJson = readFileSync(file, 'utf8')
  let renamed = false
  try {
    // The archive keeps workspace/memory/local files, but integrations and CP
    // crons are authority that must not revive after a restart and later re-add.
    ensurePrivateAgentDirectory(archiveRoot)
    scrubAgentDependents(file, agentId)
    syncPath(file)
    const metadataFile = join(archiveRoot, DETACHED_META_FILE)
    writeFileSync(metadataFile, JSON.stringify(metadata, null, 2) + '\n')
    syncPath(metadataFile)
    syncPath(archiveRoot)
    syncPath(dirname(archiveRoot))
    syncPath(agentsDir)
    renameSync(activeDir, archived)
    renamed = true
    // The removal marker is cleared only after this function returns. Persist
    // both sides of the rename first so a power loss cannot roll the active
    // authority back into the discovery tree after that marker is gone.
    syncPath(dirname(activeDir))
    syncPath(archiveRoot)
  } catch (err) {
    // Do not strand an empty/metadata-only state that makes every retry look
    // like a conflicting archive. The active directory is still intact when
    // either metadata write or rename fails, so rolling this root back is safe.
    // rename is atomic: on failure the active file remains at `file`, so put its
    // exact original text (including local formatting/templates) back.
    if (!renamed) {
      if (existsSync(file)) {
        writeAgentJson(file, originalAgentJson)
        syncPath(file)
      }
      rmSync(archiveRoot, { recursive: true, force: true })
      syncPathIfExists(dirname(archiveRoot))
    }
    throw err
  }
  return 'archived'
}

/** Restore a cold-move archive to its exact former relative location. */
export function restoreArchivedAgent(agentsDir: string, agentId: string): boolean {
  const archiveRoot = detachedAgentDir(agentsDir, agentId)
  const archived = detachedDataDir(agentsDir, agentId)
  if (!existsSync(archiveRoot)) return false
  ensurePrivateAgentDirectory(archiveRoot)
  if (!existsSync(archived)) throw new Error(`cannot activate agent "${agentId}": detached archive is incomplete`)

  let metadata: DetachedAgentMetadata
  try {
    metadata = JSON.parse(readFileSync(join(archiveRoot, DETACHED_META_FILE), 'utf8')) as DetachedAgentMetadata
  } catch {
    throw new Error(`cannot activate agent "${agentId}": detached archive metadata is invalid`)
  }
  if (metadata.agentId !== agentId || typeof metadata.relativePath !== 'string' || !metadata.relativePath) {
    throw new Error(`cannot activate agent "${agentId}": detached archive metadata does not match`)
  }

  const base = resolve(agentsDir)
  const target = resolve(base, metadata.relativePath)
  if (target === base || !target.startsWith(base + sep)) {
    throw new Error(`cannot activate agent "${agentId}": detached archive path escapes agentsDir`)
  }
  if (existsSync(target)) {
    throw new Error(`cannot activate agent "${agentId}": original path is already occupied`)
  }
  if (!findAgentFileById(archived, agentId)) {
    throw new Error(`cannot activate agent "${agentId}": detached archive does not contain the agent`)
  }

  mkdirSync(dirname(target), { recursive: true })
  renameSync(archived, target)
  // Authoritative re-add clears the removal obligation after writeAgentSpec
  // returns. Persist the restored root and both rename parents before then.
  syncPath(dirname(archived))
  syncPath(dirname(target))
  // Only metadata/empty parents remain after the data directory moved out.
  rmSync(archiveRoot, { recursive: true, force: true })
  syncPathIfExists(dirname(archiveRoot))
  syncPath(agentsDir)
  return true
}

/**
 * Exact-set the CP-owned dependents restored from a move-back archive BEFORE
 * the agent becomes visible to reconcile. CP crons are explicitly tagged and
 * can coexist with hand-authored entries. New integrations are tagged too, but
 * an archive may predate that marker; move activation therefore still treats
 * the CP list as authoritative/fail-closed and removes every non-listed
 * integration. Retaining an unknown stale bot credential is the less safe
 * ambiguity during an explicit move.
 */
function pruneAgentDependents(
  file: string,
  agentId: string,
  desired: { integrationIds: string[]; cronIds: string[] }
): boolean {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  const integrationIds = new Set(desired.integrationIds)
  const cronIds = new Set(desired.cronIds)
  let changed = false

  if (!Array.isArray(raw.integrations)) {
    // Archive/detach historically erased this field unconditionally. Preserve
    // that credential boundary for malformed/legacy non-array values too.
    raw.integrations = []
    changed = true
  } else {
    const seen = new Set<string>()
    const next = raw.integrations.filter((integration) => {
      if (typeof integration !== 'object' || integration === null) return false
      const id = (integration as { id?: unknown }).id
      if (typeof id !== 'string' || !integrationIds.has(id) || seen.has(id)) return false
      seen.add(id)
      return true
    })
    if (JSON.stringify(next) !== JSON.stringify(raw.integrations)) {
      raw.integrations = next
      changed = true
    }
  }
  const localCronCollisions = new Set<string>()
  if (Array.isArray(raw.crons)) {
    const seenCp = new Set<string>()
    const next = raw.crons.filter((cron) => {
      if (typeof cron !== 'object' || cron === null) return true
      const item = cron as { id?: unknown; origin?: unknown }
      if (item.origin !== 'cp') {
        if (typeof item.id === 'string' && cronIds.has(item.id)) localCronCollisions.add(item.id)
        return true
      }
      if (typeof item.id !== 'string' || !cronIds.has(item.id) || seenCp.has(item.id)) return false
      seenCp.add(item.id)
      return true
    })
    if (JSON.stringify(next) !== JSON.stringify(raw.crons)) {
      raw.crons = next
      changed = true
    }
  }
  if (changed) writeAgentJson(file, JSON.stringify(raw, null, 2) + '\n')

  const finalIntegrations = new Set(
    (Array.isArray(raw.integrations) ? raw.integrations : []).flatMap((integration) => {
      if (typeof integration !== 'object' || integration === null) return []
      const id = (integration as { id?: unknown }).id
      return typeof id === 'string' ? [id] : []
    })
  )
  const finalCpCrons = new Set(
    (Array.isArray(raw.crons) ? raw.crons : []).flatMap((cron) => {
      if (typeof cron !== 'object' || cron === null) return []
      const item = cron as { id?: unknown; origin?: unknown }
      return item.origin === 'cp' && typeof item.id === 'string' ? [item.id] : []
    })
  )
  const missingIntegrations = desired.integrationIds.filter((id) => !finalIntegrations.has(id))
  const missingCrons = desired.cronIds.filter((id) => !finalCpCrons.has(id))
  if (missingIntegrations.length || missingCrons.length || localCronCollisions.size) {
    throw new Error(
      `cannot activate agent "${agentId}": authoritative dependent bundle did not persist` +
        ` (missing integrations: ${missingIntegrations.join(', ') || 'none'};` +
        ` missing crons: ${missingCrons.join(', ') || 'none'};` +
        ` local cron collisions: ${[...localCronCollisions].join(', ') || 'none'})`
    )
  }
  return changed
}

export function pruneMovedAgentDependents(
  agentsDir: string,
  agentId: string,
  desired: { integrationIds: string[]; cronIds: string[] }
): boolean {
  const file = findAgentFileById(agentsDir, agentId)
  return file ? pruneAgentDependents(file, agentId, desired) : false
}

/** Map a CP workspace mode onto the daemon's AgentSchema workspace mode. */
function mapWorkspaceMode(mode: 'scratch' | 'github' | 'gitlab'): 'from-scratch' | 'git-repo' {
  return mode === 'scratch' ? 'from-scratch' : 'git-repo'
}

/**
 * Locate the on-disk `agent.json` whose INTERNAL `id` equals `agentId`.
 * Agents live under arbitrary directory layouts (discoverAgents walks recursively
 * and the dir name need NOT equal the id), so we must match by parsed id — never
 * assume the file sits at `<agentsDir>/<id>/agent.json`. Returns the file path, or
 * undefined if no agent with that id exists. Unparseable files are skipped.
 */
export function findAgentFileById(agentsDir: string, agentId: string): string | undefined {
  for (const file of findAgentFiles(agentsDir)) {
    protectAgentJson(file)
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { id?: unknown }
      if (raw.id === agentId) return file
    } catch {
      // skip a malformed agent.json — it can't be the merge target
    }
  }
  return undefined
}

/**
 * Locate the agent's `agent.json` whether it is ACTIVE or sitting in a cold-move
 * archive. `writeAgentSpec` restores an archive before merging CP fields, so the
 * config-revision fence (organization-secrets-and-variables.md §7) must see the
 * archived marker too — otherwise a stale fan-out completing after a move-away
 * would both un-archive the root and downgrade its configuration.
 */
export function findReplicaFileById(agentsDir: string, agentId: string): string | undefined {
  const active = findAgentFileById(agentsDir, agentId)
  if (active) return active
  const archived = detachedDataDir(agentsDir, agentId)
  return existsSync(archived) ? findAgentFileById(archived, agentId) : undefined
}

/** Persist the complete active replica before a removal obligation can clear. */
export function syncAgentReplica(agentsDir: string, agentId: string): void {
  const file = findAgentFileById(agentsDir, agentId)
  if (!file) throw new Error(`cannot persist agent "${agentId}": active replica is missing`)
  syncPath(file)
  syncPath(dirname(file))
  syncPath(agentsDir)
}

/**
 * Apply the CP-owned spec fields onto an agent-shaped raw object IN PLACE.
 * Used by both the legacy disk writer and the current in-memory registry.
 * `creating` controls whether workspace.path may be set (only on create — an
 * update never overwrites a path).
 */
export function applySpecFields(
  raw: Record<string, unknown>,
  spec: AgentSpec,
  opts: { agentId: string; agentDir: string; creating: boolean }
): void {
  // Mark replica ownership separately from the wire spec. The reconnect
  // handshake reports this field from the in-memory effective representation.
  raw.origin = 'cp'
  raw.name = spec.name
  // displayName follows PATCH semantics: value ⇒ set, null ⇒ clear, absent ⇒
  // preserve a hand-authored or previously replicated value on disk.
  if (spec.displayName !== undefined) {
    if (spec.displayName === null) delete raw.displayName
    else raw.displayName = spec.displayName
  }
  // iconUrl (Slack per-message icon_url) follows the same PATCH semantics as
  // displayName: value ⇒ set, null ⇒ clear, absent ⇒ preserve.
  if (spec.iconUrl !== undefined) {
    if (spec.iconUrl === null) delete raw.iconUrl
    else raw.iconUrl = spec.iconUrl
  }
  // description follows PATCH semantics: a non-empty value ⇒ set, an empty string ⇒
  // clear (the CP replicates a cleared description as ""), absent ⇒ preserve a
  // hand-authored or previously replicated value on disk.
  if (spec.description !== undefined) {
    if (spec.description) raw.description = spec.description
    else delete raw.description
  }
  // runtime is CP-owned — a PATCH may switch it (e.g. claude → codex). Apply it on
  // merge too, not only on create; absent ⇒ leave the on-disk runtime as-is.
  if (spec.runtime !== undefined) raw.runtime = spec.runtime
  // model/reasoningEffort/permissionMode/approvalsReviewer are per-runtime override vocabularies:
  // null ⇒ clear (revert to runtime default), a value ⇒ set, absent ⇒ leave alone.
  // Clearing must delete the key so a runtime switch drops the old runtime's override
  // instead of leaving it stale (model handled below, inside runtimeOverrides).
  if (spec.reasoningEffort !== undefined) {
    if (spec.reasoningEffort === null) delete raw.reasoningEffort
    else raw.reasoningEffort = spec.reasoningEffort
  }
  if (spec.executionMode !== undefined) raw.executionMode = spec.executionMode
  if (spec.fastMode !== undefined) raw.fastMode = spec.fastMode
  if (spec.permissionMode !== undefined) {
    if (spec.permissionMode === null) delete raw.permissionMode
    else raw.permissionMode = spec.permissionMode
  }
  if (spec.approvalsReviewer !== undefined) {
    if (spec.approvalsReviewer === null) delete raw.approvalsReviewer
    else raw.approvalsReviewer = spec.approvalsReviewer
  }
  if (spec.allowRuntimeChangesInChat !== undefined) {
    raw.allowRuntimeChangesInChat = spec.allowRuntimeChangesInChat
  }
  if (spec.pause !== undefined) raw.pause = spec.pause
  if (spec.mcpServers !== undefined) raw.mcpServers = spec.mcpServers
  // Skill sources are CP-owned and self-contained (design: shared-skills.md); mirror
  // the mcpServers contract — always shipped, so an emptied list clears on disk.
  if (spec.skills !== undefined) raw.skills = spec.skills
  // Managed skill metadata is also a complete CP-owned set. The archive bytes
  // are fetched separately and never enter agent.json.
  if (spec.managedSkills !== undefined) raw.managedSkills = spec.managedSkills
  // Agent→agent call policy (§2.5). callPolicy absent ⇒ leave alone (like pause);
  // allowedCallerAgentIds always ships from the CP so removing the last caller replicates.
  if (spec.callPolicy !== undefined) raw.callPolicy = spec.callPolicy
  if (spec.allowedCallerAgentIds !== undefined) raw.allowedCallerAgentIds = spec.allowedCallerAgentIds
  // Outbound authorization mirrors the inbound policy above. The policy is
  // optional for mixed-version CPs; the allow-list is definite when present.
  if (spec.outboundPolicy !== undefined) raw.outboundPolicy = spec.outboundPolicy
  if (spec.allowedTargetAgentIds !== undefined) raw.allowedTargetAgentIds = spec.allowedTargetAgentIds
  // Self-introduce-on-join (#536): absent ⇒ leave the on-disk value alone (like pause/fastMode).
  if (spec.introduceOnJoin !== undefined) raw.introduceOnJoin = spec.introduceOnJoin
  // Sandbox toggle (#312): the CP always ships it (definite column); absent ⇒ leave alone.
  if (spec.runInSandbox !== undefined) raw.runInSandbox = spec.runInSandbox
  // Preset marker (preset-agents.md §3.1): the CP always ships it (definite record
  // field), so a flip replicates; absent (older CP) ⇒ leave the on-disk value alone.
  if (spec.builtin !== undefined) raw.builtin = spec.builtin
  if (spec.memory !== undefined) raw.memory = spec.memory

  // Output settings preserve sibling/future keys while applying CP-owned values.
  if (spec.outputMode !== undefined || spec.showFooter !== undefined || spec.showStatusBar !== undefined) {
    const out = (
      typeof raw.output === 'object' && raw.output !== null ? (raw.output as Record<string, unknown>) : {}
    ) as Record<string, unknown>
    if (spec.outputMode !== undefined) out.mode = spec.outputMode
    if (spec.showFooter !== undefined) out.showFooter = spec.showFooter
    if (spec.showStatusBar !== undefined) out.showStatusBar = spec.showStatusBar
    raw.output = out
  }

  // model → runtimeOverrides.model; env/secrets (Record) → runtimeOverrides.{env,secrets}
  // (array). model null ⇒ clear the override: a runtime switch resets the model to
  // default, so the previous runtime's model must be DELETED, not left stale.
  if (spec.model !== undefined || spec.env !== undefined || spec.secrets !== undefined) {
    const ro = (
      typeof raw.runtimeOverrides === 'object' && raw.runtimeOverrides !== null
        ? (raw.runtimeOverrides as Record<string, unknown>)
        : {}
    ) as Record<string, unknown>
    if (spec.model !== undefined) {
      if (spec.model === null) delete ro.model
      else ro.model = spec.model
    }
    if (spec.env !== undefined) {
      ro.env = Object.entries(spec.env).map(([name, value]) => ({ name, value }))
    }
    if (spec.secrets !== undefined) {
      ro.secrets = Object.entries(spec.secrets).map(([name, value]) => ({ name, value }))
    }
    raw.runtimeOverrides = ro
  }

  // workspace: translate mode + git fields. On update, PRESERVE the existing
  // workspace.path (never overwrite a path); on create, generate a default path.
  if (spec.workspace !== undefined) {
    const ws = spec.workspace
    const existing = (
      typeof raw.workspace === 'object' && raw.workspace !== null ? (raw.workspace as Record<string, unknown>) : {}
    ) as Record<string, unknown>
    existing.mode = mapWorkspaceMode(ws.mode)
    existing.isolation = ws.isolation
    // AgentSpec carries the complete workspace state. Root/scratch therefore
    // clears a previously replicated cwd rather than preserving a stale local value.
    delete existing.agentDir
    if (ws.mode === 'gitlab') {
      // The managed-GitLab workspace (gitlab-com-integration.md §13): the local
      // credential marker routes clone/pull/session git through the daemon
      // helper with provider 'gitlab'. The CP only sends this arm to a daemon
      // that advertised gitlab-com-v1 (§17.3).
      existing.gitRepo = normalizeGitCloneUrl(redactGitUrlSecrets(ws.gitRepo))
      existing.gitBranch = ws.branch
      if (ws.agentDir !== undefined) existing.agentDir = ws.agentDir
    }
    if (ws.mode === 'github') {
      // Keep old CPs safe too: strip historical URL secrets, then reject any
      // transport a current daemon would refuse. Origin authorization remains
      // daemon-local and happens at the clone/pull boundary: one incompatible
      // roster entry must not prevent the daemon from completing CP register.
      existing.gitRepo =
        ws.gitCredential === 'github-app'
          ? normalizeGithubRepoUrl(ws.gitRepo)
          : normalizeGitCloneUrl(redactGitUrlSecrets(ws.gitRepo))
      existing.gitBranch = ws.branch
      if (ws.agentDir !== undefined) {
        try {
          const normalized = normalizeRepoSubdir(ws.agentDir)
          if (normalized !== undefined) existing.agentDir = normalized
        } catch {
          // Wire schemas intentionally remain lenient for historical CP rows.
          // Persist that value so daemon registration/reconcile still succeeds;
          // prepareWorkspace rejects it authoritatively before clone/session start.
          existing.agentDir = ws.agentDir
        }
      }
    }
    // Credential mode is CP-derived config and also applies to scratch
    // workspaces with explicit repo grants. Mirror it exactly, including clear.
    if (ws.mode === 'gitlab') {
      existing.gitCredential = 'gitlab'
      // The rename-stable identity rides the spec (§17.1); the grant consumer
      // verifies every echo against it.
      existing.gitlabProjectId = ws.projectId
    } else {
      if (ws.gitCredential !== undefined) existing.gitCredential = ws.gitCredential
      else delete existing.gitCredential
      delete existing.gitlabProjectId
    }
    // The CP is the authority on the additional-repository allowlist and always ships
    // the full set, so mirror it exactly — [] must replicate as a cleared list.
    existing.additionalRepos = ws.additionalRepos
    if (opts.creating && existing.path === undefined) {
      existing.path = join(opts.agentDir, 'workspace')
    }
    raw.workspace = existing
  }
}

/**
 * Create-or-merge the CP spec onto `<agentsDir>/<agentId>/agent.json`.
 *
 * MERGE (file exists): re-read the raw JSON text, set only CP-owned keys,
 * write it back pretty-printed. Preserves literal string contents, the relative
 * workspace.path, and all locally-owned keys.
 *
 * CREATE (no file): synthesize a minimal valid agent.json under a fresh
 * `<agentsDir>/<spec.name>/` dir (named by the unique slug) — runtime from
 * `spec.runtime` (falling back to
 * the first known runtime + a warn), workspace translated or defaulted to
 * from-scratch, path daemon-generated.
 */
export function writeAgentSpec(agentsDir: string, agentId: string, spec: AgentSpec, deps: WriteAgentDeps): void {
  // MERGE: find the existing agent.json by its internal id (any directory layout),
  // and write back IN PLACE so a custom-named dir isn't duplicated at <agentsDir>/<id>.
  let existingFile = findAgentFileById(agentsDir, agentId)
  // A daemon this agent previously lived on may hold a non-destructive cold-move
  // archive. Restore it BEFORE applying CP fields so workspace/memory/local config
  // survive a move back, while the current CP spec still wins its owned fields.
  if (!existingFile && restoreArchivedAgent(agentsDir, agentId)) {
    existingFile = findAgentFileById(agentsDir, agentId)
  }
  if (existingFile) {
    const raw = JSON.parse(readFileSync(existingFile, 'utf8')) as Record<string, unknown>
    applySpecFields(raw, spec, { agentId, agentDir: dirname(existingFile), creating: false })
    writeAgentJson(existingFile, JSON.stringify(raw, null, 2) + '\n')
    syncAgentReplica(agentsDir, agentId)
    return
  }

  // CREATE — no agent with this id exists anywhere; make a fresh dedicated dir
  // named by the agent's slug (spec.name, unique per org), not its opaque id.
  // Mixed-version wire schemas accept arbitrary names, so never trust one as a
  // path segment. A collision or unsafe name gets a stable opaque fallback.
  const safeName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(spec.name) && spec.name !== '.' && spec.name !== '..'
  const namedDir = safeName ? join(agentsDir, spec.name) : undefined
  const fallbackName = `agent-${createHash('sha256').update(agentId).digest('hex').slice(0, 32)}`
  const agentDir = namedDir && !existsSync(namedDir) ? namedDir : join(agentsDir, fallbackName)
  if (agentDir !== namedDir) {
    deps.warn?.(`cp: agent "${agentId}" name cannot be used as a unique local directory; using "${fallbackName}"`)
  }
  if (existsSync(agentDir)) {
    throw new Error(`cannot create agent "${agentId}": local directory "${fallbackName}" is already occupied`)
  }
  const file = join(agentDir, 'agent.json')
  let runtime = spec.runtime
  if (!runtime) {
    runtime = deps.knownRuntimes[0]
    if (!runtime) throw new Error(`cannot create agent "${agentId}": spec has no runtime and no runtimes are known`)
    deps.warn?.(`cp: agent "${agentId}" spec has no runtime; defaulting to "${runtime}"`)
  }

  const raw: Record<string, unknown> = {
    id: agentId,
    name: spec.name,
    status: 'active',
    runtime,
    workspace: { mode: 'from-scratch', path: join(agentDir, 'workspace') }
  }
  applySpecFields(raw, spec, { agentId, agentDir, creating: true })

  writeAgentJson(file, JSON.stringify(raw, null, 2) + '\n')
  syncAgentReplica(agentsDir, agentId)
}

/**
 * Delete the agent whose internal `id` is `agentId`. Called ONLY from the
 * `agent/remove` handler — unconditional. Locates the file by id (any directory
 * layout) and removes its containing dir; falls back to `<agentsDir>/<id>` when
 * no such agent exists (no-op). `discoverAgents` treats an agent.json dir as a
 * leaf, so the containing dir is the agent's own dir.
 */
export function removeAgent(agentsDir: string, agentId: string): void {
  const existingFile = findAgentFileById(agentsDir, agentId)
  if (existingFile) {
    const base = resolve(agentsDir)
    const activeDir = resolve(dirname(existingFile))
    const relativePath = relative(base, activeDir)
    if (!relativePath || isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
      throw new Error(`cannot remove agent "${agentId}": its root is not a child of agentsDir`)
    }
    const parent = dirname(activeDir)
    rmSync(activeDir, { recursive: true, force: true })
    // The caller clears the fail-closed marker next. Persist the unlink first.
    syncPath(parent)
    syncPath(agentsDir)
  }
  // `agent/remove` is actual deletion, not detach: purge any cold-move archive too.
  const detached = detachedAgentDir(agentsDir, agentId)
  rmSync(detached, { recursive: true, force: true })
  syncPathIfExists(dirname(detached))
  clearAgentMoveStage(agentsDir, agentId)
  syncPathIfExists(join(agentsDir, STAGED_DIR))
  syncPath(agentsDir)
}
