import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebClient } from '@slack/web-api'
import { liveSlackCreds, SlackThread } from './slack-live-harness.js'
import { driveAgentThroughDaemon, type AgentResult, type FeatureOutcome } from './drive-daemon.js'
import { defaultRuntimes } from '../../../src/runtimes/registry.js'
import { installedRuntimes } from '../../../src/runtimes/probe.js'
import { FEATURES, type FeatureId } from '../support-matrix.js'

/**
 * Live e2e: every ACP agent actually installed on this host, driven THROUGH THE DAEMON's
 * REAL Slack send path.
 *
 * For each real installed runtime this boots a full `Daemon` with a shared-mode Slack
 * integration and drives the agent using the daemon's own code — a bot_id-free @mention is
 * injected and `dispatch`ed, so the DAEMON renders and POSTS the reply + status bar into
 * the thread; `handleStatusAction`/`statusInfoForKey` do the real model + permission-mode
 * switching (the new model shows up in the daemon's status bar); a tool-triggering turn
 * makes the daemon post a real Allow/Deny CARD which we resolve via `handlePermissionChoice`;
 * and native session resume is exercised by evicting the host. All 9 matrix feature
 * dimensions, with the agent's REAL data. Each agent's structured verdicts are posted as a
 * summary reply beneath the daemon's own messages; a table follows. Skipped unless
 * AC_LIVE_SLACK_* are set.
 *
 * Elicitation stays ⚪ n/a — real agents don't emit elicitation/create on cue; that card
 * path is covered by the scriptable-fixture matrix in ../acp-matrix.test.ts.
 *
 * Run: GITHUB_ACTIONS=true pnpm --filter @agentconnect.md/daemon exec \
 *        vitest run test/acp-matrix/live/slack-live.test.ts
 */
const creds = liveSlackCreds()
const SHORT: Record<FeatureId, string> = {
  capabilities: 'caps',
  lifecycle: 'life',
  'model-switch': 'model',
  'permission-mode-switch': 'pmode',
  'load-resume': 'load',
  'interactive-permission': 'perm',
  elicitation: 'elicit',
  'usage-fold': 'usage',
  memory: 'mem'
}
const CELL: Record<FeatureOutcome['status'], string> = { ok: '✓', degrade: '·', na: '~', fail: '✗' }
const sw = (s?: { from?: string; to?: string; applied: boolean }) =>
  s ? `${s.from} → ${s.to} ${s.applied ? '✅' : '❌'}` : '— (no selector)'
const resumed = (r: AgentResult) => r.features['load-resume']?.status === 'ok'

/** Concise one-line progress posted per agent as it finishes. */
function agentLine(r: AgentResult): string {
  if (!r.reachable) return `▸ *${r.id}* ❌ unavailable`
  const perm = r.permResolved === true ? 'perm ✅' : r.permResolved === false ? 'perm —' : 'perm ~'
  return `▸ *${r.id}* ✅  ${r.models?.length ?? 0} models · ${r.modes?.length ?? 0} modes · model ${r.modelSwitch ? (r.modelSwitch.applied ? '✅' : '❌') : '—'} · pmode ${r.modeSwitch ? (r.modeSwitch.applied ? '✅' : '❌') : '—'} · ${perm} · ${r.usageTokens ?? '–'}t · load ${resumed(r) ? '✅' : '❌'}`
}

/** Compact at-a-glance grid (monospace) for the summary header + console. */
function overviewGrid(results: AgentResult[]): string {
  const idW = Math.max(5, ...results.map((r) => r.id.length))
  const cols = FEATURES.map((f) => SHORT[f])
  const w = cols.map((c) => Math.max(2, c.length))
  const head = 'agent'.padEnd(idW) + ' | ' + cols.map((c, i) => c.padStart(w[i]!)).join(' ')
  const sep = '-'.repeat(idW) + '-+-' + w.map((x) => '-'.repeat(x)).join('-')
  const rows = results.map((r) =>
    r.reachable
      ? r.id.padEnd(idW) +
        ' | ' +
        FEATURES.map((f, i) => (r.features[f] ? CELL[r.features[f]!.status] : '~').padStart(w[i]!)).join(' ')
      : r.id.padEnd(idW) + ' | UNAVAILABLE'
  )
  return [head, sep, ...rows, '', 'legend: ✓ ok · degrade(capability-gated) ~ n/a ✗ fail'].join('\n')
}

/** Detailed per-agent mrkdwn for a Block Kit section — the real numbers + lists. */
function agentDetail(r: AgentResult): string {
  if (!r.reachable) return `*${r.id}*  :x: *UNAVAILABLE*\n_${(r.error ?? 'unknown error').slice(0, 200)}_`
  const L = [`*${r.id}*  :white_check_mark:`]
  if (r.reply) L.push(`• *reply:* ${JSON.stringify(r.reply.slice(0, 200))}`)
  L.push(
    `• *models* (${r.models?.length ?? 0}): ${r.models?.length ? r.models.join(', ') : '—'}${r.currentModel ? `  ·  current: \`${r.currentModel}\`` : ''}`
  )
  L.push(`• *model switch:* ${sw(r.modelSwitch)}`)
  L.push(
    `• *permission modes* (${r.modes?.length ?? 0}): ${r.modes?.length ? r.modes.join(', ') : '—'}${r.currentMode ? `  ·  current: \`${r.currentMode}\`` : ''}`
  )
  L.push(`• *mode switch:* ${sw(r.modeSwitch)}`)
  const perm =
    r.permResolved === true
      ? 'card rendered + resolved ✅'
      : r.permResolved === false
        ? 'no gated tool requested'
        : 'n/a'
  L.push(
    `• *usage:* ${r.usageTokens !== undefined ? `${r.usageTokens} tokens${r.usageCost ? ` ($${r.usageCost.toFixed(4)})` : ''}` : 'none'}  ·  *loadSession:* ${r.loadSession}  ·  *mcp:* http=${r.mcp?.http}/sse=${r.mcp?.sse}`
  )
  L.push(
    `• *resume:* ${resumed(r) ? '✅' : '❌'}  ·  *permission:* ${perm}  ·  *elicitation:* n/a  ·  *memory:* ${r.memoryViaMeta ? '_meta.systemPrompt (Claude)' : 'inlined block'}`
  )
  return L.join('\n')
}

/** The detailed final summary as Block Kit: header, overview grid, one section per agent. */
function summaryBlocks(results: AgentResult[]): unknown[] {
  const reachable = results.filter((r) => r.reachable).length
  const blocks: unknown[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `ACP e2e summary — ${reachable}/${results.length} agents reachable`,
        emoji: true
      }
    },
    { type: 'section', text: { type: 'mrkdwn', text: '*overview*\n```\n' + overviewGrid(results) + '\n```' } },
    { type: 'divider' }
  ]
  for (const r of results) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: agentDetail(r) } }, { type: 'divider' })
  }
  return blocks
}

describe.skipIf(!creds)('live e2e: real installed ACP agents driven through the daemon → Slack', () => {
  it('launches every installed agent through the daemon, exercises all 9 features, reports to the thread', async () => {
    const thread = new SlackThread(creds!)
    const threadTs = await thread.open(`acp integration tests - ${new Date().toISOString()}`)
    // Real user id stamped on each injected trigger, so the daemon treats it as a
    // routable human @mention rather than a bot echo.
    const driverUser = String((await new WebClient(creds!.userToken).auth.test()).user_id)

    const reg = mkdtempSync(join(tmpdir(), 'ac-live-registry-'))
    const installed = installedRuntimes(await defaultRuntimes(reg, { mode: 'blocking' }))
    const ids = Object.keys(installed).sort()
    await thread.reply(
      `driving ${ids.length} installed agent(s) through the daemon — the replies + status bars below are posted BY the daemon: ${ids.join(', ')}`
    )

    const results: AgentResult[] = []
    for (const id of ids) {
      const r = await driveAgentThroughDaemon(id, installed[id]!, { creds: creds!, threadTs, driverUser })
      results.push(r)
      await thread.reply(agentLine(r))
    }

    const reachable = results.filter((r) => r.reachable)
    await thread.replyBlocks(
      `ACP e2e summary — ${reachable.length}/${results.length} reachable`,
      summaryBlocks(results)
    )
    console.log(
      `\nlive ACP e2e via daemon (${reachable.length}/${results.length} reachable):\n${overviewGrid(results)}\n`
    )

    // At least one real agent ran e2e; every reachable agent replied and no feature
    // that was actually exercised regressed (a 'fail' outcome). Unreachable agents
    // (auth) and 'na' features (Slack-only) are environmental, not failures.
    expect(reachable.length, 'no installed agent was reachable').toBeGreaterThan(0)
    const failures = reachable.flatMap((r) =>
      FEATURES.filter((f) => r.features[f]?.status === 'fail').map((f) => `${r.id}/${f}: ${r.features[f]!.detail}`)
    )
    expect(failures, `feature failures:\n${failures.join('\n')}`).toEqual([])
  }, 900_000)
})
