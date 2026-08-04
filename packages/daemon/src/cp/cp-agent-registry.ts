/**
 * In-memory registry for Control Plane agent specs.
 *
 * CP configuration is deliberately never persisted as `agent.json`. A matching
 * hand-authored/legacy file is removed when the CP claims that id; every other
 * `agent.json` remains untouched and is treated as user-owned. The agent's data
 * directory remains durable and carries only a private id marker, allowing a
 * reconnect after daemon restart to reuse workspace, memory, and session data
 * without storing the CP spec or its secrets.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { AgentSpec } from '@agentconnect.md/protocol'
import { AgentSchema } from '../agents/agent-schema.js'
import type { LoadedAgent } from '../agents/load-agents.js'
import { ensurePrivateAgentDirectory } from '../agents/agent-json-file.js'
import { applySpecFields, findAgentFileById, type WriteAgentDeps } from '../agents/write-agent.js'
import {
  agentSpecDigest,
  compareConfigRevision,
  parseConfigRevision,
  type AppliedConfigRevision,
  type ConfigRevisionDecision
} from '../agents/config-revision.js'

const ROOT_MARKER = '.cp-agent-id'
const MAX_DEPTH = 4

export type AgentSpecApplyResult = ConfigRevisionDecision

function markerRoot(dir: string, agentId: string, depth = 0): string | undefined {
  if (depth > MAX_DEPTH || !existsSync(dir)) return undefined
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return undefined
  }
  const marker = entries.find((entry) => entry.isFile() && entry.name === ROOT_MARKER)
  if (marker) {
    try {
      if (readFileSync(join(dir, ROOT_MARKER), 'utf8').trim() === agentId) return dir
    } catch {
      // A malformed marker cannot claim a directory.
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name === '.git') continue
    const found = markerRoot(join(dir, entry.name), agentId, depth + 1)
    if (found) return found
  }
  return undefined
}

function fallbackDir(agentsDir: string, agentId: string): string {
  return join(agentsDir, `agent-${createHash('sha256').update(agentId).digest('hex').slice(0, 32)}`)
}

function assertSafeLifecycleId(agentId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(agentId) || agentId === '.' || agentId === '..') {
    throw new Error('agent id is unsafe for daemon-local lifecycle storage')
  }
}

function chooseRoot(agentsDir: string, agentId: string, spec: AgentSpec): { dir: string; file?: string } {
  const file = findAgentFileById(agentsDir, agentId)
  if (file) return { dir: dirname(file), file }
  const marked = markerRoot(agentsDir, agentId)
  if (marked) return { dir: marked }
  const safeName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(spec.name) && spec.name !== '.' && spec.name !== '..'
  const named = safeName ? join(agentsDir, spec.name) : undefined
  return { dir: named && !existsSync(named) ? named : fallbackDir(agentsDir, agentId) }
}

function writeRootMarker(dir: string, agentId: string): void {
  ensurePrivateAgentDirectory(dir)
  const file = join(dir, ROOT_MARKER)
  const temp = `${file}.tmp`
  try {
    writeFileSync(temp, `${agentId}\n`, { mode: 0o600 })
    renameSync(temp, file)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

function rawAgent(agent: LoadedAgent): Record<string, unknown> {
  const { dir: _dir, ...raw } = agent
  return structuredClone(raw) as Record<string, unknown>
}

function readLegacyAgent(file: string): LoadedAgent | undefined {
  try {
    const dir = dirname(file)
    const agent = AgentSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
    if (!isAbsolute(agent.workspace.path)) agent.workspace.path = resolve(dir, agent.workspace.path)
    return { ...agent, dir }
  } catch {
    return undefined
  }
}

export class CpAgentRegistry {
  private readonly active = new Map<string, LoadedAgent>()
  private readonly detached = new Map<string, LoadedAgent>()
  private readonly revisions = new Map<string, AppliedConfigRevision>()

  constructor(
    private readonly agentsDir: string,
    private readonly deps: WriteAgentDeps,
    private readonly onChange: () => void,
    private readonly warn?: (msg: string) => void
  ) {}

  has(agentId: string): boolean {
    return this.active.has(agentId)
  }

  agents(): LoadedAgent[] {
    return [...this.active.values()]
  }

  upsert(agentId: string, spec: AgentSpec): AgentSpecApplyResult {
    const decision = this.apply(agentId, spec)
    if (decision === 'apply') this.onChange()
    return decision
  }

  remove(agentId: string): void {
    assertSafeLifecycleId(agentId)
    const agent = this.active.get(agentId) ?? this.detached.get(agentId)
    this.active.delete(agentId)
    this.detached.delete(agentId)
    this.revisions.delete(agentId)
    if (agent) rmSync(agent.dir, { recursive: true, force: true })
    this.onChange()
  }

  detach(agentId: string): 'archived' | 'already-detached' | 'missing' {
    assertSafeLifecycleId(agentId)
    const agent = this.active.get(agentId)
    if (!agent) return this.detached.has(agentId) ? 'already-detached' : 'missing'
    this.active.delete(agentId)
    this.detached.set(agentId, agent)
    this.onChange()
    return 'archived'
  }

  /** CP dependents are held by their own in-memory registries. */
  exactDependents(_agentId: string, _desired: { integrationIds: string[]; cronIds: string[] }): boolean {
    return false
  }

  activate(
    agentId: string,
    _desired: { integrationIds: string[]; cronIds: string[] }
  ): 'restored' | 'already-active' | 'missing' {
    assertSafeLifecycleId(agentId)
    if (this.active.has(agentId)) return 'already-active'
    const agent = this.detached.get(agentId)
    if (!agent) return 'missing'
    this.detached.delete(agentId)
    this.active.set(agentId, agent)
    this.onChange()
    return 'restored'
  }

  converge(roster: Array<AgentSpec & { agentId: string }>): string[] {
    const applied: string[] = []
    for (const { agentId, ...spec } of roster) {
      if (this.apply(agentId, spec) === 'apply') applied.push(agentId)
    }
    this.onChange()
    return applied
  }

  private apply(agentId: string, spec: AgentSpec): AgentSpecApplyResult {
    const revision = parseConfigRevision(spec)
    const digest = agentSpecDigest(spec)
    const decision = compareConfigRevision(this.revisions.get(agentId), { revision, digest })
    if (decision === 'stale') {
      this.warn?.(`cp: agent "${agentId}" spec revision ${spec.configRevision} is older than the applied one; ignoring`)
      return decision
    }
    if (decision === 'conflict') {
      this.warn?.(
        `cp: agent "${agentId}" spec revision ${spec.configRevision} arrived with different content than the one already applied; refusing`
      )
      return decision
    }
    if (decision === 'idempotent') return decision

    const located = chooseRoot(this.agentsDir, agentId, spec)
    const previous =
      this.active.get(agentId) ??
      this.detached.get(agentId) ??
      (located.file ? readLegacyAgent(located.file) : undefined)
    if (previous) located.dir = previous.dir
    const runtime = spec.runtime ?? previous?.runtime ?? this.deps.knownRuntimes[0]
    if (!runtime) throw new Error(`cannot create agent "${agentId}": spec has no runtime and no runtimes are known`)
    if (!spec.runtime && !previous) {
      this.deps.warn?.(`cp: agent "${agentId}" spec has no runtime; defaulting to "${runtime}"`)
    }
    const raw: Record<string, unknown> = previous
      ? rawAgent(previous)
      : {
          id: agentId,
          name: spec.name,
          status: 'active',
          runtime,
          workspace: { mode: 'from-scratch', path: join(located.dir, 'workspace') }
        }
    raw.id = agentId
    raw.runtime ??= runtime
    raw.integrations = []
    raw.crons = []
    applySpecFields(raw, spec, { agentId, agentDir: located.dir, creating: !previous })
    const agent = { ...AgentSchema.parse(raw), dir: located.dir }

    // Remove every local file claiming this id. Duplicate ids are invalid local
    // state, but CP authority must not leave an arbitrary duplicate discoverable.
    if (located.file) rmSync(located.file, { force: true })
    for (let matching = findAgentFileById(this.agentsDir, agentId); matching;) {
      rmSync(matching, { force: true })
      matching = findAgentFileById(this.agentsDir, agentId)
    }
    // Commit the memory representation only after its durable data-root marker
    // succeeds. The marker contains no config or secret values.
    writeRootMarker(located.dir, agentId)
    rmSync(join(located.dir, '.cp-config-revision.json'), { force: true })
    this.detached.delete(agentId)
    this.active.set(agentId, agent)
    if (revision !== undefined) this.revisions.set(agentId, { revision, digest })
    return 'apply'
  }
}
