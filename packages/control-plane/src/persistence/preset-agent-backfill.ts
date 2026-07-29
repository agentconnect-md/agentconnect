/**
 * One-time preset backfill (docs/designs/preset-agents.md §3.2, M0).
 *
 * Existing orgs receive the `agentconnect` general preset with the SAME
 * semantics as the org-creation seam. The worklist is "orgs with no
 * `preset_agent` row for `general`" — the row itself is the marker, so the
 * sweep converges to an empty worklist after its first complete run and a
 * partially-failed boot simply resumes on the next one. Nothing here can
 * resurrect a deleted preset: deletion leaves the row behind.
 *
 * A slug collision (the org already has an agent named `agentconnect`) writes a
 * permanent `skipped` row and never renames user resources (§3.3). New rows of
 * that name can no longer appear (RESERVED_AGENT_SLUGS lands with this), so the
 * pre-check is stable; a lost race against a concurrent provisioner still fails
 * onto the (orgId, preset) primary key and is retried next boot.
 *
 * Runs once from `startBackground()` — tests never start it, so suites opt in
 * explicitly (mirrors the reaper convention).
 */
import type { PrismaClient } from '../generated/prisma/client.js'
import { withTx } from './prisma.js'
import { ensurePresetAgentsProvisioned } from './preset-agents.js'

export interface PresetBackfillLog {
  info(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
}

export class PresetAgentBackfill {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly log: PresetBackfillLog
  ) {}

  /** Sweep every org missing a `general` preset row. Per-org transactions: one
   *  org's failure (logged) never blocks the rest, and a crashed run resumes. */
  async run(): Promise<{ provisioned: number; skipped: number; failed: number }> {
    const orgs = await this.prisma.org.findMany({
      where: { presetAgents: { none: { preset: 'general' } } },
      select: { id: true },
      orderBy: { createdAt: 'asc' }
    })
    let provisioned = 0
    let skipped = 0
    let failed = 0
    for (const org of orgs) {
      try {
        // Re-checks inside the tx — a concurrent seam write (org just created?
        // impossible for pre-existing orgs, but harmless) or a prior partial run
        // may have landed a row since the worklist query. System write: the
        // backfill has no acting user (§3.2 attribution).
        const wasSkipped = await withTx(this.prisma, (tx) => ensurePresetAgentsProvisioned(tx, org.id))
        if (wasSkipped === true) skipped++
        else if (wasSkipped === false) provisioned++
      } catch (err) {
        failed++
        this.log.warn({ err, orgId: org.id }, 'preset-backfill: org failed — will retry next boot')
      }
    }
    if (provisioned + skipped + failed > 0) {
      this.log.info({ provisioned, skipped, failed }, 'preset-backfill: sweep complete')
    }
    return { provisioned, skipped, failed }
  }
}
