/**
 * Persist CP-owned crons onto the owning agent's on-disk `agent.json` `crons[]`,
 * which is the SINGLE SOURCE OF TRUTH — so CP crons survive a daemon restart
 * with the Control Plane down: the Scheduler re-registers them from disk alone
 * at start.
 *
 * CP entries are marked `origin:"cp"` so they coexist with hand-authored crons:
 * the CP replaces/removes only its own entries and never touches user ones.
 *
 * CRITICAL: like write-agent.ts, we operate on the RAW JSON TEXT (readFileSync →
 * JSON.parse → mutate only `crons[]` → writeFileSync). We never serialize the
 * parsed `LoadedAgent`, whose `workspace.path` has been rewritten absolute.
 * Editing the raw file preserves the original relative path.
 */
import { readFileSync } from 'node:fs'
import type { CronUpsert } from '@agentconnect.md/protocol'
import type { CronDef } from './agent-schema.js'
import { protectAgentJson, writeAgentJson } from './agent-json-file.js'
import { findAgentFiles } from './load-agents.js'
import { findAgentFileById } from './write-agent.js'

/** Map the wire def to the daemon's `CronDef` shape (agent-schema). */
export function toCronDef(cron: CronUpsert): CronDef {
  return {
    id: cron.cronId,
    schedule: cron.schedule,
    timezone: cron.timezone,
    // §6.8: the target persists with its REAL platform — the anchor path posts
    // through the target integration's own connection (anchorTrigger is
    // platform-generic), so the old degrade-non-slack-to-headless fold is gone.
    ...(cron.target
      ? {
          target: {
            platform: cron.target.platform,
            channel: cron.target.channel,
            ...(cron.target.integrationId ? { integrationId: cron.target.integrationId } : {})
          }
        }
      : {}),
    trigger: cron.trigger,
    enabled: cron.enabled !== false,
    origin: 'cp'
  }
}

export interface WriteCronDeps {
  /** Warn sink for the orphan case (owning agent not on disk). */
  warn?: (msg: string) => void
}

/**
 * Upsert one CP cron into the owning agent's `agent.json` `crons[]` (replace the
 * `origin:"cp"` entry with that `id`, else append). Returns whether the file
 * CHANGED — an identical re-apply (every register/ok converge re-sends the full
 * set) skips the write so the file-watcher doesn't churn a reconcile per
 * reconnect. Returns false (with a warn) when no agent with `cron.agentId`
 * exists on disk — an orphan cron is not persisted; it self-heals when the
 * agent spec lands and the CP re-sends.
 *
 * The replace slot is matched by `id` AND `origin:"cp"` (mirroring
 * {@link removeCronDef}): a hand-authored entry that happens to share the id is
 * NEVER overwritten — the CP touches only its own entries. Such a collision is
 * skipped with a warn rather than silently converting a user cron into a CP one.
 */
export function writeCronDef(agentsDir: string, cron: CronUpsert, deps: WriteCronDeps): boolean {
  const file = findAgentFileById(agentsDir, cron.agentId)
  if (!file) {
    deps.warn?.(
      `cp: cron ${cron.cronId} references missing agent ${cron.agentId} — not persisted (will retry on next push)`
    )
    return false
  }
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  const list: unknown[] = Array.isArray(raw.crons) ? raw.crons : []
  const next = toCronDef(cron)
  const at = (c: unknown) => typeof c === 'object' && c !== null && (c as { id?: unknown }).id === next.id
  // A hand-authored (no-origin) entry sharing this id is off-limits — don't clobber it.
  const collision = list.find((c) => at(c) && (c as { origin?: unknown }).origin !== 'cp')
  if (collision) {
    deps.warn?.(
      `cp: cron ${cron.cronId} collides with a hand-authored cron of the same id on agent ${cron.agentId} — not persisted`
    )
    return false
  }
  const idx = list.findIndex((c) => at(c) && (c as { origin?: unknown }).origin === 'cp')
  if (idx >= 0) {
    if (JSON.stringify(list[idx]) === JSON.stringify(next)) return false // identical re-apply
    list[idx] = next
  } else list.push(next)
  raw.crons = list
  writeAgentJson(file, JSON.stringify(raw, null, 2) + '\n')
  return true
}

/**
 * Remove one CP cron (by id) from whichever agent.json holds it. Scans all agent
 * files since the owning agent is not part of `cron/remove`. Only `origin:"cp"`
 * entries are eligible — a hand-authored cron that happens to share the id is
 * never deleted. Returns whether an entry was removed.
 */
export function removeCronDef(agentsDir: string, cronId: string): boolean {
  for (const file of findAgentFiles(agentsDir)) {
    protectAgentJson(file)
    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    } catch {
      continue // malformed agent.json can't hold the cron
    }
    if (!Array.isArray(raw.crons)) continue
    const list = raw.crons as unknown[]
    const idx = list.findIndex(
      (c) =>
        typeof c === 'object' &&
        c !== null &&
        (c as { id?: unknown }).id === cronId &&
        (c as { origin?: unknown }).origin === 'cp'
    )
    if (idx === -1) continue
    list.splice(idx, 1)
    writeAgentJson(file, JSON.stringify(raw, null, 2) + '\n')
    return true
  }
  return false
}
