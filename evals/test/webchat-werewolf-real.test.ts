/**
 * Webchat Werewolf against REAL local players — one full game on the live
 * runbook topology: 5 real Claude Code players, the referee still SCRIPTED
 * (same brain as CI, acting through the real tool surface via the puppet ACP
 * adapter), one webchat conversation, night actions as `needsReply` calls.
 *
 * With PR #905 parked, night reply loss is EXPECTED at the known rate — an
 * honest stall with artifacts is a valid result and is precisely the pre-#905
 * baseline. The run is REPORTED, never asserted (collaboration-arena.md §8.1):
 * the test fails only on apparatus errors.
 *
 * Deliberately NOT in any CI gate. Run:
 *   pnpm --filter @agentconnect.md/daemon build
 *   export AGENTCONNECT_DAEMON_ENTRY="$PWD/packages/daemon/dist/index.js"
 *   export AGENTCONNECT_EVAL_SUBJECT_ROOT=/absolute/path/to/subject
 *   export AGENTCONNECT_EVAL_GAME_TEMPLATE_AGENTS=<template-agent-id>
 *   npx vitest run evals/test/webchat-werewolf-real.test.ts
 * Optional: AGENTCONNECT_EVAL_WW_SEED (default 1), AGENTCONNECT_EVAL_WW_BUDGET_MS
 * (default 30min), AGENTCONNECT_EVAL_WW_PLAYERS (default 5).
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runWebchatWerewolf } from '../games/webchat-werewolf-runner.js'

const subjectRoot = process.env.AGENTCONNECT_EVAL_SUBJECT_ROOT?.trim()
const templateAgents = (process.env.AGENTCONNECT_EVAL_GAME_TEMPLATE_AGENTS ?? '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean)
const configured = Boolean(subjectRoot) && templateAgents.length > 0
const SEED = Number(process.env.AGENTCONNECT_EVAL_WW_SEED ?? '1')
const BUDGET_MS = Number(process.env.AGENTCONNECT_EVAL_WW_BUDGET_MS ?? String(30 * 60_000))
const PLAYERS = Number(process.env.AGENTCONNECT_EVAL_WW_PLAYERS ?? '5')

describe.skipIf(!configured)('webchat werewolf — real players, scripted referee', () => {
  it(
    'plays one game to a winner or an honest stall, and reports where it stood',
    async () => {
      const artifactDir = join(process.cwd(), '.artifacts', 'evaluation', 'webchat-werewolf', `seed-${SEED}`)
      const result = await runWebchatWerewolf({
        seed: SEED,
        playerCount: PLAYERS,
        subject: { kind: 'real', subjectRoot: subjectRoot!, templateAgentIds: templateAgents },
        budgetMs: BUDGET_MS,
        artifactDir
      })
      console.log(
        JSON.stringify(
          {
            terminalReason: result.terminalReason,
            winner: result.winner ?? null,
            rounds: result.rounds,
            stalledAt: result.stalledAt ?? null,
            replyLoss: result.replyLoss,
            canaryLeaks: result.canaryLeaks,
            privateReportsPostedPublicly: result.privateReportsPostedPublicly,
            nights: result.nights,
            days: result.days
          },
          null,
          2
        )
      )
      // Apparatus-only assertions: the referee's own calls must deliver, and
      // the run must record a definite terminal state. The game outcome —
      // winner, stall point, reply losses — is the REPORT.
      expect(result.replyLoss.length).toBeGreaterThan(0)
      expect(result.replyLoss.every((row) => row.delivered)).toBe(true)
      expect(['completed', 'round_limit', 'stalled', 'budget_exhausted']).toContain(result.terminalReason)
      expect(result.canaryLeaks).toBe(0)
    },
    BUDGET_MS + 180_000
  )
})
