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
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, renameSync, readdirSync } from 'node:fs'
import { join, dirname, relative, resolve, isAbsolute, sep } from 'node:path'
import { normalizeGitUrl, normalizeRepoSubdir, type AgentSpec } from '@agentconnect.md/protocol'
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
const DETACHED_DATA_DIR = 'agent'
const DETACHED_META_FILE = 'metadata.json'
const MOVE_META_FILE = 'metadata.json'

interface DetachedAgentMetadata {
  agentId: string
  /** Original agent-root path, relative to agentsDir. */
  relativePath: string
}

export interface AgentMoveStageMetadata {
  moveId: string
  state: 'staging' | 'committed'
  /** Durable marker for the first half of scratch→GitHub conversion. */
  requireEmptyWorkspace?: boolean
}

/** Stable cold-move archive root. It is hidden, so agent discovery ignores it. */
export function detachedAgentDir(agentsDir: string, agentId: string): string {
  return join(agentsDir, DETACHED_DIR, agentId)
}

export function stagedAgentDir(agentsDir: string, agentId: string): string {
  return join(agentsDir, STAGED_DIR, agentId)
}

function writeMoveStage(agentsDir: string, agentId: string, metadata: AgentMoveStageMetadata): void {
  const root = stagedAgentDir(agentsDir, agentId)
  const file = join(root, MOVE_META_FILE)
  const temp = join(root, `${MOVE_META_FILE}.tmp`)
  mkdirSync(root, { recursive: true })
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

function detachedDataDir(agentsDir: string, agentId: string): string {
  return join(detachedAgentDir(agentsDir, agentId), DETACHED_DATA_DIR)
}

function scrubAgentIntegrations(file: string): string {
  const original = readFileSync(file, 'utf8')
  const raw = JSON.parse(original) as Record<string, unknown>
  if (Array.isArray(raw.integrations) && raw.integrations.length === 0) return original
  raw.integrations = []
  writeFileSync(file, JSON.stringify(raw, null, 2) + '\n')
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
    const archivedFile = findAgentFileById(archived, agentId)
    if (!archivedFile) throw new Error(`cannot detach agent "${agentId}": detached archive is incomplete`)
    // Idempotent security convergence: an archive produced by an interrupted or
    // older detach must also be scrubbed before a repeated detach can ACK.
    scrubAgentIntegrations(archivedFile)
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
  try {
    // The archive keeps workspace/memory/local files, but bot credentials are CP
    // authority and must not remain forever on the historical source daemon.
    mkdirSync(archiveRoot, { recursive: true })
    scrubAgentIntegrations(file)
    writeFileSync(join(archiveRoot, DETACHED_META_FILE), JSON.stringify(metadata, null, 2) + '\n')
    renameSync(activeDir, archived)
  } catch (err) {
    // Do not strand an empty/metadata-only state that makes every retry look
    // like a conflicting archive. The active directory is still intact when
    // either metadata write or rename fails, so rolling this root back is safe.
    // rename is atomic: on failure the active file remains at `file`, so put its
    // exact original text (including local formatting/templates) back.
    if (existsSync(file)) writeFileSync(file, originalAgentJson)
    rmSync(archiveRoot, { recursive: true, force: true })
    throw err
  }
  return 'archived'
}

/** Restore a cold-move archive to its exact former relative location. */
export function restoreArchivedAgent(agentsDir: string, agentId: string): boolean {
  const archiveRoot = detachedAgentDir(agentsDir, agentId)
  const archived = detachedDataDir(agentsDir, agentId)
  if (!existsSync(archiveRoot)) return false
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
  // Only metadata/empty parents remain after the data directory moved out.
  rmSync(archiveRoot, { recursive: true, force: true })
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
export function pruneMovedAgentDependents(
  agentsDir: string,
  agentId: string,
  desired: { integrationIds: string[]; cronIds: string[] }
): boolean {
  const file = findAgentFileById(agentsDir, agentId)
  if (!file) return false
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  const integrationIds = new Set(desired.integrationIds)
  const cronIds = new Set(desired.cronIds)
  let changed = false

  if (Array.isArray(raw.integrations)) {
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
  if (changed) writeFileSync(file, JSON.stringify(raw, null, 2) + '\n')

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

/** Map a CP workspace mode onto the daemon's AgentSchema workspace mode. */
function mapWorkspaceMode(mode: 'scratch' | 'github'): 'from-scratch' | 'git-repo' {
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
 * Apply the CP-owned spec fields onto a parsed raw agent.json object IN PLACE.
 * `creating` controls whether workspace.path may be set (only on create — an
 * update never overwrites a path).
 */
function applySpecFields(
  raw: Record<string, unknown>,
  spec: AgentSpec,
  opts: { agentId: string; agentDir: string; creating: boolean }
): void {
  // Persist replica ownership separately from the wire spec. The reconnect
  // handshake reports this marker so the CP can prune only its own stale copy.
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
  // model/reasoningEffort/permissionMode are per-runtime override vocabularies:
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
  if (spec.allowRuntimeChangesInChat !== undefined) {
    raw.allowRuntimeChangesInChat = spec.allowRuntimeChangesInChat
  }
  if (spec.pause !== undefined) raw.pause = spec.pause
  if (spec.mcpServers !== undefined) raw.mcpServers = spec.mcpServers
  // Skill sources are CP-owned and self-contained (design: shared-skills.md); mirror
  // the mcpServers contract — always shipped, so an emptied list clears on disk.
  if (spec.skills !== undefined) raw.skills = spec.skills
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
  // Sandbox toggle (#642): the CP always ships it (definite column); absent ⇒ leave alone.
  if (spec.restrictFileAccess !== undefined) raw.restrictFileAccess = spec.restrictFileAccess
  if (spec.memory !== undefined) raw.memory = spec.memory

  // Output settings preserve sibling/future keys while applying CP-owned values.
  if (spec.outputMode !== undefined || spec.showFooter !== undefined) {
    const out = (
      typeof raw.output === 'object' && raw.output !== null ? (raw.output as Record<string, unknown>) : {}
    ) as Record<string, unknown>
    if (spec.outputMode !== undefined) out.mode = spec.outputMode
    if (spec.showFooter !== undefined) out.showFooter = spec.showFooter
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
    // AgentSpec carries the complete workspace state. Root/scratch therefore
    // clears a previously replicated cwd rather than preserving a stale local value.
    delete existing.agentDir
    if (ws.mode === 'github') {
      // agent.json stores the FULL cloneable address; a spec replicated from a
      // pre-normalization CP row may still carry the "org/repo" shorthand.
      existing.gitRepo = normalizeGitUrl(ws.gitRepo)
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
    if (ws.gitCredential !== undefined) existing.gitCredential = ws.gitCredential
    else delete existing.gitCredential
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
    writeFileSync(existingFile, JSON.stringify(raw, null, 2) + '\n')
    return
  }

  // CREATE — no agent with this id exists anywhere; make a fresh dedicated dir
  // named by the agent's slug (spec.name, unique per org), not its opaque id.
  const agentDir = join(agentsDir, spec.name)
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

  mkdirSync(agentDir, { recursive: true })
  writeFileSync(file, JSON.stringify(raw, null, 2) + '\n')
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
  const agentDir = existingFile ? dirname(existingFile) : join(agentsDir, agentId)
  rmSync(agentDir, { recursive: true, force: true })
  // `agent/remove` is actual deletion, not detach: purge any cold-move archive too.
  rmSync(detachedAgentDir(agentsDir, agentId), { recursive: true, force: true })
  clearAgentMoveStage(agentsDir, agentId)
}
