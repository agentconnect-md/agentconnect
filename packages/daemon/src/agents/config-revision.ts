/**
 * The daemon-side ordering fence for CP-owned agent configuration
 * (organization-secrets-and-variables.md §7).
 *
 * `AgentSpec.env` / `AgentSpec.secrets` are FULL resolved maps: applying an older
 * snapshot after a newer one silently reinstates a rotated or deleted value. The
 * CP coalesces its projection work per agent, but that is only a load
 * optimization — slow assembly, several CP publishers, retries, and reconnects
 * can all still deliver snapshots out of order. This module is the correctness
 * boundary: the greatest applied revision plus a digest of that revision's
 * CP-owned spec is persisted beside `agent.json`, and every apply is decided
 * against it:
 *
 *   - a GREATER revision      → apply normally;
 *   - an EQUAL revision, same digest    → idempotent retry, nothing to write;
 *   - an EQUAL revision, different digest → an invariant violation, refused;
 *   - a LOWER revision        → a stale no-op that never reaches writeAgentSpec.
 *
 * A spec with NO revision (an older CP, or a hand-authored/partial spec) is
 * always applied: the fence is opt-in per snapshot, and the CP gates placement of
 * an organization-bound agent on `agent-config-revision-v1` rather than relying
 * on lenient decoding.
 *
 * DURABILITY ORDER: the caller writes `agent.json` FIRST and this marker second.
 * A crash in between leaves a marker that is absent or older than the content on
 * disk, so the retry re-applies — harmless. The reverse order would let an
 * equal-revision retry be dismissed as idempotent while the content was never
 * written.
 */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { AgentSpec } from '@agentconnect.md/protocol'
import { ensurePrivateAgentDirectory } from './agent-json-file.js'

/** Sidecar name. Dot-prefixed and not `agent.json`, so agent discovery skips it. */
const REVISION_FILE = '.cp-config-revision.json'

const PRIVATE_FILE_MODE = 0o600

export interface AppliedConfigRevision {
  /** The greatest revision whose spec was fully written to `agent.json`. */
  revision: bigint
  /** `sha256:<hex>` over that revision's CP-owned spec (see {@link agentSpecDigest}). */
  digest: string
}

/** What the fence decided for one incoming snapshot. */
export type ConfigRevisionDecision =
  /** Write it: a greater revision, or a spec that carries none. */
  | 'apply'
  /** Same revision, same content — already on disk. */
  | 'idempotent'
  /** Lower revision: acknowledge, but never write. */
  | 'stale'
  /** Same revision, different content — the CP broke its own invariant. */
  | 'conflict'

/**
 * `sha256:<hex>` over the CP-owned spec with `configRevision` REMOVED and object
 * keys sorted, so the digest is a stable function of the replicated content
 * alone. Values (including secret values) are hashed, never stored.
 */
export function agentSpecDigest(spec: AgentSpec): string {
  const { configRevision: _ignored, ...content } = spec
  return 'sha256:' + createHash('sha256').update(canonicalJson(content)).digest('hex')
}

/** Deterministic JSON: objects emit their keys in sorted order, arrays keep theirs. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

/**
 * Parse the wire field. Absent ⇒ undefined (unfenced). The protocol already
 * constrains the shape; a value that somehow fails it is treated as absent
 * rather than throwing, so one malformed roster entry cannot fail a handshake.
 */
export function parseConfigRevision(spec: AgentSpec): bigint | undefined {
  const raw = spec.configRevision
  if (raw === undefined || !/^(0|[1-9][0-9]*)$/.test(raw)) return undefined
  return BigInt(raw)
}

/** The pure comparison. Exported for unit tests; production reaches it via {@link decideAgentSpecApply}. */
export function compareConfigRevision(
  applied: AppliedConfigRevision | undefined,
  incoming: { revision: bigint | undefined; digest: string }
): ConfigRevisionDecision {
  // An unfenced snapshot (older CP / hand-authored spec) always applies. It also
  // deliberately does NOT advance the marker — see writeAppliedConfigRevision.
  if (incoming.revision === undefined) return 'apply'
  if (!applied) return 'apply'
  if (incoming.revision > applied.revision) return 'apply'
  if (incoming.revision < applied.revision) return 'stale'
  return incoming.digest === applied.digest ? 'idempotent' : 'conflict'
}

/** Read the persisted marker for an agent root. Missing/corrupt ⇒ undefined (unfenced). */
export function readAppliedConfigRevision(agentFile: string): AppliedConfigRevision | undefined {
  const file = join(dirname(agentFile), REVISION_FILE)
  if (!existsSync(file)) return undefined
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { revision?: unknown; digest?: unknown }
    if (typeof raw.revision !== 'string' || !/^(0|[1-9][0-9]*)$/.test(raw.revision)) return undefined
    if (typeof raw.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(raw.digest)) return undefined
    return { revision: BigInt(raw.revision), digest: raw.digest }
  } catch {
    // A truncated/garbled marker must not wedge replication: fall back to
    // unfenced, which re-applies the current snapshot and rewrites the marker.
    return undefined
  }
}

/**
 * Durably record the revision just written. Called AFTER `agent.json` is on disk.
 *
 * An unfenced snapshot leaves the marker untouched: overwriting the greatest
 * applied revision with "unknown" would reopen the window for a stale fenced
 * snapshot arriving afterwards.
 */
export function writeAppliedConfigRevision(agentFile: string, revision: bigint | undefined, digest: string): void {
  if (revision === undefined) return
  const dir = dirname(agentFile)
  const file = join(dir, REVISION_FILE)
  const temp = `${file}.tmp`
  ensurePrivateAgentDirectory(dir)
  try {
    writeFileSync(temp, JSON.stringify({ revision: revision.toString(), digest }, null, 2) + '\n', {
      encoding: 'utf8',
      mode: PRIVATE_FILE_MODE
    })
    syncFile(temp)
    renameSync(temp, file)
    syncFile(dir)
  } catch (err) {
    rmSync(temp, { force: true })
    throw err
  }
}

function syncFile(path: string): void {
  // Windows lacks the POSIX directory-fsync primitive; the production target is Linux.
  if (process.platform === 'win32') return
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
